# Clio Coder

Clio Coder is a TypeScript/Node.js CLI and terminal UI for supervised coding agents in IOWarp's CLIO ecosystem. It ships the `clio` binary from `dist/cli/index.js`, loads checked-in `CLIO.md` project guidance by default, and is expected to be runnable from a fresh clone after installing dependencies and building.

## Conventions

- Use Node.js >=22. From a fresh clone run `npm install`, `npm run build`, then `node dist/cli/index.js --version` or `npm link`.
- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.
- `npm run ci` is the full local gate; run `npm run prepublishOnly` before release packaging.
- Keep `package.json`, `package-lock.json`, README, and CHANGELOG versions synchronized.
- Prefer typed tools, package scripts, and scratch `CLIO_HOME`/XDG state over ad hoc shell state in tests.
- Do not push, tag, publish, or mutate remote state unless the user explicitly asks.

## Hard invariants

1. Engine boundary: only `src/engine/**` may value-import `@earendil-works/pi-*`.
2. Worker isolation: `src/worker/**` never imports `src/domains/**` except provider runtime descriptors.
3. Domain independence: `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`.

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-02T17:44:42.000Z",
  "model": "release-prep",
  "gitHead": "50a4fa2aa5900795c51cafabd1b407270af28f08",
  "treeHash": "7442cac8f66eb430f55b7e89d77072aedc83a9d477563d6c862606f8dc3502b2",
  "loc": 105379
}
-->
