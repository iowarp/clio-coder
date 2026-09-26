#!/usr/bin/env python3
"""Join explicitly audited correctness with measurements; never infer correctness from keywords or exit code."""
import argparse,json,pathlib,statistics
p=argparse.ArgumentParser();p.add_argument('--evidence',required=True);p.add_argument('--judgments',required=True);p.add_argument('--out',required=True);a=p.parse_args();root=pathlib.Path(a.evidence);judgments=json.loads(pathlib.Path(a.judgments).read_text());rows=[]
for f in sorted(root.glob('*/results.json')):
 for r in json.loads(f.read_text()):
  key=f.parent.name+'/'+str(r['repeat'])+'-'+r['condition']+'-'+r['task'];j=judgments[key];assert len(j['criteria'])==4 and all(type(x)==bool for x in j['criteria'])
  rows.append({**r,'key':key,'score':sum(j['criteria']),'correct':all(j['criteria']) and r['exitCode']==0,'audit':j})
summary=[]
for project in sorted(set(r['project'] for r in rows)):
 for condition in sorted(set(r['condition'] for r in rows if r['project']==project)):
  sub=[r for r in rows if r['project']==project and r['condition']==condition]
  med=lambda values:statistics.median(values)
  summary.append({'project':project,'condition':condition,'runs':len(sub),'correct':sum(r['correct'] for r in sub),'rubricPoints':sum(r['score'] for r in sub),'maxPoints':4*len(sub),'runtimeSuccess':sum(r['exitCode']==0 for r in sub),'medianElapsedMs':med([r['elapsedMs'] for r in sub]),'medianInputTokens':med([r['usage']['input'] for r in sub]),'medianOutputTokens':med([r['usage']['output'] for r in sub]),'medianTotalTokens':med([r['usage']['totalTokens'] for r in sub]),'medianToolCalls':med([r['toolCalls'] for r in sub]),'medianReadCalls':med([r['sourceReads'] for r in sub]),'medianRepeatedCalls':med([r['repeatedIdenticalCalls'] for r in sub]),'measuredUsageRuns':sum(r['providerUsageMeasured'] for r in sub),'gatewayRetries':sum(r['gatewayRetries'] for r in sub)})
pathlib.Path(a.out).write_text(json.dumps({'summary':summary,'runs':rows},indent='\t')+'\n')
print(json.dumps(summary,indent=2))
