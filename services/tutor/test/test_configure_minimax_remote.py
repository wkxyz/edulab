import importlib.util
import contextlib
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

source = Path(__file__).resolve().parents[1] / 'scripts/configure-minimax-remote.py'
spec = importlib.util.spec_from_file_location('minimax_remote', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
KEYS = {'language': 'test-only-language-' + 'a' * 30, 'voice': 'test-only-voice-' + 'b' * 30}
ENV = '# keep the old keys and counters\nADMIN_TOKEN=' + 'c' * 40 + '\nKIE_API_KEY=old-key\nLIVE_ENABLED=true\nLIVE_TASK_LIMIT=1\nDAY_BUDGET_CENTS=1000\nJOB_BUDGET_CENTS=1000\n'


class RemoteConfigurationTests(unittest.TestCase):
    def test_key_update_keeps_limits_and_unrelated_configuration(self):
        updated = module.updated_env(ENV, KEYS)
        parsed = module.parse_env(updated)
        self.assertEqual(parsed['MINIMAX_API_KEY'], KEYS['language'])
        self.assertEqual(parsed['MINIMAX_TTS_API_KEY'], KEYS['voice'])
        self.assertEqual(parsed['LIVE_ENABLED'], 'false')
        self.assertEqual(parsed['KIE_API_KEY'], 'old-key')
        for key, value in module.LIMITS.items():
            self.assertEqual(parsed[key], value)
        self.assertIn('# keep the old keys and counters', updated)
        self.assertNotIn('\\n', updated)

    def test_changed_or_missing_limits_are_refused(self):
        for text in [ENV.replace('LIVE_TASK_LIMIT=1', 'LIVE_TASK_LIMIT=2'), ENV.replace('DAY_BUDGET_CENTS=1000\n', '')]:
            with self.assertRaisesRegex(module.SafeFailure, 'LIMITS_CHANGED'):
                module.updated_env(text, KEYS)

    def test_duplicate_values_are_refused(self):
        with self.assertRaisesRegex(module.SafeFailure, 'ENV_REQUIRES_REVIEW'):
            module.updated_env(ENV + 'LIVE_TASK_LIMIT=2\n', KEYS)

    def test_credential_injection_is_rejected_before_ssh(self):
        with patch.object(module.subprocess, 'run') as run:
            with self.assertRaises(module.SafeFailure):
                module.transmit('pass', {**KEYS, 'voice': KEYS['voice'] + '\nLIVE_TASK_LIMIT=2'})
            run.assert_not_called()

    def test_secure_file_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            key = root / 'voice.key'
            key.write_text(KEYS['voice'])
            metadata = root / 'location.json'
            metadata.write_text(json.dumps({'key': str(key)}))
            key.chmod(0o644)
            with self.assertRaises(module.SafeFailure):
                module.load_key(metadata)
            key.chmod(0o600)
            self.assertEqual(module.load_key(metadata), (key, KEYS['voice']))
            key.unlink()
            target = root / 'target'
            target.write_text(KEYS['voice'])
            target.chmod(0o600)
            key.symlink_to(target)
            with self.assertRaises(module.SafeFailure):
                module.load_key(metadata)

    def test_credentials_use_stdin_only_and_strict_host_checks(self):
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            module.transmit('print("safe source")', KEYS)
            args, kwargs = run.call_args
            command = args[0]
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertIn('BatchMode=yes', command)
            self.assertEqual(json.loads(kwargs['input']), KEYS)
            for key in KEYS.values():
                self.assertNotIn(key, ' '.join(command))

    def test_atomic_write_replaces_a_symlink_without_following_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'unrelated'
            target.write_text('keep')
            destination = root / 'receipt'
            destination.symlink_to(target)
            module.atomic_write(destination, b'{"ok":true}')
            self.assertEqual(target.read_text(), 'keep')
            self.assertFalse(destination.is_symlink())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)

    def remote_fixture(self, root, counts, node_results, fail_build=False):
        env = root / 'services/tutor/.env'
        env.parent.mkdir(parents=True)
        env.write_text(ENV)
        env.chmod(0o600)
        backup = root / 'private-rollback'
        backup.mkdir(mode=0o700)
        commands = []
        def execute(args, timeout=60):
            commands.append(args)
            if args == ['git', 'branch', '--show-current']:
                return module.BRANCH
            if args == ['git', 'rev-parse', 'HEAD']:
                return module.TARGET
            if args == module.COMPOSE + ['ps', '--quiet', 'tutor']:
                return 'container-test'
            if args[:2] == ['docker', 'inspect']:
                return 'sha256:old-running-image'
            if fail_build and args == module.COMPOSE + ['build', 'tutor']:
                raise module.SafeFailure('BUILD_FAILED')
            return ''
        fd = os.open(root / 'lock', os.O_CREAT | os.O_RDWR, 0o600)
        def controlled_open(path, flags, *args, **kwargs):
            if path == '/run/edulab-minimax-deploy.lock':
                return fd
            return os_open(path, flags, *args, **kwargs)
        output = io.StringIO()
        state = {'liveEnabled': False, 'stopped': False, 'sampleAvailable': True}
        try:
            with patch.object(module, 'ROOT', root), patch.object(module.os, 'open', side_effect=controlled_open), patch('fcntl.flock'), \
                 patch.object(module, 'command', side_effect=execute), patch.object(module, 'node_json', side_effect=node_results), \
                 patch.object(module, 'health', return_value=state), patch.object(module, 'wait_health', return_value=state), \
                 patch.object(module.tempfile, 'mkdtemp', return_value=str(backup)), \
                 patch.object(module.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(KEYS).encode()))), \
                 contextlib.redirect_stdout(output):
                code = module.remote_main()
        finally:
            os.close(fd)
        for key in KEYS.values():
            self.assertNotIn(key, output.getvalue())
        return code, json.loads(output.getvalue()), env.read_text(), commands

    def test_busy_tasks_abort_before_configuration_or_build(self):
        with tempfile.TemporaryDirectory() as directory:
            code, result, env, commands = self.remote_fixture(Path(directory), None, [{'tasks': 1, 'busy': 1}])
            self.assertEqual(code, 1)
            self.assertEqual(result['stage'], 'preflight')
            self.assertEqual(env, ENV)
            self.assertFalse(commands)

    def test_build_failure_keeps_original_configuration(self):
        counts = {'tasks': 1, 'calls': 1, 'requests': 2, 'attempts': 1, 'busy': 0}
        with tempfile.TemporaryDirectory() as directory:
            code, result, env, commands = self.remote_fixture(Path(directory), counts, [counts], fail_build=True)
            self.assertEqual(code, 1)
            self.assertEqual(result['stage'], 'build')
            self.assertEqual(env, ENV)
            self.assertFalse(any('up' in command for command in commands))

    def test_verification_failure_restores_old_env_and_running_image(self):
        counts = {'tasks': 1, 'calls': 1, 'requests': 2, 'attempts': 1, 'busy': 0}
        with tempfile.TemporaryDirectory() as directory:
            code, result, env, commands = self.remote_fixture(Path(directory), counts, [counts, counts, {'provider': 'wrong'}])
            self.assertEqual(code, 1)
            self.assertEqual(result['status'], 'failed')
            self.assertTrue(result['rolledBack'])
            self.assertEqual(env, ENV)
            self.assertTrue(any(any(x.endswith('rollback.yml') for x in command) for command in commands))

    def test_success_keeps_live_disabled_and_preserves_counts(self):
        counts = {'tasks': 1, 'calls': 1, 'requests': 2, 'attempts': 1, 'busy': 0}
        config = {'provider': 'minimax', 'model': 'MiniMax-M3.1-Flash', 'ttsProvider': 'minimax',
                  'ttsModel': 'speech-2.8-hd', 'configured': True, 'languageKeyConfigured': True,
                  'voiceKeyConfigured': True, 'liveEnabled': False, 'limit': 1, 'day': 1000, 'job': 1000}
        with tempfile.TemporaryDirectory() as directory:
            code, result, env, commands = self.remote_fixture(Path(directory), counts, [counts, counts, config, {'language': True, 'voice': True}, counts])
            self.assertEqual(code, 0)
            self.assertEqual(result['status'], 'deployed_live_off')
            self.assertEqual(result['counters'], counts)
            self.assertTrue(result['limitsPreserved'])
            self.assertFalse(module.parse_env(env)['LIVE_ENABLED'] == 'true')
            for key, value in module.LIMITS.items():
                self.assertEqual(module.parse_env(env)[key], value)
            self.assertFalse(any('rollback.yml' in ' '.join(command) for command in commands))


os_open = os.open

if __name__ == '__main__':
    unittest.main()
