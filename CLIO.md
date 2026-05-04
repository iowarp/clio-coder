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

1. Engine boundary. Only `src/engine/**` may value-import `@mariozechner/pi-*`.
2. Worker isolation. `src/worker/**` never imports `src/domains/**` except `src/domains/providers`.
3. Domain independence. `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`.

<!-- clio:fingerprint v1
{
  "initAt": "2026-05-04T01:57:19.822Z",
  "model": "local-bootstrap",
  "gitHead": "57ef01b1a6d8b4bc829154ce19c862d555e92b52",
  "treeHash": "29828ed99631e3334bf9f3c4e4947faa294a9ce6e45f5513c758d73b3d9557f2",
  "loc": 83717
}
-->
