# engine

- [Engine acp](acp.md) — Agent Client Protocol v1 server and delegation client for Clio, including the stdio JSON-RPC transport, permission mediation, headless command catalog, and ACP peer lifecycle.
- [Engine apis](apis.md) — The engine's provider API layer: two registered providers (OpenAI-completions and Ollama-native), a shared capacity-aware residency reconciler for local runtimes, a degraded-inference watchdog, and per-runtime adapters for LM Studio, llama.cpp router, and Ollama.
