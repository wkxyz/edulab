import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/upgrade-edulab-remote.py'
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location('minimax_upgrade', SOURCE)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
else:
    m = types.SimpleNamespace()

REVISION = 'a' * 40
OLD_REVISION = 'b' * 40
OLD_IMAGE = 'sha256:' + '1' * 64
NEW_IMAGE = 'sha256:' + '2' * 64
ENV = ('# Keep financial caps and credentials byte for byte\n'
       'MINIMAX_API_KEY=private-language-key\nMINIMAX_TTS_API_KEY=private-voice-key\n'
       'ADMIN_TOKEN=private-admin-token\nLIVE_ENABLED=true\nLIVE_TASK_LIMIT=7\n'
       'DAY_BUDGET_CENTS=3000\nJOB_BUDGET_CENTS=200\n').encode()
CONFIG = {'provider':'minimax','model':'MiniMax-M3.1-Flash','ttsProvider':'minimax',
          'ttsModel':'speech-2.8-hd','ttsVoice':'female-chengshu','reasoningEffort':'medium',
          'configured':True,'languageKeyConfigured':True,'voiceKeyConfigured':True,
          'adminConfigured':True,'liveEnabled':True,'limit':7,'day':3000,'job':200,
          'host':'0.0.0.0','port':8788,'dataDir':'/data'}
