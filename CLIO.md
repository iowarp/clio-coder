# Clio Coder

Clio Coder is a TypeScript/Node.js project. Coding agent for HPC and scientific-software developers, part of IOWarp's CLIO ecosystem of agentic science.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.
- Prefer a git worktree per slice when concurrent edits could conflict.
- Do not push, tag, publish, or mutate remote state.
- Do not run destructive git commands such as `git reset --hard`, `git checkout --`, `git clean`, or branch deletion.
- Prefer patches and review over blind merge/application.
- **rule2**: `src/worker/**` never imports `src/domains/**`. Shared types go through contracts.

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-05T17:36:12.195Z",
  "model": "local-bootstrap",
  "gitHead": "734775a835d35cfab9e7bc5fecf57e1fba393205",
  "treeHash": "a275345d9a071ec0487d5fe19bc54aa2a5d66458aa77bfc14695c54df97572e9",
  "loc": 110027
}
-->
