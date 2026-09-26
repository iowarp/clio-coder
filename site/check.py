#!/usr/bin/env python3
"""Check generated pages, metadata, assets, and the internal link graph."""
import json
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / 'public').resolve()
site = Path(__file__).parent
product = json.loads((site / 'product.json').read_text())
origin = product['origin']
manifest = json.loads((root / 'content/docs-manifest.json').read_text())
docs_source = manifest['source']
repository = product['repository'].rstrip('/')
source_tree = f"{repository}/tree/{docs_source['ref']}/docs"
errors = []


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.path = path
        self.ids = set()
        self.refs = []
        self.canonical = None
        self.description = None
        self.social = {}
        self.doc_path = None
        self.doc_source = None
        self.snapshot_source = None
        self.snapshot_version = None
        self.snapshot_ref = None
        self.snapshot_commit = None
        self.jsonld = []
        self.in_jsonld = False
        self.title = ''
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if len(a) != len(attrs):
            errors.append(f'{self.path}: duplicate attributes on {tag}')
        if 'id' in a:
            if a['id'] in self.ids:
                errors.append(f'{self.path}: duplicate id {a["id"]}')
            self.ids.add(a['id'])
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonical = a.get('href')
        elif tag in ('a', 'link') and 'href' in a:
            self.refs.append(a['href'])
        if tag in ('img', 'script', 'iframe') and 'src' in a:
            self.refs.append(a['src'])
        if tag == 'meta' and a.get('name') == 'description':
            self.description = a.get('content')
        if tag == 'meta' and a.get('property', a.get('name', '')).startswith(('og:', 'twitter:')):
            self.social[a.get('property', a.get('name'))] = a.get('content')
        if a.get('id') == 'doc':
            self.doc_path = a.get('data-doc')
        if a.get('id') == 'doc-github':
            self.doc_source = a.get('href')
        if a.get('id') == 'doc-snapshot-source':
            self.snapshot_source = a.get('href')
            self.snapshot_version = a.get('data-source-version')
            self.snapshot_ref = a.get('data-source-ref')
            self.snapshot_commit = a.get('data-source-commit')
        if tag == 'title':
            self.in_title = True
        if tag == 'script' and a.get('type') == 'application/ld+json':
            self.in_jsonld = True

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if tag == 'script':
            self.in_jsonld = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.in_jsonld:
            self.jsonld.append(data)


if docs_source.get('version') != product.get('version'):
    errors.append('Documentation source version differs from product.json')
if not isinstance(docs_source.get('commit'), str) or len(docs_source['commit']) != 40:
    errors.append('Documentation source commit is not a full Git commit')
manifest_paths = [item.get('path') for item in manifest.get('files', [])]
index_paths = [item.get('path') for item in json.loads((root / 'content/index.json').read_text())]
if manifest_paths != index_paths:
    errors.append('Documentation index paths differ from the provenance manifest')
if any(path == 'wiki' or path.startswith('wiki/') for path in manifest_paths if isinstance(path, str)):
    errors.append('Generated Wiki content entered the product documentation manifest')

urls = [e.text for e in ET.parse(root / 'sitemap.xml').findall('.//{*}loc')]
if len(urls) != len(set(urls)):
    errors.append('Sitemap contains duplicate URLs')
pages = {}
for url in urls:
    path = urlsplit(url).path
    file = root / ('index.html' if path == '/' else path.lstrip('/'))
    if not file.is_file():
        errors.append(f'{path}: sitemap points to a missing file')
        continue
    page = Page(path)
    source = file.read_text()
    page.feed(source)
    page.title = page.title.strip()
    pages[path] = page
    if page.canonical != url:
        errors.append(f'{path}: canonical {page.canonical} differs from sitemap {url}')
    if not page.title or not page.description:
        errors.append(f'{path}: missing title or description')
    for key, value in [('og:title', page.title), ('twitter:title', page.title), ('og:description', page.description), ('twitter:description', page.description)]:
        if page.social.get(key) != value:
            errors.append(f'{path}: {key} does not match page metadata')
    if page.doc_path and page.doc_source != f"{repository}/blob/{docs_source['ref']}/docs/{page.doc_path}":
        errors.append(f'{path}: source link points to the wrong document')
    if page.doc_path and (
        page.snapshot_source != source_tree
        or page.snapshot_version != docs_source['version']
        or page.snapshot_ref != docs_source['ref']
        or page.snapshot_commit != docs_source['commit']
    ):
        errors.append(f'{path}: visible documentation provenance differs from the manifest')
    try:
        json.loads(''.join(page.jsonld))
    except (ValueError, TypeError):
        errors.append(f'{path}: missing or invalid structured data')
    if path.startswith('/docs') and ('data-doc=' not in source or 'Opening the page' in source):
        errors.append(f'{path}: documentation is not rendered in the HTML')
if len({p.title for p in pages.values()}) != len(pages):
    errors.append('Page titles are not unique')
if len({p.description for p in pages.values()}) != len(pages):
    errors.append('Page descriptions are not unique')
for path, page in pages.items():
    for ref in page.refs:
        url = urlsplit(urljoin(origin + path, ref))
        if url.scheme not in ('http', 'https') or url.netloc != urlsplit(origin).netloc:
            continue
        target = unquote(url.path)
        if target == '/index.html':
            target = '/'
        file = root / ('index.html' if target == '/' else target.lstrip('/'))
        if not file.is_file():
            errors.append(f'{path}: missing internal target {ref}')
        elif url.fragment and target in pages and unquote(url.fragment) not in pages[target].ids:
            errors.append(f'{path}: missing anchor {ref}')
if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'Checked {len(pages)} pages: unique titles, canonical URLs, structured data, rendered docs, assets, and internal links.')
