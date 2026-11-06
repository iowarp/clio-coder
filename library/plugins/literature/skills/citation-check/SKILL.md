---
name: citation-check
description: "Checks every citation in a bibliography or draft against scholarly records: extracts BibTeX entries, DOIs and arXiv IDs offline, verifies each through the CiteNexus server (Crossref, DataCite, Europe PMC, arXiv), and reports VERIFIED, MISMATCH, NOT_FOUND, UNAVAILABLE or UNVERIFIABLE with the evidence. Also resolves a DOI or arXiv ID to BibTeX. Never edits the bibliography."
---

# Citation check

Find out whether each cited work exists and matches what the citation claims:
its identifier, title and year. A verified citation shows only that the work
exists and the metadata agrees. It does not show that the paper supports the
sentence that cites it. Never edit or delete a citation yourself; report, and
let the author decide.

## Phase 1 - Extract, offline

Run the bundled extractor with `run_script` (or with `bash` and `python3` when
the pack is installed outside the workspace):

```text
run_script(interpreter="python3",
           script="${pluginRoot}/assets/scripts/extract_citations.py",
           args=["--json", "<refs.bib>", "<draft.md>"], inputs=["<refs.bib>", "<draft.md>"])
```

It reads `.bib` entries (key, title, year, DOI, arXiv `eprint`), plus every DOI
and arXiv ID in other text files. Each candidate carries its `identifier` and a
`verify_input`. Exit 0 means candidates were found, 1 means some have no
identifier and no title, and 2 means a file was unreadable or nothing was found.
It needs no network and writes nothing.

## Phase 2 - Verify through CiteNexus

`gateway(op="find", query="cite-nexus")`. The server needs the operator's
`clio-coder mcp trust cite-nexus`; if it is missing or untrusted, use Phase 3.

- For each candidate, `mcp_cite-nexus__verify-citation` with
  `citation` = the candidate's `verify_input`, plus `expected_title` and
  `expected_year` from the BibTeX fields when present.
- To resolve or export, use `mcp_cite-nexus__resolve-paper` (`identifier`:
  a DOI, `arxiv:<id>`, `PMID:<n>`), or `mcp_cite-nexus__get-citation` with
  `format` `bibtex`, `ris` or `csl-json`. `batch-citations` takes up to 20
  `identifiers`.

All of these tools only read, and they run without asking. Map each result's
`status`:

| status | Verdict | Meaning |
| --- | --- | --- |
| `verified` | VERIFIED | The identifier resolves, and the supplied title and year agree |
| `mismatch` | MISMATCH | The work exists, but a field differs; quote its `differences` |
| `not_found` | NOT_FOUND | No source record matched; inspect it by hand |
| `unavailable` | UNAVAILABLE | Every provider failed (offline, rate-limited); inconclusive |

A candidate with no identifier and no title is UNVERIFIABLE. A candidate with
only a title can be searched with `mcp_cite-nexus__search-papers`; a title
match is a lead, not a verification.

## Phase 3 - Fallback without the server

Use `web_fetch` with GET requests:

- DOI: `https://api.crossref.org/works/<doi>`. Compare `message.title[0]` and
  `message.issued.date-parts[0][0]` with the citation. A 404 there may be a
  DataCite DOI: try `https://api.datacite.org/dois/<doi>`. Then
  `https://doi.org/api/handles/<doi>` tells whether the DOI is registered at all
  (`responseCode` 1 means registered, 100 means not found).
- arXiv: `https://export.arxiv.org/api/query?id_list=<id>`. Make at most one
  request every three seconds.

Fetch only the candidates that need it, at most one request per candidate.

## Offline

Phase 1 always works. Without network, CiteNexus answers each lookup with
status `unavailable` and names every provider's `network_error`, and
`web_fetch` fails. Report those citations as UNAVAILABLE, offline. Never
report them as NOT_FOUND, and never guess.

## Final answer

A table with one row per candidate: key or location, identifier, verdict, and
evidence (the provider, plus the differing field for a MISMATCH). Below it, the
count per verdict, and the line: "Verified means the record exists and matches;
it does not check that the source supports the claim."
