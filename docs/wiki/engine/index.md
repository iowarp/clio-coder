# engine

3 complete, 0 pending.

- [Agent Client Protocol engine: transport, delegation, tool mediation and commands](acp.md) — How Clio speaks the Agent Client Protocol (ACP) both as a server to editors and as a client that delegates work to external ACP peers. Read this before changing the stdio transport, the delegation adapter, the permission mediator or the ACP command allowlist.
- [Engine API providers and local-runtime residency](apis.md) — How Clio registers its engine API providers, how the OpenAI-compatible and Ollama streams wrap local runtimes with model residency and the degraded-inference watchdog, and which tests cover those paths. Read this before changing a provider stream, a residency decision, or a runtime notice.
- [Claude worker runtimes: SDK and CLI subprocess](claude.md) — How Clio runs a dispatched worker on Claude, either through the optional Claude Agent SDK or through the official claude CLI as a subprocess, and how each path mediates tool calls, budgets, usage, and permissions. Read this before changing Claude worker behavior.
