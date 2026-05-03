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
  "initAt": "2026-05-02T21:44:59.398Z",
  "model": "local-bootstrap",
  "gitHead": "904adf00809dd3a58f546ba22b616559facf9544",
  "treeHash": "094961ac88618a2e875ee59fda426b8048c7ebfd7abceedd4ddd8469d518d7e0",
  "loc": 79424
}
-->
