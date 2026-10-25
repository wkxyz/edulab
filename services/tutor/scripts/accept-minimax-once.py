#!/usr/bin/env python3
"""Exactly one separately authorized MiniMax acceptance; no retries or new keys.

Authorization: 2026-10-24, one additional question, CNY10 reservation per job,
cumulative limit 2 and daily reservation CNY20. Historical records are preserved.
This script does not buy credits or add an ongoing generation allowance.
"""
import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

HOST = 'root@43.173.94.201'
ROOT = Path('/opt/edulab')
TARGET = '9828eed4e4d489984990fdb7264fe7d499df25b1'
AUTHORIZATION = 'minimax-acceptance-20261024-extra1'
APPROVAL_FLAG = '--approved-extra-one-20261024'
RECEIPT = Path('/tmp/edulab-minimax-acceptance-result.json')
CHECKPOINT_DIR = Path('/var/lib/edulab-minimax-acceptance')
COMPOSE = ['docker', 'compose', '-f', 'compose.tutor.yml', '-f', 'compose.tutor.public.yml', '-f', 'compose.tutor.host.yml']
BEFORE = {'tasks': 1, 'calls': 1, 'requests': 2, 'attempts': 1, 'busy': 0}
OLD_LIMITS = {'LIVE_TASK_LIMIT': '1', 'DAY_BUDGET_CENTS': '1000', 'JOB_BUDGET_CENTS': '1000'}
NEW_LIMITS = {'LIVE_TASK_LIMIT': '2', 'DAY_BUDGET_CENTS': '2000', 'JOB_BUDGET_CENTS': '1000'}
CONFIG_CHECK = """import {configFromEnv} from './config.mjs';const c=configFromEnv();
console.log(JSON.stringify({provider:c.provider,model:c.aiModel,ttsProvider:c.ttsProvider,
ttsModel:c.ttsModel,configured:c.configured,liveEnabled:c.liveEnabled,
limit:c.liveTaskLimit,day:c.dayBudgetCents,job:c.jobBudgetCents}));"""
COUNTS_CHECK = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/tutor.sqlite',{readOnly:true});
const x=db.prepare("SELECT count(*) tasks,coalesce(sum(calls),0) calls,coalesce(sum(requests),0) requests,coalesce(sum(attempts),0) attempts FROM tasks WHERE mode='live'").get();
x.busy=db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued','running')").get().n;
db.close();console.log(JSON.stringify(x));"""
TASK_CHECK = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/tutor.sqlite',{readOnly:true});
const rows=db.prepare("SELECT id,status,error,attempts,calls,requests,reserve FROM tasks WHERE mode='live' AND idem='minimax-acceptance-20261024-extra1'").all();
db.close();console.log(JSON.stringify(rows));"""

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
        print('正在连接已配置的服务器；不会要求填写 MiniMax Key。', flush=True)
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


