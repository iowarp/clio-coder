#!/usr/bin/env python3
"""Export completed agent runs without homes, credentials, generated stores or source workspaces."""
import argparse, gzip, hashlib, json, pathlib, subprocess
p=argparse.ArgumentParser();p.add_argument('--runs',required=True);p.add_argument('--out',required=True);a=p.parse_args();source=pathlib.Path(a.runs);out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True);rows=[]
for d in sorted(source.iterdir()):
 result=d/'result.json'
 if not result.exists() or not result.stat().st_size:continue
 row=json.loads(result.read_text());events=[]
 for line in (d/'events.jsonl').read_text().splitlines():
  try:events.append(json.loads(line))
  except json.JSONDecodeError:pass
 calls=[e for e in events if e.get('type')=='tool_execution_start'];keys=[json.dumps([e.get('toolName'),e.get('args')],sort_keys=True) for e in calls]
 row['repeatedIdenticalCalls']=len(keys)-len(set(keys));row['toolErrors']=sum(e.get('message',{}).get('isError',False) for e in events if e.get('type')=='message_end');row['sourceReadsNote']='read tool calls only; bash reads/searches are recorded in tools but not converted to file counts'
 target=out/d.name;target.mkdir(exist_ok=True)
 for name in ['answer.md','stderr.txt','generation.json','generation.stderr']:
  f=d/name
  if f.exists():(target/name).write_bytes(f.read_bytes())
 raw=(d/'events.jsonl').read_bytes();(target/'events.jsonl.gz').write_bytes(gzip.compress(raw,mtime=0));row['transcriptSha256']=hashlib.sha256(raw).hexdigest()
 if row['task']=='edit':
  diff=subprocess.check_output(['git','diff','--','src/tools/codewiki/code-nav.ts','tests/contracts/code-nav.test.ts'],cwd=d/'workspace');(target/'change.patch').write_bytes(diff)
 (target/'result.json').write_text(json.dumps(row,indent='\t')+'\n');rows.append(row)
if (source/'source.json').exists():(out/'source.json').write_bytes((source/'source.json').read_bytes())
(out/'results.json').write_text(json.dumps(rows,indent='\t')+'\n')
print(f'Exported {len(rows)} completed runs; home/config/state/workspace directories excluded.')
