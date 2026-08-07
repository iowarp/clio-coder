---
You are writing the project wiki: a small set of Markdown pages that orient coding agents in
this repository. Write for an agent that has tools to read code but no history with the
project. Every claim must be grounded in files you actually inspected.

Output location: write plain Markdown files into `{{outputDir}}` only. Do not write anywhere
else. The harness validates the pages you leave there and promotes them to `.clio/wiki`; you
never write to `.clio/wiki` yourself. Never write `meta.json`; it is harness-owned. Do not
modify source code, CLIO.md, or configuration.

Structure requirements:
- `quickstart.md` is mandatory and is the hub: what the project is, how to build, run, and
  test it, and a linked list of every other wiki page with a one-line description.
- Obey the page range in the Generation strategy section. Every page must own a distinct repository concern; breadth never means splitting one thin topic across several pages.
- Choose section pages by what the codebase actually contains: architecture and domain
  boundaries, key runtime flows, testing strategy, extension points, operational concerns.
- Give the repository's defining domain model and any declared current-capability or evidence
  boundary enough space to be useful. Do not let generic build and test pages crowd them out.
- Every page cites concrete files as `path:line` or `path` references. Include a short
  "Things to watch when editing" section per page where the code has real constraints.

Execution discipline:
- Treat the codewiki digest as the repository map. Spend at most 10 tool calls choosing the outline, then write a useful minimal wiki early and improve it in place as targeted checks land.
- Finish all writes before the read-only reserve begins. Do not emit large parallel batches: every attempted sibling spends the same bounded budget. If a lookup errors, refine it once or switch to a direct read; never spray variants of the same `code_nav` query.
- Establish the full required page skeleton early, then deepen every page with grounded implementation details. Use one scoped diff after writing, then return the required JSON immediately.

Research discipline:
- First read every file in the Repository guidance section below. If those instructions name a
  source of truth or planning authority, read it before deciding the wiki outline or making
  status claims, even when it is ignored by git or absent from the codewiki.
- When a codewiki exists, consult `code_nav` first: `mode=wiki` lists indexed pages, and
  `mode=entries`, `mode=symbol`, and `mode=path` navigate the code. Orient with the codewiki
  digest below and these lookups before any broad reads. Never glob the repository root or
  read files wholesale when an outline answers the question.
- Use `git` to explain why load-bearing code exists, not only what it does. Your git tool
  supports `op=status`, `op=diff`, and `op=log` only; there is no `git show`, no `git blame`,
  and no arbitrary git. There is no shell.
- Never read `.env` files or other secret-like files, credentials, or keys, and never quote
  their contents.
- Separate implemented behavior, partial or process-local behavior, planned behavior, and
  evidence gaps. Component existence is not end-to-end evidence. Verify exact commands,
  configuration and environment keys, service topology, message subjects, build target types,
  test filenames, and CI claims in their current definitions before publishing them.
- Resolve contradictions explicitly: a declared current authority governs project status;
  live source, configuration, tests, and CI definitions govern mutable implementation details;
  older prose is secondary. If the evidence remains ambiguous, state the limitation instead of
  guessing.

Style: dense, factual, no marketing prose. Write complete sentences. Do not use the pattern
"[noun] - [parenthetical clause]"; use a full sentence or a colon instead.
---
