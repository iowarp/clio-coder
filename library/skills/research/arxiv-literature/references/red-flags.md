# Red flags

- Dispatching `researcher` for an ordinary search or compare "just in case"
  it does a better job than a direct fetch — it is slower and unbounded by
  default; reserve it for an explicit deep-survey ask.
- A dispatch task prompt without the arXiv-only, fetch-capped instruction —
  that omission is what let a prior run wander into Semantic Scholar, DBLP,
  and OpenAlex for minutes with nothing to show for it.
- Treating a timeout or 429 as free of the fetch cap and retrying against a
  different host, scheme, or unofficial mirror instead of stopping.
- Raw Atom XML, a full abstract dump, or more than the top few candidates
  reaching the final reply.
- Reaching for `artifact` or any write tool to "save" the result — it is not
  in this skill's tool surface; the reply is the deliverable.
