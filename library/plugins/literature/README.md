# Literature pack

Checks citations and turns paper identifiers into citation-ready entries. The
pack declares the CiteNexus MCP server (`cite-nexus-mcp` 0.2.3) and adds the
`citation-check` skill, plus an offline extractor for BibTeX and Markdown. It
requires the `arxiv-literature` skill package, which uses the same server for
BibTeX export and arXiv ID checks.

```bash
clio-coder library install plugin:literature --project --with-requirements
clio-coder mcp list                 # shows cite-nexus and its per-tool classes
clio-coder mcp trust cite-nexus
```

| Skill | What it does |
| --- | --- |
| `citation-check` | Extracts BibTeX entries, DOIs and arXiv IDs from `.bib`, `.tex` or `.md` files offline, verifies each through CiteNexus, and reports VERIFIED, MISMATCH, NOT_FOUND, UNAVAILABLE or UNVERIFIABLE, with the evidence for each. It never edits a bibliography. |
| `arxiv-literature` (required package) | Searches arXiv and writes paper cards. With CiteNexus installed it exports BibTeX, RIS or CSL-JSON and verifies arXiv IDs. |

## The server

`mcp.json` launches `uvx --from cite-nexus-mcp==0.2.3 cite-nexus-mcp --no-env-file`.
The package version is pinned. On first launch, uv resolves and installs its
dependencies into uv's cache, and later launches reuse that environment. Every
tool CiteNexus ships is declared `read`, so lookups run without asking: the
server writes no file, and it only queries scholarly services. A tool a later
release adds stays `unknown`, which asks. `uvx` must be on `PATH`.

The server uses only the free, key-free providers by default: Crossref,
DataCite and Europe PMC for search, and arXiv when a request names it or an
identifier is an arXiv ID. The pack sets no provider keys and stores no
credential. CiteNexus can use keyed providers (OpenAlex, Semantic Scholar
keys, SerpAPI, SearchApi, Scopus, Web of Science), but Clio passes an MCP
server only a safe allowlist of environment variables, so keys in your shell
never reach this server. To use one, write your own user-scope `mcp.yaml`
entry; that also means accepting that provider's terms.

When the server is absent or untrusted, the skills fall back to `web_fetch`
GET requests against the Crossref, DataCite, doi.org and arXiv APIs.

## Offline behavior

- The extractor (`assets/scripts/extract_citations.py`, stdlib Python 3.10+)
  needs no network and writes nothing.
- Every verification or resolution needs network. Offline, CiteNexus answers
  each lookup with status `unavailable` and names each provider's
  `network_error`. The skills report those citations as UNAVAILABLE, never as
  NOT_FOUND.
- The server needs one online launch to install its environment. After that it
  starts offline from uv's cache, and only its lookups fail.

## Data sources and their terms

| Source | Used for | Terms, as each source states them |
| --- | --- | --- |
| Crossref REST API (`api.crossref.org`) | DOI metadata, title and year checks | Crossref says "almost none of the metadata is subject to copyright, and you may use it for any purpose", and notes that some abstracts may be under publisher or author copyright. Anonymous use falls in the public pool (rate limit 5, concurrency 1); identifying with `mailto` moves you to the polite pool. See https://www.crossref.org/documentation/retrieve-metadata/rest-api/ and its access-and-authentication page. |
| DataCite (`api.datacite.org`) | DOIs for datasets, software and arXiv's `10.48550` DOIs | DataCite "asserts no claims of ownership to individual items of bibliographic metadata", and its website terms forbid systematic automated collection from the website without consent. See https://datacite.org/terms-and-conditions/. The API guide asks frequent API callers to send a `User-Agent`. |
| Europe PMC (EMBL-EBI) | Biomedical literature, PubMed and PMC identifiers | EMBL-EBI's terms of use apply: "the original data may be subject to rights claimed by third parties", EMBL-EBI expects attribution, and use that degrades the service for others can be blocked. See https://www.ebi.ac.uk/about/terms-of-use. |
| arXiv API (`export.arxiv.org`) | arXiv IDs, metadata and arXiv BibTeX | arXiv's API terms of use: descriptive metadata is CC0; make no more than one request every three seconds, one connection at a time; do not store and serve e-prints; do not imply arXiv endorses your project. See https://info.arxiv.org/help/api/tou.html. |
| doi.org handle API | Whether a DOI is registered at all (fallback only) | A public resolver lookup; the pack makes one request per DOI. |

CiteNexus itself is MIT-licensed. The pack is Apache-2.0 and bundles no
third-party code or data.