FLOW = r'''import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const base='http://127.0.0.1:8788',publicBase='https://pt.yokily.com';
const idem='minimax-acceptance-20261024-extra1';
let browser,task,token;const out={status:'failed',submissionAttempts:0};
const check=(ok,code)=>{if(!ok)throw Error(code);};
async function api(route,options={}){
 const r=await fetch(base+route,{...options,redirect:'error',signal:AbortSignal.timeout(12000),
 headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...options.headers}});
 const x=await r.json();check(r.ok,'TASK_API_FAILED');return x;
}
try{
 const {chromium}=await import('playwright');browser=await chromium.launch({headless:true});
 const fixturePage=await browser.newPage({viewport:{width:800,height:300}});
 await fixturePage.setContent('<html><body style="margin:0;background:white"><div style="font:64px Arial,sans-serif;padding:100px 130px;color:black">3x - 7 = 8</div></body></html>');
 const image='data:image/png;base64,'+(await fixturePage.screenshot({type:'png'})).toString('base64');
 await fixturePage.close();
 ({token}=await api('/api/session',{method:'POST',body:'{}'}));
 check(/^[a-f0-9]{64}$/.test(token),'INVALID_SESSION');
 out.submissionAttempts=1;
 task=await api('/api/tasks',{method:'POST',headers:{'idempotency-key':idem},
 body:JSON.stringify({image,text:'请解图片中的方程，并用中文讲解。',style:'whiteboard',delivery:'video',exportVideo:true})});
 check(/^[a-f0-9-]{36}$/.test(task.id),'INVALID_TASK_ID');out.taskId=task.id;
 const deadline=Date.now()+335000;
 while(['queued','running'].includes(task.status)&&Date.now()<deadline){
  await new Promise(r=>setTimeout(r,2000));task=await api('/api/tasks/'+task.id);
 }
 out.taskStatus=task.status;
 check(task.status==='completed','TASK_'+String(task.error||task.status).replace(/[^A-Z0-9_]/gi,'_').toUpperCase());
 out.answer=task.result?.answer;
 const normalized=String(out.answer||'').replace(/[\\{}$\s]/g,'');
 check(/x=5(?![\d.])/i.test(normalized),'ANSWER_MISMATCH');
 const original=String(task.result?.problem||'').replace(/[\\{}$\s]/g,'').replaceAll('−','-');
 check(original.includes('3x-7=8'),'QUESTION_MISMATCH');
 const video=path.join('/data/jobs',task.id,'video.mp4');
 const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',video],{encoding:'utf8',timeout:15000});
 check(probe.status===0,'MEDIA_PROBE_FAILED');const info=JSON.parse(probe.stdout);
 const visual=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.find(s=>s.codec_type==='audio');
 check(visual?.width===1280&&visual?.height===720&&!!audio,'MEDIA_TRACKS_FAILED');
 const seconds=Number(info.format.duration);check(seconds>1&&seconds<=245,'MEDIA_DURATION_FAILED');
 const volume=spawnSync('ffmpeg',['-hide_banner','-i',video,'-vn','-af','volumedetect','-f','null','-'],{encoding:'utf8',timeout:20000});
 const peak=/max_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr||'');
 check(volume.status===0&&peak&&Number(peak[1])>-45,'AUDIO_EMPTY');
 const errors=[];const page=await browser.newPage({viewport:{width:390,height:844}});
 page.on('pageerror',()=>errors.push('PAGE_ERROR'));
 await page.addInitScript(value=>{if(location.hostname==='pt.yokily.com')localStorage.setItem('tutor-token',value);},token);
 await page.goto(publicBase+'/#task/'+task.id,{waitUntil:'domcontentloaded',timeout:20000});
 await page.locator('video').waitFor({timeout:20000});
 await page.locator('video').evaluate(v=>v.play());await page.waitForTimeout(1200);
 const playback=await page.locator('video').evaluate(v=>({duration:v.duration,currentTime:v.currentTime,width:v.videoWidth,height:v.videoHeight,error:!!v.error}));
 check(playback.currentTime>.3&&!playback.error&&playback.width===1280&&playback.height===720,'PLAYBACK_FAILED');
 await page.locator('video').evaluate(v=>v.pause());
 await page.reload({waitUntil:'domcontentloaded'});await page.locator('video').waitFor();
 check(errors.length===0,'PAGE_SCRIPT_FAILED');
 check(typeof task.result.video==='string'&&task.result.video.startsWith('/api/media/'+task.id+'/video.mp4?token='),'MEDIA_URL_FAILED');
 const range=await fetch(publicBase+task.result.video,{headers:{range:'bytes=0-1023'},redirect:'error',signal:AbortSignal.timeout(10000)});
 check(range.status===206&&(await range.arrayBuffer()).byteLength===1024,'MEDIA_RANGE_FAILED');
 out.status='passed';out.duration=seconds;out.audioPresent=true;out.audioNonSilent=true;
 out.playback=playback;out.httpRange=206;out.consoleErrors=errors.length;
 out.videoUrl=publicBase+task.result.video;
}catch(e){
 const message=String(e?.message||'');
 out.error=/^[A-Z][A-Z0-9_]{0,100}$/.test(message)?message:'VERIFICATION_FAILED';
}finally{
 if(browser)try{await browser.close();}catch{out.browserCloseFailed=true;out.status='failed';out.error='BROWSER_CLOSE_FAILED';}
}
console.log(JSON.stringify(out));
'''

def change_env(text, expected, live):
    before = parse_env(text)
    if any(before.get(k) != v for k, v in expected.items()):
        raise SafeFailure('LIMITS_CHANGED_REQUIRES_REVIEW')
    if before.get('AI_PROVIDER') != 'minimax' or before.get('TTS_PROVIDER') != 'minimax':
        raise SafeFailure('PROVIDER_CHANGED_REQUIRES_REVIEW')
    if not before.get('MINIMAX_API_KEY') or not before.get('MINIMAX_TTS_API_KEY'):
        raise SafeFailure('SERVER_CREDENTIALS_MISSING')
    changes = {**NEW_LIMITS, 'LIVE_ENABLED': 'true' if live else 'false'}
    pending = dict(changes)
    lines = []
    for line in text.splitlines():
        key = line.split('=', 1)[0].strip()
        lines.append(key + '=' + pending.pop(key) if key in pending else line)
    lines.extend(k + '=' + v for k, v in pending.items())
    return '\n'.join(lines) + '\n'


