# Citation-ready entries and verification

Read this when a paper card needs a BibTeX, RIS or CSL-JSON entry, or when the
user asks whether a cited arXiv ID or DOI is real.

## With the CiteNexus server

The `literature` pack declares the `cite-nexus` MCP server (cite-nexus-mcp
0.2.2). Check with `gateway(op="find", query="cite-nexus")`.

- Export: `mcp_cite-nexus__get-citation` with `identifier` `arxiv:<id>` (or a
  DOI) and `format` `bibtex`, `ris` or `csl-json`. The entry is built from
  retrieved metadata and reports the fields it is missing. Never fill a missing
  field by hand.
- Several papers: `mcp_cite-nexus__batch-citations` with up to 20
  `identifiers`.
- Verify a cited ID: `mcp_cite-nexus__verify-citation` with `citation`
  `arxiv:<id>`, plus `expected_title` and `expected_year` from the card. The
  status is `verified`, `mismatch` (quote `differences`), `not_found`, or
  `unavailable` (no provider reachable, so it is inconclusive). For a whole
  bibliography, use the `citation-check` skill.

These tools only read and run without asking. arXiv versions normalize to the
base ID, so `1706.03762v5` resolves as `1706.03762`.

## Without the server

Build the entry from the Atom record the search already fetched; no extra
request is needed:

```bibtex
@misc{<firstauthor><year>,
  title         = {<title>},
  author        = {<Last, First> and <Last, First>},
  year          = {<year of the published date>},
  eprint        = {<id without version>},
  archivePrefix = {arXiv},
  primaryClass  = {<primary category>},
  doi           = {10.48550/arXiv.<id without version>}
}
```

arXiv registers a DataCite DOI of the form `10.48550/arXiv.<id>` for its
papers. To check one ID, `web_fetch`
`https://export.arxiv.org/api/query?id_list=<id>`. That counts against the
skill's two-fetch cap.

## Offline

Without network, neither path can verify anything. Report the entry as built
from metadata already in hand, and mark it unverified.