COUNTS = {'tasks':12,'liveTasks':7,'calls':15,'requests':31,'attempts':10,
          'reservedCents':2400,'busy':0,'dailyJobs':12,'dailyCalls':98,'dailyCost':2400,
          'ownerJobs':12,'fingerprint':'f'*64}


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(callable(getattr(m,'upgrade',None)), 'standalone upgrade implementation exists')

    def fixture(self, root, stopped=False):
        env=root/'services/tutor/.env';env.parent.mkdir(parents=True)
        env.write_bytes(ENV);env.chmod(0o600)
        state={'stopped':stopped,'counts':copy.deepcopy(COUNTS),'config':copy.deepcopy(CONFIG),
               'image':OLD_IMAGE,'container':'1'*64,'head':OLD_REVISION,'commands':[],
               'buildFailure':False,'verifyFailure':False,'buildHook':None,'postPauseHook':None,
               'defaultImage':OLD_IMAGE,'afterPublishFailure':False,'publishedOnce':False,
               'candidateHealthFailure':False}
        def execute(args, timeout=60):
            state['commands'].append(args)
            if args==['git','branch','--show-current']:return m.BRANCH
            if args==['git','rev-parse','HEAD']:return state['head']
            if args[:3]==['git','merge','--ff-only']:state['head']=args[3]
            if args==m.COMPOSE+['ps','--quiet','tutor']:return state['container']
            if args[:2]==['docker','inspect']:
                return json.dumps({'image':state['image'],'running':True,'mounts':[{'Type':'volume','Name':'edulab_tutor-data','Destination':'/data','RW':True}]})
            if args[:3]==['docker','image','inspect']:
                return state['defaultImage'] if args[-1]==getattr(m,'DEFAULT_IMAGE','edulab-tutor:latest') else NEW_IMAGE
            if args[:2]==['docker','run']:
                return json.dumps({'counts':state['counts'],'stopped':state['stopped']})
            if args[:2]==['docker','tag'] and args[-1]==getattr(m,'DEFAULT_IMAGE','edulab-tutor:latest'):
                state['defaultImage']=args[2]
                if args[2]==NEW_IMAGE:state['publishedOnce']=True
            if 'build' in args:
                if state['buildHook']:state['buildHook'](state,env)
                if state['buildFailure']:raise m.SafeFailure('BUILD_FAILED')
            if args[-2:]==['control.mjs','stop']:
                state['stopped']=True
                if state['postPauseHook']:state['postPauseHook'](state,env)
                return json.dumps({'stopped':True,'running':state['counts']['busy'],'queued':0})
            if args[-2:]==['control.mjs','resume']:
                state['stopped']=False
                return json.dumps({'stopped':False,'running':0,'queued':0})
            if 'up' in args:
                override=Path(args[args.index('-f',len(m.COMPOSE))+1]).read_text()
                state['image']=OLD_IMAGE if 'before-upgrade-' in override else NEW_IMAGE
                state['container']='2'*64 if state['image']==NEW_IMAGE else '3'*64
            return ''
        def node(source):
            if source==m.CONFIG_CHECK:
                if state['image']==NEW_IMAGE and state['verifyFailure']:
                    state['verifyFailure']=False
                    return {**state['config'],'limit':99}
                return copy.deepcopy(state['config'])
            if source==m.COUNTS_CHECK:return copy.deepcopy(state['counts'])
            raise AssertionError('Unexpected remote Node program')
        def health(url=m.LOCAL_HEALTH):
            config=state['config'];count=state['counts']['liveTasks']
            if state['image']==NEW_IMAGE and state['candidateHealthFailure']:
                raise m.SafeFailure('SERVICE_NOT_READY')
            if state['image']==NEW_IMAGE and not state['stopped'] and state['afterPublishFailure']:
                state['afterPublishFailure']=False
                return {'stopped':False,'sampleAvailable':False,'liveLimitReached':True,'liveEnabled':False}
            return {'stopped':state['stopped'],'sampleAvailable':True,
                    'liveLimitReached':count>=config['limit'],
                    'liveEnabled':config['liveEnabled'] and not state['stopped'] and count<config['limit']}
        def endpoint(url):
            if url.endswith('/api/capabilities'):
                return {'capabilities':[{'id':x} for x in m.CAPABILITIES]}
            return health(url)
        def invoke():
            private=root/'private-overrides';private.mkdir(mode=0o700,exist_ok=True)
            with patch.object(m,'ROOT',root),patch.object(m,'command',side_effect=execute), \
                 patch.object(m,'node_json',side_effect=node),patch.object(m,'health',side_effect=health), \
                 patch.object(m,'wait_health',side_effect=health),patch.object(m,'endpoint',side_effect=endpoint), \
                 patch.object(m,'upgrade_lock',contextlib.nullcontext), \
                 patch.object(m.tempfile,'mkdtemp',return_value=str(private)):
                return m.upgrade(REVISION)
        return env,state,invoke

    def test_ci_must_verify_exact_completed_success_before_ssh(self):
        runs={'workflow_runs':[{'id':1,'head_sha':REVISION,'head_branch':m.BRANCH,
              'name':'Tutor checks','path':'.github/workflows/tutor-check.yml',
              'status':'in_progress','conclusion':None}]}
        with tempfile.TemporaryDirectory() as directory,patch.object(m,'RECEIPT',Path(directory)/'receipt.json'), \
             patch.object(m,'read_public_json',return_value=runs),patch.object(m,'ssh_session') as ssh, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.local_main(['--revision',REVISION]),1)
            ssh.assert_not_called()
        runs['workflow_runs'][0].update(status='completed',conclusion='success',head_sha=OLD_REVISION)
        with patch.object(m,'read_public_json',return_value=runs):
            with self.assertRaisesRegex(m.SafeFailure,'CI_NOT_VERIFIED'):m.verify_ci(REVISION)
        runs['workflow_runs'][0]['head_sha']=REVISION
        with patch.object(m,'read_public_json',return_value=runs):self.assertTrue(m.verify_ci(REVISION))

    def test_success_preserves_environment_budgets_counters_and_six_capabilities(self):
        with tempfile.TemporaryDirectory() as directory:
            env,state,invoke=self.fixture(Path(directory));before=copy.deepcopy(state['counts'])
            result=invoke()
            self.assertEqual(result['status'],'upgraded')
            self.assertEqual(env.read_bytes(),ENV)
            self.assertEqual(state['config'],CONFIG);self.assertEqual(state['counts'],before)
            self.assertEqual(result['capabilitiesVerified'],sorted(m.CAPABILITIES))
            self.assertFalse(result['publicHealth']['liveEnabled']);self.assertTrue(result['publicHealth']['liveLimitReached'])
            self.assertFalse(state['stopped']);self.assertEqual(state['image'],NEW_IMAGE)
            self.assertEqual(result['generationSubmissions'],0)

    def test_busy_server_aborts_before_fetch_build_pause_or_recreation(self):
        with tempfile.TemporaryDirectory() as directory:
            env,state,invoke=self.fixture(Path(directory));state['counts']['busy']=1
            result=invoke();self.assertEqual(result['error'],'TASKS_BUSY')
            self.assertEqual(env.read_bytes(),ENV);self.assertEqual(state['image'],OLD_IMAGE)
            self.assertFalse(any('fetch' in c or 'build' in c or 'up' in c for c in state['commands']))

    def test_build_failure_keeps_old_running_application_and_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            env,state,invoke=self.fixture(Path(directory));state['buildFailure']=True
            result=invoke();self.assertEqual(result['stage'],'build')
            self.assertEqual(state['image'],OLD_IMAGE);self.assertFalse(state['stopped'])
            self.assertEqual(env.read_bytes(),ENV);self.assertEqual(state['head'],REVISION)
            self.assertFalse(any('up' in c for c in state['commands']))

    def test_failed_verification_rolls_back_actual_image_without_resetting_git(self):
        for failure in ('verifyFailure','candidateHealthFailure'):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as directory:
                env,state,invoke=self.fixture(Path(directory));state[failure]=True
                result=invoke();self.assertTrue(result['rolledBack'])
                self.assertEqual(result['runtimeImage'],'original');self.assertEqual(state['image'],OLD_IMAGE)
                self.assertEqual(state['head'],REVISION);self.assertEqual(env.read_bytes(),ENV)
                self.assertFalse(state['stopped']);self.assertEqual(state['counts'],COUNTS)
                self.assertFalse(any('reset' in c for c in state['commands']))

    def test_originally_stopped_service_remains_stopped_after_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            env,state,invoke=self.fixture(Path(directory),stopped=True)
            result=invoke();self.assertEqual(result['status'],'upgraded');self.assertTrue(state['stopped'])
            self.assertTrue(result['publicHealth']['stopped'])
            self.assertFalse(any(c[-2:]==['control.mjs','resume'] for c in state['commands']))

    def test_concurrent_env_or_busy_task_changes_abort_without_overwriting_admin_changes(self):
        for change in ('env','busy','stop'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as directory:
                env,state,invoke=self.fixture(Path(directory))
                def changed(s,e):
                    if change=='env':e.write_bytes(ENV+b'ADMIN_CHANGED=true\n')
                    elif change=='busy':s['counts']['busy']=1
                    else:s['stopped']=True
                state['buildHook']=changed
                result=invoke();self.assertEqual(result['status'],'failed');self.assertEqual(state['image'],OLD_IMAGE)
                self.assertFalse(any('up' in c for c in state['commands']))
                self.assertEqual(env.read_bytes(),ENV+b'ADMIN_CHANGED=true\n' if change=='env' else ENV)

    def test_admission_race_after_pause_never_recreates_over_unrelated_task(self):
        with tempfile.TemporaryDirectory() as directory:
            env,state,invoke=self.fixture(Path(directory))
            state['postPauseHook']=lambda s,e:s['counts'].update(tasks=13,busy=1,fingerprint='e'*64)
            result=invoke();self.assertEqual(result['status'],'failed');self.assertEqual(state['image'],OLD_IMAGE)
            self.assertFalse(any('up' in c for c in state['commands']))
            self.assertEqual(state['counts']['tasks'],13);self.assertEqual(env.read_bytes(),ENV)

    def test_private_receipt_and_ssh_payload_never_include_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            env,state,invoke=self.fixture(Path(directory));result=invoke()
            encoded=json.dumps(result)
            for secret in ('private-language-key','private-voice-key','private-admin-token'):self.assertNotIn(secret,encoded)
            receipt=Path(directory)/'receipt.json';m.atomic_write(receipt,encoded.encode())
            self.assertEqual(stat.S_IMODE(receipt.stat().st_mode),0o600)
        with patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='{}')) as run:
            m.transmit('print("safe source")',REVISION,Path('/tmp/private/connection'))
            args,kwargs=run.call_args;self.assertEqual(json.loads(kwargs['input']),{'revision':REVISION})
            self.assertIn('BatchMode=yes',args[0]);self.assertIn('StrictHostKeyChecking=yes',args[0])
            self.assertIn('ControlMaster=no',args[0]);self.assertNotIn('private-language-key',' '.join(args[0]))

    def test_default_compose_image_is_published_and_restored_without_overwriting_concurrent_edits(self):
        for scenario in ('success','lateFailure','concurrentTag'):
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory:
                env,state,invoke=self.fixture(Path(directory))
                if scenario=='lateFailure':state['afterPublishFailure']=True
                if scenario=='concurrentTag':
                    state['buildHook']=lambda s,e:s.update(defaultImage='sha256:'+'3'*64)
                result=invoke()
                if scenario=='success':
                    self.assertEqual(result['status'],'upgraded')
                    self.assertEqual(state['defaultImage'],NEW_IMAGE)
                elif scenario=='lateFailure':
                    self.assertTrue(state['publishedOnce']);self.assertTrue(result['rolledBack'])
                    self.assertEqual(state['defaultImage'],OLD_IMAGE);self.assertEqual(state['image'],OLD_IMAGE)
                else:
                    self.assertEqual(result['status'],'failed');self.assertEqual(state['defaultImage'],'sha256:'+'3'*64)
                    self.assertEqual(state['image'],OLD_IMAGE);self.assertFalse(any('up' in c for c in state['commands']))
                self.assertEqual(env.read_bytes(),ENV)


if __name__=='__main__':unittest.main()
