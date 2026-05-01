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
  "initAt": "2026-05-01T19:00:14.224Z",
  "model": "local-bootstrap",
  "gitHead": "56839f2019c8f2b7421cd7370f4763829f7b329d",
  "treeHash": "0db4d6b00e7eddba0c438a72a9b90464025d6dda7a34dc4508931a42946e28df",
  "loc": 73272
}
-->
