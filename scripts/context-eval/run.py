#!/usr/bin/env python3
"""Run pinned project-context comparisons; outputs and workspaces must be outside the source repository."""
import argparse, concurrent.futures, hashlib, json, os, pathlib, shutil, subprocess, time
P=argparse.ArgumentParser(); P.add_argument('--implementation',required=True); P.add_argument('--source',required=True); P.add_argument('--revision',required=True); P.add_argument('--config',required=True); P.add_argument('--out',required=True); P.add_argument('--conditions',default='none,today'); P.add_argument('--repeats',type=int,default=3); P.add_argument('--tasks',default='locate,entry,impact,commands,edit,status,drift,wiki'); P.add_argument('--target',default='blade'); P.add_argument('--model',default='dynamo/qwopus3.8-27b-flash@q5_k_m'); P.add_argument('--jobs',type=int,default=2); P.add_argument('--today-implementation'); P.add_argument('--omit-published-wiki',action='store_true'); P.add_argument('--dependencies'); P.add_argument('--implementation-id'); P.add_argument('--project',choices=['clio','hpc'],default='clio'); A=P.parse_args()
ROOT=pathlib.Path(A.out).resolve(); ROOT.mkdir(parents=True,exist_ok=True); IMPL=pathlib.Path(A.implementation).resolve(); SOURCE=pathlib.Path(A.source).resolve(); DEPS=pathlib.Path(A.dependencies or A.implementation).resolve()
IMPLEMENTATION_ID=A.implementation_id or subprocess.check_output(['git','rev-parse','HEAD'],cwd=IMPL,text=True).strip()
if ROOT.is_relative_to(SOURCE) or ROOT.is_relative_to(IMPL): P.error('--out must be outside the source and implementation')
BASE='Inspect current source evidence, cite paths and line numbers for conclusions, and keep the response concise. Do not delegate, install packages, access the network, or read benchmark state outside this workspace. '
TASKS={
'locate':'Locate the implementation of renderPromptContext and relevant tests. Explain exactly what ordinary project prompts preload and what they retrieve later.',
'entry':'Explain the execution path from the context index CLI command to persisted artifacts, including concurrency and worker boundaries. Cite the source.',
'impact':'Trace callers and dependencies of writeClioState. If its validation rejects a state file, what project prompt and indexing behavior changes? Identify relevant tests.',
'commands':'Identify the documented root build, focused test, typecheck, lint, and installed-package test commands. Explain runtime dependencies on shipped src and docs; do not run a build.',
'edit':'Make one bounded change: reject an invalid code_nav mode before building or writing project artifacts. Add a regression exercising this behavior in the existing code-nav test suite and run that focused suite. Preserve all valid modes. Do not change unrelated files.',
'status':'Explain the declared project purpose and durable operator objectives, progress, and blockers. Distinguish operator intent, recorded task status, assistant claims, and verified outcomes. Do not infer release completion from the version or Markdown presence.',
'drift':'Find the exported renamedProjectProbe symbol and its actual current source file. Confirm deletedProjectProbe is absent. Explain how navigation handles stale generated context; use source evidence for current facts.',
'wiki':'Inspect available generated wiki context, explain whether it is current and complete, and assess its claim that all project work is complete. Verify against source and durable operator tasks. Markdown presence alone does not establish validation.'}
if A.project=='hpc': TASKS={'locate':'Locate the PoolManager RegisterContainer implementation and its relevant tests; explain the responsibilities from source.', 'commands':'Identify the documented CMake configure/build/test commands and the master switch required to enable tests. Explain default component options and distinguish console scripts from build commands.', 'impact':'Trace the effect of changing CLIO_CORE_ENABLE_TESTS from OFF to ON on component test registration. Cite the CMake execution path.', 'status':'Explain the declared project purpose, components, and current release evidence. Distinguish documented objectives and defaults from proof of test success or completed work.'}
SELECT=A.tasks.split(','); missing=set(SELECT)-TASKS.keys()
if missing: P.error('unsupported tasks: '+str(missing))
archive=subprocess.check_output(['git','archive',A.revision],cwd=SOURCE); archivehash=hashlib.sha256(archive).hexdigest(); (ROOT/'source.json').write_text(json.dumps({'source':str(SOURCE),'revision':A.revision,'archiveSha256':archivehash,'project':A.project},indent=2)+'\n')
def call(args,cwd,env,stdout,stderr):
 with open(stdout,'w') as o,open(stderr,'w') as e:
  start=time.monotonic()
  try: p=subprocess.run(args,cwd=cwd,env=env,stdout=o,stderr=e,timeout=240); code=p.returncode
  except subprocess.TimeoutExpired: code=124
  return code,(time.monotonic()-start)*1000

