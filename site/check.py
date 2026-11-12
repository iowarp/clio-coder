#!/usr/bin/env python3
"""Check generated pages, metadata, assets, and the internal link graph."""
import base64
import hashlib
import json
import re
import struct
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
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
link_ref = product.get('linkRef') or docs_source['ref']
source_tree = f"{repository}/tree/{link_ref}"
doc_sources = {item["path"]: item["source"] for item in manifest["files"]}
errors = []
for private in ('content/docs', 'content/doc-summaries', 'content/tutorials', 'content/research', 'content/drafts', 'review', 'vendor', 'cards', 'capture'):
    if (root / private).exists():
        errors.append(f'Private source directory entered the public output: {private}')
for private in ('assets/brand/provenance.json', 'assets/logo.webp', 'assets/banner.webp'):
    if (root / private).exists():
        errors.append(f'Private or legacy brand asset entered the public output: {private}')
public_copyright = json.loads((site / 'design-system.json').read_text())['copyright']


def png_size(path):
    header = path.read_bytes()[:24]
    if header[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', header[16:24])


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.path = path
        self.ids = set()
        self.refs = []
        self.canonical = None
        self.lang = None
        self.alternates = {}
        self.webmanifest = None
        self.robots = None
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
        if tag == 'html':
            self.lang = a.get('lang')
        if tag == 'link' and a.get('rel') == 'alternate':
            self.alternates[a.get('hreflang')] = a.get('href')
        if tag == 'link' and a.get('rel') == 'manifest':
            self.webmanifest = a.get('href')
        if tag == 'meta' and a.get('name') == 'robots':
            self.robots = a.get('content')
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonical = a.get('href')
        elif tag in ('a', 'link') and 'href' in a:
            self.refs.append(a['href'])
        if tag in ('img', 'script', 'iframe') and 'src' in a:
            self.refs.append(a['src'])
        if tag == 'img':
            if not a.get('width') or not a.get('height'):
                errors.append(f'{self.path}: image has no intrinsic dimensions')
            if a.get('srcset'):
                self.refs.extend(candidate.strip().split()[0] for candidate in a['srcset'].split(','))
                if not a.get('sizes'):
                    errors.append(f'{self.path}: responsive image has no sizes')
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

sitemap = ET.parse(root / 'sitemap.xml').getroot()
if sitemap.tag != '{http://www.sitemaps.org/schemas/sitemap/0.9}urlset':
    errors.append('sitemap.xml must be a sitemaps.org 0.9 urlset')
urls = []
for entry in sitemap:
    loc = entry.find('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')
    lastmod = entry.find('{http://www.sitemaps.org/schemas/sitemap/0.9}lastmod')
    if entry.tag != '{http://www.sitemaps.org/schemas/sitemap/0.9}url' or loc is None or not loc.text.startswith(origin + '/'):
        errors.append('Sitemap entries must be url elements with an absolute loc on the site origin')
        continue
    if lastmod is not None and not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})', lastmod.text or ''):
        errors.append(f'{loc.text}: sitemap lastmod is not a W3C datetime')
    urls.append(loc.text)
if len(urls) != len(set(urls)):
    errors.append('Sitemap contains duplicate URLs')
# Every published HTML page is either a public page listed in the sitemap, the
# 404 page, or a generated redirect that names its target as canonical.
redirects = json.loads((site / 'redirects.json').read_text())
for file in sorted(root.rglob('*.html')):
    path = '/' + file.relative_to(root).as_posix()
    url = origin + ('/' if path == '/index.html' else path)
    if path in redirects:
        text = file.read_text()
        target = redirects[path]
        target_path, _, target_anchor = target.partition('#')
        target_file = root / ('index.html' if target_path == '/' else target_path.lstrip('/'))
        if url in urls or '<meta name="robots" content="noindex">' not in text or f'<link rel="canonical" href="{origin}{target}">' not in text:
            errors.append(f'{path}: redirect must be noindex, name its target as canonical, and stay out of the sitemap')
        if not target_file.is_file() or (target_anchor and f'id="{target_anchor}"' not in target_file.read_text()):
            errors.append(f'{path}: redirect target {target} does not exist')
    elif path != '/404.html' and url not in urls:
        errors.append(f'{path}: published page is missing from the sitemap')
