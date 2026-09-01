---
name: arxiv-literature
description: Use when the user asks to search arXiv, summarize an arXiv paper, compare papers, find recent research, or build a compact literature survey. Prefer the Researcher shadow agent for noisy multi-paper retrieval; return only citation-ready, source-linked paper cards.
triggers:
  - search arXiv
  - summarize an arXiv paper
  - compare these papers
  - find recent research papers
  - build a literature survey
version: 0.3.1
license: Apache-2.0
allowed-tools:
  - web_fetch
  - dispatch
  - read
  - grep
  - find
  - ls
  - artifact
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/research/arxiv-literature
  audit: pass
  provenance: designed
  eval-status: smoke-checked
  model-size: any
  agents:
    - researcher
---

# ArXiv Literature

Find, summarize, or compare academic papers without flooding the main context
window. Raw search results and paper text stay in a worker or get compressed
immediately; only paper cards reach the user.

## Step 1 — Classify the request

Pick exactly one:

- **Single paper**: one arXiv URL/ID, "summarize this paper", "explain this paper".
- **Search**: "find papers about X", "search arxiv for X", "latest papers on X".
- **Compare**: two or more paper URLs/IDs, "compare these papers".
- **Survey**: "what is the literature on X", "best papers for X".

## Step 2 — Pick the vehicle

- **Search, compare, survey**: dispatch the `researcher` shadow agent. Task
  prompt:

  ```text
  Research arXiv literature for: <user goal>.
  Return only compact source-linked paper cards, comparison/synthesis,
  caveats, and read/skim/skip recommendations.
  ```

- **Single paper, or dispatch unavailable**: use `web_fetch` directly.
  - Paper URL/ID: fetch the arXiv page. Clio normalizes it into structured
    metadata plus AlphaXiv enrichment when available.
  - Search query: fetch the arXiv Atom API; Clio compacts the XML into paper
    cards:

  ```text
  https://export.arxiv.org/api/query?search_query=all:QUERY&sortBy=submittedDate&sortOrder=descending&start=0&max_results=10
  ```

Useful categories for `search_query`: `cs.AI` (AI), `cs.LG` (ML), `cs.CL`
(NLP/LLMs), `cs.CR` (security), `cs.SE` (software engineering), `cs.MA`
(multi-agent), `cs.IR` (retrieval/RAG), `cs.CV` (vision), `cs.RO` (robotics).

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
means at most two Atom API fetches: the initial query plus one refinement.
Rewording the same query a third time is thrash — build cards from what the
first two returned.

## Gotchas

- arXiv Atom is XML, not JSON; fetch it through `web_fetch` so Clio compacts it.
- `lastUpdatedDate` surfaces old papers with trivial edits; use `submittedDate`
  for newly submitted work.
- AlphaXiv is AI-generated enrichment: useful for scanning, never citable as
  authoritative.
- Fetch or enrich only the top candidates, not every result.
