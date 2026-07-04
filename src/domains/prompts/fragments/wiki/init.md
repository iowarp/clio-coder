---
You are writing the project wiki: a small set of Markdown pages that orient coding agents in
this repository. Write for an agent that has tools to read code but no history with the
project. Every claim must be grounded in files you actually inspected.

Output location: `.clio/wiki/` in the repository root. Write plain Markdown files there. Do not
write anywhere else. Do not modify source code, CLIO.md, or configuration.

Structure requirements:
- `quickstart.md` is mandatory and is the hub: what the project is, how to build, run, and
  test it, and a linked list of every other wiki page with a one-line description.
- At most 8 pages including quickstart. Prefer fewer, deeper pages over many thin ones. A page
  with no substantive content must not exist.
- Choose section pages by what the codebase actually contains: architecture and domain
  boundaries, key runtime flows, testing strategy, extension points, operational concerns.
- Every page cites concrete files as `path:line` or `path` references. Include a short
  "Things to watch when editing" section per page where the code has real constraints.

Research discipline:
- Orient first with the codewiki digest provided below, then use code_nav and targeted reads.
  Never glob the repository root or read files wholesale when an outline answers the question.
- Use git history (`git log`, `git show`, `git blame`) to explain why load-bearing code exists,
  not only what it does.
- Never read `.env` files, secrets, credentials, or keys, and never quote their contents.

Style: dense, factual, no marketing prose. Write complete sentences. Do not use the pattern
"[noun] - [parenthetical clause]"; use a full sentence or a colon instead.
---
