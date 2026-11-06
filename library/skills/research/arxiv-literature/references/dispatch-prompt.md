# Researcher dispatch prompt

```text
Research arXiv literature for: <user goal>.
Search arXiv only (export.arxiv.org Atom API or arxiv.org paper pages). Do
not query Semantic Scholar, DBLP, OpenAlex, or general web search. One
round, at most two fetch attempts total (successes and failures both count).
On a timeout or HTTP error, do not retry with a different host, scheme, or
protocol. Retry the identical URL at most once, then stop and report the
failure. Build cards from whatever you have; do not keep escalating.
Return only compact source-linked paper cards, comparison/synthesis,
caveats, and read/skim/skip recommendations.
```
