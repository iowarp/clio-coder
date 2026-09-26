#!/usr/bin/env python3
"""One-token local/provider probes to count equivalent retrieved views with the serving tokenizer."""
import argparse,json,pathlib,time,urllib.request
p=argparse.ArgumentParser();p.add_argument('--endpoint',required=True);p.add_argument('--model',required=True);p.add_argument('--formats',required=True);p.add_argument('--names',default='empty,json,pretty-json,toml,toon,xml,poml');a=p.parse_args();root=pathlib.Path(a.formats);rows=[]
for name in a.names.split(','):
 content='' if name=='empty' else (root/(name+'.txt')).read_text()
 body={'model':a.model,'messages':[{'role':'user','content':content or ' '}],'max_tokens':1,'temperature':0,'reasoning_effort':'low','stream':False};start=time.monotonic()
 try:
  request=urllib.request.Request(a.endpoint.rstrip('/')+'/chat/completions',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(request,timeout=45) as response: result=json.load(response)
  row={'name':name,'usage':result.get('usage'),'responseModel':result.get('model'),'elapsedMs':(time.monotonic()-start)*1000}
 except Exception as e:row={'name':name,'error':str(e),'elapsedMs':(time.monotonic()-start)*1000}
 rows.append(row);print(json.dumps(row),flush=True)
(root/'provider-tokens.json').write_text(json.dumps({'model':a.model,'endpoint':a.endpoint,'note':'Serving-provider input usage includes the common chat template. Empty control uses one space. One-token completion probes are token accounting, not agent task performance.','rows':rows},indent=2)+'\n')
