#!/usr/bin/env python3
"""Enable one fixed five-question allowance only after explicit budget confirmation.

No generation is submitted by this script. Existing history, keys and reservations
are preserved. The private checkpoint prevents a second invocation adding quota.
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
APPROVAL_FLAG = '--add-five-with-10-yuan-reserve'
PLAN = 'extra-five-10-yuan-20261024'
RECEIPT = Path('/tmp/edulab-minimax-allowance-result.json')
CHECKPOINT_DIR = Path('/var/lib/edulab-live-allowance')
COMPOSE = ['docker', 'compose', '-f', 'compose.tutor.yml', '-f', 'compose.tutor.public.yml', '-f', 'compose.tutor.host.yml']
BEFORE = {'tasks': 2, 'calls': 7, 'requests': 8, 'attempts': 2, 'busy': 0}
OLD_LIMITS = {'LIVE_TASK_LIMIT': '2', 'DAY_BUDGET_CENTS': '2000', 'JOB_BUDGET_CENTS': '1000'}
NEW_LIMITS = {'LIVE_TASK_LIMIT': '7', 'DAY_BUDGET_CENTS': '3000', 'JOB_BUDGET_CENTS': '200'}
PAYLOAD = {'additionalTasks': 5, 'additionalReserveCents': 1000}
CONFIG_CHECK = """import {configFromEnv} from './config.mjs';const c=configFromEnv();
console.log(JSON.stringify({provider:c.provider,model:c.aiModel,ttsProvider:c.ttsProvider,
ttsModel:c.ttsModel,configured:c.configured,liveEnabled:c.liveEnabled,
limit:c.liveTaskLimit,day:c.dayBudgetCents,job:c.jobBudgetCents}));"""
COUNTS_CHECK = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/tutor.sqlite',{readOnly:true});
const x=db.prepare("SELECT count(*) tasks,coalesce(sum(calls),0) calls,coalesce(sum(requests),0) requests,coalesce(sum(attempts),0) attempts FROM tasks WHERE mode='live'").get();
x.busy=db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued','running')").get().n;
db.close();console.log(JSON.stringify(x));"""
QUOTA_CHECK = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/tutor.sqlite',{readOnly:true});
const day=new Date().toISOString().slice(0,10);
const row=db.prepare("SELECT jobs,cost FROM daily WHERE day=?").get(day)||{jobs:0,cost:0};
db.close();console.log(JSON.stringify(row));"""

class SafeFailure(Exception):
    pass

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


def replacement_env(text):
    pairs = parse_env(text)
    if pairs.get('LIVE_ENABLED') != 'false' or any(pairs.get(k) != v for k, v in OLD_LIMITS.items()):
        raise SafeFailure('LIMITS_CHANGED_REQUIRES_REVIEW')
    if pairs.get('AI_PROVIDER') != 'minimax' or pairs.get('TTS_PROVIDER') != 'minimax':
        raise SafeFailure('PROVIDER_CHANGED_REQUIRES_REVIEW')
    if not pairs.get('MINIMAX_API_KEY') or not pairs.get('MINIMAX_TTS_API_KEY'):
        raise SafeFailure('SERVER_CREDENTIALS_MISSING')
    pending = {**NEW_LIMITS, 'LIVE_ENABLED': 'true'}
    lines = []
    for line in text.splitlines():
        key = line.split('=', 1)[0].strip()
        lines.append(key + '=' + pending.pop(key) if key in pending else line)
    lines.extend(k + '=' + v for k, v in pending.items())
    return '\n'.join(lines) + '\n'


def expected_config(live, limits):
    return {'provider': 'minimax', 'model': 'MiniMax-M3.1-Flash',
            'ttsProvider': 'minimax', 'ttsModel': 'speech-2.8-hd',
            'configured': True, 'liveEnabled': live,
            'limit': int(limits['LIVE_TASK_LIMIT']), 'day': int(limits['DAY_BUDGET_CENTS']),
            'job': int(limits['JOB_BUDGET_CENTS'])}


def recreate():
    command(COMPOSE + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'tutor'], timeout=90)
    wait_health()


def remote_main():
    import fcntl
    result = {'status': 'failed', 'plan': PLAN, 'generationSubmissions': 0}
    stage, lock, owned_checkpoint = 'preflight', None, False
    mutated, paused, original = False, False, None
    env_path = ROOT / 'services/tutor/.env'
    checkpoint = CHECKPOINT_DIR / (PLAN + '.json')
    try:
        payload = sys.stdin.buffer.read(4097)
        if len(payload) > 4096 or json.loads(payload) != PAYLOAD:
            raise SafeFailure('EXPLICIT_FIVE_TASK_TEN_YUAN_PLAN_REQUIRED')
        lock = os.open('/run/edulab-minimax-deploy.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        CHECKPOINT_DIR.mkdir(mode=0o700, exist_ok=True)
        directory = CHECKPOINT_DIR.lstat()
        if not stat.S_ISDIR(directory.st_mode) or stat.S_IMODE(directory.st_mode) != 0o700 or directory.st_uid != os.getuid():
            raise SafeFailure('CHECKPOINT_DIRECTORY_PERMISSIONS')
        if checkpoint.exists() or checkpoint.is_symlink():
            saved = checkpoint.lstat()
            if not stat.S_ISREG(saved.st_mode) or stat.S_IMODE(saved.st_mode) != 0o600:
                raise SafeFailure('CHECKPOINT_FILE_PERMISSIONS')
            previous = json.loads(checkpoint.read_text())
            if previous.get('status') == 'started' or previous.get('plan') != PLAN:
                raise SafeFailure('ALREADY_STARTED_NO_QUOTA_REFILL')
            previous['alreadyApplied'] = True
            # Return historical result plus current health; never add or renew allowance.
            previous['currentHealth'] = health()
            print(json.dumps(previous, ensure_ascii=False), flush=True)
            return 0 if previous.get('status') == 'enabled_bounded' else 1
        env_stat = env_path.lstat()
        if not stat.S_ISREG(env_stat.st_mode) or stat.S_IMODE(env_stat.st_mode) != 0o600:
            raise SafeFailure('SERVER_ENV_PERMISSIONS')
        original = env_path.read_bytes()
        replacement = replacement_env(original.decode()).encode()
        if health().get('stopped') is not False or node_json(COUNTS_CHECK) != BEFORE:
            raise SafeFailure('TASK_STATE_CHANGED_REQUIRES_REVIEW')
        quota = node_json(QUOTA_CHECK)
        if quota['jobs'] >= 20 or quota['cost'] > 2000:
            raise SafeFailure('DAILY_QUOTA_REQUIRES_REVIEW')
        if command(['git', 'rev-parse', 'HEAD']) != TARGET or node_json(CONFIG_CHECK) != expected_config(False, OLD_LIMITS):
            raise SafeFailure('RUNNING_APPLICATION_CHANGED')
        fd = os.open(checkpoint, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'status': 'started', 'plan': PLAN, 'startedAt': time.time()}, out)
            out.flush()
            os.fsync(out.fileno())
        owned_checkpoint = True
        stage = 'configure'
        command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
        paused = True
        if env_path.read_bytes() != original or node_json(COUNTS_CHECK) != BEFORE:
            raise SafeFailure('STATE_CHANGED_BEFORE_ENABLE')
        atomic_write(env_path, replacement)
        mutated = True
        recreate()
        if node_json(CONFIG_CHECK) != expected_config(True, NEW_LIMITS) or node_json(COUNTS_CHECK) != BEFORE:
            raise SafeFailure('CONFIGURATION_NOT_VERIFIED')
        paused_health = health()
        if paused_health.get('stopped') is not True or paused_health.get('liveEnabled') is not False:
            raise SafeFailure('SERVICE_MUST_STAY_PAUSED_DURING_CHECKS')
        # This is the first point at which paid tasks can be admitted.
        stage = 'enable'
        command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
        current = health()
        counts = node_json(COUNTS_CHECK)
        public = health('https://pt.yokily.com/api/health')
        if current.get('stopped') is not False or public.get('stopped') is not False or public.get('sampleAvailable') is not True:
            raise SafeFailure('PUBLIC_SERVICE_CHECK_FAILED')
        if not 2 <= counts['tasks'] <= 7 or counts['calls'] < BEFORE['calls'] or counts['requests'] < BEFORE['requests'] or counts['attempts'] < BEFORE['attempts']:
            raise SafeFailure('HISTORY_CHECK_FAILED')
        if counts['tasks'] < 7 and (current.get('liveEnabled') is not True or public.get('liveEnabled') is not True):
            raise SafeFailure('LIVE_SERVICE_NOT_ENABLED')
        result.update(status='enabled_bounded', limits=NEW_LIMITS, additionalTasks=5,
                      additionalReserveCents=1000, remaining=max(0, 7-counts['tasks']),
                      counters=counts, publicHealth=public)
    except Exception as error:
        result.update(status='failed', stage=stage,
                      error=str(error) if isinstance(error, SafeFailure) else type(error).__name__)
        if mutated and original is not None:
            try:
                # Disable further admission before restoring the previous configuration.
                command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
                if env_path.read_bytes() != replacement:
                    raise SafeFailure('CONFIG_CHANGED_SERVICE_PAUSED')
                atomic_write(env_path, original)
                recreate()
                if node_json(CONFIG_CHECK) != expected_config(False, OLD_LIMITS):
                    raise SafeFailure('ROLLBACK_CHECK_FAILED')
                command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
                result['rolledBack'] = True
            except Exception:
                result['rolledBack'] = False
                try:
                    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
                except Exception:
                    pass
        elif paused and original is not None:
            try:
                if env_path.read_bytes() == original:
                    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
            except Exception:
                pass
    finally:
        if owned_checkpoint:
            result['recordedAt'] = time.time()
            atomic_write(checkpoint, (json.dumps(result, ensure_ascii=False)+'\n').encode())
        if lock is not None:
            os.close(lock)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result['status'] == 'enabled_bounded' else 1


def transmit(source, control):
    encoded = base64.b64encode(source.encode()).decode()
    remote = 'python3 -c ' + shlex.quote('import base64;exec(compile(base64.b64decode(' + repr(encoded) + "),'<edulab-allowance>','exec'))") + ' --remote'
    args = ['ssh', '-T', '-S', str(control), '-o', 'ControlMaster=no',
            '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', HOST, remote]
    return subprocess.run(args, input=json.dumps(PAYLOAD), capture_output=True, text=True, timeout=360)


def local_main():
    if sys.argv[1:] != [APPROVAL_FLAG]:
        print('未执行。此方案会新增5题，合计预算预留10元；需要明确确认参数。')
        return 1
    try:
        print('按已确认方案恢复：新增5题，每题预留2元，合计新增预留10元。按实际用量计费，用完停止新增；不充值，不提交测试题。', flush=True)
        with ssh_session() as control:
            completed = transmit(Path(__file__).read_text(), control)
        if not completed.stdout.strip():
            raise SafeFailure('SSH_RESULT_UNKNOWN_NO_AUTOMATIC_RETRY')
        result = json.loads(completed.stdout)
        atomic_write(RECEIPT, (json.dumps(result, ensure_ascii=False)+'\n').encode())
        print('EDULAB_ALLOWANCE_RESULT='+json.dumps(result, ensure_ascii=False), flush=True)
        if result.get('alreadyApplied'):
            print('此方案已处理，本次仅查询，没有补充或重置次数。请参考 currentHealth 中的当前状态。')
        elif completed.returncode == 0 and result.get('status') == 'enabled_bounded':
            print('已恢复真实拍题，最多新增5题。请刷新 https://pt.yokily.com 后使用。')
        else:
            print('未确认恢复，请把上面 EDULAB_ALLOWANCE_RESULT 一行发回聊天。不要重新填写Key。')
        return completed.returncode
    except Exception as error:
        code = str(error) if isinstance(error, SafeFailure) else type(error).__name__
        print('未确认恢复：'+code+'。请回到聊天说明结果。')
        return 1


if __name__ == '__main__':
    sys.exit(remote_main() if sys.argv[1:] == ['--remote'] else local_main())
