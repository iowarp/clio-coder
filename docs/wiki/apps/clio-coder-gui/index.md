# apps / clio-coder-gui

5 complete, 0 pending.

- [Browser client](client.md) — The React single-page client of the Clio Coder GUI: its route table, query and error policy, the chat composer's submit decision and draft store, tool-call presentation, the settings controls view, the machines registration flow, the setup wizard steps, and the Markdown rendering boundary. Read this to find where a browser view or client rule lives.
- [GUI wire contracts](contracts.md) — The shared TypeBox contracts between the Clio Coder GUI server and browser client: the route table, the OpenAPI generator and its schema hoist, and the session projection that folds streamed deltas into a snapshot. Read this when adding a route, changing a DTO, or touching session streaming.
- [Command-line surfaces for GUI checks, brand tokens and OpenAPI](scripts.md) — Describes the developer-facing scripts under apps/clio-coder-gui/scripts: the browser smoke run, the visual review captures, the performance workload, the brand-token and contrast checks, the brand asset projection, and the OpenAPI regeneration. Read this page to decide which script to run and what it checks.
- [GUI server](server.md) — How the local GUI server starts, owns its domain worker threads, child processes, and path completion, and how the background launcher reuses it. Read this before changing server startup, worker dispatch, ACP child lifecycle, or background install behavior.
- [Graphical application test suite](tests.md) — Describes the tests under apps/clio-coder-gui/tests: the scripted ACP fixture child, the harnesses that launch the server against it or against the real built CLI, and the focused client and server tests. Read this to pick the right harness or to add a case.