pages = {}
for collection in ('tutorials', 'research'):
    for item in json.loads((site / f'content/{collection}.json').read_text()):
        if f"{origin}/{collection}/{item['slug']}.html" not in urls:
            errors.append(f"{collection}/{item['slug']}: registered article is missing from sitemap")
if origin + '/research.html' not in urls:
    errors.append('Research listing is missing from sitemap')
if origin + '/404.html' in urls:
    errors.append('404 must not be listed in sitemap')
# The page policy as published before recordings, byte for byte; only the theme script's hash varies.
BASE_POLICY = ("default-src 'self'; script-src 'self' {theme} https://static.cloudflareinsights.com; style-src 'self'; "
               "img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; "
               "frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'none'")
theme_script = re.search(r'<script>(.*?)</script>', (root / 'index.html').read_text(), re.S)
base_policy = BASE_POLICY.format(theme="'sha256-" + base64.b64encode(hashlib.sha256((theme_script.group(1) if theme_script else '').encode()).digest()).decode() + "'")
cast_pages = []
for url in [*urls, origin + '/404.html']:
    path = urlsplit(url).path
    file = root / ('index.html' if path == '/' else path.lstrip('/'))
    if not file.is_file():
        errors.append(f'{path}: sitemap points to a missing file')
        continue
    page = Page(path)
    source = file.read_text()
    page.feed(source)
    if re.search(r'<a(?![^>]*\shref=)(?:\s[^>]*)?>', source):
        errors.append(f'{path}: a link has no href, so crawlers cannot follow it')
    if public_copyright not in source:
        errors.append(f'{path}: public copyright wording is missing')
    policy = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', source)
    # Only pages that embed a recording may compile WebAssembly; every other page keeps the base policy exactly.
    has_cast = 'data-cast="' in source
    expected_policy = base_policy.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") if has_cast else base_policy
    if not policy or policy.group(1) != expected_policy:
        errors.append(f"{path}: the page policy is not the {'recording' if has_cast else 'base'} policy")
    if has_cast:
        cast_pages.append((path, source))
    elif '/js/cast.js' in source or 'asciinema-player' in source:
        errors.append(f'{path}: a page without a recording loads the player')
    for script in re.findall(r'<script>(.*?)</script>', source, re.S):
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        if not policy or f"'sha256-{digest}'" not in policy.group(1) or 'unsafe-inline' in policy.group(1):
            errors.append(f'{path}: an inline script is not allowed by its exact hash in the page policy')
    # Published assets are cached by URL, so each reference names the bytes it expects.
    assets = re.findall(r'\s(?:href|src|poster|data-src|data-light-src|data-cast|data-player-src|data-player-css|data-cast-css)="(/(?:css|js|assets)/[^"]+)"', source)
    assets += re.findall(r'(?:srcset="|, )(/assets/\S+) \d+w', source)
    for ref in assets:
        asset, _, version = ref.partition('?v=')
        file = root / asset.lstrip('/')
        if file.suffix in ('.css', '.js', '.woff2', '.png', '.webp', '.jpg', '.jpeg', '.svg', '.ico', '.mp4', '.cast') and file.is_file() and version != hashlib.sha256(file.read_bytes()).hexdigest()[:10]:
            errors.append(f'{path}: {ref} does not carry the hash of the published file')
    first_card = re.search(r'<a class="tutorial-card"[^>]*><img [^>]*>', source)
    if first_card and ('loading="lazy"' in first_card.group(0) or 'fetchpriority="high"' not in first_card.group(0)):
        errors.append(f'{path}: the first listing image is the likely LCP element and must load eagerly with high priority')
    page.title = page.title.strip()
    pages[path] = page
    if page.canonical != url:
        errors.append(f'{path}: canonical {page.canonical} differs from sitemap {url}')
    if page.lang != 'en' or page.alternates:
        errors.append(f'{path}: the page must declare lang="en" and no hreflang alternates (the site is not localized)')
    if page.webmanifest != '/site.webmanifest':
        errors.append(f'{path}: missing web manifest')
    if path == '/404.html' and page.robots != 'noindex':
        errors.append('404 must be noindex')
    if not page.title or not page.description:
        errors.append(f'{path}: missing title or description')
    for key, value in [('og:title', page.title), ('twitter:title', page.title), ('og:description', page.description), ('twitter:description', page.description), ('og:url', url)]:
        if page.social.get(key) != value:
            errors.append(f'{path}: {key} does not match page metadata')
    preview = page.social.get('og:image') or ''
    preview_file = root / urlsplit(preview).path.lstrip('/')
    if not preview.startswith(origin + '/') or page.social.get('twitter:image') != preview or not preview_file.is_file():
        errors.append(f'{path}: og:image must be a published image on this site, shared with twitter:image')
    elif png_size(preview_file) != (1200, 630) or (page.social.get('og:image:width'), page.social.get('og:image:height')) != ('1200', '630'):
        errors.append(f'{path}: og:image must be a 1200x630 PNG with matching declared dimensions')
    if not page.social.get('og:image:alt') or page.social.get('twitter:image:alt') != page.social.get('og:image:alt'):
        errors.append(f'{path}: social preview needs the same alt text for og and twitter')
    if page.doc_path and page.doc_source != f"{repository}/blob/{link_ref}/{doc_sources.get(page.doc_path)}":
        errors.append(f'{path}: source link points to the wrong document')
    if page.doc_path and (
        page.snapshot_source != source_tree
        or page.snapshot_version != docs_source['version']
        or page.snapshot_ref != docs_source['ref']
        or page.snapshot_commit != docs_source['commit']
    ):
        errors.append(f'{path}: visible documentation provenance differs from the manifest')
    try:
        graph = json.loads(''.join(page.jsonld))['@graph']
        entity = next(node for node in graph if node.get('@id') == f'{url}#page')
        if entity.get('url') != url or entity.get('name') != page.title or entity.get('description') != page.description:
            errors.append(f'{path}: structured page metadata differs from the HTML')
        if path not in ('/', '/404.html'):
            crumbs = next(node for node in graph if node.get('@type') == 'BreadcrumbList')['itemListElement']
            if [item['position'] for item in crumbs] != list(range(1, len(crumbs) + 1)) or crumbs[-1]['item'] != url:
                errors.append(f'{path}: structured breadcrumbs are not a valid path to this page')
        if entity.get('@type') in ('Article', 'TechArticle') and entity.get('dateModified'):
            modified, published = entity['dateModified'], entity.get('datePublished')
            if not published or datetime.fromisoformat(published) > datetime.fromisoformat(modified):
                errors.append(f'{path}: datePublished must exist and not follow dateModified')
            if f'<time datetime="{modified}">' not in source:
                errors.append(f'{path}: the visible Updated date differs from dateModified')
        if path.startswith(('/tutorials/', '/research/')) and (entity.get('@type') != 'Article' or not entity.get('headline') or not entity.get('author')):
            errors.append(f'{path}: tutorial article metadata is incomplete')
        if path == '/':
            software = next(node for node in graph if node.get('@type') == 'SoftwareSourceCode')
            if software.get('version') != product['version']:
                errors.append('Software source metadata differs from the site version')
            application = next(node for node in graph if node.get('@type') == 'SoftwareApplication')
            if application.get('softwareVersion') != product['publishedVersion']:
                errors.append('Software application metadata differs from the published version')
    except (ValueError, TypeError, KeyError, StopIteration):
        errors.append(f'{path}: missing or invalid structured data')
    if path.startswith('/docs') and ('data-doc=' not in source or 'Opening the page' in source):
        errors.append(f'{path}: documentation is not rendered in the HTML')