def check_config(live, limits):
    expected = {'provider': 'minimax', 'model': 'MiniMax-M3.1-Flash',
                'ttsProvider': 'minimax', 'ttsModel': 'speech-2.8-hd',
                'configured': True, 'liveEnabled': live,
                'limit': int(limits['LIVE_TASK_LIMIT']),
                'day': int(limits['DAY_BUDGET_CENTS']),
                'job': int(limits['JOB_BUDGET_CENTS'])}
    if node_json(CONFIG_CHECK) != expected:
        raise SafeFailure('CONFIG_CHECK_FAILED')


def recreate():
    command(COMPOSE + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'tutor'], timeout=90)
    wait_health()


def run_flow():
    args = COMPOSE + ['exec', '-T', 'tutor', 'node', '--disable-warning=ExperimentalWarning',
                      '--input-type=module', '-e', FLOW]
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=420)
    data = json.loads(result.stdout)
    if result.returncode != 0 or data.get('status') not in ('passed', 'failed') or data.get('submissionAttempts') not in (0, 1):
        raise SafeFailure('INVALID_ACCEPTANCE_RESULT')
    return data


def close_generation(env_path, active_bytes):
    # Compare-and-swap prevents overwriting a separate administrator's config.
    if env_path.read_bytes() != active_bytes:
        command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
        raise SafeFailure('CONFIG_CHANGED_SERVICE_PAUSED')
    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
    atomic_write(env_path, change_env(active_bytes.decode(), NEW_LIMITS, False).encode())
    recreate()
    check_config(False, NEW_LIMITS)
    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
    state = health()
    if state.get('liveEnabled') is not False or state.get('stopped') is not False:
        raise SafeFailure('LIVE_OFF_CHECK_FAILED')
    if node_json(COUNTS_CHECK)['busy'] != 0:
        raise SafeFailure('BUSY_AFTER_CLEANUP')
    public = health('https://pt.yokily.com/api/health')
    if public.get('liveEnabled') is not False or public.get('sampleAvailable') is not True or public.get('stopped') is not False:
        raise SafeFailure('PUBLIC_HEALTH_CHECK_FAILED')


def remote_main():
    import fcntl
    stage, mutated, checkpoint, active, lock = 'preflight', False, None, None, None
    env_path = ROOT / 'services/tutor/.env'
    result = {'status': 'failed', 'authorization': AUTHORIZATION, 'submissionAttempts': 0}
    try:
        lock = os.open('/run/edulab-minimax-deploy.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        CHECKPOINT_DIR.mkdir(mode=0o700, exist_ok=True)
        s = CHECKPOINT_DIR.lstat()
        if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o700 or s.st_uid != os.getuid():
            raise SafeFailure('CHECKPOINT_DIRECTORY_PERMISSIONS')
        checkpoint = CHECKPOINT_DIR / (AUTHORIZATION + '.json')
        if checkpoint.exists() or checkpoint.is_symlink():
            s = checkpoint.lstat()
            if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o600:
                raise SafeFailure('CHECKPOINT_FILE_PERMISSIONS')
            previous = json.loads(checkpoint.read_text())
            if previous.get('authorization') != AUTHORIZATION or previous.get('status') == 'started':
                raise SafeFailure('ALREADY_STARTED_NO_RESUBMISSION')
            # Read an existing receipt only. Never re-enable or resubmit.
            previous['alreadyExecuted'] = True
            print(json.dumps(previous, ensure_ascii=False), flush=True)
            return 0 if previous.get('status') == 'passed_live_off' else 1
        s = env_path.lstat()
        if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o600:
            raise SafeFailure('SERVER_ENV_PERMISSIONS')
        original = env_path.read_bytes()
        parsed = parse_env(original.decode())
        if parsed.get('LIVE_ENABLED') != 'false':
            raise SafeFailure('LIVE_MUST_ALREADY_BE_OFF')
        active = change_env(original.decode(), OLD_LIMITS, True).encode()
        if node_json(COUNTS_CHECK) != BEFORE or health().get('stopped') is not False:
            raise SafeFailure('TASK_STATE_REQUIRES_REVIEW')
        if command(['git', 'rev-parse', 'HEAD']) != TARGET:
            raise SafeFailure('SERVER_REVISION_CHANGED')
        check_config(False, OLD_LIMITS)
        # Persist the authorization before any mutation; a second invocation cannot run again.
        fd = os.open(checkpoint, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'status': 'started', 'authorization': AUTHORIZATION, 'startedAt': time.time()}, out)
            out.flush()
            os.fsync(out.fileno())
        stage = 'configure'
        command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
        if env_path.read_bytes() != original or node_json(COUNTS_CHECK) != BEFORE:
            raise SafeFailure('STATE_CHANGED_BEFORE_ENABLE')
        atomic_write(env_path, active)
        mutated = True
        recreate()
        check_config(True, NEW_LIMITS)
        if node_json(COUNTS_CHECK) != BEFORE:
            raise SafeFailure('COUNTERS_CHANGED_BEFORE_TEST')
        command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
        stage = 'single_acceptance'
        result.update(run_flow())
        if result['status'] != 'passed':
            raise SafeFailure(result.get('error', 'ACCEPTANCE_FAILED'))
        stage = 'accounting'
        rows = node_json(TASK_CHECK)
        counts = node_json(COUNTS_CHECK)
        if len(rows) != 1 or rows[0]['id'] != result.get('taskId') or rows[0]['status'] != 'completed':
            raise SafeFailure('ACCEPTANCE_TASK_CHECK_FAILED')
        task = rows[0]
        if not (task['attempts'] == 1 and task['reserve'] == 1000 and 3 <= task['calls'] <= 14 and task['requests'] == task['calls']):
            raise SafeFailure('TASK_ACCOUNTING_CHECK_FAILED')
        expected = {**BEFORE, 'tasks': 2, 'calls': BEFORE['calls'] + task['calls'],
                    'requests': BEFORE['requests'] + task['requests'], 'attempts': 2}
        if counts != expected:
            raise SafeFailure('HISTORY_COUNTERS_CHANGED')
        result.update(status='passed_live_off', task=task, counters=counts)
    except BaseException as error:
        result.update(status='failed', stage=stage,
                      error=str(error) if isinstance(error, SafeFailure) else type(error).__name__)
    finally:
        if mutated:
            try:
                close_generation(env_path, active)
                result['liveDisabled'] = True
                result['limits'] = NEW_LIMITS
                result['counters'] = node_json(COUNTS_CHECK)
                rows = node_json(TASK_CHECK)
                if len(rows) == 1:
                    result['task'] = rows[0]
                    result['taskId'] = rows[0]['id']
            except BaseException as error:
                result.update(status='failed', liveDisabled=False,
                              cleanupError=str(error) if isinstance(error, SafeFailure) else type(error).__name__)
                # Best effort emergency stop; do not resume if cleanup was not verified.
                try:
                    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'stop'])
                except Exception:
                    pass
        elif checkpoint is not None and stage != 'preflight':
            # A stop may have happened before the env write. Restore samples only when live is off.
            try:
                if env_path.exists() and parse_env(env_path.read_text()).get('LIVE_ENABLED') == 'false':
                    command(COMPOSE + ['exec', '-T', 'tutor', 'node', 'control.mjs', 'resume'])
            except Exception:
                pass
        if checkpoint is not None and stage != 'preflight':
            result['recordedAt'] = time.time()
            atomic_write(checkpoint, (json.dumps(result, ensure_ascii=False) + '\n').encode())
        if lock is not None:
            os.close(lock)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result['status'] == 'passed_live_off' else 1


