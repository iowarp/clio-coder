---
name: arxiv-literature
description: Searches arXiv, summarizes or compares papers, and builds a compact literature survey as citation-ready, source-linked paper cards, with BibTeX export and ID verification through the CiteNexus server when the literature pack is installed. Fetches arXiv directly by default and dispatches the researcher shadow agent only when the user asks for a deep or broad survey.
triggers:
  - search arXiv
  - summarize an arXiv paper
  - compare these papers
  - find recent research papers
  - build a literature survey
  - bibtex for this arxiv paper
version: 0.6.1
license: Apache-2.0
allowed-tools:
  - web_fetch
  - gateway
  - mcp_cite-nexus__get-citation
  - mcp_cite-nexus__batch-citations
  - mcp_cite-nexus__verify-citation
  - dispatch
  - read
  - grep
  - find
  - ls
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/research/arxiv-literature
  audit: pass
  model-size: any
  agents:
    - researcher
---

# ArXiv Literature

Find, summarize, or compare academic papers without flooding the main context
window. Raw search results and paper text stay in a worker or get compressed
immediately; only paper cards reach the user.

## Arguments

```text
/skill arxiv-literature <request>
```

The request is free text: a paper URL/ID, a topic, or two or more IDs to
compare. There is no operator in a headless run: `ask_user` is not registered, so
any call is refused as an unregistered tool rather than answered. If the request is ambiguous (no
clear topic, an ID that doesn't resolve), state your best reading and
proceed; never stall waiting for clarification. `tasks` sits outside this
skill's tool surface and is refused; the steps below are the whole plan, do
not open a task list for them.

## Step 1 — Classify the request

Pick exactly one:

- **Single paper**: one arXiv URL/ID, "summarize this paper", "explain this paper".
- **Search**: "find papers about X", "search arxiv for X", "latest papers on X".
- **Compare**: two or more paper URLs/IDs, "compare these papers".
- **Survey**: "what is the literature on X", "best papers for X".

## Step 2 — Pick the vehicle

Default every request (single paper, search, compare, and survey alike) to
`web_fetch` directly against arXiv:

- Paper URL/ID: fetch the arXiv page. Clio normalizes it into structured
  metadata plus AlphaXiv enrichment when available.
- Topic, compare, or survey: fetch the arXiv Atom API; Clio compacts the XML
  into paper cards:

  ```text
  https://export.arxiv.org/api/query?search_query=abs:%22PHRASE%22+AND+abs:TERM+AND+abs:TERM&sortBy=submittedDate&sortOrder=descending&start=0&max_results=10
  ```

  arXiv ORs bare words: `all:learned I/O prediction` becomes
  `all:learned OR all:I/O OR all:prediction`, and a date sort then returns the
  newest unrelated papers. Build `search_query` from two to four distinctive
  terms, each with its own field prefix (`abs:` abstract, `ti:` title,
  `cat:cs.DC` category), joined with `+AND+`, and quote a multi-word phrase as
  `%22two+words%22`. If the results are off-topic, drop the least essential
  term or switch to `sortBy=relevance` before concluding that no papers exist.

  For a compare request, run one query per paper ID (`id_list=ID` instead of
  `search_query`) or one broader query covering all of them, whichever stays
  inside the fetch cap in Step 3.

When a search needs a `cat:` term, read references/arxiv-categories.md.

**Only dispatch the `researcher` shadow agent when the user explicitly asks
for a deep or broad survey** ("survey the field", "don't just skim arXiv, go
wide"), never as the default for an ordinary search or compare. Left
unbounded, a dispatched worker has no arXiv-only restriction and no fetch
budget of its own, and will wander into Semantic Scholar, DBLP, OpenAlex, and
general web search, taking several minutes to return nothing useful. When you
do dispatch, state the same bound this skill uses directly, in the task
prompt itself: read references/dispatch-prompt.md and send that prompt.

If dispatch is unavailable, fall back to the direct `web_fetch` path above.

## Step 3 — Return paper cards only

Never paste raw Atom XML or full paper text into the response. Output format:

```markdown
## Literature Result

### Query
...

### Best Matches / Papers
1. **Title** — authors, date, `arxiv:id`
   - Problem:
   - Method:
   - Evidence:
   - Limitation:
   - Relevance:
   - Links:

### Recommendation
- Read:
- Skim:
- Skip:
```

Done when every returned paper has a card with a working link and the
recommendation section is filled in. Stop after one search round unless the
user asks to go deeper; do not keep fetching to "be thorough". One round
means at most two Atom API fetch attempts total: the initial query plus one
refinement, or one retry of a failed fetch. Failed attempts (timeout, 429,
connection error) count against this cap the same as successful ones; a
timeout is not a free retry. Rewording the same query a third time, or
retrying through a different host/scheme (`http` vs `https`,
`export.arxiv.org` vs `arxiv.org/search`, an unofficial JSON mirror) after a
failure, is thrash: build cards from whatever the attempts returned, or
report the network failure plainly and stop.

## Gotchas

- arXiv Atom is XML, not JSON; fetch it through `web_fetch` so Clio compacts it.
- `lastUpdatedDate` surfaces old papers with trivial edits; use `submittedDate`
  for newly submitted work.
- AlphaXiv is AI-generated enrichment: useful for scanning, never citable as
  authoritative.
- Fetch or enrich only the top candidates, not every result.
- `export.arxiv.org` rate-limits (HTTP 429) under repeated hits; that is a
  reason to stop at the fetch cap, not a reason to retry against a mirror.
- This skill's tool surface has no file-writing tool and no `artifact`. The
  paper cards are the chat reply, never a document; do not go looking for a
  way to save one.
- When vetting a draft reply or dispatch prompt, read references/red-flags.md.
- For a BibTeX, RIS or CSL-JSON entry, or to check a cited ID, read references/citations.md.
