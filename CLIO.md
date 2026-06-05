# Clio Coder

Clio Coder is a TypeScript/Node.js CLI and terminal UI for supervised coding agents in IOWarp's CLIO ecosystem. It ships the `clio` binary from `dist/cli/index.js`, loads checked-in `CLIO.md` project guidance by default, and is expected to be runnable from a fresh clone after installing dependencies and building.

## Conventions

- Use Node.js >=22.19.0. From a fresh clone run `npm install`, `npm run build`, then `node dist/cli/index.js --version` or `npm link`.
- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.
- Prefer typed tools, package scripts, and scratch `CLIO_HOME`/XDG state over ad hoc shell state in tests.
- Prefer a git worktree per slice when concurrent edits could conflict.
- Do not push, tag, publish, or mutate remote state unless the user explicitly asks.
- Do not run destructive git commands such as `git reset --hard`, `git checkout --`, `git clean`, or branch deletion unless the user explicitly asks.
- Prefer patches and review over blind merge/application.

## Hard invariants

1. Engine boundary: only `src/engine/**` may value-import `@earendil-works/pi-*`.
2. Worker isolation: `src/worker/**` never imports `src/domains/**` except worker-safe provider runtime rehydration modules; shared types go through contracts.
3. Domain independence: `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`.

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-04T16:43:20.024Z",
  "model": "local-bootstrap",
  "gitHead": "0491b95619f5384566187a4997d556c8ee54f8af",
  "treeHash": "b0d986074882147a123cd71d8b504695a0ea312155e9e5cf8c16d5cdca0559e6",
  "loc": 109851
}
-->
