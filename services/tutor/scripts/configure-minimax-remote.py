#!/usr/bin/env python3
"""One-shot private MiniMax configuration and deployment; paid generation stays off.

Run on the Mac where the secure input windows saved the two credentials.
Credentials travel only over SSH stdin, never in arguments, output, or Git.
"""
import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

HOST = 'root@43.173.94.201'
ROOT = Path('/opt/edulab')
TARGET = '9828eed4e4d489984990fdb7264fe7d499df25b1'
BRANCH = 'codex/ai-video-website'
LIMITS = {'LIVE_TASK_LIMIT': '1', 'DAY_BUDGET_CENTS': '1000', 'JOB_BUDGET_CENTS': '1000'}
METADATA = {
    'language': Path('/tmp/edulab-minimax-key-location.json'),
    'voice': Path('/tmp/edulab-minimax-voice-key-location.json'),
}
RECEIPT = Path('/tmp/edulab-minimax-deploy-result.json')
COMPOSE = ['docker', 'compose', '-f', 'compose.tutor.yml', '-f', 'compose.tutor.public.yml', '-f', 'compose.tutor.host.yml']
CONFIG_CHECK = """import {configFromEnv} from './config.mjs';
const c=configFromEnv();console.log(JSON.stringify({provider:c.provider,model:c.aiModel,
ttsProvider:c.ttsProvider,ttsModel:c.ttsModel,configured:c.configured,
languageKeyConfigured:!!process.env.MINIMAX_API_KEY,voiceKeyConfigured:!!process.env.MINIMAX_TTS_API_KEY,
liveEnabled:c.liveEnabled,limit:c.liveTaskLimit,day:c.dayBudgetCents,job:c.jobBudgetCents}));"""
COUNTS_CHECK = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/tutor.sqlite',{readOnly:true});
const x=db.prepare(\"SELECT count(*) tasks,coalesce(sum(calls),0) calls,coalesce(sum(requests),0) requests,coalesce(sum(attempts),0) attempts FROM tasks WHERE mode='live'\").get();
x.busy=db.prepare(\"SELECT count(*) n FROM tasks WHERE status IN ('queued','running')\").get().n;
db.close();console.log(JSON.stringify(x));"""
AUTH_CHECK = """const headers={authorization:'Bearer '+process.env.MINIMAX_API_KEY};
const a=await fetch('https://api.minimax.cn/v1/models',{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
if(!a.ok)throw Error('LANGUAGE_AUTH');const models=await a.json();
const b=await fetch('https://api.minimax.cn/v1/get_voice',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{authorization:'Bearer '+process.env.MINIMAX_TTS_API_KEY,'content-type':'application/json'},body:JSON.stringify({voice_type:'system'})});
if(!b.ok)throw Error('VOICE_AUTH');const voices=await b.json();
console.log(JSON.stringify({language:(models.data||[]).some(x=>x.id==='MiniMax-M3.1-Flash'),voice:voices.base_resp?.status_code===0&&(voices.system_voice||[]).some(x=>x.voice_id==='female-chengshu')}));"""


class SafeFailure(Exception):
    pass


def valid_keys(keys):
    if set(keys) != {'language', 'voice'} or any(
        not isinstance(v, str) or re.fullmatch(r'[A-Za-z0-9._-]{24,4096}', v) is None
        for v in keys.values()
    ):
        raise SafeFailure('INVALID_CREDENTIAL_INPUT')


def parse_env(text):
    pairs = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        key, sep, value = s.partition('=')
        key = key.strip()
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in pairs:
            raise SafeFailure('ENV_REQUIRES_REVIEW')
        pairs[key] = value.strip().strip('\"\'')
    return pairs


def updated_env(text, keys):
    valid_keys(keys)
    before = parse_env(text)
    if any(before.get(k) != v for k, v in LIMITS.items()):
        raise SafeFailure('LIMITS_CHANGED_REQUIRES_REVIEW')
    changes = {
        'AI_PROVIDER': 'minimax', 'MINIMAX_API_KEY': keys['language'],
        'MINIMAX_REGION': 'cn', 'MINIMAX_REASONING_EFFORT': 'medium',
        'TTS_PROVIDER': 'minimax', 'MINIMAX_TTS_API_KEY': keys['voice'],
        'MINIMAX_TTS_REGION': 'cn', 'MINIMAX_TTS_MODEL': 'speech-2.8-hd',
        'MINIMAX_TTS_VOICE': 'female-chengshu', 'LIVE_ENABLED': 'false',
    }
    pending = dict(changes)
    lines = []
    for line in text.splitlines():
        key = line.split('=', 1)[0].strip()
        lines.append(key + '=' + pending.pop(key) if key in pending else line)
    lines.extend(k + '=' + v for k, v in pending.items())
    result = '\n'.join(lines) + '\n'
    after = parse_env(result)
    if any(after[k] != before[k] for k in LIMITS):
        raise SafeFailure('LIMIT_CHANGE_REFUSED')
    return result


def atomic_write(path, data):
    fd, name = tempfile.mkstemp(prefix='.edulab-write-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load_key(metadata):
    path = Path(json.loads(metadata.read_text())['key'])
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o600 or s.st_uid != os.getuid():
        raise SafeFailure('CREDENTIAL_FILE_PERMISSIONS')
    if stat.S_IMODE(path.parent.stat().st_mode) != 0o700 or s.st_size > 4096:
        raise SafeFailure('CREDENTIAL_DIRECTORY_PERMISSIONS')
    return path, path.read_text().strip()


def command(args, timeout=60):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise SafeFailure('REMOTE_COMMAND_FAILED')
    return result.stdout.strip()


def node_json(source):
    return json.loads(command(COMPOSE + ['exec', '-T', 'tutor', 'node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], timeout=40))


def health(url='http://127.0.0.1:8788/api/health'):
    with urllib.request.urlopen(url, timeout=3) as response:
        return json.loads(response.read(65536))


def wait_health():
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            return health()
        except Exception:
            time.sleep(1)
    raise SafeFailure('SERVICE_NOT_READY')


def remote_main():
    stage = 'preflight'
    backup_dir = None
    original = None
    env_path = ROOT / 'services/tutor/.env'
    rollback_image = None
    mutated = False
    before_health = None
    result = {'status': 'failed', 'paidGenerationCalls': 0}
    try:
        import fcntl
        lock = os.open('/run/edulab-minimax-deploy.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload = sys.stdin.buffer.read(16385)
        if len(payload) > 16384:
            raise SafeFailure('INPUT_TOO_LARGE')
        keys = json.loads(payload)
        valid_keys(keys)
        s = env_path.lstat()
        if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o600:
            raise SafeFailure('SERVER_ENV_PERMISSIONS')
        original = env_path.read_bytes()
        replacement = updated_env(original.decode(), keys).encode()
        before_health = health()
        before = node_json(COUNTS_CHECK)
        if before['busy'] != 0 or before['tasks'] != 1:
            raise SafeFailure('TASK_STATE_REQUIRES_REVIEW')
        if command(['git', 'branch', '--show-current']) != BRANCH:
            raise SafeFailure('SERVER_BRANCH_REQUIRES_REVIEW')
        command(['git', 'diff', '--quiet'])
        command(['git', 'diff', '--cached', '--quiet'])
        stage = 'source'
        command(['git', 'fetch', '--no-tags', 'origin', BRANCH], timeout=60)
        current = command(['git', 'rev-parse', 'HEAD'])
        command(['git', 'merge-base', '--is-ancestor', current, TARGET])
        command(['git', 'merge', '--ff-only', TARGET])
        if command(['git', 'rev-parse', 'HEAD']) != TARGET:
            raise SafeFailure('UNEXPECTED_SERVER_REVISION')
        container = command(COMPOSE + ['ps', '--quiet', 'tutor'])
        if not container or '\n' in container:
            raise SafeFailure('CONTAINER_REQUIRES_REVIEW')
        old_image = command(['docker', 'inspect', '--format', '{{.Image}}', container])
        rollback_image = 'edulab-tutor:before-minimax-' + str(time.time_ns())
        command(['docker', 'tag', old_image, rollback_image])
        stage = 'build'
        command(COMPOSE + ['build', 'tutor'], timeout=600)
        if env_path.read_bytes() != original or node_json(COUNTS_CHECK) != before or health().get('stopped') != before_health.get('stopped'):
            raise SafeFailure('STATE_CHANGED_DURING_BUILD')
        backup_dir = Path(tempfile.mkdtemp(prefix='edulab-minimax-rollback-', dir='/run'))
        atomic_write(backup_dir / 'env', original)
        stage = 'configure'
        atomic_write(env_path, replacement)
        mutated = True
        command(COMPOSE + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'tutor'], timeout=90)
        wait_health()
        stage = 'verify'
        config = node_json(CONFIG_CHECK)
        expected = {'provider': 'minimax', 'model': 'MiniMax-M3.1-Flash', 'ttsProvider': 'minimax',
                    'ttsModel': 'speech-2.8-hd', 'configured': True, 'languageKeyConfigured': True,
                    'voiceKeyConfigured': True, 'liveEnabled': False, 'limit': 1, 'day': 1000, 'job': 1000}
        if config != expected:
            raise SafeFailure('CONFIG_CHECK_FAILED')
        auth = node_json(AUTH_CHECK)
        if auth != {'language': True, 'voice': True}:
            raise SafeFailure('PROVIDER_AUTH_FAILED')
        if not before_health.get('stopped', True):
            command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
        after_health = health()
        after = node_json(COUNTS_CHECK)
        if after != before or after_health.get('liveEnabled') is not False or after_health.get('stopped') != before_health.get('stopped'):
            raise SafeFailure('STATE_CHECK_FAILED')
        public = health('https://pt.yokily.com/api/health')
        if public.get('liveEnabled') is not False or public.get('sampleAvailable') is not True:
            raise SafeFailure('PUBLIC_HEALTH_CHECK_FAILED')
        shutil.rmtree(backup_dir, ignore_errors=True)
        if backup_dir.exists():
            result['privateRecoveryDirectory'] = str(backup_dir)
        else:
            backup_dir = None
        result.update(status='deployed_live_off', revision=TARGET, config=config, counters=after,
                      publicHealth=True, credentialsInstalled=True, limitsPreserved=True)
    except Exception as error:
        result.update(status='failed', stage=stage, error=str(error) if isinstance(error, SafeFailure) else type(error).__name__)
        if mutated and original is not None and rollback_image and backup_dir:
            try:
                atomic_write(env_path, original)
                override = backup_dir / 'rollback.yml'
                override.write_text('services:\n  tutor:\n    image: ' + rollback_image + '\n')
                command(COMPOSE + ['-f', str(override), 'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'tutor'], timeout=90)
                wait_health()
                if before_health is not None and not before_health.get('stopped', True):
                    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
                result['rolledBack'] = True
                shutil.rmtree(backup_dir, ignore_errors=True)
                if not backup_dir.exists():
                    backup_dir = None
            except Exception:
                result['rolledBack'] = False
        if backup_dir is not None:
            result['privateRecoveryDirectory'] = str(backup_dir)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result['status'] == 'deployed_live_off' else 1


@contextmanager
def ssh_session():
    if not sys.stdin.isatty():
        raise SafeFailure('USER_TERMINAL_REQUIRED')
    directory = Path(tempfile.mkdtemp(prefix='edulab-ssh-', dir='/tmp'))
    control = directory / 'connection'
    started = False
    try:
        print('先完成一次 SSH 登录：如提示主机指纹，请核对后确认；如提示登录密码，输入服务器密码，输入时不显示字符。不要输入 MiniMax Key。', flush=True)
        args = ['ssh', '-M', '-S', str(control), '-o', 'ControlPersist=60',
                '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask',
                '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-fN', HOST]
        result = subprocess.run(args, timeout=120)
        if result.returncode:
            raise SafeFailure('SSH_LOGIN_FAILED')
        started = True
        yield control
    finally:
        if started or control.exists():
            try:
                subprocess.run(['ssh', '-S', str(control), '-o', 'BatchMode=yes', '-O', 'exit', HOST],
                               capture_output=True, text=True, timeout=10)
            except Exception:
                pass
        shutil.rmtree(directory, ignore_errors=True)


def transmit(source, keys, control=None):
    valid_keys(keys)
    encoded = base64.b64encode(source.encode()).decode()
    remote = 'python3 -c ' + shlex.quote('import base64;exec(compile(base64.b64decode(' + repr(encoded) + "),'<edulab-deploy>','exec'))") + ' --remote'
    args = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1']
    if control is not None:
        args += ['-S', str(control), '-o', 'ControlMaster=no']
    args += [HOST, remote]
    return subprocess.run(args, input=json.dumps(keys), capture_output=True, text=True, timeout=900)


def local_main():
    stage = 'credentials'
    try:
        loaded = {kind: load_key(meta) for kind, meta in METADATA.items()}
        keys = {kind: pair[1] for kind, pair in loaded.items()}
        valid_keys(keys)
        print('正在安全连接服务器并部署，通常需要几分钟。密钥不会显示；真实生成保持关闭。', flush=True)
        stage = 'ssh_auth'
        with ssh_session() as control:
            stage = 'ssh_deploy'
            completed = transmit(Path(__file__).read_text(), keys, control)
        if not completed.stdout.strip():
            result = {'status': 'failed', 'stage': 'ssh', 'error': 'SSH_CONNECTION_FAILED', 'paidGenerationCalls': 0}
        else:
            result = json.loads(completed.stdout)
        result['recordedAt'] = time.time()
        atomic_write(RECEIPT, (json.dumps(result, ensure_ascii=False) + '\n').encode())
        if completed.returncode == 0 and result.get('status') == 'deployed_live_off' and result.get('credentialsInstalled') is True and result.get('limitsPreserved') is True:
            for path, _ in loaded.values():
                path.unlink()
            print('部署完成：两个 Key 已写入服务器，本机临时密钥已清理。原预算和累计次数限制已保留，真实生成保持关闭。')
            print('请回到聊天回复「完成」。')
            return 0
        print('未完成部署，阶段：' + str(result.get('stage', 'unknown')) + '；原因：' + str(result.get('error', 'UNKNOWN')))
        if 'rolledBack' in result:
            print('已恢复原服务。' if result['rolledBack'] else '恢复原服务未完成，请保留终端并返回聊天。')
        print('本机密钥已保留。请回到聊天回复「未完成」，无需重新填写 Key。')
        return 1
    except Exception as error:
        code = str(error) if isinstance(error, SafeFailure) else type(error).__name__
        try:
            atomic_write(RECEIPT, (json.dumps({'status': 'failed', 'stage': stage, 'error': code,
                                             'paidGenerationCalls': 0, 'recordedAt': time.time()}) + '\n').encode())
        except Exception:
            pass
        print('未执行或未确认部署：' + code)
        print('请回到聊天说明结果；不要粘贴密钥。')
        return 1


if __name__ == '__main__':
    sys.exit(remote_main() if sys.argv[1:] == ['--remote'] else local_main())