if len({p.title for p in pages.values()}) != len(pages):
    errors.append('Page titles are not unique')
if len({p.description for p in pages.values()}) != len(pages):
    errors.append('Page descriptions are not unique')
# Search results cut longer titles and descriptions; very short descriptions get replaced.
# The overview carries the product description iowarp.ai uses, whose first sentence
# still stands alone when a search result cuts the rest.
for path, page in pages.items():
    longest = 240 if path == '/' else 160
    if len(page.title) > 65:
        errors.append(f'{path}: title is {len(page.title)} characters; keep it within 65')
    if not 70 <= len(page.description) <= longest:
        errors.append(f'{path}: description is {len(page.description)} characters; keep it between 70 and {longest}')
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
webmanifest = json.loads((root / 'site.webmanifest').read_text())
for icon in webmanifest.get('icons', []):
    if not (root / icon['src'].lstrip('/')).is_file():
        errors.append(f"Missing manifest icon: {icon['src']}")
if {icon['sizes'] for icon in webmanifest.get('icons', [])} != {'192x192', '512x512'}:
    errors.append('Manifest must provide 192px and 512px icons')
if f'Sitemap: {origin}/sitemap.xml' not in (root / 'robots.txt').read_text():
    errors.append('robots.txt must reference the canonical sitemap')
