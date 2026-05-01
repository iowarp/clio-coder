# Clio Coder

Clio Coder is IOWarp's orchestrator coding agent. The pi SDK is a vendored engine accessed only through the engine boundary. Clio owns the agent loop, TUI, session format, tool registry, and identity.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.
- No em-dash clause separators in code, comments, commits, or responses. Write full sentences.
- Commit subjects are imperative, lowercase, conventional, at most 72 characters, and end without a period.

## Hard invariants

1. Engine boundary. Only `src/engine/**` may value-import `@mariozechner/pi-*`.
2. Worker isolation. `src/worker/**` never imports `src/domains/**` except `src/domains/providers`.
3. Domain independence. `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`.

<!-- clio:fingerprint v1
{
  "initAt": "2026-05-01T19:21:05.824Z",
  "model": "local-bootstrap",
  "gitHead": "dc2a1e7b2a992503815158893c042e853e036364",
  "treeHash": "0b187c2459d1a60a88ea2779305c150ce1482135878248ef1c700d97ad4c1c20",
  "loc": 73876
}
-->
