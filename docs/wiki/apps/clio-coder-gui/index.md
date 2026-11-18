# apps / clio-coder-gui

> **Partial audit at `3aae1044`:** route/client/contracts/server/test ownership now covers arena, research, metrics/reports, rewind, review, session control, runtime, auth and launch. No regeneration or test execution is implied.

- [Browser client](client.md) — Current routes and domain views plus the retained chat/settings/machines coverage.
- [GUI wire contracts](contracts.md) — Current arena/research/metrics/report/rewind/review/control/runtime/auth/launch contracts plus OpenAPI and projections.
- [Command-line surfaces for GUI checks, brand tokens and OpenAPI](scripts.md) — Describes the developer-facing scripts under apps/clio-coder-gui/scripts: the browser smoke run, the visual review captures, the performance workload, the brand-token and contrast checks, the brand asset projection, and the OpenAPI regeneration. Read this page to decide which script to run and what it checks.
- [GUI server](server.md) — Route composition, domain services, workers/processes, ACP, path completion and launchers.
- [Graphical application test suite](tests.md) — Harnesses and current coverage pointers; tests were not executed in this audit.