repository_root = site.parent
for installer in ('install.sh', 'install.ps1', 'install.cmd'):
    published = root / installer
    source = repository_root / 'scripts' / ('' if installer == 'install.cmd' else 'installer-bootstrap') / installer
    if not published.is_file() or published.read_bytes() != source.read_bytes():
        errors.append(f'{installer} is missing or differs from the release bootstrap')
if (root / 'CNAME').read_text().strip() != urlsplit(origin).hostname:
    errors.append('CNAME does not name the site origin')
if not (root / '.nojekyll').is_file():
    errors.append('.nojekyll is missing')
for installer in ('install.sh', 'install.ps1', 'install.cmd'):
    if f'/{installer}' in (root / 'sitemap.xml').read_text():
        errors.append(f'{installer} must not be listed in the sitemap')
faq = next((node for node in json.loads(''.join(pages['/'].jsonld))['@graph'] if node.get('@type') == 'FAQPage'), None)
if not faq or len(faq['mainEntity']) != (root / 'index.html').read_text().count('<details><summary>'):
    errors.append('The overview FAQ structured data must list every question on the page')
robots = (root / 'robots.txt').read_text()
for agent in ('Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot', 'Applebot-Extended', '*'):
    if f'User-agent: {agent}\n' not in robots:
        errors.append(f'robots.txt must name {agent} explicitly')
if len(re.findall(r'^User-agent:', robots, re.M)) and robots.count('\nAllow: /\n') != 1:
    errors.append('robots.txt must keep one shared group that allows the site')
for line in re.findall(r'^Disallow:\s*(\S*)', robots, re.M):
    if line in ('', '/') or line.startswith(('/css', '/js', '/assets', '/docs', '/tutorials', '/research', '/llms')):
        errors.append(f'robots.txt must not block pages, styles, scripts, or assets: Disallow: {line}')


def site_links(text, label):
    """Every link to this site in a Markdown file must reach a published file and anchor."""
    found = set()
    for href in re.findall(r'\]\((https://[^)\s]+)', text):
        url = urlsplit(href)
        if url.netloc != urlsplit(origin).netloc:
            continue
        target = unquote(url.path)
        file = root / ('index.html' if target == '/' else target.lstrip('/'))
        if not file.is_file():
            errors.append(f'{label}: link to a missing page {href}')
        elif url.fragment and target in pages and unquote(url.fragment) not in pages[target].ids:
            errors.append(f'{label}: link to a missing anchor {href}')
        found.add(origin + url.path)
    return found


