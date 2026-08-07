---
You are updating an existing project wiki after repository changes. The current pages are
already present in `{{outputDir}}`; edit them in place there. The wiki was last written at the
git commit recorded below, and the change evidence lists what happened since. Make surgical
edits only.

Output location: write only into `{{outputDir}}`. The harness validates what you leave there
and promotes it to `.clio/wiki`; you never write to `.clio/wiki` yourself. Never write
`meta.json`; it is harness-owned. An accurate wiki may be left exactly as seeded.

Execution discipline:
- Treat this as a bounded editing pass, not a repo-wide audit. Read the seeded pages and the supplied Git and working-tree evidence before choosing any source lookup.
- Use no more than 10 tool calls to identify affected pages. Make edits as soon as a claim is verified, and finish all writes before the read-only reserve begins. Do not emit large parallel batches: every attempted sibling spends the same bounded budget.
- If a lookup errors, refine it once or switch to a direct read; never spray variants of the same `code_nav` query. Do not create `plan.md`. If temporary written planning helps, use `_plan.md`; the harness removes it before promotion. Use one scoped diff after editing, then return the required JSON immediately.

Rules:
- First read every file in the Repository guidance section below. If those instructions name a
  source of truth or planning authority, read it before deciding that seeded content is still
  accurate, even when it is ignored by git or absent from the codewiki.
- Update only pages whose content the changes actually invalidate or whose adjacent workflow is exposed as materially incomplete. Scope by affected systems and relationships, not an arbitrary changed-file-to-page ratio. It is acceptable, and common, to change nothing: if the wiki is still accurate, stop without editing and say so.
- Never rewrite a page wholesale when a section edit suffices. Never make formatting-only edits. Use the page range in the Generation strategy section as guidance. Add missing concern pages and link every page from quickstart.md. Keep quickstart's task-routing table aligned with changed ownership, symbols, tests, and validation commands.
- Verify every source reference introduced or relied on by an edit. Prefer stable paths and symbols over line numbers. The harness validates cited source paths and internal wiki links, so repair stale seeded references and broken links rather than preserving them.
- When a codewiki exists, consult `code_nav` first: `mode=wiki` lists indexed pages, and
  `mode=entries`, `mode=symbol`, and `mode=path` navigate the code before any broad reads.
- Use `git` to confirm what changed. Your git tool supports `op=status`, `op=diff`, and
  `op=log` only; there is no `git show`, no `git blame`, and no arbitrary git. There is no
  shell.
- Never read `.env` files or other secret-like files, credentials, or keys.
- Treat the Working-tree evidence below as part of the update scope; same-HEAD edits can
  invalidate the seeded wiki. Separate implemented, partial, planned, and unverified behavior.
  Verify exact commands, configuration and environment keys, service topology, message
  subjects, build target types, test filenames, and CI claims in their current definitions.
  When a declared authority, live implementation, and older prose disagree, follow the declared
  precedence and explain any remaining limitation rather than preserving a convenient claim.
- Before finishing, reconcile affected components and one-hop workflows against the canonical pages. Check that responsibilities, runtime/data flow, invariants, extension surfaces, focused tests, and editing hazards remain discoverable; do not treat page count or byte size as evidence of correctness.

Style: match the existing pages. Dense, factual, complete sentences. Do not use the pattern
"[noun] - [parenthetical clause]"; use a full sentence or a colon instead.
---
