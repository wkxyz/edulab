import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/enable-minimax-allowance.py'
spec = importlib.util.spec_from_file_location('minimax_allowance', SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ENV = ('# preserve previous keys and reservations\nADMIN_TOKEN=private-admin\n'
       'KIE_API_KEY=private-kie\nMINIMAX_API_KEY=private-language\n'
       'MINIMAX_TTS_API_KEY=private-voice\nAI_PROVIDER=minimax\nTTS_PROVIDER=minimax\n'
       'LIVE_ENABLED=false\nLIVE_TASK_LIMIT=2\nDAY_BUDGET_CENTS=2000\nJOB_BUDGET_CENTS=1000\n')
REAL_OPEN = os.open


class AllowanceTests(unittest.TestCase):
    def test_budget_plan_preserves_keys_and_reserves_only_ten_additional_yuan(self):
        before = m.parse_env(ENV)
        after = m.parse_env(m.replacement_env(ENV))
        self.assertEqual(after['LIVE_TASK_LIMIT'], '7')
        self.assertEqual(after['JOB_BUDGET_CENTS'], '200')
        self.assertEqual(int(after['DAY_BUDGET_CENTS'])-int(before['DAY_BUDGET_CENTS']), 1000)
        self.assertEqual((int(after['LIVE_TASK_LIMIT'])-int(before['LIVE_TASK_LIMIT']))*int(after['JOB_BUDGET_CENTS']), 1000)
        for key in before:
            if key not in m.OLD_LIMITS and key != 'LIVE_ENABLED':
                self.assertEqual(before[key], after[key])

    def test_unconfirmed_invocation_does_not_connect(self):
        with patch.object(m.sys, 'argv', ['enable-minimax-allowance.py']), \
             patch.object(m, 'ssh_session') as ssh, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.local_main(), 1)
            ssh.assert_not_called()

    def test_changed_limits_or_duplicate_env_keys_are_refused(self):
        for value in (ENV.replace('LIVE_TASK_LIMIT=2', 'LIVE_TASK_LIMIT=3'),
                      ENV+'JOB_BUDGET_CENTS=200\n',
                      ENV.replace('LIVE_ENABLED=false', 'LIVE_ENABLED=true')):
            with self.assertRaises(m.SafeFailure):
                m.replacement_env(value)

    def fixture(self, root):
        env = root / 'services/tutor/.env'
        env.parent.mkdir(parents=True)
        env.write_text(ENV)
        env.chmod(0o600)
        checkpoint = root / 'checkpoint'
        state = {'config': m.expected_config(False, m.OLD_LIMITS), 'counts': dict(m.BEFORE),
                 'stopped': False, 'commands': [], 'quota': {'jobs': 2, 'cost': 2000},
                 'fail_recreate': False, 'fail_verify': False, 'concurrent': False, 'revision': m.TARGET}
        def command(args, timeout=60):
            state['commands'].append(args)
            if args == ['git', 'rev-parse', 'HEAD']:
                return state['revision']
            if args[-2:] == ['control.mjs', 'stop']:
                state['stopped'] = True
            elif args[-2:] == ['control.mjs', 'resume']:
                state['stopped'] = False
            elif 'up' in args:
                if state['fail_recreate']:
                    state['fail_recreate'] = False
                    raise m.SafeFailure('RECREATE_FAILED')
                values = m.parse_env(env.read_text())
                state['config'] = m.expected_config(values['LIVE_ENABLED']=='true', values)
            return ''
        def node(source):
            if source == m.COUNTS_CHECK:
                return dict(state['counts'])
            if source == m.QUOTA_CHECK:
                return state['quota']
            if source == m.CONFIG_CHECK:
                if state['config']['liveEnabled'] and state['fail_verify']:
                    state['fail_verify'] = False
                    if state['concurrent']:
                        env.write_text(env.read_text()+'UNRELATED_SETTING=preserve\n')
                    return {}
                return dict(state['config'])
            raise AssertionError('Unexpected node source')
        def health(url=None):
            return {'stopped': state['stopped'], 'sampleAvailable': True,
                    'liveEnabled': state['config']['liveEnabled'] and not state['stopped']
                                   and state['counts']['tasks'] < state['config']['limit'],
                    'liveLimitReached': state['counts']['tasks'] >= state['config']['limit']}
        def invoke(payload=None):
            fd = REAL_OPEN(root/'lock', os.O_CREAT|os.O_RDWR, 0o600)
            def opened(path, flags, *args, **kwargs):
                if str(path) == '/run/edulab-minimax-deploy.lock':
                    return fd
                return REAL_OPEN(path, flags, *args, **kwargs)
            output = io.StringIO()
            with patch.object(m, 'ROOT', root), patch.object(m, 'CHECKPOINT_DIR', checkpoint), \
                 patch.object(m.os, 'open', side_effect=opened), patch('fcntl.flock'), \
                 patch.object(m, 'command', side_effect=command), patch.object(m, 'node_json', side_effect=node), \
                 patch.object(m, 'health', side_effect=health), patch.object(m, 'wait_health', side_effect=health), \
                 patch.object(m.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(m.PAYLOAD if payload is None else payload).encode()))), \
                 contextlib.redirect_stdout(output):
                code = m.remote_main()
            # Invalid confirmation fails before opening the lock, so close the fixture fd here.
            try:
                os.fstat(fd)
            except OSError:
                pass
            else:
                os.close(fd)
            for secret in ('private-admin', 'private-kie', 'private-language', 'private-voice'):
                self.assertNotIn(secret, output.getvalue())
            return code, json.loads(output.getvalue())
        return env, checkpoint, state, invoke

    def test_success_enables_five_slots_without_submitting_or_resetting_history(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            code, result = invoke()
            self.assertEqual(code, 0)
            self.assertEqual(result['status'], 'enabled_bounded')
            self.assertEqual(result['remaining'], 5)
            self.assertEqual(result['generationSubmissions'], 0)
            self.assertEqual(result['counters'], m.BEFORE)
            self.assertTrue(result['publicHealth']['liveEnabled'])
            self.assertFalse(state['stopped'])
            self.assertEqual(m.parse_env(env.read_text())['LIVE_ENABLED'], 'true')
            self.assertEqual(stat.S_IMODE((checkpoint/(m.PLAN+'.json')).stat().st_mode), 0o600)

    def test_wrong_budget_confirmation_cannot_mutate_server(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            code, result = invoke({'additionalTasks': 50, 'additionalReserveCents': 1000})
            self.assertEqual(code, 1)
            self.assertEqual(state['commands'], [])
            self.assertEqual(env.read_text(), ENV)

    def test_verified_upgrade_revision_can_keep_the_same_explicit_budget_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            state['revision'] = 'a' * 40
            code, result = invoke({**m.PAYLOAD, 'revision': state['revision']})
            self.assertEqual(code, 0)
            self.assertEqual(result['remaining'], 5)
            self.assertEqual(result['additionalReserveCents'], 1000)

    def test_revision_injection_is_rejected_before_ssh(self):
        with patch.object(m.subprocess, 'run') as run:
            with self.assertRaisesRegex(m.SafeFailure, 'INVALID_APP_REVISION'):
                m.transmit('pass', Path('/tmp/control'), 'a'*40+';echo unsafe')
            run.assert_not_called()

    def test_busy_or_changed_history_aborts_before_enable(self):
        for changes in ({'busy': 1}, {'tasks': 3}, {'calls': 8}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory:
                env, checkpoint, state, invoke = self.fixture(Path(directory))
                state['counts'].update(changes)
                code, result = invoke()
                self.assertEqual(code, 1)
                self.assertEqual(env.read_text(), ENV)
                self.assertFalse(any('up' in c for c in state['commands']))

    def test_daily_budget_or_project_limit_is_checked(self):
        for quota in ({'jobs': 20, 'cost': 2000}, {'jobs': 2, 'cost': 2001}):
            with self.subTest(quota=quota), tempfile.TemporaryDirectory() as directory:
                env, checkpoint, state, invoke = self.fixture(Path(directory))
                state['quota'] = quota
                code, result = invoke()
                self.assertEqual(code, 1)
                self.assertEqual(result['error'], 'DAILY_QUOTA_REQUIRES_REVIEW')
                self.assertEqual(env.read_text(), ENV)

    def test_repeated_invocation_cannot_replenish_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            self.assertEqual(invoke()[0], 0)
            commands = len(state['commands'])
            state['counts']['tasks'] = 7
            code, result = invoke()
            self.assertEqual(code, 0)
            self.assertTrue(result['alreadyApplied'])
            self.assertFalse(result['currentHealth']['liveEnabled'])
            self.assertEqual(len(state['commands']), commands)
            self.assertEqual(m.parse_env(env.read_text())['LIVE_TASK_LIMIT'], '7')

    def test_interrupted_plan_is_not_reapplied(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            checkpoint.mkdir(mode=0o700)
            m.atomic_write(checkpoint/(m.PLAN+'.json'), json.dumps({'status':'started','plan':m.PLAN}).encode())
            code, result = invoke()
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], 'ALREADY_STARTED_NO_QUOTA_REFILL')
            self.assertEqual(state['commands'], [])
            self.assertEqual(env.read_text(), ENV)

    def test_recreate_failure_restores_closed_service_and_history(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            state['fail_recreate'] = True
            code, result = invoke()
            self.assertEqual(code, 1)
            self.assertTrue(result['rolledBack'])
            self.assertEqual(env.read_text(), ENV)
            self.assertFalse(state['stopped'])
            self.assertEqual(state['counts'], m.BEFORE)

    def test_verify_failure_rolls_back_before_any_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            state['fail_verify'] = True
            code, result = invoke()
            self.assertEqual(code, 1)
            self.assertTrue(result['rolledBack'])
            self.assertEqual(env.read_text(), ENV)
            resumes = [c for c in state['commands'] if c[-2:] == ['control.mjs','resume']]
            self.assertEqual(len(resumes), 1)
            self.assertFalse(state['config']['liveEnabled'])

    def test_concurrent_admin_configuration_is_preserved_and_service_paused(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, invoke = self.fixture(Path(directory))
            state['fail_verify'] = True
            state['concurrent'] = True
            code, result = invoke()
            self.assertEqual(code, 1)
            self.assertFalse(result['rolledBack'])
            self.assertTrue(state['stopped'])
            self.assertIn('UNRELATED_SETTING=preserve', env.read_text())


if __name__ == '__main__':
    unittest.main()