def run(spec):
 repeat,condition,task=spec
 IMPL=pathlib.Path(A.today_implementation).resolve() if A.today_implementation and condition in ('none','today') else pathlib.Path(A.implementation).resolve()
 implementation_id=subprocess.check_output(['git','rev-parse','HEAD'],cwd=IMPL,text=True).strip() if A.today_implementation and condition in ('none','today') else IMPLEMENTATION_ID
 D=ROOT/f'{repeat}-{condition}-{task}'; result=D/'result.json'
 if result.exists():
  try: return json.loads(result.read_text())
  except json.JSONDecodeError: pass
 if D.exists(): shutil.rmtree(D)
 D.mkdir(exist_ok=True); W=D/'workspace'; H=D/'home'; W.mkdir(exist_ok=True); H.mkdir(exist_ok=True)
 subprocess.run(['tar','-x','-C',str(W)],input=archive,check=True)
 if A.omit_published_wiki and (W/'docs/wiki').exists(): shutil.rmtree(W/'docs/wiki')
 subprocess.run(['git','init','-q'],cwd=W,check=True); subprocess.run(['git','add','.'],cwd=W,check=True); subprocess.run(['git','-c','user.name=Benchmark','-c','user.email=benchmark@local','commit','-qm','snapshot'],cwd=W,check=True)
 # The same authored guidance is discoverable with ordinary reads in every condition.
 # No generated handbook is created. None suppresses all project preload via the existing CLI flag.
 shutil.copytree(A.config,H/'config',dirs_exist_ok=True)
 os.symlink(DEPS/'node_modules',W/'node_modules',target_is_directory=True)
 env={k:v for k,v in os.environ.items() if not k.startswith('CLIO_CODER_')};env.update(CLIO_CODER_HOME=str(H),NO_COLOR='1',CLIO_CODER_PACKAGE_ROOT=str(IMPL))
 cli=['node',str(IMPL/'dist/cli/index.js')]
 if task=='drift':
  (W/'old-probe.ts').write_text('export const deletedProjectProbe = 1;\n')
 if task in ('status','wiki') and A.project=='clio':
  (W/'.clio-coder').mkdir(exist_ok=True)
  (W/'.clio-coder/user-tasks.json').write_text(json.dumps({'version':1,'nextId':3,'tasks':[{'id':'u1','title':'Preserve numerical tolerance while improving navigation','status':'open','createdAt':'2026-09-26T00:00:00Z','updatedAt':'2026-09-26T00:00:00Z'},{'id':'u2','title':'Qualify the next release','status':'picked','note':'Waiting for external integration checks; no passing receipt attached.','createdAt':'2026-09-26T00:00:00Z','updatedAt':'2026-09-26T00:00:00Z','handedSessionId':'other-session','boardTaskId':'t2'}]})+'\n')
 generation=None
 if condition!='none':
  code,generation=call(cli+['context','index','--json'],W,env,D/'generation.json',D/'generation.stderr')
  if code: raise RuntimeError('generation failed: '+str(D))
  # A controlled partial wiki, identical bytes for today and improved. No model-generated answer keys.
  if task=='wiki':
   wiki=W/'.clio-coder/wiki';wiki.mkdir(exist_ok=True)
   page='---\ntitle: Historical project status\nsummary: Unvalidated old status\nsources:\n  - package.json\n---\n\nAll project work is complete.\n';(wiki/'status.md').write_text(page)
   # Use the implementation metadata writer to avoid fabricating an invalid schema.
   js='import {writeWikiMeta} from "'+str(IMPL/'src/domains/context/wiki/meta.ts')+'"; writeWikiMeta(process.argv[1],{version:1,updatedAt:"2020-01-01T00:00:00Z",gitHead:null,model:"controlled-fixture",contentHash:"0".repeat(64),pages:[{path:"status.md",title:"Historical project status"}],generation:{requestedDepth:"simple",depth:"simple",sourceFiles:1,sourceLines:1,pagesPlanned:3,pagesWritten:0}});'
   subprocess.run(['node','--import',str(DEPS/'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',js,str(W)],cwd=IMPL,env=env,check=True)
 if task=='drift':
  (W/'old-probe.ts').unlink();(W/'renamed-probe.ts').write_text('export const renamedProjectProbe = 2;\n')
 request=BASE+TASKS[task]+(' Do not edit files.' if task!='edit' else '')
 args=cli+(['--no-context-files'] if condition=='none' else [])+['run','--cwd',str(W),'--target',A.target,'--model',A.model,'--thinking','low','--temperature','0','--no-skills','--no-delegate','--allow-tools','read,bash,code_nav'+(',edit,write' if task=='edit' else ''),'--json','--timeout','180',request]
 code,elapsed=call(args,W,env,D/'events.jsonl',D/'stderr.txt')
 events=[]
 for line in (D/'events.jsonl').read_text().splitlines():
  try: events.append(json.loads(line))
  except json.JSONDecodeError: pass
 ends=[e for e in events if e.get('type')=='agent_end']; calls=[e for e in events if e.get('type')=='tool_execution_start']; messages=[e['message'] for e in events if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant']
 usage={k:sum(e.get('usage',{}).get(k,0) for e in ends) for k in ('input','output','cacheRead','cacheWrite','totalTokens','apiCalls','costUsd')}
 answer=''.join(e.get('delta','') for e in events if e.get('type')=='text_delta');(D/'answer.md').write_text(answer)
 row={'repeat':repeat,'condition':condition,'task':task,'project':A.project,'exitCode':code,'elapsedMs':elapsed,'generationMs':generation,'usage':usage,'toolCalls':len(calls),'tools':[{'name':e.get('toolName'),'args':e.get('args')} for e in calls],'providerUsageMeasured':any(e.get('usage',{}).get('measured') for e in ends),'gatewayRetries':sum(m.get('gatewayRouting',{}).get('attemptedRetries',0) for m in messages),'model':A.model,'thinking':'low','temperature':0,'sourceArchiveSha256':archivehash,'implementationHead':implementation_id,'publishedWikiHandling':'omitted uniformly as generated project explanations' if A.omit_published_wiki else 'retained uniformly as ordinary published repository docs','backendCacheState':'uncontrolled; provider cache accounting may be absent','processState':'fresh','sourceReads':sum(e.get('toolName')=='read' for e in calls)}
 result.write_text(json.dumps(row,indent=2)+'\n'); print(f'{repeat} {condition} {task}: exit={code} ms={elapsed:.0f} calls={len(calls)} tokens={usage["totalTokens"]}',flush=True)
 return row
specs=[]
conditions=A.conditions.split(',')
for r in range(A.repeats):
 for task in SELECT:
  for c in conditions[r%len(conditions):]+conditions[:r%len(conditions)]: specs.append((r,c,task))
with concurrent.futures.ThreadPoolExecutor(max_workers=A.jobs) as pool: rows=list(pool.map(run,specs))
(ROOT/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
