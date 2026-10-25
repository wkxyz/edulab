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

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/accept-minimax-once.py'
spec = importlib.util.spec_from_file_location('minimax_acceptance', SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ENV = ('# preserve credentials and historical reservations\n'
       'ADMIN_TOKEN=test-admin-do-not-expose\nKIE_API_KEY=test-old-do-not-expose\n'
       'AI_PROVIDER=minimax\nTTS_PROVIDER=minimax\n'
       'MINIMAX_API_KEY=test-language-do-not-expose\nMINIMAX_TTS_API_KEY=test-voice-do-not-expose\n'
       'LIVE_ENABLED=false\nLIVE_TASK_LIMIT=1\nDAY_BUDGET_CENTS=1000\nJOB_BUDGET_CENTS=1000\n')
TASK_ID = '11111111-1111-4111-8111-111111111111'
REAL_OPEN = os.open


class AcceptanceTests(unittest.TestCase):
    def test_only_the_authorized_limits_change_and_keys_stay_private(self):
        active = m.change_env(ENV, m.OLD_LIMITS, True)
        off = m.change_env(active, m.NEW_LIMITS, False)
        before, after = m.parse_env(ENV), m.parse_env(off)
        self.assertEqual(after['LIVE_ENABLED'], 'false')
        for k, v in m.NEW_LIMITS.items():
            self.assertEqual(after[k], v)
        for k, v in before.items():
            if k not in m.NEW_LIMITS and k != 'LIVE_ENABLED':
                self.assertEqual(after[k], v)
        self.assertIn('# preserve credentials', off)

    def test_changed_limits_duplicate_settings_and_missing_credentials_are_refused(self):
        for text in (ENV.replace('LIVE_TASK_LIMIT=1', 'LIVE_TASK_LIMIT=2'),
                     ENV + 'JOB_BUDGET_CENTS=1000\n',
                     ENV.replace('MINIMAX_TTS_API_KEY=test-voice-do-not-expose', 'MINIMAX_TTS_API_KEY=')):
            with self.assertRaises(m.SafeFailure):
                m.change_env(text, m.OLD_LIMITS, True)

    def test_normal_invocation_cannot_enable_generation(self):
        with patch.object(m.sys, 'argv', ['accept-minimax-once.py']), \
             patch.object(m, 'ssh_session') as ssh, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.local_main(), 1)
            ssh.assert_not_called()

    def test_embedded_node_program_parses_without_running_or_contacting_providers(self):
        result = subprocess.run(['node', '--check', '--input-type=module'],
                                input=m.FLOW, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def fixture(self, root):
        env = root / 'services/tutor/.env'
        env.parent.mkdir(parents=True)
        env.write_text(ENV)
        env.chmod(0o600)
        checkpoint_dir = root / 'acceptance'
        state = {'counts': dict(m.BEFORE), 'rows': [], 'effective': m.parse_env(ENV),
                 'stopped': False, 'commands': [], 'flows': 0, 'fail_recreate': False}
        def command(args, timeout=60):
            state['commands'].append(args)
            if args == ['git', 'rev-parse', 'HEAD']:
                return m.TARGET
            if args[-2:] == ['control.mjs', 'stop']:
                state['stopped'] = True
            elif args[-2:] == ['control.mjs', 'resume']:
                state['stopped'] = False
            elif 'up' in args:
                if state['fail_recreate']:
                    state['fail_recreate'] = False
                    raise m.SafeFailure('RECREATE_FAILED')
                state['effective'] = m.parse_env(env.read_text())
            return ''
        def node(source):
            if source == m.COUNTS_CHECK:
                return dict(state['counts'])
            if source == m.TASK_CHECK:
                return state['rows']
            if source == m.CONFIG_CHECK:
                p = state['effective']
                return {'provider': p['AI_PROVIDER'], 'model': 'MiniMax-M3.1-Flash',
                        'ttsProvider': p['TTS_PROVIDER'], 'ttsModel': 'speech-2.8-hd',
                        'configured': True, 'liveEnabled': p['LIVE_ENABLED'] == 'true',
                        'limit': int(p['LIVE_TASK_LIMIT']), 'day': int(p['DAY_BUDGET_CENTS']),
                        'job': int(p['JOB_BUDGET_CENTS'])}
            raise AssertionError('Unexpected node source')
        def health(url=None):
            return {'liveEnabled': state['effective']['LIVE_ENABLED'] == 'true'
                    and not state['stopped'] and state['counts']['tasks'] < 2,
                    'stopped': state['stopped'], 'sampleAvailable': True}
        def flow(failed=False, raises=False):
            state['flows'] += 1
            task = {'id': TASK_ID, 'status': 'failed' if failed else 'completed',
                    'error': 'PROVIDER_FAILED' if failed else None, 'attempts': 1,
                    'calls': 1 if failed else 4, 'requests': 1 if failed else 4, 'reserve': 1000}
            state['rows'] = [task]
            state['counts'] = {**m.BEFORE, 'tasks': 2, 'calls': m.BEFORE['calls'] + task['calls'],
                               'requests': m.BEFORE['requests'] + task['requests'], 'attempts': 2}
            if raises:
                raise subprocess.TimeoutExpired('safe-test-command', 420)
            return {'status': 'failed' if failed else 'passed', 'submissionAttempts': 1,
                    'taskId': TASK_ID, 'answer': 'x = 5', **({'error': 'TASK_PROVIDER_FAILED'} if failed else {})}
        def invoke(action=None):
            fd = REAL_OPEN(root / 'lock', os.O_CREAT | os.O_RDWR, 0o600)
            def controlled_open(path, flags, *args, **kwargs):
                if str(path) == '/run/edulab-minimax-deploy.lock':
                    return fd
                return REAL_OPEN(path, flags, *args, **kwargs)
            output = io.StringIO()
            with patch.object(m, 'ROOT', root), patch.object(m, 'CHECKPOINT_DIR', checkpoint_dir), \
                 patch.object(m.os, 'open', side_effect=controlled_open), patch('fcntl.flock'), \
                 patch.object(m, 'command', side_effect=command), patch.object(m, 'node_json', side_effect=node), \
                 patch.object(m, 'health', side_effect=health), patch.object(m, 'wait_health', side_effect=health), \
                 patch.object(m, 'run_flow', side_effect=action or flow), contextlib.redirect_stdout(output):
                code = m.remote_main()
            for secret in ['test-admin-do-not-expose', 'test-old-do-not-expose',
                           'test-language-do-not-expose', 'test-voice-do-not-expose']:
                self.assertNotIn(secret, output.getvalue())
            return code, json.loads(output.getvalue())
        return env, checkpoint_dir, state, flow, invoke

    def test_success_preserves_history_and_turns_generation_off(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            code, result = invoke()
            self.assertEqual(code, 0)
            self.assertEqual(result['status'], 'passed_live_off')
            self.assertTrue(result['liveDisabled'])
            self.assertEqual(result['counters']['tasks'], 2)
            self.assertEqual(result['counters']['calls'], 5)
            self.assertEqual(result['counters']['requests'], 6)
            self.assertEqual(state['flows'], 1)
            self.assertFalse(state['stopped'])
            self.assertEqual(m.parse_env(env.read_text())['LIVE_ENABLED'], 'false')
            receipt = checkpoint / (m.AUTHORIZATION + '.json')
            self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)

    def test_failed_paid_task_is_not_retried_or_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            code, result = invoke(lambda: flow(failed=True))
            self.assertEqual(code, 1)
            self.assertEqual(result['task']['status'], 'failed')
            self.assertEqual(result['task']['attempts'], 1)
            self.assertEqual(result['counters']['tasks'], 2)
            self.assertEqual(state['flows'], 1)
            self.assertTrue(result['liveDisabled'])
            self.assertEqual(m.parse_env(env.read_text())['LIVE_ENABLED'], 'false')

    def test_uncertain_submission_timeout_still_closes_generation_without_resubmitting(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            code, result = invoke(lambda: flow(failed=True, raises=True))
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], 'TimeoutExpired')
            self.assertEqual(result['taskId'], TASK_ID)
            self.assertTrue(result['liveDisabled'])
            self.assertEqual(state['flows'], 1)

    def test_repeated_invocation_only_reads_the_existing_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            self.assertEqual(invoke()[0], 0)
            command_count = len(state['commands'])
            code, result = invoke()
            self.assertEqual(code, 0)
            self.assertTrue(result['alreadyExecuted'])
            self.assertEqual(state['flows'], 1)
            self.assertEqual(len(state['commands']), command_count)

    def test_incomplete_checkpoint_refuses_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            checkpoint.mkdir(mode=0o700)
            m.atomic_write(checkpoint / (m.AUTHORIZATION + '.json'),
                           json.dumps({'status': 'started', 'authorization': m.AUTHORIZATION}).encode())
            code, result = invoke()
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], 'ALREADY_STARTED_NO_RESUBMISSION')
            self.assertEqual(state['flows'], 0)
            self.assertEqual(state['commands'], [])
            self.assertEqual(env.read_text(), ENV)

    def test_busy_or_changed_counters_abort_before_enable(self):
        for changes in ({'busy': 1}, {'tasks': 2}, {'calls': 2}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory:
                env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
                state['counts'].update(changes)
                code, result = invoke()
                self.assertEqual(code, 1)
                self.assertEqual(result['stage'], 'preflight')
                self.assertEqual(state['flows'], 0)
                self.assertEqual(env.read_text(), ENV)

    def test_failed_service_recreation_closes_generation_without_a_paid_call(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            state['fail_recreate'] = True
            code, result = invoke()
            self.assertEqual(code, 1)
            self.assertEqual(state['flows'], 0)
            self.assertTrue(result['liveDisabled'])
            self.assertEqual(m.parse_env(env.read_text())['LIVE_ENABLED'], 'false')

    def test_external_config_change_is_preserved_and_service_is_paused(self):
        with tempfile.TemporaryDirectory() as directory:
            env, checkpoint, state, flow, invoke = self.fixture(Path(directory))
            def concurrent_change():
                value = flow()
                env.write_text(env.read_text() + 'NEW_ADMIN_SETTING=preserve-me\n')
                return value
            code, result = invoke(concurrent_change)
            self.assertEqual(code, 1)
            self.assertFalse(result['liveDisabled'])
            self.assertEqual(result['cleanupError'], 'CONFIG_CHANGED_SERVICE_PAUSED')
            self.assertTrue(state['stopped'])
            self.assertIn('NEW_ADMIN_SETTING=preserve-me', env.read_text())

    def test_ssh_transfer_keeps_strict_host_checks_and_never_requests_new_keys(self):
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            m.transmit('print("safe")', Path('/tmp/private/control'))
            args, kwargs = run.call_args
            self.assertIn('StrictHostKeyChecking=yes', args[0])
            self.assertIn('BatchMode=yes', args[0])
            self.assertNotIn('input', kwargs)


if __name__ == '__main__':
    unittest.main()
