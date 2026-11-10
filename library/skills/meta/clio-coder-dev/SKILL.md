---
name: clio-coder-dev
description: "Develop Clio Coder inside its own repository: orient on the running build versus the workspace, trace owners, avoid the checks that fail landings, apply each edit the right way and hand the work back. Use before changing Clio source, prompts, tools or library; pair with clio-coder-test for validation."
triggers:
  - develop Clio in its own repository
  - implement a Clio sprint packet
  - change Clio context or session lifecycle
  - edit Clio skills tools or prompts
  - work a Clio lane brief or spec
version: 0.7.1
license: Apache-2.0
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/meta/clio-coder-dev
  audit: pass
  model-size: any
---

# Clio self-development

Use this when the task changes Clio Coder inside its own repository. Load
`clio-coder-test` when you choose checks. The lane brief, the spec and
`.clio-coder/rules/` outrank this skill; the repository handbook is already in
your prompt.

## Know which Clio you are

Two trees are involved and they are usually different directories.

- The running Clio is the build that started this session;
  `clio-coder --version` prints its commit. Prompt
  fragments, built-in agent recipes, tool code, bundled docs and
  `code_nav(source="clio")` come from that root.
- The workspace is the checkout or worktree you edit. The repository handbook,
  `.clio-coder/rules/` and these two skills (when no installed package owns
  their names) come from the workspace.

An edit in the workspace does not change the running session except where
[references/live-edit.md](references/live-edit.md) says so. Read that table
after your first edit and before you claim a change works. Never make an edit
live by touching the running install: no build in its checkout, no
`scripts/install-local.sh`, no `pnpm run install:local`, no launcher relink.
Other sessions run from it. Build the workspace and start a separate candidate
process from the workspace's own `dist/cli/index.js`.

## Establish the assignment

Read the brief or spec fully; its acceptance criteria are the contract. Check
`git status`, the branch and `git log -1`, and confirm you are in the assigned
worktree, not the main checkout. When the brief is silent: change source,
add at most one focused regression test per defect in the nearest existing
test file, make only the inventory rows lint demands in `docs/`, and never
edit `CHANGELOG.md`. Proposed changelog lines and deferred docs go in the
handback. A spec that is wrong or unsafe as written is a question, not a
licence to improvise.

## Trace before changing

Find the owner and its callers with `code_nav` or `grep`, then read the
contract, the nearest tests and the architecture page for that area. Use
[references/change-map.md](references/change-map.md) for owners and for the
seams a setting, tool, command or contract type must touch. Put policy in the
owning domain and compose at the entry seam. The hard invariants in
the repository handbook are enforced by `pnpm run lint`.

## What failed landings

- Composition root: `src/entry/orchestrator.ts` is at its line ceiling and
  may not gain module-scope functions or feature imports (rule15). Put wiring
  in the owning domain and call it from one existing line.
- Export hygiene: an `export function` whose name appears in one file fails
  lint. Remove the keyword, then `pnpm exec biome check --write <file>`.
- GUI contract: after editing `src/core/telemetry/dto.ts` or a schema module
  it imports, `src/engine/acp/types.ts` or `apps/clio-coder-gui/contracts/*.ts`,
  run `pnpm --filter @iowarp/clio-coder-gui run openapi` and commit
  `apps/clio-coder-gui/contracts/openapi.json`. Only `test:gui` catches a
  stale file.
- Files parallel lanes collide in: `src/session-control/slash-commands.ts`,
  `src/domains/report/index.ts`, `src/interactive/interactive-application.ts`,
  `src/domains/dispatch/extension.ts`, `src/interactive/overlay-lifecycle.ts`,
  `src/entry/orchestrator.ts`. Add your entry as one hunk,
  leave neighbours unformatted and unordered as they are, and never add a
  required field to a shared entry type inside a feature commit.
- A new test file runs in no gate until `scripts/ci-tests.mjs` lists it.
- Strict types: optional properties are spread in, never assigned
  `undefined`; relative imports end in `.js`; type imports use `import type`.
- Library edits: bump the version in `SKILL.md` and `plugin.json`, then
  `pnpm run skills:pin` and `pnpm run library:pin`.

## Flywheel

Start a dev session that chooses, scopes, prioritises or triages Clio work by
running `clio-coder dev flywheel --json`. It prints `{usage, backlog}`:
`usage` is the week's headline for Clio Coder (npm downloads, install-script
requests, GitHub views and clones, stars, forks, open reports, shares on
file, the latest release and its share of downloads, stale data sources, the
latest weekly digest issue); `backlog` is the ranked rows, highest first, with
every column the backlog has, including `why` when present. Pick from the top
rows, narrow with `--kind <kind>` and `--top N`, and cite the row you acted on
(rank, key, evidence) in the issue or PR. Without access the command says the
data is private to the maintainers; carry on without it.

A `file-me` row is an issue the metrics suggest filing; its `title` is ready to
paste. Show the maintainer the title, why and evidence and ask before filing
it; never file one unasked. A `has-bundle` issue carries an encrypted share
that only a maintainer can pull with `--pull`; never pull or decrypt one
unless the maintainer asks.

## Git in a shared repository

Every worktree shares one `.git/config`, one stash and one object store.
Never `git stash`, never move a branch by relative ref, never commit in the
main checkout, never merge or rebase other lanes in. Before any git-driven
runner (`git bisect run`, hooks, `git rebase --exec`) unset `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_PREFIX` for the
command it runs; a test fixture's `git config` otherwise writes the shared
config.

Commit small conventional commits with the trailer the brief names. After
each commit read it back: `git log -1 --format='%an <%ae>%n%B'`. Clio's commit
attribution may set the author or append trailers
(`integrations.git.commitAttribution`, `integrations.git.commitAuthor`). If
the result differs from what the brief requires, stop and report it; do not
rewrite history to hide it.

## Delegating

A dispatched worker does not inherit your loaded skills. Put the rules it
needs in the task or briefing: owned files, the traps above that apply, the
checks to run and what to return. Parallel workers need disjoint write roots.
You own shared registries and integration.

## Hand back

Run the checks `clio-coder-test` selects, verify the behaviour live unless
the brief waives it, then write the handback in
[references/lane.md](references/lane.md). Separate what a test proved, what a
built process proved, what a live model proved and what was not run.