def transmit(source, control):
    encoded = base64.b64encode(source.encode()).decode()
    remote = 'python3 -c ' + shlex.quote('import base64;exec(compile(base64.b64decode(' + repr(encoded) + "),'<edulab-acceptance>','exec'))") + ' --remote'
    args = ['ssh', '-T', '-S', str(control), '-o', 'ControlMaster=no',
            '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', HOST, remote]
    return subprocess.run(args, capture_output=True, text=True, timeout=800)


def local_main():
    if sys.argv[1:] != [APPROVAL_FLAG]:
        print('本脚本只用于已确认的新增1题验收；未提供对应参数，不执行。')
        return 1
    try:
        print('开始新增1题验收，单题预算预留10元，失败不重试；结束后自动关闭真实生成。通常需要几分钟。', flush=True)
        with ssh_session() as control:
            completed = transmit(Path(__file__).read_text(), control)
        if not completed.stdout.strip():
            raise SafeFailure('SSH_RESULT_UNKNOWN_DO_NOT_RESUBMIT')
        result = json.loads(completed.stdout)
        atomic_write(RECEIPT, (json.dumps(result, ensure_ascii=False) + '\n').encode())
        print('EDULAB_ACCEPTANCE_RESULT=' + json.dumps(result, ensure_ascii=False), flush=True)
        if result.get('alreadyExecuted'):
            print('本次授权已执行，本次仅查询结果，没有重新提交。')
        if completed.returncode == 0 and result.get('status') == 'passed_live_off' and result.get('liveDisabled') is True:
            print('真实视频验收通过，真实生成已关闭。')
            if result.get('videoUrl'):
                print('本题视频：' + result['videoUrl'])
            return 0
        print('验收未通过或尚未确认关闭状态；未重试。请把上面 EDULAB_ACCEPTANCE_RESULT 一行发回聊天。')
        return 1
    except Exception as error:
        code = str(error) if isinstance(error, SafeFailure) else type(error).__name__
        print('未完成确认：' + code + '。不要重新提交题目，请回到聊天说明结果。')
        return 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--remote']:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        def interrupted(signum, frame):
            raise SafeFailure('INTERRUPTED')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        sys.exit(remote_main())
    sys.exit(local_main())
