#!/usr/bin/env python3
"""Use the existing real-PTY boot bench with installed packages and offline post-install migration."""
import argparse,pathlib,subprocess
p=argparse.ArgumentParser();p.add_argument('--implementation',required=True);p.add_argument('--harness',required=True);p.add_argument('--workspace',required=True);p.add_argument('--out',required=True);a=p.parse_args();impl=pathlib.Path(a.implementation).resolve();harness=pathlib.Path(a.harness).resolve();out=pathlib.Path(a.out).resolve()
if out.is_relative_to(impl) or out.is_relative_to(harness):p.error('--out must be external')
out.mkdir(parents=True,exist_ok=True);script=(harness/'scripts/bench-boot.ts').read_text().replace('[CLI, "upgrade"]','[CLI, "upgrade", "--post-install"]');script=script.replace('const runs: Run[] = [];','const runs: Run[] = [];').replace('\n\tconsole.log(\n\t\t`median:', '\n\tconsole.log(JSON.stringify({runs}));\n\tconsole.log(\n\t\t`median:');(out/'bench-boot.mts').write_text(script)
link=out/'node_modules'
if not link.exists():link.symlink_to(harness/'node_modules',target_is_directory=True)
with open(out/'results.log','w') as log:subprocess.run(['node','--import',str(harness/'node_modules/tsx/dist/loader.mjs'),str(out/'bench-boot.mts'),'--runs','3','--cwd',a.workspace,'--cli',str(impl/'dist/cli/index.js')],stdout=log,stderr=subprocess.STDOUT,check=True)
