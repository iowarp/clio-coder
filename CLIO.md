# Clio Coder

Clio Coder is IOWarp's orchestrator coding agent. The pi SDK is a vendored engine accessed only through the engine boundary. Clio owns the agent loop, TUI, session format, tool registry, and identity.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.
- No em-dash clause separators in code, comments, commits, or responses. Write full sentences.
- Commit subjects are imperative, lowercase, conventional, at most 72 characters, and end without a period.
- Branch from `main`. Never force-push `main`. Every commit must leave `npm run ci` green. Don't stack broken commits.
- Don't add `scripts/diag-*.ts` or `scripts/verify-*.ts`. If it's a test, it belongs under `tests/`. If it's a one-off probe, use `/tmp/` and delete when done.
- Don't bypass boundary rules with ignores. Fix the import.

## Hard invariants

1. Engine boundary. Only `src/engine/**` may value-import `@earendil-works/pi-*`.
2. Worker isolation. `src/worker/**` never imports `src/domains/**` except `src/domains/providers`.
3. Domain independence. `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`.

<!-- clio:fingerprint v1
{
  "initAt": "2026-05-17T02:27:46.835Z",
  "model": "local-bootstrap",
  "gitHead": "c65ef60821cd24eb0c00804e8f933b1b1f8d36f7",
  "treeHash": "8526cd22906b29678a31aad2a3fcd445c3d0fa0cb2fccbb61782b732e6d89c75",
  "loc": 95310
}
-->
