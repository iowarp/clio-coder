#!/usr/bin/env python3
"""Create disposable pinned snapshots and run the same mechanical protocol on either implementation."""
import argparse,json,pathlib,shutil,subprocess
p=argparse.ArgumentParser();p.add_argument('--implementation',required=True);p.add_argument('--source',required=True);p.add_argument('--revision',required=True);p.add_argument('--out',required=True);p.add_argument('--repeats',type=int,default=3);a=p.parse_args()
impl=pathlib.Path(a.implementation).resolve();source=pathlib.Path(a.source).resolve();out=pathlib.Path(a.out).resolve()
if out.is_relative_to(impl) or out.is_relative_to(source):p.error('--out must be outside the implementations and source')
archive=subprocess.check_output(['git','archive',a.revision],cwd=source)
for r in range(a.repeats):
 d=out/str(r);w=d/'workspace';results=d/'results'
 if (results/'metrics.json').exists():continue
 if d.exists():shutil.rmtree(d)
 w.mkdir(parents=True);subprocess.run(['tar','-x','-C',str(w)],input=archive,check=True)
 subprocess.run(['git','init','-q'],cwd=w,check=True);subprocess.run(['git','add','.'],cwd=w,check=True);subprocess.run(['git','-c','user.name=Benchmark','-c','user.email=bench@local','commit','-qm','snapshot'],cwd=w,check=True)
 (w/'.context-benchmark-workspace').touch()
 # The script belongs to the candidate; root selects the runtime implementation.
 runner=pathlib.Path(__file__).with_name('mechanical.mts').resolve()
 with open(d/'stdout.json','w') as output:
  subprocess.run(['node','--import',str(impl/'node_modules/tsx/dist/loader.mjs'),str(runner),str(impl),str(w),str(results)],cwd=impl,stdout=output,check=True)
 print(f'{a.implementation} repeat {r} complete',flush=True)
