---
name: arxiv-literature
description: Use when the user asks to search arXiv, summarize an arXiv paper, compare papers, find recent research, or build a compact literature survey. Delegates noisy paper retrieval to the Literature shadow agent when available and returns only citation-ready, source-linked paper cards.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - web_fetch
  - dispatch
  - read
  - grep
  - glob
  - ls
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/arxiv-literature
audit: pass
---

# ArXiv Literature

Find, summarize, or compare academic papers while protecting the main context window.

Prefer dispatching the `literature` shadow agent for searches, comparisons, and multi-paper synthesis. Use direct `web_fetch` only for a single known paper URL or when dispatch is unavailable.

## Route

- **Single paper**: arXiv URL/ID, “summarize this paper”, “explain this paper”
- **Search**: “find papers about X”, “search arxiv for X”, “latest papers on X”
- **Compare**: multiple paper URLs/IDs, “compare these papers”
- **Survey**: “what is the literature on X”, “best papers for X”

## Preferred workflow

### 1. Delegate noisy retrieval

Ask the `literature` shadow agent for a compact result:

```text
Research arXiv literature for: <user goal>.
Return only compact source-linked paper cards, comparison/synthesis, and read/skim/skip recommendations.
```

### 2. If doing it directly

For paper URLs, call `web_fetch` on the arXiv URL. Clio normalizes arXiv paper pages into structured metadata plus AlphaXiv enrichment when available.

For search, use arXiv Atom API:

```text
https://export.arxiv.org/api/query?search_query=all:QUERY&sortBy=submittedDate&sortOrder=descending&start=0&max_results=10
```

Useful categories:
- `cs.AI` artificial intelligence
- `cs.LG` machine learning
- `cs.CL` NLP/LLMs
- `cs.CR` security
- `cs.SE` software engineering
- `cs.MA` multi-agent systems
- `cs.IR` information retrieval/RAG
- `cs.CV` vision
- `cs.RO` robotics

### 3. Return compressed output

Do not paste raw Atom XML or entire paper text. Return:

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

## Gotchas

- arXiv Atom is XML, not JSON.
- `lastUpdatedDate` can surface old papers with small edits. Use `submittedDate` for newly submitted work.
- AlphaXiv is AI-generated enrichment; useful for scanning but not authoritative.
- Fetch/enrich only top candidates. Keep the main context small.
