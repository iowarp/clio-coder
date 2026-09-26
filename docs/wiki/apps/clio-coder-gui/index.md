# apps / clio-coder-gui

- [Clio Coder GUI Client](client.md) — The browser frontend for Clio Coder: a React SPA with React Router, TanStack Query, and pure decision modules for composer, approval, tool presentation, and Markdown rendering. The client separates pure policy (tested under node:test) from declarative components, and communicates with a local ACP server through a typed HTTP contract.
- [Apps clio coder gui server](server.md) — The loopback Node.js backend that supervises ACP sessions, runs the Clio CLI, offloads blocking work to worker threads, and persists state for the Clio Coder GUI.
- [Apps clio coder gui tests](tests.md) — The GUI test suite splits into pure-logic node:test files that exercise client decision models and HTTP-harness integration tests that drive the ACP fixture child, plus the JSON-RPC fixture subprocess that simulates the engine.
