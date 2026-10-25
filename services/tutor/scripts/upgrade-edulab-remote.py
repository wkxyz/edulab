#!/usr/bin/env python3
"""Upgrade the six-capability tutor from a user Mac without changing its allowance.

Usage: python3 upgrade-edulab-remote.py --revision <40-hex Git commit>
The public Tutor checks workflow must have succeeded for that exact commit.
No generation endpoints or provider APIs are called. Environment bytes are never
written, and rollback restores the actual previous running image, not Git HEAD.
Git can remain at the new revision after an image rollback; no git reset is used.
This file is standalone when copied to /tmp; it imports no companion utilities.
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
import urllib.parse
import urllib.request

HOST = 'root@43.173.94.201'
ROOT = Path('/opt/edulab')
BRANCH = 'main'
REPOSITORY = 'wkxyz/edulab'
WORKFLOW = '.github/workflows/tutor-check.yml'
RECEIPT = Path('/tmp/edulab-upgrade-result.json')
LOCAL_HEALTH = 'http://127.0.0.1:8788/api/health'
PUBLIC_HEALTH = 'https://pt.yokily.com/api/health'
COMPOSE = ['docker', 'compose', '-f', 'compose.tutor.yml', '-f', 'compose.tutor.public.yml', '-f', 'compose.tutor.host.yml']
DEFAULT_IMAGE = 'edulab-tutor:latest'
CAPABILITIES = ('solid-geometry', 'analytic-geometry', 'chem-reaction', 'math-video', 'physics-video', 'chem-video')
CONFIG_CHECK = """import {configFromEnv} from './config.mjs';
const c=configFromEnv();console.log(JSON.stringify({provider:c.provider,model:c.aiModel,
ttsProvider:c.ttsProvider,ttsModel:c.ttsModel||null,ttsVoice:c.ttsVoice||null,
reasoningEffort:c.reasoningEffort||null,configured:c.configured,
languageKeyConfigured:!!c.aiKey,voiceKeyConfigured:!!c.ttsKey,adminConfigured:!!c.adminToken,
liveEnabled:c.liveEnabled,limit:c.liveTaskLimit,day:c.dayBudgetCents,job:c.jobBudgetCents,
host:c.host,port:c.port,dataDir:c.dataDir}));"""
COUNTS_CHECK = """import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';import {configFromEnv} from './config.mjs';
import path from 'node:path';
const db=new DatabaseSync(path.join(configFromEnv().dataDir,'tutor.sqlite'),{readOnly:true});
db.exec('PRAGMA busy_timeout=5000;BEGIN');
const tasks=db.prepare('SELECT id,mode,status,attempts,calls,requests,reserve FROM tasks ORDER BY id').all();
const daily=db.prepare('SELECT day,jobs,calls,cost FROM daily ORDER BY day').all();
const owners=db.prepare('SELECT owner,day,jobs FROM owner_daily ORDER BY owner,day').all();
const sum=(rows,key)=>rows.reduce((n,r)=>n+r[key],0);
const x={tasks:tasks.length,liveTasks:tasks.filter(t=>t.mode==='live').length,
calls:sum(tasks,'calls'),requests:sum(tasks,'requests'),attempts:sum(tasks,'attempts'),
reservedCents:sum(tasks,'reserve'),busy:tasks.filter(t=>['queued','running'].includes(t.status)).length,
dailyJobs:sum(daily,'jobs'),dailyCalls:sum(daily,'calls'),dailyCost:sum(daily,'cost'),ownerJobs:sum(owners,'jobs'),
fingerprint:createHash('sha256').update(JSON.stringify({tasks,daily,owners})).digest('hex')};
db.exec('COMMIT');db.close();console.log(JSON.stringify(x));"""
RECOVERY_CHECK = (COUNTS_CHECK
    .replace("import {configFromEnv} from './config.mjs';",'')
    .replace("path.join(configFromEnv().dataDir,'tutor.sqlite')","'/data/tutor.sqlite'")
    .replace("db.exec('COMMIT');db.close();console.log(JSON.stringify(x));",
             "const stopped=db.prepare(\"SELECT value FROM settings WHERE key='stopped'\").get()?.value;"
             "if(!['0','1'].includes(stopped))throw Error('STATE');"
             "db.exec('COMMIT');db.close();console.log(JSON.stringify({counts:x,stopped:stopped==='1'}));"))
COUNT_FIELDS = ('tasks','liveTasks','calls','requests','attempts','reservedCents','busy','dailyJobs','dailyCalls','dailyCost','ownerJobs')
ERRORS = frozenset(('REVISION_REQUIRED','INVALID_REVISION','INVALID_PAYLOAD','CI_NOT_VERIFIED',
    'CI_REQUEST_FAILED','USER_TERMINAL_REQUIRED','SSH_LOGIN_FAILED','SSH_CONNECTION_FAILED',
    'REMOTE_COMMAND_FAILED','UPGRADE_LOCKED','SERVER_ENV_PERMISSIONS','SERVER_ENV_TOO_LARGE',
    'CONFIG_REQUIRES_REVIEW','TASKS_BUSY','SERVER_BRANCH_REQUIRES_REVIEW','UNEXPECTED_SERVER_REVISION',
    'CONTAINER_REQUIRES_REVIEW','VOLUME_REQUIRES_REVIEW','ENV_CHANGED','STOP_STATE_CHANGED',
    'CONTAINER_CHANGED','ADMISSION_RACE','CONFIG_CHECK_FAILED','COUNTERS_CHANGED','SERVICE_NOT_READY',
    'HEALTH_CHECK_FAILED','CAPABILITIES_CHECK_FAILED','IMAGE_CHECK_FAILED','BUILD_FAILED',
    'UPGRADE_FAILED','UNSAFE_REMOTE_RESULT','RECOVERY_STATE_CHANGED',
    'DEFAULT_IMAGE_REQUIRES_REVIEW','DEFAULT_IMAGE_CHANGED'))


class SafeFailure(Exception):
    pass


def revision(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9a-fA-F]{40}',value):
        raise SafeFailure('INVALID_REVISION')
    return value.lower()


def error_code(error):
    return str(error) if isinstance(error,SafeFailure) and str(error) in ERRORS else 'UPGRADE_FAILED'


def atomic_write(path, data):
    fd,name=tempfile.mkstemp(prefix='.edulab-write-',dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb') as out:
            out.write(data);out.flush();os.fsync(out.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise SafeFailure('CI_REQUEST_FAILED')


def read_public_json(url):
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname!='api.github.com' or parsed.username or parsed.password:
        raise SafeFailure('CI_REQUEST_FAILED')
    request=urllib.request.Request(url,headers={'Accept':'application/vnd.github+json','User-Agent':'edulab-public-ci-upgrade','X-GitHub-Api-Version':'2022-11-28'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
            data=response.read(2*1024*1024+1)
        if len(data)>2*1024*1024:raise SafeFailure('CI_REQUEST_FAILED')
        return json.loads(data)
    except Exception:
        raise SafeFailure('CI_REQUEST_FAILED') from None


def verify_ci(target):
    target=revision(target)
    query=urllib.parse.urlencode({'head_sha':target,'branch':BRANCH,'per_page':100})
    data=read_public_json('https://api.github.com/repos/'+REPOSITORY+'/actions/workflows/tutor-check.yml/runs?'+query)
    if not isinstance(data,dict) or not isinstance(data.get('workflow_runs'),list):
        raise SafeFailure('CI_NOT_VERIFIED')
    matching=[]
    for run in data['workflow_runs']:
        if not isinstance(run,dict):continue
        if (run.get('head_sha')==target and run.get('head_branch')==BRANCH and run.get('name')=='Tutor checks'
            and run.get('path')==WORKFLOW and type(run.get('id')) is int
            and run.get('head_repository',{}).get('full_name',REPOSITORY)==REPOSITORY):
            matching.append(run)
    if not matching:raise SafeFailure('CI_NOT_VERIFIED')
    latest=max(matching,key=lambda r:(r['id'],r.get('run_attempt',0)))
    if latest.get('status')!='completed' or latest.get('conclusion')!='success':
        raise SafeFailure('CI_NOT_VERIFIED')
    return True


def command(args, timeout=60):
    result=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise SafeFailure('REMOTE_COMMAND_FAILED')
    return result.stdout.strip()


def node_json(source):
    return json.loads(command(COMPOSE+['exec','-T','tutor','node','--disable-warning=ExperimentalWarning','--input-type=module','-e',source],timeout=40))


def endpoint(url):
    if url not in (LOCAL_HEALTH,PUBLIC_HEALTH,LOCAL_HEALTH.replace('/health','/capabilities'),PUBLIC_HEALTH.replace('/health','/capabilities')):
        raise SafeFailure('HEALTH_CHECK_FAILED')
    with urllib.request.build_opener(NoRedirect()).open(url,timeout=6) as response:
        data=response.read(512*1024+1)
    if len(data)>512*1024:raise SafeFailure('HEALTH_CHECK_FAILED')
    return json.loads(data)


def health(url=LOCAL_HEALTH):
    return endpoint(url)


def wait_health():
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        try:return health()
        except Exception:time.sleep(1)
    raise SafeFailure('SERVICE_NOT_READY')


def read_env():
    path=ROOT/'services/tutor/.env'
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as src:
            s=os.fstat(src.fileno())
            if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode)!=0o600 or s.st_uid!=os.getuid():
                raise SafeFailure('SERVER_ENV_PERMISSIONS')
            if s.st_size>131072:raise SafeFailure('SERVER_ENV_TOO_LARGE')
            data=src.read(131073)
            if len(data)>131072:raise SafeFailure('SERVER_ENV_TOO_LARGE')
            return data
    except SafeFailure:raise
    except Exception:raise SafeFailure('SERVER_ENV_PERMISSIONS') from None


@contextmanager
def upgrade_lock():
    import fcntl
    fd=os.open('/run/edulab-minimax-deploy.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:raise SafeFailure('UPGRADE_LOCKED') from None
        yield
    finally:os.close(fd)


def checked_counts(result):
    if not isinstance(result,dict) or any(type(result.get(k)) is not int or not 0<=result[k]<=2**53-1 for k in COUNT_FIELDS) or not re.fullmatch(r'[0-9a-f]{64}',result.get('fingerprint','')):
        raise SafeFailure('CONFIG_REQUIRES_REVIEW')
    return result


def counts():
    return checked_counts(node_json(COUNTS_CHECK))


def config():
    result=node_json(CONFIG_CHECK)
    if not isinstance(result,dict) or any(type(result.get(k)) is not bool for k in ('configured','languageKeyConfigured','voiceKeyConfigured','adminConfigured','liveEnabled')) or not result['adminConfigured']:
        raise SafeFailure('CONFIG_REQUIRES_REVIEW')
    for key,maximum in (('limit',200),('day',10000),('job',1000)):
        if type(result.get(key)) is not int or not 0<=result[key]<=maximum:raise SafeFailure('CONFIG_REQUIRES_REVIEW')
    return result


def check_health(value, before_config, snapshot, stopped):
    reached=snapshot['liveTasks']>=before_config['limit']
    expected={'liveEnabled':before_config['liveEnabled'] and not reached and before_config['configured'] and not stopped and before_config['day']>0 and before_config['job']>0,
              'liveLimitReached':reached,'stopped':stopped,'sampleAvailable':True}
    if not isinstance(value,dict) or any(type(value.get(k)) is not bool or value[k]!=v for k,v in expected.items()):
        raise SafeFailure('HEALTH_CHECK_FAILED')
    return expected


def container():
    identity=command(COMPOSE+['ps','--quiet','tutor'])
    if not re.fullmatch(r'[0-9a-f]{12,64}',identity):raise SafeFailure('CONTAINER_REQUIRES_REVIEW')
    template='{"image":{{json .Image}},"running":{{json .State.Running}},"mounts":{{json .Mounts}}}'
    value=json.loads(command(['docker','inspect','--format',template,identity]))
    if value.get('running') is not True or not re.fullmatch(r'sha256:[0-9a-f]{64}',value.get('image','')):
        raise SafeFailure('CONTAINER_REQUIRES_REVIEW')
    mounts=[x for x in value.get('mounts',[]) if x.get('Destination')=='/data']
    if len(mounts)!=1 or mounts[0].get('Type')!='volume' or mounts[0].get('RW') is not True or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,200}',mounts[0].get('Name','')):
        raise SafeFailure('VOLUME_REQUIRES_REVIEW')
    return {'id':identity,'image':value['image'],'volume':mounts[0]['Name']}


def override_file(directory, filename, image, volume):
    # Pin the actual existing volume, even if the checked-out Compose definition
    # acquires a different project name. This file contains no environment values.
    value={'services':{'tutor':{'image':image,'volumes':[{'type':'volume','source':'edulab_upgrade_data','target':'/data'}]}},
           'volumes':{'edulab_upgrade_data':{'external':True,'name':volume}}}
    path=directory/filename
    atomic_write(path,(json.dumps(value)+'\n').encode())
    return path


def image_id(reference):
    value=command(['docker','image','inspect','--format','{{.Id}}',reference])
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',value):raise SafeFailure('IMAGE_CHECK_FAILED')
    return value


def check_default_image(expected,result):
    if image_id(DEFAULT_IMAGE)!=expected:
        result['defaultImage']='unknown'
        raise SafeFailure('DEFAULT_IMAGE_CHANGED')


def control(stopped):
    value=json.loads(command(COMPOSE+['exec','-T','tutor','node','control.mjs','stop' if stopped else 'resume']))
    if value.get('stopped') is not stopped or value.get('running')!=0 or value.get('queued')!=0:
        raise SafeFailure('ADMISSION_RACE')


def verify_capabilities():
    for base in (LOCAL_HEALTH,PUBLIC_HEALTH):
        data=endpoint(base.replace('/health','/capabilities'))
        entries=data.get('capabilities') if isinstance(data,dict) else None
        if not isinstance(entries,list) or len(entries)!=6 or sorted(x.get('id','') for x in entries if isinstance(x,dict))!=sorted(CAPABILITIES):
            raise SafeFailure('CAPABILITIES_CHECK_FAILED')


def unchanged_environment(original):
    if read_env()!=original:raise SafeFailure('ENV_CHANGED')


def unchanged_state(original, stopped, snapshot=None):
    unchanged_environment(original)
    current=health()
    if type(current.get('stopped')) is not bool or current['stopped'] is not stopped:
        raise SafeFailure('STOP_STATE_CHANGED')
    current_counts=counts()
    if current_counts['busy']:raise SafeFailure('TASKS_BUSY')
    if snapshot is not None and current_counts!=snapshot:raise SafeFailure('COUNTERS_CHANGED')
    return current_counts


def recovery_snapshot(original, stopped, snapshot, prior_container):
    """Inspect the same volume when a broken candidate cannot answer HTTP/exec.

    The prior image runs only a read-only SQLite query, with no network and no
    environment credentials. It does not start the application or submit jobs.
    """
    unchanged_environment(original)
    output=command(['docker','run','--rm','--network','none','--read-only',
        '--cpus','0.5','--memory','128m','--pids-limit','64',
        '--mount','type=volume,src='+prior_container['volume']+',dst=/data,readonly',
        '--entrypoint','node',prior_container['image'],'--disable-warning=ExperimentalWarning',
        '--input-type=module','-e',RECOVERY_CHECK],timeout=40)
    value=json.loads(output)
    if type(value.get('stopped')) is not bool or value['stopped'] is not stopped:
        raise SafeFailure('STOP_STATE_CHANGED')
    current=checked_counts(value.get('counts'))
    if current['busy']:raise SafeFailure('TASKS_BUSY')
    if current!=snapshot:raise SafeFailure('COUNTERS_CHANGED')


def upgrade(target):
    target=revision(target)
    result={'status':'failed','revision':target,'generationSubmissions':0,'paidGenerationCalls':0,
            'runtimeImage':'unknown','rolledBack':False}
    stage='preflight';original=None;before_config=None;original_stopped=None;before_container=None
    latest=None;directory=None;rollback=None;changed=False;pause_requested=False;expected_stopped=None
    default_before=None;new_image=None;published=False
    lock=upgrade_lock();lock_held=False
    try:
        lock.__enter__();lock_held=True
        original=read_env();before_config=config();initial=counts()
        if initial['busy']:raise SafeFailure('TASKS_BUSY')
        initial_health=health();original_stopped=initial_health.get('stopped')
        if type(original_stopped) is not bool:raise SafeFailure('HEALTH_CHECK_FAILED')
        check_health(initial_health,before_config,initial,original_stopped)
        expected_stopped=original_stopped
        if command(['git','branch','--show-current'])!=BRANCH:raise SafeFailure('SERVER_BRANCH_REQUIRES_REVIEW')
        command(['git','diff','--quiet']);command(['git','diff','--cached','--quiet'])
        current=command(['git','rev-parse','HEAD']);result['sourceRevision']=revision(current)
        before_container=container();result['runtimeImage']='original'
        try:default_before=image_id(DEFAULT_IMAGE)
        except Exception:raise SafeFailure('DEFAULT_IMAGE_REQUIRES_REVIEW') from None
        if default_before!=before_container['image']:raise SafeFailure('DEFAULT_IMAGE_REQUIRES_REVIEW')
        result['defaultImage']='original'
        rollback_tag='edulab-tutor:before-upgrade-'+str(time.time_ns())
        command(['docker','tag',before_container['image'],rollback_tag])
        stage='source'
        command(['git','fetch','--no-tags','origin',BRANCH],timeout=90)
        command(['git','cat-file','-e',target+'^{commit}'])
        command(['git','merge-base','--is-ancestor',current,target])
        command(['git','merge-base','--is-ancestor',target,'FETCH_HEAD'])
        command(['git','merge','--ff-only',target])
        if command(['git','rev-parse','HEAD'])!=target:raise SafeFailure('UNEXPECTED_SERVER_REVISION')
        result['sourceRevision']=target
        directory=Path(tempfile.mkdtemp(prefix='edulab-upgrade-',dir='/run'));directory.chmod(0o700)
        new_tag='edulab-tutor:upgrade-'+target+'-'+str(time.time_ns())
        candidate=override_file(directory,'candidate.json',new_tag,before_container['volume'])
        rollback=override_file(directory,'rollback.json',rollback_tag,before_container['volume'])
        stage='build'
        command(COMPOSE+['-f',str(candidate),'build','tutor'],timeout=900)
        new_image=image_id(new_tag)
        check_default_image(default_before,result)
        latest=unchanged_state(original,original_stopped)
        if container()!=before_container:raise SafeFailure('CONTAINER_CHANGED')
        if config()!=before_config:raise SafeFailure('CONFIG_CHECK_FAILED')
        # A completed request during the build is allowed. Snapshot the latest
        # counters now; admission after this point must not alter them.
        latest=unchanged_state(original,original_stopped)
        stage='pause'
        if not original_stopped:
            pause_requested=True
            control(True)
        expected_stopped=True
        unchanged_state(original,True,latest)
        check_default_image(default_before,result)
        if command(['git','rev-parse','HEAD'])!=target:raise SafeFailure('UNEXPECTED_SERVER_REVISION')
        command(['git','diff','--quiet']);command(['git','diff','--cached','--quiet'])
        stage='cutover';changed=True;result['runtimeImage']='unknown'
        command(COMPOSE+['-f',str(candidate),'up','-d','--no-deps','--no-build','--force-recreate','tutor'],timeout=120)
        result['runtimeImage']='requested';wait_health();stage='verify'
        unchanged_state(original,True,latest)
        if config()!=before_config:raise SafeFailure('CONFIG_CHECK_FAILED')
        running=container()
        if running['image']!=new_image or running['volume']!=before_container['volume']:raise SafeFailure('IMAGE_CHECK_FAILED')
        verify_capabilities()
        check_health(health(),before_config,latest,True)
        check_health(health(PUBLIC_HEALTH),before_config,latest,True)
        unchanged_state(original,True,latest)
        check_default_image(default_before,result)
        # Future ordinary Compose/allowance operations use this tag. Publish only
        # after the paused candidate has passed configuration and six-mode checks.
        stage='publish';published=True;result['defaultImage']='unknown'
        command(['docker','tag',new_image,DEFAULT_IMAGE])
        check_default_image(new_image,result);result['defaultImage']='requested'
        stage='verify'
        if not original_stopped:
            control(False);expected_stopped=False
        public=check_health(health(PUBLIC_HEALTH),before_config,latest,original_stopped)
        check_health(health(),before_config,latest,original_stopped)
        unchanged_state(original,original_stopped,latest)
        if config()!=before_config:raise SafeFailure('CONFIG_CHECK_FAILED')
        check_default_image(new_image,result)
        result.update(status='upgraded',environmentPreserved=True,configurationPreserved=True,
                      limitsPreserved=True,countersPreserved=True,stoppedPreserved=True,
                      capabilitiesVerified=sorted(CAPABILITIES),publicHealth=public,
                      counters={k:latest[k] for k in COUNT_FIELDS})
    except Exception as error:
        result.update(stage=stage,error=error_code(error))
        if original is not None and before_config is not None and latest is not None:
            try:
                # Never restore env bytes over another administrator's edits, nor
                # force-recreate over a newly admitted/active unrelated task.
                try:unchanged_state(original,expected_stopped,latest)
                except Exception:
                    if not changed or expected_stopped is not True:raise
                    recovery_snapshot(original,True,latest,before_container)
                if changed:
                    stage='rollback'
                    if expected_stopped is False:
                        control(True);expected_stopped=True
                        unchanged_state(original,True,latest)
                    if published:
                        current_default=image_id(DEFAULT_IMAGE)
                        if current_default==new_image:
                            result['defaultImage']='unknown'
                            command(['docker','tag',default_before,DEFAULT_IMAGE])
                            check_default_image(default_before,result)
                        elif current_default!=default_before:
                            result['defaultImage']='unknown'
                            raise SafeFailure('DEFAULT_IMAGE_CHANGED')
                        published=False;result['defaultImage']='original'
                    else:check_default_image(default_before,result)
                    result['runtimeImage']='unknown'
                    command(COMPOSE+['-f',str(rollback),'up','-d','--no-deps','--no-build','--force-recreate','tutor'],timeout=120)
                    wait_health()
                    unchanged_state(original,True,latest)
                    if config()!=before_config:raise SafeFailure('CONFIG_CHECK_FAILED')
                    restored=container()
                    if restored['image']!=before_container['image'] or restored['volume']!=before_container['volume']:raise SafeFailure('IMAGE_CHECK_FAILED')
                    result['runtimeImage']='original'
                if pause_requested and not original_stopped:
                    control(False);expected_stopped=False
                check_health(health(),before_config,latest,original_stopped)
                check_health(health(PUBLIC_HEALTH),before_config,latest,original_stopped)
                unchanged_state(original,original_stopped,latest)
                result['rolledBack']=changed
                result['stoppedPreserved']=True
            except Exception as recovery_error:
                result['recoveryError']=error_code(recovery_error)
                result['recoveryDeferred']=True
        # If no image recreation was attempted, the old application was left up.
        if not changed and before_container is not None:result['runtimeImage']='original'
    finally:
        if directory is not None:
            if changed and not result['rolledBack'] and result['status']!='upgraded':
                result['privateRecoveryDirectory']=str(directory)
            else:shutil.rmtree(directory,ignore_errors=True)
        if lock_held:lock.__exit__(None,None,None)
    return safe_result(result)


def safe_result(value):
    if not isinstance(value,dict):raise SafeFailure('UNSAFE_REMOTE_RESULT')
    out={'status':'upgraded' if value.get('status')=='upgraded' else 'failed','generationSubmissions':0,'paidGenerationCalls':0}
    for key in ('revision','sourceRevision'):
        if isinstance(value.get(key),str) and re.fullmatch('[0-9a-f]{40}',value[key]):out[key]=value[key]
    for key in ('environmentPreserved','configurationPreserved','limitsPreserved','countersPreserved','stoppedPreserved','rolledBack','recoveryDeferred'):
        if type(value.get(key)) is bool:out[key]=value[key]
    for key in ('stage',):
        if value.get(key) in ('input','ci','ssh_auth','ssh_upgrade','preflight','source','build','pause','cutover','publish','verify','rollback','ssh'):out[key]=value[key]
    for key in ('error','recoveryError'):
        if value.get(key) in ERRORS:out[key]=value[key]
        elif key in value:out[key]='UPGRADE_FAILED'
    if value.get('runtimeImage') in ('original','requested','unknown'):out['runtimeImage']=value['runtimeImage']
    if value.get('defaultImage') in ('original','requested','unknown'):out['defaultImage']=value['defaultImage']
    if value.get('capabilitiesVerified')==sorted(CAPABILITIES):out['capabilitiesVerified']=sorted(CAPABILITIES)
    if isinstance(value.get('publicHealth'),dict):
        out['publicHealth']={k:value['publicHealth'][k] for k in ('liveEnabled','liveLimitReached','stopped','sampleAvailable') if type(value['publicHealth'].get(k)) is bool}
    if isinstance(value.get('counters'),dict):
        out['counters']={k:value['counters'][k] for k in COUNT_FIELDS if type(value['counters'].get(k)) is int and 0<=value['counters'][k]<=2**53-1}
    recovery=value.get('privateRecoveryDirectory','')
    if isinstance(recovery,str) and re.fullmatch(r'/run/edulab-upgrade-[A-Za-z0-9_-]+',recovery):out['privateRecoveryDirectory']=recovery
    return out


def remote_main():
    try:
        raw=sys.stdin.buffer.read(257)
        if len(raw)>256:raise SafeFailure('INVALID_PAYLOAD')
        value=json.loads(raw)
        if not isinstance(value,dict) or set(value)!={'revision'}:raise SafeFailure('INVALID_PAYLOAD')
        result=upgrade(revision(value['revision']))
    except Exception as error:
        result={'status':'failed','stage':'input','error':error_code(error),'generationSubmissions':0,'paidGenerationCalls':0}
    print(json.dumps(safe_result(result)),flush=True)
    return 0 if result.get('status')=='upgraded' else 1


@contextmanager
def ssh_session():
    if not sys.stdin.isatty():raise SafeFailure('USER_TERMINAL_REQUIRED')
    directory=Path(tempfile.mkdtemp(prefix='edulab-ssh-',dir='/tmp'));directory.chmod(0o700)
    socket=directory/'connection';started=False
    try:
        print('请完成一次服务器 SSH 登录；核对主机指纹，密码输入时不会显示。无需输入任何 API Key。',flush=True)
        args=['ssh','-M','-S',str(socket),'-o','ControlPersist=60','-o','BatchMode=no','-o','StrictHostKeyChecking=ask','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','-fN',HOST]
        completed=subprocess.run(args,timeout=120)
        if completed.returncode:raise SafeFailure('SSH_LOGIN_FAILED')
        started=True;yield socket
    finally:
        if started or socket.exists():
            try:subprocess.run(['ssh','-S',str(socket),'-o','BatchMode=yes','-O','exit',HOST],capture_output=True,text=True,timeout=10)
            except Exception:pass
        shutil.rmtree(directory,ignore_errors=True)


def transmit(source,target,control):
    target=revision(target)
    encoded=base64.b64encode(source.encode()).decode()
    remote='python3 -c '+shlex.quote('import base64;exec(compile(base64.b64decode('+repr(encoded)+"),'<edulab-upgrade>','exec'))")+' --remote'
    args=['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','-S',str(control),'-o','ControlMaster=no',HOST,remote]
    return subprocess.run(args,input=json.dumps({'revision':target}),capture_output=True,text=True,timeout=1500)


def local_main(argv=None):
    stage='input';target=None
    try:
        args=sys.argv[1:] if argv is None else argv
        if len(args)!=2 or args[0]!='--revision':raise SafeFailure('REVISION_REQUIRED')
        target=revision(args[1]);stage='ci'
        print('先核验指定版本的公开 Tutor checks；通过后连接服务器。原预算、累计次数和配置保持不变。',flush=True)
        verify_ci(target)
        stage='ssh_auth'
        with ssh_session() as socket:
            stage='ssh_upgrade'
            completed=transmit(Path(__file__).read_text(),target,socket)
        try:result=safe_result(json.loads(completed.stdout))
        except Exception:raise SafeFailure('SSH_CONNECTION_FAILED') from None
        if result.get('revision')!=target:raise SafeFailure('UNSAFE_REMOTE_RESULT')
        required=('environmentPreserved','configurationPreserved','limitsPreserved','countersPreserved','stoppedPreserved')
        success=completed.returncode==0 and result['status']=='upgraded' and all(result.get(k) is True for k in required) and result.get('capabilitiesVerified')==sorted(CAPABILITIES)
        if not success and result['status']=='upgraded':raise SafeFailure('UNSAFE_REMOTE_RESULT')
        result['recordedAt']=time.time();atomic_write(RECEIPT,(json.dumps(result)+'\n').encode())
        if success:
            print('升级完成：六个模块已通过检查，原预算、累计次数、密钥配置和暂停状态均已保留。')
        else:
            print('升级未完成，阶段：'+result.get('stage','ssh')+'；原因：'+result.get('error','UPGRADE_FAILED'))
            if result.get('rolledBack'):print('已恢复原运行镜像；Git 工作区可能保留新版本，没有执行 git reset。')
            elif result.get('recoveryDeferred'):print('检测到并发状态变化，未强行覆盖管理员配置或新任务；请保留终端并返回聊天。')
        print('结果记录：/tmp/edulab-upgrade-result.json。请返回聊天说明结果，不要粘贴密钥。')
        return 0 if success else 1
    except Exception as error:
        result={'status':'failed','stage':stage,'error':error_code(error),'generationSubmissions':0,'paidGenerationCalls':0}
        if target:result['revision']=target
        result['recordedAt']=time.time()
        try:atomic_write(RECEIPT,(json.dumps(result)+'\n').encode())
        except Exception:pass
        print('未执行或未确认升级：'+result['error']+'。请返回聊天说明结果，不要粘贴密钥。')
        return 1


if __name__=='__main__':
    sys.exit(remote_main() if sys.argv[1:]==['--remote'] else local_main())