articles = [u for u in urls if urlsplit(u).path.startswith(('/docs', '/tutorials/', '/research/'))]
llms = (root / 'llms.txt').read_text()
if not llms.startswith('# CLIO Coder\n\n> ') or '\n## ' not in llms:
    errors.append('llms.txt must open with an H1, a blockquote summary, and H2 link sections')
linked = site_links(llms, 'llms.txt')
for url in articles:
    if url not in linked:
        errors.append(f'llms.txt does not link {url}')
if origin + '/llms-full.txt' not in linked:
    errors.append('llms.txt must link llms-full.txt')
full = (root / 'llms-full.txt').read_text()
site_links(full, 'llms-full.txt')
for url in articles:
    if f'\nSource: {url}\n' not in full:
        errors.append(f'llms-full.txt is missing {url}')
def outside_code(text):
    # Markdown lines outside backtick or tilde code fences.
    lines, fence = [], None
    for line in text.split('\n'):
        marker = re.match(r'\s*(`{3,}|~{3,})', line)
        marker = marker and marker.group(1)
        if fence:
            if marker and marker[0] == fence[0] and len(marker) >= len(fence) and line.strip() == marker:
                fence = None
        elif marker:
            fence = marker
        else:
            lines.append(line)
    return '\n'.join(lines)
if re.search(r'^:::', outside_code(full), re.M):
    errors.append('llms-full.txt contains an unconverted guide directive')
for name, text in (('llms.txt', llms), ('llms-full.txt', full)):
    prose = outside_code(text)
    if '<!--' in prose or re.search(r'<a\s', prose):
        errors.append(f'{name} contains an unresolved template slot or HTML link')
for path in pages:
    if re.search(r'<p>:::', (root / ('index.html' if path == '/' else path.lstrip('/'))).read_text()):
        errors.append(f'{path}: an unconverted guide directive reached the page')
# Recordings: the player, its stylesheet and font ship only with pages that embed a cast,
# and the first press of Play on a page stays inside the media budget.
player = root / 'assets/player'
player_files = ['asciinema-player.min.js', 'asciinema-player.css', 'cast.css', 'cast-symbols.woff2']
if not cast_pages and (player.exists() or (root / 'js/cast.js').exists() or (root / 'css/cast.css').exists()):
    errors.append('The terminal player was published without a page that embeds a recording')
if cast_pages:
    sizes = {name: (root / ('css' if name == 'cast.css' else 'assets/player') / name).stat().st_size for name in player_files}
    if sizes['asciinema-player.min.js'] + sizes['asciinema-player.css'] > 600_000:
        errors.append('The terminal player exceeds its 600 KB budget')
    if sizes['cast-symbols.woff2'] > 25 * 1024:
        errors.append('Cast Symbols exceeds its 25 KB budget')
    for path, source in cast_pages:
        casts = [root / ref.partition('?')[0].lstrip('/') for ref in re.findall(r'\sdata-cast="([^"]+)"', source)]
        for cast in casts:
            if cast.stat().st_size > 300_000:
                errors.append(f'{path}: {cast.name} exceeds the 300 KB recording budget')
            header = json.loads(cast.read_text().split('\n', 1)[0])
            if header.get('version') != 2 or {'env', 'command', 'timestamp'} & header.keys():
                errors.append(f'{path}: {cast.name} must be asciicast v2 without env, command or timestamp')
        if casts and sum(sizes.values()) + max(cast.stat().st_size for cast in casts) > 1_500_000:
            errors.append(f'{path}: the first play exceeds the 1.5 MB recording media budget')
if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'Checked {len(pages)} pages: unique titles, canonical URLs, social previews, structured data, rendered docs, assets, internal links, sitemap coverage, robots.txt, and llms.txt.')
