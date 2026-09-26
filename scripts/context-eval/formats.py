#!/usr/bin/env python3
"""Complete XML/POML wrapper comparisons and tokenizer measurements; no model call."""
import argparse, hashlib, html, json, pathlib, statistics, time, xml.etree.ElementTree as ET
import tiktoken
p=argparse.ArgumentParser();p.add_argument('--results',required=True);a=p.parse_args();root=pathlib.Path(a.results)
original=json.loads((root/'json.txt').read_text())
def element(v):
 if isinstance(v,dict): return '<object>'+''.join('<field name="'+html.escape(k,quote=True)+'">'+element(x)+'</field>' for k,x in v.items())+'</object>'
 if isinstance(v,list): return '<array>'+''.join(element(x) for x in v)+'</array>'
 if v is None: return '<null/>'
 if isinstance(v,bool): return '<boolean>'+str(v).lower()+'</boolean>'
 if isinstance(v,(int,float)): return '<number>'+json.dumps(v)+'</number>'
 return '<string>'+html.escape(v,quote=False)+'</string>'
def decode(e):
 if e.tag=='object': return {c.attrib['name']:decode(c[0]) for c in e}
 if e.tag=='array': return [decode(c) for c in e]
 if e.tag=='null': return None
 if e.tag in ('number','boolean'): return json.loads(e.text)
 return e.text or ''
rows=json.loads((root/'node-results.json').read_text())
for name,enc,dec in [('xml',element,lambda s:decode(ET.fromstring(s))),('poml',lambda v:'<poml><text whiteSpace="pre">'+html.escape(json.dumps(v,separators=(',',':'),ensure_ascii=False),quote=False)+'</text></poml>',lambda s:json.loads(ET.fromstring(s)[0].text))]:
 t=time.perf_counter();body=enc(original);generation=(time.perf_counter()-t)*1000;times=[]
 for _ in range(5):
  t=time.perf_counter();v=dec(body);times.append((time.perf_counter()-t)*1000);assert v==original
 (root/(name+'.txt')).write_text(body)
 rows['rows'].append({'name':name,'bytes':len(body.encode()),'generatedMs':generation,'parseMs':times,'roundTrip':True,'parser':'Python ElementTree; POML wrapper extraction does not execute POML templating'})
for row in rows['rows']:
 body=(root/(row['name']+'.txt')).read_text();row['tokenCounts']={name:len(tiktoken.get_encoding(name).encode(body,disallowed_special=())) for name in ['o200k_base','cl100k_base']}
row={'note':'Tokenizer measurements are comparison proxies for OpenAI encodings, not measured local Qwopus provider tokens. Whole-index payloads exceed the local model context; ordinary prompts never send them. POML is a presentation wrapper, not a native typed index serializer.','tiktoken':tiktoken.__version__};rows.update(row)
(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps(rows,indent=2))
