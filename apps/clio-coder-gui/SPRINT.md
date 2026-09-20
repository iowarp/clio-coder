# Clio Coder web: canonical sprint prompt

This file is the executable plan. A fresh coding session executes it without the planning conversation. Read it top to bottom before touching code. `ARCHITECTURE_REVIEW.md` in this directory is the reasoning behind every decision here; when the two disagree, this file wins and the ledger records why.

**2026-09-11 operator amendment — v0.4.8 closeout.** After the S slices, the operator requested final UI polish, restoration of the Workbench logo, npm onboarding, a GitHub-hosted curl installer, and a release-session handoff targeting v0.4.8. This authorizes R1 package integration and its root CLI/build/manifest/release-budget/tests/docs changes, `scripts/build.ts` (temporary-config-free builds), `scripts/install.sh`, and its contract tests. A Claude Code Fable 5.1 Medium helper pane was explicitly authorized. Keep atomic local commits, no push/publication/version bump, no extra visible Chrome, and all verification artifacts and the release prompt outside the checkout. R2–R4 remaining items stay explicit for release closeout; Workbench must remain retained and disconnected.

**2026-09-11 operator correction — documentation only.** The operator clarified that the old HTML blueprints must be fully retired, not embedded or shipped beside Markdown. This supersedes the earlier S6/R3 blueprint-preservation requirements. Render canonical Markdown directly in the GUI, generate navigation/search/outlines from it, remove the HTML tree and its routes/iframe bridge/package entries, and update the documentation checks. Keep this correction confined to docs and their integration; no unrelated package optimization, version bump or push.

**2026-09-11 operator amendment — release candidate.** The operator requested a release cut. Prepare the local v0.4.8 candidate, version metadata and dated release notes, then run strict release and installed-package checks. This supersedes the earlier no-version-bump restriction. The operator subsequently clarified that Git release work is the agent’s responsibility and explicitly excluded npm login/publication. This authorizes canonical main integration/push, an annotated v0.4.8 tag and the GitHub release after passing checks, superseding the earlier no-push restriction for this cut. npm login and npm publication remain operator-owned.

**2026-09-12 verification correction — normal publish environment.** The operator’s actual npm prepublish gate failed after earlier verification used an alternate temporary directory. Final local release acceptance must include `npm run prepublishOnly` in the operator’s normal temporary environment; a pass with an alternate `TMPDIR` is additional evidence only. Keep logs outside the checkout, distinguish filesystem exhaustion from product failures, and preserve unrelated temporary data when recovering space. npm login and publication remain operator-owned.

## 0. Baseline and how to start a session

**Implementation status:** all 15 named S slices and all four R integration slices are done. The operator's documentation-only correction is complete: one Markdown-driven GUI replaces the earlier HTML blueprint integration. It passes all 92 app tests and 142 headless browser checks, plus root/app types, docs/CLI/package checks and lint/hygiene. Project-tree and optional-performance deferrals remain explicit. Further GUI expansion is parked. CLI/TUI/headless/ACP remain independent surfaces; the 0.4.8 candidate passes strict local release verification with dated release notes. GitHub release execution is authorized; npm login/publication remains operator-owned. Earlier verification counts and HTML-preservation records below are historical, not the current docs contract.

**Current operator authorization (2026-09-11).** Continue through all S slices, including lettered slices, until implemented, tested, and verified. This overrides the one-slice-per-session stopping rule below; retain acceptance checks and a ledger entry for each slice. The operator subsequently authorized atomic local commits as work completes: "commit atomically as you go. the rule is no push". This overrides earlier no-commit instructions. Latest steering prioritizes REST API coverage and parity for future GUI sessions. Keep `apps/workbench/`, disconnect it from builds, publication, and gates; remove the absorbed trace viewer and its active references. These specific root integration changes are authorized exceptions; the later closeout steering also authorizes R1–R4. Push, publication, and branch changes remain unauthorized. Keep temporary reports, audits, screenshots, and prompts outside the checkout; record durable implementation progress in this existing ledger. The operator moved the unrelated docs audit to ignored `.superpowers/`; recheck hygiene without the old baseline exception if it now passes.

**PWA amendment (2026-09-11).** The operator rejected deferring PWA and explicitly approved keeping the local web server available in the background so the installed icon works when reopened. PWA installation and reliable reopening are now required. Reopen S9 for an explicit background-service setup, stable local origin and protected persistent browser access, installable assets, offline/recovery UX, restart/reopen checks, and ownership-safe removal. Ordinary foreground idle-exit behavior and CLI/TUI/headless independence remain required. The failed E5 record remains historical evidence for the old shutdown-on-close lifecycle; it no longer authorizes deferral. S10 follows the amended S9.

**Reviewed baseline.** Branch `v048`, SHA `1e1162f687a610f19f27a34495ad06251b237260`, 2026-09-11. Every existing path, symbol, and behavior named in this file was read at that SHA. Every path under `apps/clio-coder-web/` other than the three planning documents is a proposal until the slice that creates it; if a slice finds a better layout it records the change in the ledger. A future session starts at whatever `git rev-parse HEAD` says; that is the session SHA and it is never assumed to equal the reviewed one.

**Baseline state at the reviewed SHA.** `pnpm run typecheck` passes. `pnpm run lint` passes Biome with pre-existing warnings and then fails `scripts/check-hygiene.ts` on two docs-parity conditions caused by the untracked `docs/architecture-managed-prefill-reuse.md`, which belongs to another workstream. Treat that as unrelated baseline dirt: never edit, move, or delete that file, and never claim the whole tree is green. During app work, report the command as failed with no new lint regressions only when Biome passes and those two docs-parity lines are its only hygiene failures. A full pass is also acceptable if the owning workstream has resolved them.

**Start or resume protocol.** Do these in order at the top of every session.

1. Record `git rev-parse HEAD`, `git status --short`, `node --version`, `pnpm --version`.
2. Compare the session SHA with the reviewed SHA and with the SHA in the last ledger row. If they differ, run `git log --oneline <ledger-sha>..HEAD` and `git diff --stat <ledger-sha>..HEAD -- src package.json pnpm-workspace.yaml tsup.config.ts scripts tests/smoke/installed-package.test.ts biome.json`. Then read the diff for every file in the seam list (section 3.4) that changed. Record in the ledger which seams changed and whether the slice's direction still holds. Never reset, never rebase, never claim to have reviewed a commit you did not open.
3. `pnpm install --frozen-lockfile` before editing. When the current slice introduces app dependencies, update only the app's manifest and its necessary root lockfile entries with `pnpm install`, as allowed by class B; record exact versions. Then `pnpm run build` at the root, because slices from S3 on spawn the checkout's `dist/cli/index.js`. Then, once S1 exists, `pnpm --filter @iowarp/clio-coder-web build` so the Vite client exists before `start`; on a clean checkout `start` refuses with a clear message when `dist/client/index.html` is missing.
4. Resume any `in-progress` slice before starting another. Otherwise pick the first slice in section 5 whose status is `todo` and whose dependencies are `done`. Execute only that slice, validate it, update its status here, append its ledger row, and hand off. A session never starts a second slice. If a slice needs more than one session, keep it `in-progress` and carry its remaining acceptance checks into the next session; never mark it done to fit the estimate.
5. Finish by running the slice's acceptance checks, the app verify (`pnpm --filter @iowarp/clio-coder-web verify` once S1 exists), root `pnpm run typecheck`, and root `pnpm run lint` (interpreted per the baseline note during app work; release acceptance in section 8 allows no such exception). Update the ledger (section 9). Do not commit, push, change branches, or publish unless the operator explicitly asks in that session.

**Operator constraints, verbatim in effect.** New application work lives under `apps/clio-coder-web/`, outside root `src/`. The CLI, TUI, and ACP stay canonical and independent; nothing makes them depend on an HTTP process. Workbench, trace viewer, and docs server are replaceable, and the trace viewer is deleted once its capabilities are absorbed, in a root integration slice. Zero users: no migrations, no legacy wire readers, no compatibility aliases, no state importers, no parallel implementations for the old apps. Do not touch unrelated work, do not change branches, reset, commit, push, or publish. Naming is provisional and never a blocker.

## 1. Accepted architecture in one screen

- One Node process (`clio-coder web` at v0.4.8; `node --import tsx server/main.ts` from the checkout now) on `127.0.0.1`, foreground by default with Ctrl+C to stop, or explicitly installed as a Linux user service for PWA availability. Ordinary CLI, TUI, and ACP startup never starts it. Explicit app launch actions, including `clio-coder docs` after R3, may start it.
- Hono 4 on `@hono/node-server`. TypeBox on the root's `typebox` line. A **route table** in `contracts/routes.ts` is the single source of truth for validation, OpenAPI, and the typed client.
- REST for commands and queries; one global SSE stream with `{v, epoch, seq}` envelopes, a 4,096-entry ring, `hello` and `resync` events, snapshot headers `X-Clio-Epoch` and `X-Clio-Seq`; resource SSE streams for live trace tails.
- Two `worker_threads` domain workers (reads, ops) host every blocking adapter that imports `src/**`. Bounded queues (64), per-call deadlines, no interruption of synchronous work, truthful `cancellable` flags.
- One supervised `clio-coder acp --cwd <root>` child per open session, spawned through `src/engine/acp/transport.ts` `createStdioTransport`.
- Mutations with admission logic in CLI commands run as fixed-argv CLI children through one spawn chokepoint (`server/process-policy.ts`).
- Problem JSON errors with a closed `code` enum. Per-launch bearer token in foreground mode, protected persistent token in background mode, loopback bind, `Host` and `Origin` checks, identifiers validated by shape, `realpath` containment on every path.
- React 19, Vite 8, `react-router`, `@tanstack/react-query`, the workbench's Markdown, Prism, and Mermaid renderer modules reused.
- App state under `<clio state dir>/web/` only (recent workspaces, ACP ownership records, and explicit background setup). Clio's own files are never written by the app except through Clio's own seams or commands.

## 2. Naming

Package `@iowarp/clio-coder-web`. Directory `apps/clio-coder-web`. Product name `Clio Coder`. Command `clio-coder web` (v0.4.8). State `<state>/web/`. Log prefix `[clio-coder:web]`. The product, package, command, and state directory are not named workbench, GUI, or daemon; the words themselves are fine in prose.

## 3. Boundaries

### 3.1 Class A: apps-only, every slice S1 to S10

All files under `apps/clio-coder-web/`. Root imports are written against real module targets under `<repo>/src/` and appear only in `server/clio/**`:

- `server/clio/http-shims.ts` is the only file the HTTP process may use to reach root code, and it re-exports exactly: `createStdioTransport` and the `AcpJsonRpcTransport` type from `src/engine/acp/transport.ts`; `AcpProcessError`, `AcpTimeoutError`, `AcpRequestError`, `AcpProtocolError` from `src/engine/acp/errors.ts`; wire types from `src/engine/acp/types.ts`; `clioStateDir`, `clioDataDir`, `clioConfigDir`, `resolveClioDirs` from `src/core/xdg.ts`; `resolvePackageRoot` from `src/core/package-root.ts`; `processAlive`, `processBirthToken` from `src/core/process-identity.ts`; `getVersionInfo` from `src/domains/lifecycle/version.ts`.
- `server/clio/adapters/**` holds blocking adapters and is imported only by `server/worker/reads-main.ts` and `server/worker/ops-main.ts`.
- Never imported directly: `src/interactive/**`, `src/entry/**`, `src/tools/**`, `src/engine/**` beyond the three ACP files, any `extension.ts`. The rule is about direct imports; a seam's transitive graph (for example `src/domains/toolchain/index.ts` importing its own `extension.ts`) is accepted as that seam's cost and recorded in the ledger once.
- `tests/harness/**` and `tests/fixtures/**` may import named root modules the production allowlist excludes (for example `TraceStore` from `src/domains/observability/trace-store.ts` to write a fixture database, and the OpenAI-compatible fixture from `tests/harness/` at the root); the boundary test carries that second, narrower allowlist explicitly.
- `tests/boundaries.test.ts` enforces all of the above and fails the app verify when violated.
- When the only existing form of a fact is an unexported `src/cli/*Snapshot` builder, choose one and record it in the ledger: project from the exported domain seam beneath it; run the fixed-argv CLI command through the mutation runner as a deliberate bridge; or defer to a class C slice. Adding `export` under `src/` is never done in an S slice.

### 3.2 Class B: minimal root integration allowed in S slices, each enumerated

| Edit | Slice |
| --- | --- |
| `pnpm-lock.yaml` updated by `pnpm install` for the app importer and dependencies introduced by the current slice; no unrelated upgrades | S1 initially; later S slices only when their app dependencies change |
| Root `package.json`: add script `"test:web": "pnpm --filter @iowarp/clio-coder-web test"` and append `&& pnpm run test:web` to `ci` | S1 |
| `scripts/check-hygiene.ts`: append the same `&& pnpm run test:web` to the expected `ci` string only | S1 closeout; explicit operator boundary exception approved 2026-09-11 |

Nothing else under the root is edited before the R slices. If a slice discovers it needs more, it stops, records the need in the ledger under "class C requests", and finishes what it can without it.

### 3.3 Class C: root integration, slices R1 to R4 (v0.4.8)

`src/cli/index.ts` and `src/cli/web.ts`; `tsup.config.ts` entries `web/server`, `web/reads-worker`, `web/ops-worker` plus `noExternal` or `dependencies` for `hono` and `@hono/node-server`; root `devDependencies`; `package.json` `files`; `scripts/release-manifest.json`; `scripts/check-release.mjs` budgets if measurement demands; `tests/smoke/installed-package.test.ts`; `src/cli/trace.ts` (removal of the obsolete `trace ui` subcommand); `TraceReader.runsPage` in `src/domains/observability/trace-store.ts`; `src/cli/docs.ts` replaced by a canonical navigation command into the app (not a compatibility alias) and `tests/contracts/docs-server.test.ts`; any `export` keyword added under `src/`; deletion of `apps/trace-viewer` and disconnection of retained `apps/workbench` with their root references (`package.json` scripts `trace:ui`, `test:trace-viewer`, `ci`; `biome.json`; `README.md`; `CONTRIBUTING.md`; `ROADMAP.md`; `docs/architecture/acp.md`; `docs/architecture/trace-store.md`; comments in `src/domains/evidence/detail.ts`, `src/cli/fleet-verify.ts`, `src/interactive/overlays/settings.ts`); `src/cli/uninstall.ts`; `CHANGELOG.md`.

### 3.4 Seam list to re-inspect when the SHA moves

`src/engine/acp/server.ts` (methods, `ACP_FORWARDABLE_EVENT_KINDS`, `session_limit`, `session_cwd_mismatch`), `src/engine/acp/transport.ts`, `src/engine/acp/errors.ts`, `src/engine/acp/types.ts`, `src/cli/acp.ts`, `src/entry/boot-options.ts`, `src/domains/observability/trace-store.ts` (`TraceReader`, schema, `TRACE_SCHEMA_VERSION`), `src/domains/observability/evidence-index.ts`, `src/domains/toolchain/{index,install,resolve,registry,remove,types,version}.ts`, `src/domains/session/history.ts`, `src/domains/session/archive-readers.ts`, `src/domains/dispatch/state.ts`, `src/domains/dispatch/council-topology.ts`, `src/domains/dispatch/gate-topology.ts`, `src/domains/evidence/{store,inventory,detail}.ts`, `src/core/settings-layers.ts`, `src/core/xdg.ts`, `src/core/package-root.ts`, `src/domains/lifecycle/{version,doctor}.ts`, `src/cli/config-inspect.ts`, `src/domains/interop/index.ts`, `src/domains/resources/index.ts`, `src/cli/index.ts`, `src/cli/trace.ts`, `src/cli/docs.ts`, `package.json`, `tsup.config.ts`, `scripts/check-release.mjs`, `scripts/release-manifest.json`, `scripts/check-hygiene.ts`, `biome.json`, `tests/smoke/installed-package.test.ts`, `apps/trace-viewer/**`, `apps/workbench/{clio-host.ts,acp-client.ts,src/timeline.ts,src/markdown.ts,src/Markdown.tsx,src/highlight.ts,src/mermaid.ts,DESIGN_SYSTEM.md}`.

## 4. v0.4.8 milestone map

```text
Foundation (apps-only, one session each)
  S1 server + contracts + workers + toolchain vertical, end to end
  S2 trace explorer (absorbs apps/trace-viewer)
  S3 sessions A: supervisor, list, new, load, prompt streaming
  S4 sessions B: permissions, cancel, settings, targets, fleet event strip, reconnect proof
  S5 shell and design system, browser smoke, accessibility floor
  S6 docs (absorbs src/cli/docs.ts capability)
  S7a settings and config inspection reads
  S7b CLI mutation runner, targets read bridge, targets use and remove
  S8a fleet runs, receipts, councils, gates
  S8b evidence inventory, detail, evidence build
  S8c evals and usage
  S8d library and catalog
  S8e interop and system (doctor, paths, version)
  S9 launcher, idle-exit, process policy, required PWA with explicit background availability
  S10 packaging rehearsal from apps/ (proves the R1 layout without root edits)
Root integration (class C, one session each)
  R1 clio-coder web command, tsup entries, files, manifest, installed-package smoke
  R2 trace retirement: TraceReader.runsPage, remove trace ui, delete apps/trace-viewer
  R3 docs: clio-coder docs becomes the canonical navigation command into the app; docs.ts static server removed
  R4 workbench deletion, uninstall awareness, references, CHANGELOG
Release acceptance (section 8), publication not authorized by this file
```

The status and dependency line of each slice is authoritative. The default execution order is the document order: S1 through S10, including the lettered slices, then R1 through R4. S5 may run before S4 after S2 and S3 are done; S8b, S8c, and S8d require S7b. There are nineteen slices plus release acceptance. Plan roughly one focused session per slice, allowing unfinished slices to resume; each session works on at most one slice and hands off.

## 5. Battle order: slices

Every slice is sized for one focused agent session, leaves a green app verify and a runnable app, and ends with a ledger row. "Existing" commands run today at the reviewed SHA; "introduced" commands exist only after the slice that names them.

Shared acceptance floor for every S slice: `pnpm --filter @iowarp/clio-coder-web verify` passes (typecheck, lint through root Biome, tests, client build, and from S5 the browser smoke); root `pnpm run typecheck` passes; root `pnpm run lint` passes or shows only the two baseline docs-parity failures (reportable during app work, never a release pass); `tests/boundaries.test.ts` passes; no file outside `apps/clio-coder-web/` changed except the class B edits allowed for the slice; the slice status and ledger row are updated.

---

### S1. Foundation and the toolchain vertical

Status: `done`. Depends on: nothing. Class B edits: `pnpm-lock.yaml`, root `package.json` scripts `test:web` and `ci`; operator-authorized exception for the matching `ci` expectation in `scripts/check-hygiene.ts`.

**Closeout:** done after the operator approved and the session applied the one-line `ci` checker update. App verify passes all 19 tests; root build and typecheck pass; root lint has only the two documented baseline docs-parity failures, with no new lint regressions. See the [closeout record](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S1-closeout.md) and [original implementation evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S1.md). S2 was implemented in the continuation below.

**Goal.** From a clean checkout, `pnpm --filter @iowarp/clio-coder-web start` serves a page at a printed loopback URL that lists the three pinned tools with their resolution, installs one on request with progress streamed to the page, removes it, and reports every failure as a problem. Every foundation mechanism exists once and is tested: route table, validation, problem JSON, auth, SSE hub, operation registry, two domain workers, spawn chokepoint, typed client.

**Proposed files to create** (all under `apps/clio-coder-web/`; the layout is a proposal and the slice may adjust it, recording the change):

- `package.json` (`@iowarp/clio-coder-web`, private, `type: module`), `tsconfig.json` (extends `../../tsconfig.json`, overrides the inherited `rootDir` to `"../.."` so root `src/**` imports are inside the program (TS6059 otherwise), `noEmit: true`, no `outDir`, includes `server`, `contracts`, `tests`, `scripts`; imported root files join the program through the imports themselves), `tsconfig.client.json` (`lib: ["ES2022","DOM","DOM.Iterable"]`, `jsx: react-jsx`, includes `client`, `contracts`), `vite.config.ts` (`root: "client"`, `build.outDir: "../dist/client"`, dev proxy of `/api` to the server port), `README.md`.
- `contracts/common.ts` (`Problem`, `ProblemCode` enum, `PageCursor`, `Id` pattern), `contracts/meta.ts`, `contracts/events.ts` (envelope, `hello`, `resync`, `operation.progress`, `operation.finished`, `toolchain.changed`), `contracts/operations.ts`, `contracts/toolchain.ts`, `contracts/routes.ts` (`defineRoute`, the table), `contracts/openapi.ts` (emitter), `contracts/openapi.json` (generated).
- `server/main.ts`, `server/app.ts`, `server/http/{auth,validate,problem,sse,static,routes-meta,routes-events,routes-operations,routes-toolchain}.ts`, `server/services/{event-hub,operations,toolchain}.ts`, `server/worker/{protocol,host,reads-main,ops-main,reads-methods,ops-methods}.ts`, `server/clio/http-shims.ts`, `server/clio/adapters/{paths,version,toolchain}.ts`, `server/process-policy.ts`.
- `client/index.html`, `client/main.tsx`, `client/app.tsx` (router with `/` and `/toolchain`), `client/api/{client,events,queries}.ts`, `client/pages/{home,toolchain}.tsx`, `client/styles.css` (minimal; S5 owns design).
- `tests/harness/{scratch-home,fake-fetch}.ts`, `tests/{boundaries,contracts,openapi,event-hub,operations,worker-rpc,http-meta,http-toolchain,process-policy}.test.ts`, `scripts/openapi.ts`.

**Direction.** Pin exact versions when installing and record them in the ledger: `hono`, `@hono/node-server`, `typebox` (the root's `1.3.0`), `react`, `react-dom`, `react-router`, `@tanstack/react-query`; dev `vite`, `@vitejs/plugin-react`, `tsx`, `typescript` (match the root's `6.0.3`), `@types/node` (match root), `@types/react`, `@types/react-dom`, and one OpenAPI 3.1 validator for tests. Root imports resolve against `<repo>/src/...` (from `server/clio/` that is `../../../../src/`); `tests/boundaries.test.ts` proves the resolution and the allowlist. `main.ts` binds `127.0.0.1`, mints the token, prints `http://127.0.0.1:<port>/#token=<token>`, starts both workers, and installs SIGINT and SIGTERM handlers that stop workers and close the listener. The toolchain adapter passes `installTool` a `fetch` restricted to `PINNED_TOOLS` download and document URLs. `toolStatuses()` runs in the reads worker; `installTool` and `removeTool` in the ops worker; `installTool`'s `onProgress` frames become `{id, progress}` RPC frames become `operation.progress` events. The install operation is created with `cancellable: false`. Public projections live in `server/services/toolchain.ts`; the `installDir` and `binaryPath` fields are projected as-is because the operator is on loopback, and the ledger notes that choice.

**Commands.** Existing: `pnpm install`, root `pnpm run build`, root `pnpm run typecheck`, root `pnpm run lint`. Introduced: `pnpm --filter @iowarp/clio-coder-web start` (`node --import tsx server/main.ts`; refuses with a message when `dist/client/index.html` is absent, so run `build` first), `... dev:server`, `... dev:client`, `... build`, `... typecheck`, `... test`, `... openapi`, `... verify`, root `pnpm run test:web`.

**Acceptance.**

1. `curl -sf http://127.0.0.1:<port>/api/meta` without a token is `401` problem JSON; with `Authorization: Bearer <token>` it returns `{clio, app, apiVersion, epoch}` where `clio` equals the root `package.json` version.
2. A request with `Host: example.com` is `421`.
3. `GET /api/toolchain/tools` returns three rows whose `id` set equals `PINNED_TOOLS` ids, in registry order, and the call ran in the reads worker (asserted by a worker-thread id echoed in a test-only header or log line).
4. With the fake fetcher serving a fabricated `PinnedTool` (the pattern `tests/contracts` uses for `installPinnedTool`), `POST .../install` returns `202 {operationId}`, the global SSE stream delivers at least two `operation.progress` events and one `operation.finished` with `status: succeeded`, and `GET /api/operations/:id` returns the same terminal record. The same key with the same body returns the same operation; the same key with a different body is `409`.
5. A fetch to a URL outside the pin is refused before any socket opens (fake fetcher asserts it was never called).
6. `POST /api/operations/:id/cancel` on the install is `409` with `code: unsupported`.
7. Worker queue: 65 concurrent reads produce at least one `503` problem with `code: unavailable` and a `Retry-After` header; a read whose adapter sleeps past its deadline returns `unavailable` and the worker's late result is discarded (test hook).
8. SSE: a client connecting with `Last-Event-ID` older than the ring receives `resync` first; one within the ring receives exactly the missed envelopes in order; the ring never exceeds 4,096 entries or 8 MiB (test fills it).
9. `contracts/openapi.json` is regenerated by `pnpm ... openapi`, a test fails if it is stale, and the document validates as OpenAPI 3.1 with every route in the table present with its path parameters and query parameters.
10. E1 and E4 recorded in the ledger: worker start under `tsx` works or the fallback was taken; measured glue line counts for `server/http/**` plus `contracts/routes.ts` plus `contracts/openapi.ts`.
11. Browser: the built client at `/toolchain` renders the three tools; clicking install on the fabricated tool (dev fixture mode) shows streamed progress and the finished state. Manual check recorded with a screenshot path in the ledger; automated browser smoke arrives in S5.

**Out of scope.** Design system, sessions, trace, docs, any page beyond home and toolchain, `--open`, PWA, idle exit.

---

### S2. Trace explorer

Status: `done`. Depends on: S1.

**Closeout:** all 25 app tests and Chrome checks pass; root typecheck passes, root lint retains only the documented baseline failures. [S2 evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S2.md).

**Goal.** Everything `apps/trace-viewer` shows, plus full-history pagination and a live tail over SSE, at `/traces`.

**Proposed files.** `contracts/traces.ts`; routes added to `contracts/routes.ts`; `server/http/routes-traces.ts`; `server/services/traces.ts` (public projections, receipt field policy); `server/clio/adapters/traces.ts` (opens `TraceReader` once per worker lifetime and reopens on schema or I/O error; keyset SQL on `reader.db`; sidecar readers using `readEvidenceIndex` and `<state>/receipts/<runId>.json`); `client/pages/traces/{runs,run}.tsx` and components (waterfall, phase facts, event row with payload disclosure, gates, processes, receipt panel, live indicator); `tests/harness/trace-fixture.ts` (writes a fixture database through `TraceStore` from `src/domains/observability/trace-store.ts`, which tests may import directly), `tests/{http-traces,traces-pagination,traces-live}.test.ts`.

**Direction.** Endpoints: `GET /api/traces/status` (`available`, `schemaVersion`, retention policy, never the path), `GET /api/traces/runs?limit<=200&cursor&source&status&q`, `GET /api/traces/runs/:runId`, `/phases`, `/events?after&limit<=500`, `/gates`, `/envelopes`, `/processes`, `/receipt` (five large fields omitted) and `/receipt?include=full`, `GET /api/traces/runs/:runId/live?after=<rowid>` (SSE, 500 ms worker poll, closes after two idle polls past a terminal status). Pagination cursor is base64url of `{startedAt, runId}` over `ORDER BY started_at DESC, run_id DESC`. `q` matches `run_id`, `agent`, `model`, `status`, and `request` with `LIKE`. Port the trace-viewer's server-clock adoption (`Date` header) and truthful formatting rules (missing spend reads as absent, never zero).

**Commands.** Existing: `node apps/trace-viewer/server.mjs --db <path>` for side-by-side comparison; `clio-coder trace runs --json`. Introduced: none beyond S1's.

**Acceptance.**

1. With a fixture database of 1,200 runs, paging with `limit=200` visits every run exactly once and the last page has no `nextCursor`; filters by `source` and `status` return only matching rows; an invalid cursor is `422`.
2. Every `apps/trace-viewer` server test scenario (schema refusal, WAL check, rowid cursor bounds, receipt field omission, sidecar absence tolerance, traversal refusal for `runId`) has an equivalent passing test here.
3. `GET .../receipt` omits `output`, `upstreamResponses`, `routeDecision`, `briefing`, `steering`; `?include=full` returns them.
4. Live tail: a run left `running` in the fixture with events appended by the test after the stream opens delivers those events on the stream in rowid order; marking the run terminal closes the stream within about 1.5 s.
5. Browser check recorded: runs list, filter, run page with waterfall, event payload disclosure, gates, processes, receipt panel; a running run shows the live indicator.
6. Coverage matrix rows for trace-viewer (section 7) are updated to `absorbed` or the gap is named.

**Out of scope.** Deleting the trace viewer, changing `src/cli/trace.ts`, `TraceReader.runsPage` (R2).

---

### S3. Sessions A: supervisor, list, new, load, streamed turns

Status: `done`. Depends on: S1. Requires root `pnpm run build` for the real child; tests use the fixture child.

**Closeout:** app verify passes 35 tests, the separate real-CLI test passes (including durable load/replay and E3), and Chrome verifies a streamed real-CLI conversation at 1440/390 px. [S3 evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S3.md).

**Goal.** Open a workspace by path, list its sessions from the ledger, start or load a session (which spawns one `clio-coder acp` child), send a prompt, and watch the turn stream into the page. Server death is handled truthfully.

**Proposed files.** `contracts/{workspaces,sessions,turns}.ts`; `server/http/routes-{workspaces,sessions}.ts`; `server/services/{workspaces,sessions,turn-projection}.ts` (port `apps/workbench/src/timeline.ts` and the projection parts of `clio-host.ts`); `server/acp/{supervisor,client,children-file}.ts`; `server/state/recent-workspaces.ts` (`<state>/web/workspaces.json`); `server/clio/adapters/sessions.ts` (`listSessionsForCwd`); `client/pages/{workspaces,sessions,session}.tsx`; `tests/fixtures/acp-fixture-child.ts` (Node, scenario by env var: `text`, `tool`, `permission`, `loop`, `slow`, `crash`), `tests/{acp-client,supervisor,sessions-http,turn-projection,kill-parent}.test.ts`.

**Direction.** `POST /api/workspaces {path}` validates an absolute existing directory, canonicalises with `realpath`, stores it in the recent list, returns an id derived from the canonical path. `GET /api/workspaces/:id/sessions` reads the ledger through the reads worker (no child needed). `POST /api/workspaces/:id/sessions` spawns a child (`CLIO_CODER_WEB_CLI` → checkout `dist/cli/index.js` → PATH), `initialize` with `clientCapabilities` and the full seven-kind event opt-in, `session/new` with the canonical cwd, and records `{pid, birthToken, sessionId, workspaceId}` in `<state>/web/children.json`. `POST /api/sessions/:id/load` uses `session/load` and feeds replayed `session/update` frames through the same projection. `POST /api/sessions/:id/turns {text}` returns `202 {turnId}` and runs `session/prompt` with the transport's long timeout; `session/update` frames update the projection (revision++), which emits `turn.*` events. `GET /api/sessions/:id` returns the projection snapshot with `X-Clio-Revision`. Concurrent sessions are capped (default from E3, initial 4). Until S4 adds the permission UI, every inbound `session/request_permission` is answered immediately with the reject option and the projection records `permission.rejected {reason: "no-ui"}`; nothing is ever allowed implicitly. `children.json` rows carry the owning server's instance id, pid, and birth token plus the child's pid, birth token, session id, and workspace id (written before `initialize`, removed on reap); reconciliation on start may signal a recorded child only when the owning server is proven dead through `processAlive` and `processBirthToken` and the child pid still carries the recorded birth token. Processes without a row are never candidates. Graceful shutdown closes children.

**Commands.** Existing: root `pnpm run build`; `node dist/cli/index.js acp --help`. Introduced: `CLIO_CODER_WEB_CLI=<path>` environment override; `pnpm --filter @iowarp/clio-coder-web test:acp-real` (starts the real built CLI against the OpenAI-compatible fixture the root tests use; excluded from `test`).

**Acceptance.**

1. Fixture child `text` scenario: a prompt produces `turn.started`, ordered `turn.text` events, `turn.finished` with `stopReason: end_turn` and the five usage fields from `_meta`; `GET /api/sessions/:id` after the turn shows the full text once.
2. Held-snapshot race: a test hook holds the `GET /api/sessions/:id` response; a `turn.text` delta arrives; the response is released; the client harness (a Node re-implementation of the client's buffer-and-replay rule, shared with `client/api/events.ts`) ends with the delta exactly once. Also the reverse: the delta arrives before the snapshot is assembled and the snapshot's revision covers it.
3. `session_cwd_mismatch` and `session_limit` from the real server are surfaced as `409` problems with `code: upstream_acp` and the remote code in `detail` (tested with the fixture emitting those errors).
4. Kill-parent: start the server, open a session on the `slow` fixture, `SIGKILL` the server, assert the fixture child is alive, start a new server with the same state dir, assert the child is terminated and `GET /api/sessions` reports the session as `unknown` then `closed` with `recoveredOrphan: true` in its record. The session ledger directory under `<state>/sessions/` is byte-identical before and after reconciliation.
4a. Two live servers: start two servers on the same state directory, open one session on each, assert that neither reconciliation touches the other's child and both children are alive after both servers have started.
4b. Pid reuse: write a row whose child pid belongs to a different live process with a different birth token (the test spawns a sleeper), start a server, assert the sleeper is not signalled and the row is dropped.
4c. Permission fail-safe: the `permission` fixture scenario in S3 ends with the tool not executed and `permission.rejected {reason: "no-ui"}` in the projection.
5. Graceful `SIGTERM` to the server terminates every child within the transport grace and leaves `children.json` empty.
6. E3 recorded: RSS and boot time of one, two, three real `clio-coder acp` children on this machine; the cap default set from it.
7. Browser check recorded: open a workspace, start a session, send a prompt to the real CLI against the OpenAI-compatible fixture, see the stream.

**Out of scope.** Permissions, cancel, settings, targets, fleet strip, session label and delete (S4).

---

### S4. Sessions B: permissions, cancel, safe settings, targets, fleet strip, reconnect proof

Status: `done`. Depends on: S3.

**Closeout:** app verify passes 42 tests; the separate real-CLI lane verifies the session controls and durable label/delete. E2/E4 reconnect and memory measurements pass. Root typecheck passes; lint has only the two baseline docs-parity failures. See [S4 evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S4.md).

**Goal.** A session is fully usable: approvals are answered from the page with truthful escalation, turns can be cancelled, the four safe settings and targets are read and changed through the child, dispatch and evidence events show as a strip, and a mid-turn reconnect resumes correctly.

**Proposed files.** `contracts/{permissions,settings-safe,targets,fleet-events}.ts`; routes; `server/acp/permissions.ts` (inbound `session/request_permission` handler returning a promise resolved by the REST decision, with 45 s escalate and 10 min budget timers ported from `clio-host.ts`); `server/services/{permissions,fleet-strip}.ts`; client permission card, cancel control, settings drawer, targets panel, fleet strip; `tests/{permissions,cancel,settings-safe,targets,fleet-events,reconnect-mid-turn,stream-load}.test.ts`.

**Direction.** `POST /api/sessions/:id/permissions/:permissionId {decision: allow-once|reject}`; an unanswered request is never answered implicitly; the budget expiry stops the turn through `session/cancel` and the projection records `permission.expired`. `POST /api/sessions/:id/turns/:turnId/cancel`. `GET/PATCH /api/sessions/:id/settings` map to `clio-coder/settings/get_safe` and `patch_safe` (exactly the four keys). `GET /api/sessions/:id/targets` and `POST .../targets/:targetId/probe` map to the ACP methods. `PATCH /api/sessions/:id {label}`, `DELETE /api/sessions/:id` (ledger delete through `clio-coder/session/delete`, confirmed by the client), `POST .../autonomy`. Opt into all seven `clio-coder/event` kinds and project them as `fleet.*` and `evidence.ready` events. E2 and E4 (streaming) are measured here.

**Acceptance.**

1. Permission fixture: the request appears as `permission.requested`; answering allow-once resolves the child's request; leaving it past the escalate timer emits `permission.escalated`; past the budget the turn stops with `stopReason: cancelled` and `permission.expired`.
2. Cancel mid-stream ends with `stopReason: cancelled` and the projection marks the turn cancelled once.
3. `PATCH` with a key outside the four safe keys is `422` before any ACP call.
4. All seven event kinds from the fixture reach the stream with their payloads bounded as the server sends them; `accountability.evidenceReady` is included.
5. Mid-turn reconnect: the SSE client is disconnected during a 1,400-event streamed turn and reconnects with `Last-Event-ID`; the final client state equals the server snapshot. E2 recorded: ring occupancy and whether `turn.text` stays replayable.
6. Stream load (E4): the streamed-turn workload runs through the global stream with no dropped or reordered envelope and bounded server memory (recorded numbers).

**Out of scope.** Global settings editing, target add or remove (S7b).

---

### S5. Shell, design system, browser smoke

Status: `done`. Depends on: S2, S3 (S4 preferred but not required).

**Closeout:** 55 tests and 40 Chrome page/theme/width checks pass, with zero Axe violations, overflow, script errors or failed requests. Root typecheck passes; lint has only the documented baseline failures. [S5 evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S5.md).

**Goal.** The app looks and behaves like one product: navigation, theme, empty and error states, problem toasts with instance ids, the Markdown, Prism, and Mermaid renderers in chat and docs, keyboard basics, and an automated headless-Chrome smoke with Axe.

**Proposed files.** `client/design/**` (tokens, layout, components), `client/render/{markdown,Markdown,highlight,mermaid}.ts(x)` ported from `apps/workbench/src/`, `client/app.tsx` navigation (`Sessions`, `Traces`, `Toolchain`, `Docs`, `Settings`, `Fleet`, `Evidence`, `Evals`, `Library`, `System`), `scripts/browser-smoke.ts` (playwright-core against Chrome at `/usr/bin/google-chrome`, override with `--chrome=`), `DESIGN.md` (the kept rules from `apps/workbench/DESIGN_SYSTEM.md`, trimmed to what applies).

**Acceptance.**

1. `pnpm --filter @iowarp/clio-coder-web smoke:browser` drives home, toolchain, traces list and run, sessions list and a fixture conversation with Markdown, code, and a Mermaid diagram, at 1600, 1050, and 390 px widths, with zero Axe violations of severity serious or critical and no horizontal page overflow.
2. Model-authored Markdown never reaches `innerHTML`; raw HTML renders as text; only `http`, `https`, `mailto` links are live (ported tests).
3. Problem responses render a toast with `code` and the `instance` id.
4. Client bundle size and the smoke's request failure list are recorded in the ledger.

**Out of scope.** Perf harness (optional later), visual probe.

---

### S6. Docs

Status: `done`. Depends on: S5.

**Closeout:** 58 app tests and 49 Chrome/Axe checks pass. All 60 discovered Markdown pages render, 279 internal links resolve, and 59 referenced blueprints serve. Root typecheck passes; lint retains only the baseline failures. [S6 evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S6.md).

**Goal.** `/docs` replaces what `clio-coder docs` offered and organises the shipped Markdown tree.

**Proposed files.** `contracts/docs.ts`; `server/http/routes-docs.ts`; `server/services/docs.ts`; `server/clio/adapters/docs.ts` (tree from `docs/README.md` tables plus directory scan, page reads within `resolvePackageRoot()/docs` with `realpath` containment, a small in-memory search index built once in the reads worker, blueprint listing from `docs/html` when present); `client/pages/docs/**`; `tests/{docs-http,docs-containment,docs-search}.test.ts`.

**Direction.** `GET /api/docs/tree`, `GET /api/docs/page?path=guide/x.md`, `GET /api/docs/search?q=`, `GET /api/docs/blueprints` and static `/docs-html/<name>` only when the directory exists (checkout), with the traversal and symlink protections `src/cli/docs.ts` and `tests/contracts/docs-server.test.ts` encode. Relative links between Markdown pages are rewritten to `/docs/<path>` routes; links to `docs/html/*_blueprint.html` open the blueprint route.

**Acceptance.**

1. Every scenario in `tests/contracts/docs-server.test.ts` (traversal, symlink escape, HEAD, 405, content types, menu synthesis, topic resolution) has an equivalent passing test against the new routes.
2. Every Markdown page discovered under `docs/` at test time (tracked or untracked; the count is discovered, not hard-coded) renders without a broken internal link (a test walks them).
3. Search for `trace` returns `architecture/trace-store.md` in the first three results.
4. Coverage rows for `docs.ts` updated.

**Out of scope.** Retiring `src/cli/docs.ts` (R3).

---

### S7a. Settings and config inspection reads

Status: `done`. Depends on: S5.

**Closeout:** 60 tests and 61 Chrome/Axe checks pass, including seeded layer/credential redaction and the real 15-second graph deadline. Root typecheck passes; lint has only the baseline failures. [S7a evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S7a.md).

**Goal.** Two read-only pages: effective settings with the layer each key came from, and the "why is Clio behaving this way" customization graph.

**Proposed files.** `contracts/{settings,config-graph}.ts`; routes; `server/services/{settings,config-graph}.ts` (public projections that never include credential values, environment values, or hook argv); `server/clio/adapters/{settings,config-graph}.ts` (`readLayeredSettings(cwd)` and `buildCustomizationGraph(cwd)` in the reads worker, the graph with a 15 s deadline because its import graph is heavy); client pages `Settings` (read-only in this slice) and `Why`; `tests/{settings-http,settings-redaction,config-graph}.test.ts`.

**Acceptance.**

1. `GET /api/workspaces/:id/settings` returns every key with its origin layer (`built-in`, `user`, `project`, `project.local`, `cli`) from a scratch home seeded with user and project layers.
2. The scratch home's real credential store (the config-dir `credentials.yaml` that `src/core/init.ts` creates and `scripts/smoke-real-home.sh` copies) holds a seeded value and an environment API key is set during the test; no response body contains either value.
3. `GET /api/workspaces/:id/config-graph` returns the categories `buildCustomizationGraph` produces, and a graph that exceeds the deadline returns `unavailable` without wedging later reads.
4. Browser check recorded for both pages.

**Out of scope.** Any write.

---

### S7b. CLI mutation runner, targets read, targets use and remove

Status: `done`. Depends on: S7a.

**Closeout:** 66 app tests and 73 Chrome/Axe checks pass, including real CLI selection/removal, routing parity, SIGTERM cancellation, sanitized failures, and large-result retention. Root typecheck and lint pass fully after the operator moved the unrelated audit.

**Goal.** The first mutations, through fixed-argv CLI children, plus target listing without a session.

**Proposed files.** `server/process-policy.ts` gains `runClioCommand` over a closed argv table; `server/services/cli-runner.ts` (bounded stdout 8 MiB, stderr 256 KiB, timeout, JSON parsed once, SIGTERM cancel, ported from the shape of `apps/workbench/clio-read-command.ts`); `contracts/targets-cli.ts`; routes; client `Targets` page and the `use` and `remove` controls; `tests/{cli-runner,targets-http,targets-mutations}.test.ts`.

**Direction.** `clio-coder targets --json` is a deliberate fixed-argv bridge (the `ProvidersContract` needs the loaded domain); `targets --json --probe --target <id>` is a cancellable probe operation. Mutations as operations: `targets use <id>`, `targets remove <id>`, the identifier validated by regex before it enters argv. Both commands print terminal prose, not JSON (`src/cli/targets.ts` uses `printOk`); the operation's outcome is the exit code plus a typed follow-up read (`readLayeredSettings` or `targets --json`), and their stdout is never parsed. `targets add` only if a non-interactive `--json` form exists at the session SHA; otherwise deferred and recorded. Global settings edits beyond these are recorded as a class C candidate.

**Acceptance.**

1. The runner refuses any argv not in the closed table; tests assert the exact argv spawned for each allowed command and that no client string other than a validated identifier ever appears.
2. `targets use <id>` on a scratch home changes `chat.target`, visible on the next settings read; `targets remove` removes it; both appear as finished operations whose result is the follow-up read, with no parsed prose.
3. Cancelling a running probe terminates the child (SIGTERM observed by the fixture).
4. A CLI exit code outside the accepted set becomes `operation_failed` with the exit code in `detail` and no stderr text in the response.

---

### S8a. Fleet runs, receipts, councils, gates

Status: `done`. Depends on: S5.

**Closeout:** 67 app tests and 82 Chrome/Axe checks pass. Fleet history walks all 150 fixtures exactly once beyond the root scan cap, isolates corrupt records and escaping receipt symlinks, and displays receipts, council rounds, and verified gates. Root typecheck/lint pass.

**Goal.** A paginated fleet page: durable runs, per-run receipt, council and gate topologies.

**Proposed files.** `contracts/fleet.ts`; routes; `server/services/fleet.ts`; `server/clio/adapters/fleet.ts` (own directory scan of `<state>/fleet-runs/` for pagination, `readFleetRun` per row, `councilTopologies` and `gateTopology` from `src/domains/dispatch/{council-topology,gate-topology}.ts`, receipts from `<state>/receipts/<runId>.json`); client `Fleet` pages; `tests/{fleet-http,fleet-pagination}.test.ts`.

**Acceptance.** With 150 fixture fleet-run records, pagination visits each once; a corrupt record costs its row, not the listing (the seam's rule); a run page shows its receipt, council rounds, and gate decisions from fixtures; the ledger records that `MAX_FLEET_RUN_SCAN` was bypassed by the adapter's own scan and why.

---

### S8b. Evidence

Status: `done`. Depends on: S5, S7b (for the runner).

**Goal.** Evidence inventory with pagination, artifact detail with trust, provenance, and gate decisions, and `evidence build --run <runId>` as an operation.

**Proposed files.** `contracts/evidence.ts`; routes; `server/services/evidence.ts`; `server/clio/adapters/evidence.ts` (`listEvidenceOverviews`, `inspectEvidence`, `loadEvidenceTrustStatus`, `loadEvidenceRunProvenance`, `loadEvidenceGateDecisions` from `src/domains/evidence/store.ts`); the runner gains `evidence build --run <runId>` (the syntax in `src/cli/evidence.ts`; `--session` and `--eval` forms may follow); client `Evidence` pages; `tests/{evidence-http,evidence-build}.test.ts`.

**Acceptance.** With 40 fixture artifacts, pagination visits each once; a missing trust file yields `verdict: unknown` for that artifact only; `evidence build --run <runId>` on a fixture run exits 0 and the follow-up inventory read shows the new artifact (its terminal prose is not parsed).

---

### S8c. Evals and usage

Status: `done`. Depends on: S5, S7b.

**Goal.** Stored eval reports and the cross-session usage report.

**Direction.** Evals: use the `src/domains/eval` store exports if a listing function exists at the session SHA; otherwise the fixed `clio-coder eval inventory --json` bridge through the runner, recorded in the ledger with the reason. Usage: `clio-coder usage report --repo <root> --days 30 --json` bridge (the root path is the canonical workspace root, never client text).

**Acceptance.** Both pages render from a scratch home seeded with the root test fixtures for eval artifacts and session ledgers; the ledger states seam or bridge per collection.

---

### S8d. Library and catalog

Status: `done`. Depends on: S5, S7b.

**Goal.** Agents, skills, prompts, fleets, plugins, extensions, and verifiers as one library view.

**Direction.** Prefer the loaders exported from `src/domains/resources/index.ts` and the agents registry where the projection is simple; use the `library list --json`, `library inventory --json`, `agents --json`, `extensions list --all --json`, and `verifiers inspect --json` bridges where the CLI already folds discovery the loaders do not. Record the choice per collection. No install or remove in this slice.

**Acceptance.** Every collection renders from a scratch home with the bundled library; counts match the CLI's `--json` output for the same home.

---

### S8e. Interop and system

Status: `done`. Depends on: S5.

**Goal.** Detected external coding agents, and a system page with doctor findings, resolved paths, and versions.

**Direction.** `detectInteropAgents` and `discoverInteropInventory` in the reads worker (bounded `--version` probes); `runDoctor({fix: false})` and `resolveClioDirs()`; `GET /api/meta` extended with `getVersionInfo()` fields.

**Acceptance.** The interop page lists every known kind with presence; the system page shows doctor rows and the four roots; no `--fix` path is reachable from the app.

---

### S9. Launcher, idle-exit, process policy

Status: `done`. Depends on: S4, S5.

**Goal.** The app can be opened like an application without a terminal on Linux, its process and network policy is enforced and audited, and an installable PWA reconnects to an explicitly enabled background endpoint.

**Proposed files.** `server/main.ts` flags `--open`, `--idle-exit <ms>`, `--token <value>`, `--port <n>`, `--log-file <path>`; `server/launcher/{desktop-entry,install}.ts`; `tests/{idle-exit,launcher-linux,egress-policy,open-browser}.test.ts`.

**Acceptance.**

1. `--idle-exit 2000` exits about two seconds after the last client disconnects when no operation or turn is live; a live turn holds the process and exit follows its end.
2. The app-local `launcher install --prefix <scratch>` writes a `.desktop` entry that starts the checkout server with absolute Node, tsx loader, and entry paths plus `--open --idle-exit 60000`; it works independently of the launcher's working directory. S9 cannot invoke `clio-coder web`, which does not exist until R1. `status` verifies the entry, `uninstall` removes only what it wrote; on `darwin` and `win32` the command refuses with the documented message. A manual run on this Linux machine records: entry visible in the launcher, click starts the server and opens the authenticated page, closing the page ends the process after the idle window. R1 changes the packaged launcher target to `clio-coder web --open --idle-exit 60000` and repeats this lifecycle check.
3. The test suite runs with `globalThis.fetch` throwing; only the toolchain adapter's allowlisted fetch is exercised through injection.
4. E8 recorded: probe flag support on the supported Node baseline and local runtime, then record the audit access set and whether `--permission` works under `tsx` where supported. An unavailable optional flag records the experiment as unsupported; it does not raise the app's minimum Node version silently.
5. **Amended by the operator:** ship an installable PWA backed by an explicitly enabled background service. Persist a stable origin and protected authentication across server/browser restarts; do not put credentials in the manifest, service-worker cache, or public bootstrap. Verify real Chrome installation and app-window launch, close/reopen, backend restart/recovery, offline messaging, and removal of only owned background/launcher files. Browser tabs and installed windows use the same frontend and APIs. Retain foreground idle-exit as a separate launch choice. The background endpoint starts at user login and recovers after an unexpected process failure; it does not start merely because a CLI/TUI/headless command runs. Record platform limits and actual measurements. The earlier fixed-port E5 experiment remains evidence explaining why background availability is required.

---

### S10. Packaging rehearsal from `apps/`

Status: `done`. Depends on: S9 and every slice that absorbs a non-retired coverage row (S6, S7a, S7b, S8a, S8b, S8c, S8d, S8e), so R1 never packages an app that has not absorbed what it replaces.

**Goal.** Prove the R1 layout without touching the root: bundle the server and both workers as three entries into `apps/clio-coder-web/dist/rehearsal/` with an app-local esbuild or tsup config that mirrors `tsup.config.ts` (`splitting`, `platform: node`, `external: ["node:sqlite"]`, no minify), and run them from a scratch directory with no `tsx`.

**Acceptance.**

1. Without `CLIO_CODER_PACKAGE_ROOT`, the rehearsal server started from `dist/rehearsal/` reports the wrong package root (the app's), demonstrating the hazard; with the variable pinned to the repo root, `/api/meta.clio` is correct and both workers start from their emitted entries.
2. Bundle sizes of the three entries and their shared chunks are recorded, with the projected tarball delta against the 10 MB budget.
3. A written R1 checklist with the exact `tsup.config.ts` entries, `noExternal` or `dependencies` decision, `files` globs, and manifest lines.

---

### R1. `clio-coder web` and the packaged install (class C)

Status: `done`. Depends on: S10. Root files: `src/cli/index.ts`, `src/cli/web.ts`, `tsup.config.ts`, `package.json`, `scripts/release-manifest.json`, `scripts/check-release.mjs` (only if budgets move), `tests/smoke/installed-package.test.ts`, `CHANGELOG.md` (Unreleased).

**Direction.** `web` joins `COMMAND_HANDLERS` as a literal dynamic import of `./web.js`; `src/cli/web.ts` locates `../web/server.js` beside `dist/cli/` by URL, imports it, and runs it in the foreground with the CLI's flags forwarded. tsup entries `web/server`, `web/reads-worker`, `web/ops-worker`; the server resolves worker entries by URL beside itself, with the source-mode paths as the fallback when running under `tsx`. The root build copies `apps/clio-coder-web/dist/client/` to `dist/web/client/`. `files` gains `dist/web/**`. The manifest gains `dist/web/server.js`, `dist/web/reads-worker.js`, `dist/web/ops-worker.js`, `dist/web/client/index.html`.

**Acceptance.**

1. `pnpm run build` produces the three web entries and the client directory; `node scripts/check-release.mjs` passes within budgets.
2. `tests/smoke/installed-package.test.ts` gains a case that packs, installs into a scratch prefix, proves `tsx` is not resolvable as a module from the installed package (`import.meta.resolve("tsx")` from a script inside the install root rejects, `NODE_PATH` unset, no checkout reachable), runs `clio-coder web --port 0 --token t --no-open`, reads `/api/meta`, performs one reads-worker call (`/api/toolchain/tools`) and one ops-worker call (`removeTool` on an id with nothing vendored), and asserts through a test-only diagnostic route enabled by `NODE_ENV=test` that both workers launched from `dist/web/reads-worker.js` and `dist/web/ops-worker.js` (each reports its `import.meta.url`) and that `resolvePackageRoot()` in the server and in each worker equals the installed package root.
3. `clio-coder --version` and `clio-coder --help` load time is unchanged within noise (the boot trace shows no web chunk loaded).
4. `pnpm run ci:release` passes in full. If the baseline docs-parity failure is still present, R1 is blocked on the other workstream resolving it and the ledger says so; the exception never counts as a pass.

---

### R2. Trace retirement (class C)

**Operator amendment:** viewer deletion, command/flag removal, workspace/script/gate cleanup, and current docs references completed in the separate 2026-09-11 retirement commit. The optional root `runsPage` seam replacement remains deferred to root web integration; S2 pagination continues to use its tested app-local adapter.

Status: `done`. Depends on: R1, S2 matrix rows absorbed. Root files: `src/domains/observability/trace-store.ts` (`TraceReader.runsPage({before, limit, filter})`), `src/cli/trace.ts` (remove the `ui` subcommand, its `--port` flag, `runTraceUi`, and the help line; it is obsolete, not aliased), `package.json` scripts (`trace:ui`, `test:trace-viewer`, `ci`), `docs/architecture/trace-store.md`, `README.md`, deletion of `apps/trace-viewer/`, `CHANGELOG.md`. The app's keyset SQL is replaced by the new seam in the same session.

**Acceptance.** `pnpm run ci` no longer references the viewer; `clio-coder trace ui` is an unknown trace command (exit 2, the existing rule for unknown subcommands); the app's pagination tests pass against `runsPage`; root lint passes in full.

### R3. Docs command becomes canonical navigation (class C)

**2026-09-11 operator correction.** Finish one documentation experience now, with the refreshed Fable helper: preserve handmade blueprint source/content and interactions, present it inside the app with its active theme, remove new-tab blueprint navigation and the separate CLI server, and ship the same docs experience in npm. This authorizes R3 and the corresponding app contracts, presentation, package assets, tests and current operator documentation updates, including removal of the obsolete HTML exclusion in `scripts/check-hygiene.ts`. Preserve handmade layouts and content; only correct obsolete docs-launch/package instructions manually, without regenerating the blueprints. No push or version bump.

Status: `done`. Depends on: R1, S6. Root files: `src/cli/docs.ts` loses its static server and becomes the canonical `clio-coder docs [topic]` command that starts the web server and opens `/docs[/<topic>]` (this is a deliberate product command, not a compatibility alias; the help text says what it does); `tests/contracts/docs-server.test.ts` replaced by a test of the topic-to-route mapping; help text in `src/cli/index.ts`; `README.md`, `docs/README.md`.

**Acceptance.** `clio-coder docs safety` opens the app at the safety page from a checkout and from an installed package (Markdown page with its paired blueprint available in both); no static docs server remains in `src/cli/`.

### R4. Workbench retention and disconnection (operator amendment)

**Operator amendment:** source retention and build/publication/gate disconnection completed in the separate 2026-09-11 retirement commit. Packaged launcher/uninstall integration remains dependent on R1. Do not delete Workbench.

Status: `done`. Depends on: R1, S4, S5, S7a, S7b, S8a to S8e matrix rows absorbed. Root files: retain `apps/workbench/` as reference source; exclude it from pnpm workspace builds, publication, and gates; preserve its `biome.json` exclusion; `README.md`, `CONTRIBUTING.md`, `ROADMAP.md`, `docs/architecture/acp.md`; comments in `src/domains/evidence/detail.ts`, `src/cli/fleet-verify.ts`, `src/interactive/overlays/settings.ts`; `src/cli/uninstall.ts` removes the launcher entry the app installed (reads the same manifest the launcher writes); `CHANGELOG.md`.

**Acceptance.** No active runtime, build, launch, or current operator instruction depends on `apps/workbench`, the retired `clio-coder-gui` executable, or the workbench's Deno runtime. Accurate historical records and unrelated Deno integrations may retain those names. `pnpm run ci:release` passes in full, with no baseline exception; `clio-coder uninstall --dry-run` lists the launcher entry when one exists.

## 6. Command glossary

| Command | Status | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | existing | Dependency-introducing slices use `pnpm install` after their app manifest edits, within class B |
| `pnpm run build` (root) | existing | required before any slice that spawns the real CLI |
| `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, `pnpm run ci` (root) | existing | lint caveat in section 0 |
| `node apps/trace-viewer/server.mjs --db <path>` | existing | reference for S2 until R2 deletes it |
| `node dist/cli/index.js acp --cwd <root>` | existing | the child the supervisor spawns |
| `pnpm --filter @iowarp/clio-coder-web start | dev:server | dev:client | build | typecheck | test | openapi | verify` | introduced S1 | |
| `pnpm run test:web` (root) | introduced S1 | class B |
| `pnpm --filter @iowarp/clio-coder-web test:acp-real` | introduced S3 | real CLI against the OpenAI-compatible fixture; not part of `test` |
| `pnpm --filter @iowarp/clio-coder-web smoke:browser` | introduced S5 | |
| `node --import tsx server/main.ts --open --idle-exit <ms> --token <t> --port <n> --log-file <p>` | introduced S9 | |
| `clio-coder web [...]`, `clio-coder web launcher install|status|uninstall` | introduced R1, S9 code | |

## 7. Coverage matrix

Status values: `todo`, `absorbed` (with slice), `retired` (deliberately not carried), `deferred` (named gap). Update this table in the slice that changes it.

| Capability | Source | Target slice | Status |
| --- | --- | --- | --- |
| Run list with filter, source badge, live refresh | trace-viewer | S2 | absorbed (S2) |
| Run page: headline, duration, phase waterfall, cost panel, phase facts | trace-viewer | S2 | absorbed (S2) |
| Event log with every type and payload, tool spans, truncation marks | trace-viewer | S2 | absorbed (S2) |
| Gates with checks and violations | trace-viewer | S2 | absorbed (S2) |
| Processes panel | trace-viewer | S2 | absorbed (S2) |
| Receipt panel: outcome, verification, spend, tool stats, findings, provenance; sidecar tolerance | trace-viewer | S2 | absorbed (S2) |
| Server-clock adoption for live spans; pinned timestamp formatting; truthful zero and missing spend | trace-viewer | S2 | absorbed (S2) |
| Read-only open, schema and WAL checks, rowid cursor | trace-viewer | S2 (via `TraceReader`) | absorbed (S2) |
| Full-history pagination | new | S2 | absorbed (S2) |
| Static blueprint serving, traversal and symlink protection, HEAD and 405 | `src/cli/docs.ts` | S6 | absorbed (S6) |
| Topic deep link and menu synthesis | `src/cli/docs.ts` | S6 | absorbed (S6) |
| Markdown docs tree, rendering, search | new | S6 | absorbed (S6) |
| One ACP child per session; initialize, new, load, prompt, cancel, close | workbench | S3, S4 | absorbed (S3/S4) |
| Turn projection: text, thought, tool cards with kind, status, locations; provenance labels | workbench | S3 | absorbed (S3) |
| Permission mediation with escalate and budget timers, never implicit | workbench | S4 | absorbed (S4) |
| Loop-guard and dispatch event strip; `accountability.evidenceReady` | workbench (six kinds) plus the seventh | S4 | absorbed (S4) |
| Safe settings get and patch (four keys), autonomy | workbench | S4 | absorbed (S4) |
| Targets list and probe through the session | workbench | S4 | absorbed (S4) |
| Session list, label, delete | workbench | S3, S4 | absorbed (S3/S4) |
| Recent workspaces, open by path | workbench (folder picker) | S3 | absorbed (S3) |
| Bounded read-only file tree | workbench | deferred to a slice after S8e | deferred |
| File create, move, delete with challenge | workbench | retired | retired |
| Config inspection (customization graph) | workbench | S7a | absorbed (S7a) |
| Catalog: agents, skills, library, extensions, verifiers | workbench | S8d | absorbed (S8d) |
| Usage report | workbench | S8c (bridge) | absorbed (S8c) |
| Routing: offline models, profiles, bindings | workbench | S7b (bridge) | absorbed (S7b) |
| Dispatch status, fleet inspection, decisions | workbench | S8a | absorbed (S8a) |
| Interop inspection | workbench | S8e | absorbed |
| Eval inventory | workbench | S8c | absorbed (S8c) |
| Evidence inventory and detail; receipt verify | workbench | S8b | absorbed (S8b) |
| Recovery: doctor and paths | workbench | S8e | absorbed |
| Markdown, Prism, Mermaid rendering rules | workbench | S5 | absorbed (S5) |
| Design system rules and acceptance floor | workbench | S5 | absorbed (S5) |
| Browser smoke with Axe; perf workload | workbench | S5 (perf optional) | absorbed (S5); perf deferred |
| Deterministic ACP child fixture | workbench (Deno) | S3 (Node) | absorbed (S3) |
| Deno compiled binary, `.desktop` lifecycle, `clio-coder-gui` | workbench | retired; replaced by the S9 launcher and required background PWA amendment | retired |
| Artifact allowlist snapshot windows | workbench | retired | retired |
| Host-only payload policy | workbench | retired (see review section 13, item 3) | retired |
| Protocol v4 WebSocket and command frames | workbench | retired | retired |
| State-dir migration and deprecated env override | workbench | retired | retired |
| Thirteen CLI re-validation inspectors | workbench | retired | retired |

## 8. Release acceptance for v0.4.8

Publication is not authorized by this file. These are the checks a release candidate must pass.

1. **Automatically available after a normal install.** `npm install -g @iowarp/clio-coder@<version>` on a machine without the checkout includes the API server, workers, and web assets; `clio-coder --help` prominently lists `web` and describes the app, and `clio-coder web --open` serves it without a separate download or build. `clio-coder web launcher install` succeeds on Linux and refuses with the documented message elsewhere. The application is automatically installed with the package; adding a desktop menu entry is an explicit launcher action, not an npm lifecycle side effect. State that distinction in the release instructions.
2. **Supported platforms.** Linux x64 and WSL2 verified in CI and locally; macOS and Windows verified only to the extent a session has run them, stated in the CHANGELOG as such; no claim beyond what was run.
3. **Version-matched assets and API.** `GET /api/meta` reports the same `clio` version as `clio-coder --version`; the client refuses a mismatched `apiVersion`; `contracts/openapi.json` in the package matches the served `/api/openapi.json`.
4. **Lazy startup.** `CLIO_CODER_TRACE_BOOT=1 clio-coder --version` and `clio-coder --help` load no `dist/web/` chunk; the interactive TUI boot is unaffected (boot trace compared against the previous release).
5. **Independence.** CLI, TUI, and `clio-coder acp` run with the web server absent; nothing starts it implicitly.
6. **Source-checkout-independent verification.** The installed-package smoke (R1) passes from the packed tarball with `tsx` absent; both workers start; the package root resolves correctly in all three processes.
7. **Gates.** `pnpm run ci:release` passes in full with no exception; the baseline lint caveat in section 0 applies to app work only, because the shell pipeline stops at the first failing gate and a partial pass proves nothing about the later ones. `scripts/check-release.mjs` budgets hold or were raised by explicit operator decision recorded in `CHANGELOG.md`.
8. **Retirements complete.** `apps/trace-viewer` is deleted with no dangling active references; `apps/workbench` is retained as reference source and disconnected from builds, publication, and gates; `clio-coder trace ui` no longer exists and `clio-coder docs` is the canonical navigation command per R2 and R3.
9. **Security posture stated.** `README.md` documents loopback bind, per-launch token, the spawn chokepoint, egress limited to pinned tool downloads, and whether `--permission` is used by the launcher (E8 outcome).
10. **CHANGELOG.** The `## <version>` section describes the app, the retirements, and the platform claims exactly.

## 9. Progress ledger

Append one row per session. Never rewrite history; add a correction row instead.

| Date | Slice | Status | Session SHA start | Session SHA end | Root delta since reviewed SHA inspected? | Evidence and notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-11 | S0 planning | done | `1e1162f6` | `1e1162f6` | n/a | `ARCHITECTURE_REVIEW.md` and this file written; no code; baseline lint caveat recorded |
| 2026-09-11 | S0 advisor review | done | `1e1162f6` | `1e1162f6` | HEAD unchanged | Astra accepted the architecture with E4 as the framework checkpoint; corrected unfinished-slice resume, dependency lockfile scope, checkout launcher before R1, and unconditional release gates. Planning documents only. |
| 2026-09-11 | S1 foundation/toolchain | in-progress | `1e1162f6` | `1e1162f6` | HEAD equals reviewed and last ledger SHA; no intervening commits or seam changes | App implemented; app verify passes (19 tests, both TS programs, Biome, client build), root build/typecheck pass, live curl and Chrome install/progress/remove pass. E1 threads retained; E4 363 glue lines. Root lint has the two baseline docs failures plus the exact-ci checker conflict; checker edit exceeds class B and was not made. [Full evidence, screenshots, boundary request, and resume instructions](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S1.md). No S2 work, commit, or push. |
| 2026-09-11 | S1 authorized closeout | done | `1e1162f6` | `1e1162f6` | HEAD unchanged from reviewed and preceding ledger SHA; inspected the required local checker seam | Operator explicitly approved the prepared one-line checker update. Applied it without other checker changes. Frozen install, root build/typecheck, client build, and app verify (19 tests, including boundaries and OpenAPI) pass. Root lint fails only on the two documented docs-parity conditions; Biome passes with existing warnings/info and there are no new lint regressions. Earlier browser/E1/E4 evidence remains applicable to the unchanged app. [Closeout evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S1-closeout.md). S2 is next; no S2 work, commit, or push. |

| 2026-09-11 | S2 trace explorer | done | `b89f2046` | `b89f2046` (pre-commit) | Inspected `1e1162f6..b89f2046`: only the approved S1 manifest/checker seams changed; no root source changes | Operator authorized continuing across all S slices and atomic local commits, with no push. S1 committed as `b89f2046`. Added full trace history, details, receipts, and live SSE; 25 app tests pass, including 1,200-run pagination and terminal tail closure. Chrome 1440/390 checks pass, no overflow/errors/failed requests. Root typecheck passes; lint and CI stop only on the two documented baseline docs failures. All S2 changes under the app, no dependencies added. [Evidence and measurements](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S2.md). S3 next. |

| 2026-09-11 | S3 sessions A | done | `6aa24a94` | `6aa24a94` (pre-commit) | S2 commit inspected; no root delta beyond the approved S1 edits | Workspaces, ledger history, ACP supervisor, streamed turn projection, revision buffer, app-state serialization and orphan reconciliation. 35 app tests pass; real CLI test passes with history/load/replay and E3 (three children 603,000 KiB RSS, ~1.4 s boot each; cap remains 4). Real-CLI Chrome conversation passes at 1440/390 with no overflow, JS exceptions or failed requests. Root build/typecheck pass; CI/lint stop only at the baseline docs failures. [Evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S3.md). All changes app-only, no new dependency. S4 next. |
| 2026-09-11 | S4 | done | `4edab892` | `4edab892` (pre-commit) | No root source seam changes since the reviewed baseline; app-only controls through existing ACP methods. | App verify: 42 tests PASS; real ACP controls/label/delete PASS; E2/E4 1,400 chunks replayed exactly, ring 486337 B, RSS growth 69.8 MiB, heap growth 20.0 MiB; root typecheck PASS, lint baseline two failures only. No dependency changes or class C requests. [Evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S4.md). |

| 2026-09-11 | S5 | done | `9a3f3add` | `9a3f3add` (pre-commit) | Root source seams unchanged; inspected the prior app commits and approved S1 manifest/checker delta. | Unified responsive shell, themes, local fonts, safe Markdown/Prism/Mermaid, Problem toasts, browser smoke. Verify: 55 tests and 40 Chrome checks PASS, zero Axe violations/overflow/script errors/failed requests; root typecheck PASS, lint baseline only. Assets 4,231,830 B; entry 516,540 B (156,064 gzip), chunk warnings retained. Nine exact dependencies reuse Workbench pins; root lockfile importer only (+27 lines). [Evidence and screenshots](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S5.md). S6 next. |

| 2026-09-11 | S6 | done | `2cc31787` | `2cc31787` (pre-commit) | Root source seams unchanged; S5 lockfile delta inspected, only its app importer changed. | Docs tree, contained reads, heading/link routes, search and sandboxed blueprints. Verify: 58 tests and 49 Chrome checks PASS, zero Axe/overflow/errors/failed requests. Walk: 60 Markdown pages, 279 live internal links, 59 blueprints. Three outside-repository references in the unrelated draft remain visibly unavailable. Root typecheck PASS, lint baseline only. No dependencies or root edits. [Evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S6.md). S7a next. |

| 2026-09-11 | S7a | done | `1c5dd3f6` | `1c5dd3f6` (pre-commit) | S6 is app-only; no root seam changes since reviewed baseline. | Effective settings and customization graph through lazy worker adapters. Canonical leaf/source, credential/env/argv redaction and no-write tests PASS; graph 15-second deadline and later reads PASS. Verify: 60 tests and 61 Chrome checks PASS, zero Axe/overflow/errors/failed requests. Root typecheck PASS, lint baseline only. No dependencies/root edits. Projections remove sensitive data before worker RPC; graph transitive imports stay in the reads worker. [Evidence](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/2026-09-11-S7a.md). S7b next. |

| 2026-09-11 | S7b | done | `9b786872` | `9b786872` (pre-commit) | S7a inspected; root Pi patch unchanged since its earlier keyboard commit. No root source or dependency changes in this slice. | Fixed-argv CLI runner (four children, 60 s, stdout 8 MiB/stderr 256 KiB), targets list/probe/use/remove and offline routing REST APIs with typed follow-up results; Targets/Routing pages. Real CLI mutations, routing parity, strict argv/JSON, error redaction and cancellation/reaping PASS. Large terminal results use REST refetch from SSE; retention 256 records/16 MiB. Verify: 66 tests and 73 Chrome checks PASS, zero Axe/overflow/errors/failed requests. Root typecheck/lint PASS; old docs baseline resolved by operator. Targets add deferred: configure JSON is inspection, not a non-interactive add contract; other global writes remain class C candidates. All reports now outside checkout under `/var/tmp/clio-web-verification/`; browser report `clio-web-browser-gwtgPT/report.json`. Operator authorized retaining/disconnecting Workbench and retiring trace viewer; that separate cleanup precedes S8a. |

| 2026-09-11 | Operator retirement exception | done | `ba4fe00d` | `ba4fe00d` (pre-commit) | Explicit user authorization overrides the affected root boundaries. Removed only trace UI code/flag; no ACP, provider, persistence, or Pi patch changes. | Removed trace viewer and active command/docs/gate references; retained Workbench byte-for-byte, excluded its workspace importer and namespace gate, preserved Biome exclusion and private publication status. Frozen install PASS (two workspace projects), app typecheck PASS, trace contract 5 PASS. Full `ci:release` PASS: root 2,102 passed / 1 Windows-only skip, web 66 passed, hygiene 16 checks, package 1,752 files / 8.54 MB packed / 45.93 MB unpacked. Log `/var/tmp/clio-web-verification/retirement-ci-release.log`. No audit or temporary artifacts added to the checkout. S8a started; root seam replacement and packaged launcher integration remain deferred. |

| 2026-09-11 | S8a | done | `09ecab7a` | `09ecab7a` (pre-commit) | Reviewed operator retirement delta: trace CLI removal, workspace/lock and gate changes; canonical dispatch/store seams unchanged. | Seven fleet REST reads: keyset-paginated roots and dispatches, individual records, full receipts, councils and gates, with pages consuming these APIs. Own directory scan bypasses root `MAX_FLEET_RUN_SCAN=64` to reach all records; scan rejects beyond 100,000 entries, artifact reads bounded to 8 MiB and realpath-contained. Uses canonical `readFleetRun`, read-only ledger listing, `councilTopologies`, and `gateTopology`. Council (four groups/256 rows) and gate (eight decisions/128 files) windows remain canonical and expose truncation. Fixture 150 roots visited exactly once, corrupt rows isolated, two council rounds and authenticated gate rendered; oversized-ledger error regression PASS. Verify: 67 tests and 82 Chrome checks PASS, zero Axe/overflow/errors; final typecheck/lint and focused storage regression PASS, root typecheck/lint PASS. Browser report `/var/tmp/clio-web-verification/clio-web-browser-uO8QpN/report.json`. No dependency/root changes. S8b next. |
| 2026-09-11 | S8b | done | `a534649a` | `a534649a` (pre-commit) | Inspected S8a app-only delta; root evidence, receipt-integrity and CLI seams unchanged. | Paginated evidence REST and pages, full canonical trust/provenance/gate detail, fixed-argv evidence build and receipt recheck operations. All five named evidence store exports reused; per-run trust verdicts and admitted provenance remain canonical. Bundle severity ordering matches CLI inventory presentation. 40 artifacts visited once, historical trust missing only for its artifact, incomplete files ignored, escaping links refused, invalid gates rejected. Real CLI build exits 0 and adds the 41st artifact; duplicate key does not rebuild; receipt tampering returns canonical failed/ledger-mismatch after a successful command. Bounds: 8 MiB/file, 10,000 directories, 64 MiB overview inventory. Verify PASS: 69 tests, 91 Chrome checks with zero Axe/overflow/script/request failures; final incomplete-file regression 2 PASS. Root typecheck/lint PASS. Logs `/var/tmp/clio-web-verification/S8b-verify.log`, `S8b-final-focused.log`; browser `clio-web-browser-KbTBht/report.json`. No root/dependency edits or temporary artifacts in checkout. S8c next. |
| 2026-09-11 | S8c | done | `46315a54` | `46315a54` (pre-commit) | Inspected S8b app-only changes; root eval store and usage command unchanged. | Eval listing uses exported `listEvalReports` from `eval/inventory.ts`, detail uses `loadEvalArtifactV4`; 13 reports paginate beyond CLI window, malformed files counted, unmeasured tokens remain absent, transcript attachments counted only. Canonical usage bridge receives canonical workspace only and fixed 30 days; discovered actual output is JSON Lines and added strict bounded decoding. Every fact/opportunity retained, including missing stores and shared installation scope. Real session-ledger fixture: two calls / 44 tokens / USD 0.02; another workspace excludes those sessions. Invalid extra arguments and malformed JSONL refused. Verify PASS: 72 tests and 103 Chrome checks, zero Axe/overflow/script/request failures. Root typecheck/lint PASS. Evidence `/var/tmp/clio-web-verification/S8c-verify.log`, browser `clio-web-browser-bcoQQe/report.json`. No root/dependency edits. S8d next. |
| 2026-09-11 | S8d | done | `40eedbd3` | `40eedbd3` (pre-commit) | Inspected S8c app-only changes; root library/resource, extension and verifier seams unchanged. | Seven library collections render with search and incremental display. Package/copy/resource inventory uses `readLibraryInventory`; extensions use `listInstalledExtensions(all: true)` in reads worker. Resolved agents use `agents --json` because the CLI composes agent domains; verifiers use `verifiers inspect --json` because discovery reaches protected tool code. Counts and recipe keys match canonical `library recipes`, `library list`, agents, extensions and verifiers JSON for the same scratch Clio home. Fixture verifier never executes; rejected catalog and tampered extension expose blocked/invalid state. Canonical limits retained: 512 packages, 256 copies, 1,024 resources, 64 verifier checks; agent array rejects above 2,000. Verify PASS: 73 tests / 127 Chrome checks, zero Axe/overflow/script/request failures; root typecheck/lint PASS. Evidence `/var/tmp/clio-web-verification/S8d-verify.log`, browser `clio-web-browser-Z3LFmv/report.json`. No root/dependency edits or temp artifacts in checkout. S8e next. |

Class C requests discovered during S slices (append here, do not act on them in an S slice):

| Date | Slice | Need | Proposed R slice |
| --- | --- | --- | --- |
| 2026-09-11 | S1 | Align `scripts/check-hygiene.ts:441` expected `ci` string with S1's required `test:web` addition. [One-line patch prepared, not applied](/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u/S1-ci-hygiene.patch). Without this, shared S1 acceptance fails beyond the permitted docs baseline. | Explicit S1 boundary exception needed before closeout; deferring to R1 would block its own dependencies |
| 2026-09-11 | S1 closeout resolution | The operator approved the preceding request explicitly; the prepared one-line patch is now applied. Root lint has only the two accepted baseline docs failures. | Resolved in S1 under the approved boundary exception; no R-slice action remains for this request |
| 2026-09-11 | S10 package budget | Separate web bundle added to the real npm tarball measures 10,519,027 B compressed / 52,812,561 B unpacked, above 10/50 MB. | R1 must measure a single shared CLI/web build and fit the existing limits or obtain an explicit root budget decision; no budget change in S10. |

Pinned versions (installed in S1; S10 build-tool addition noted):

| Package | Version | Where |
| --- | --- | --- |
| `@hono/node-server` | `2.1.1` | app dependencies |
| `@tanstack/react-query` | `5.102.8` | app dependencies |
| `hono` | `4.13.5` | app dependencies |
| `react` | `19.3.0` | app dependencies |
| `react-dom` | `19.3.0` | app dependencies |
| `react-router` | `8.3.1` | app dependencies |
| `typebox` | `1.3.0` | app dependencies |
| `@apidevtools/swagger-parser` | `13.0.0` | app devDependencies |
| `@types/node` | `24.12.2` | app devDependencies |
| `@types/react` | `19.3.0` | app devDependencies |
| `@types/react-dom` | `19.3.0` | app devDependencies |
| `@vitejs/plugin-react` | `6.1.1` | app devDependencies |
| `tsx` | `4.22.4` | app devDependencies |
| `tsup` | `8.5.1` | app devDependencies, S10; matches root build |
| `typescript` | `6.0.3` | app devDependencies |
| `vite` | `8.3.0` | app devDependencies |

## 10. Handoff note format

End every session by appending the ledger row and recording in that row (no new temporary notes, audits, screenshots, or prompts inside the checkout): what was built, the exact acceptance checks that ran with pass or fail, anything skipped and why, measurements taken for the bounded experiments, and the next ready slice. If the session ends mid-slice, mark the row `in-progress`, list the files touched, and state what the next session must finish before the acceptance list can be run. Do not commit unless the operator asked in that session.

| 2026-09-11 | S8e | done | `306ba98d` | `306ba98d` (pre-commit) | Inspected S8d app-only changes; root interop, doctor, XDG and version seams unchanged. | Read-only system and workspace interop REST APIs plus pages. Canonical doctor runs with fix false; all four roots and Clio/Node/Pi versions exposed. Failed settings/credentials parser text is explicitly withheld because it can quote secrets. All eight registered agent kinds retain presence and bounded version/resource discovery, including unknown inventory; no accept, execution, or repair route. Canonical limits: 2 s / 4 KiB per version probe, 4,096 inventory files, depth 12, 2 MiB per file; fixture proves a stalled executable is bounded and private config values stay private. Verify PASS: 75 tests / 136 Chrome checks, zero Axe/overflow/script/request failures; root typecheck/lint PASS. Evidence `/var/tmp/clio-web-verification/S8e-verify.log`, browser `clio-web-browser-LVVDHa/report.json`. No root/dependency edits or temporary artifacts in checkout. S9 next. |

| 2026-09-11 | S9 | done | `a654ca12` | `a654ca12` (pre-commit) | Inspected S8e app-only changes; ACP/process, package-root and lifecycle seams unchanged. | Five checkout flags, private lifecycle log, monotonic idle shutdown retaining HTTP/SSE, turns, operations and worker/CLI/session work. Linux launcher owns a checksummed pair, validates absolute targets, survives arbitrary cwd and GLib special-character quoting; preserves changed/unowned files and refuses unsupported desktop platforms. WSLg/Weston native GLib registry listed the entry as visible and activated it into authenticated headful Chrome 152; page close to exit 60,163 ms, uninstall absent. This substitutes native registry activation for a physical GNOME/KDE menu click unavailable here; R1 repeats the packaged lifecycle. E8: exact Node 22.19.0 lacks audit flag; 24.20.0 audit captures checkout/dependency/scratch reads, scratch writes, /proc identity, tsx worker/inspector probes. Enforce fixture reads/install PASS on both with explicit root grants; selecting a valid workspace outside them returns 422, so fixed permission grants are not a launcher default. Found and fixed baseline Node 22 worker tsx inheritance via explicit source bootstrap; ten additional baseline worker/lifecycle tests PASS. E5 fixed-port/token prototype installed and launched through Chrome PWA commands, then relaunch after server close had no live API: PWA deferred, no manifest shipped. Verify PASS: 83 tests / 136 Chrome checks, zero Axe/overflow/script/request failures; root typecheck/lint PASS. Evidence under `/var/tmp/clio-web-verification/`: S9-verify.log, S9-node22-tests.log, S9-desktop-result.json, E8-results.json, E8-workspace-results.json, E5-result.json; browser clio-web-browser-bmm8Ba/report.json. No root/dependency edits or disposable artifacts in checkout. S10 next. |

| 2026-09-11 | S9 PWA amendment | done | `08c0e2ef` | `08c0e2ef` (pre-commit) | Inspected the app-only S9 changes; root runtime and package seams unchanged. Operator explicitly requires PWA and approves background availability. | Explicit Linux systemd user service with stable port/256-bit credential, private atomic configuration, login enablement, failure restart, ownership-checked status/start/open/stop/uninstall, native entry and protected browser persistence. Manifest and recovery service worker ship only in background mode; exactly four public recovery assets cached, no API/token/conversation cache or queued mutations. Real Chrome 152 installability and standalone app lifecycle PASS on Node 24.20.0 and exact 22.19.0: window and full-browser reopen stay authenticated, killed owned server restarts at same origin, stopped-server relaunch shows recovery and reconnects, forgetting propagates between windows, owned service/PWA uninstall completes. DevTools install uses explicit standalone user preference; no emulated display-mode assertion. Native GLib background activation also passes from arbitrary cwd with literal spaces/dollar/percent in paths. PWA preferences/recovery pass all Axe severities and overflow at 390/1050 px; actual login restart is represented by verified enabled user-unit links, no disruptive logout performed. Full verify PASS: 88 tests / 136 Chrome checks, zero Axe/overflow/script/request failures. Root typecheck/lint PASS (existing non-failing Biome warnings only). Evidence `/var/tmp/clio-web-verification/S9-pwa-{verify,native,node22-native,root-types,root-lint,final-types}.log`, browser `clio-web-browser-T1Yexv/report.json`, native `clio-web-pwa-native-HE4ebd/report.json` and `clio-web-pwa-native-xHc0in/report.json`. All test services removed. App-only changes; no dependency/root edits or disposable artifacts in checkout. S10 next. |

| 2026-09-11 | S10 | done | `787f3323` | `787f3323` (pre-commit) | Inspected S9 PWA amendment; app-only commit, root package/worker seams unchanged. | Programmatic app-local tsup 8.5.1 build mirrors root policy, avoids temporary config bundles beside source, emits three entries plus shared chunks/client, strips fabricated tool fixture imports, and keeps source bootstrap separate. Main is importable without starting a listener; worker URLs derive from emitted server entry. Unpinned server and both workers reproduce app-root/0.0.0 hazard; pinned scratch package with only declared runtime dependency links cannot resolve tsx, reports Clio 0.4.7, uses both emitted workers, lists actual registry and completes canonical absent-tool removal in isolated state. Runtime diagnostics are authenticated and test-only; production 404 verified. Node 24.20.0 and exact Node 22.19.0 PASS, including baseline permission mode with measured root/scratch/proc grants. Native PWA/launcher regression PASS after entry changes. Full verify PASS: 88 tests / 136 Chrome checks, zero Axe/overflow/script/request failures. Root typecheck/lint PASS with existing non-failing Biome warnings. Build-tool dependency adds only app manifest and three lockfile importer lines; no unrelated upgrades or root implementation edits. Emitted server 295,601 B, reads 91,124 B, ops 1,256 B; 62 shared/dynamic chunks 2,158,576 B; client 4,336,030 B; web total 6,882,587 B excluding maps. Actual npm repack projection 10,519,027 B compressed / 52,812,561 B unpacked, +1,978,147 B compressed over 8,540,880 B baseline: exceeds 10/50 MB limits, not a passing release package. Exact R1 entries, define, noExternal/dependency choice, globs, manifest and lifecycle checklist in README; single integrated build/installed-tarball test and any budget change remain R1. Evidence under `/var/tmp/clio-web-verification/`: S10-{build,rehearsal,node22,node22-permission,pwa-regression,verify,root-types,root-lint,final-types}.log; runtime `clio-web-rehearsal-tnuJDu/report.json`, budget `clio-web-package-size-pLtIYK/report.json`, browser `clio-web-browser-lgicLm/report.json`, PWA `clio-web-pwa-native-JKaXNL/report.json`. All 15 S slices done; R1 next, not started. |

| 2026-09-11 | Repository hygiene | done | `b2d84375` | `b2d84375` (pre-commit) | No runtime changes; retained Workbench remains disconnected and trace viewer remains removed. | Archived and byte-verified all 26 S1–S7a validation notes/screenshots and the applied checker proposal outside the checkout at `/var/tmp/clio-web-verification/early-slice-evidence-8xj300_u` (1,893,034 B), then removed their tracked app copies. Existing ledger facts retained, historical links point to the archive; prior commits also retain the original evidence. README points to the canonical ledger. Root lint and all 16 hygiene checks PASS (`/var/tmp/clio-web-verification/final-hygiene.log`); no further application tests required for removal of documentation artifacts only. Workbench is byte-identical to its authorized retirement commit and excluded from the workspace; trace viewer remains absent. All S slices remain done; R1 next. |


| 2026-09-11 | UI closeout polish | done | `39e5b0dc` | `39e5b0dc` (pre-commit) | Inspected HEAD and S10/hygiene changes; retained runtime authority. Operator explicitly requested original logo, softer pastel themes, compact application chrome and no website footer. | Original Clio logo restored in header/favicon/PWA and recovery icons. Cream paper/surfaces and muted forest/sage dark tokens; 58 px header, accessible icon controls, navigation icons, no footer; version and installation/forget-browser controls moved into a native preferences dialog. Theme changes settle before paint; Library tabs wrap explicitly on narrow screens. Removed redundant shell/footer CSS rather than stacking overrides. App typecheck/lint and 88 API/unit tests PASS; final headless Chrome pass 139 checks at 1600/1050/390 px with zero Axe findings of any severity, overflow, script errors or failed requests. Root typecheck/lint PASS. Evidence `/var/tmp/clio-web-verification/polish-verify.log` (initial browser failure retained), `polish-browser.log`, browser `clio-web-browser-0xg4yv/report.json`; the final browser pass supersedes earlier timing/wrapping failures. No visible browser launched. Native installed-PWA behavior from S9 remains prior evidence; preference navigation updated and tested headlessly. R1 integration is in progress under the operator amendment above. |


| 2026-09-11 | Bootstrap installer | done | `c149fda7` | `c149fda7` (pre-commit) | Explicit operator request for a GitHub raw-content installer and coherent CLI/TUI/GUI onboarding. Claude Code Fable 5.1 Medium implemented the bounded installer/test task in the authorized pane; main agent reviewed and hardened failure recovery and printed shell quoting. | `scripts/install.sh` installs the selected npm version into a user-writable prefix, checks Node >=22.19.0/npm, supports dry-run/version/prefix/optional-dependency choices, refuses foreign launchers unless explicitly forced, restores a displaced link after an early npm failure, prints safe PATH guidance, and delegates post-install migrations to Clio. Next steps inspect the installed help so older npm releases never advertise an unavailable web command. No sudo, shell-profile edits, automatic browser launch or background enablement. All 16 isolated installer contracts PASS, with no network/global install (`/var/tmp/clio-web-verification/installer-final-tests.log`); root lint/hygiene PASS. GitHub URL is prepared, not published; no package version change. R1 and final release gate remain in progress. |

| 2026-09-11 | R1 packaged web integration | done | `4427fdc0` | `4427fdc0` (pre-commit) | Reviewed root CLI/build/package changes since the prior ledger; no ACP, domain or engine behavior changes. Operator authorized root package integration for v0.4.8. | Lazy `web` command, integrated CLI/server/two-worker build and bundled client, licenses including all three font OFLs, compiled native background/desktop launch paths with ownership checks. Removed the superseded S10 rehearsal recipe and tests in favor of the actual npm install test. Programmatic tsup/Vite builds avoid temporary config artifacts beside source. Actual isolated npm install starts both workers without tsx, exercises API/SSE/CLI operations and PWA assets, shuts down cleanly, and proves version/help do not evaluate the server. Native compiled systemd probes PASS on Node 24.20.0 and exact 22.19.0, including restart, stable identity and owned removal; existing user service untouched. Full `ci:release` PASS: 2,118 root tests passed, one skipped, 89 web tests passed, all 16 hygiene checks passed. Final app verify PASS: 139 headless Chrome checks at 1600/1050/390 px, zero Axe findings, overflow, script errors or failed requests. Package 1,929 files, 10.15 MB compressed / 50.89 MB unpacked within the measured 12/55 MB limits. Final skip-link scroll margin also verified. Evidence under `/var/tmp/clio-web-verification/`: `closeout-ci-release.log`, `closeout-app-verify.log`, `clio-web-browser-q3Z6jZ/report.json`, `R1-installed-package-smoke.log`, `R1-native-probe.log`, `R1-native-node22.log`. No visible Chrome, push, publication or version bump. |

| 2026-09-11 | Live conversation credential recovery | done | `12e30da4` | `12e30da4` (pre-commit) | Operator reported a real project session failing on “hi”; traced the recorded runtime error before changing the selected target. App/root ACP correction is required for that report. | Background service did not inherit shell-only `CLIO_AI_GATEWAY_KEY`; no stored LiteLLM key existed. Saved the existing credential through Clio’s canonical auth command without displaying it, then reopened the same durable session and confirmed the target probe healthy. Isolated real `blade-gateway` / `dynamo/qwen3.8-27b` ACP “hi”, with no key environment passed, completed in 12,516 ms with 11,989 tokens and an assistant reply. ACP now reports missing credential availability before admission using a fixed `authentication-required` reason; the app explains credential persistence/reopening and gives a trace recovery path for other turn failures. Background setup prints credential guidance. Root typecheck/build, five ACP smoke tests, and four session API tests PASS; regression covers absent service auth, no model request or update before admission, saved auth and reopened session, and no raw provider prose in errors. Evidence `/var/tmp/clio-web-verification/acp-auth-{build,types,smoke,app}.log`; isolated live report under `gateway-acp-*`. No target/model change, browser launch, push, or secret in repository. |

| 2026-09-11 | R2 trace runtime seam | done | `5dea769e` | `5dea769e` (pre-commit) | Trace viewer and `trace ui` were already retired by operator amendment. Reviewed the remaining app SQL against `TraceReader` and its legacy-source behavior. | Added shared `TraceReader.runsPage({before, limit, filter})` with stable timestamp/id keysets and parameterized filters; app now only validates/encodes cursors and projects results. Removed duplicated SQL/source-column handling from the app. Read-only legacy database remains unmigrated; tie paging, source/status/search combination, injection-shaped search and bounded limits pass. Three runtime contracts and five trace API/live tests PASS, including 1,200 runs exactly once and strict cursor validation. Evidence `/var/tmp/clio-web-verification/R2-{reader,api}.log`. Trace viewer remains absent; no Workbench edits. |

| 2026-09-11 | R4 root uninstall integration | done | `d1996693` | `d1996693` (pre-commit) | Retained Workbench remains byte-unchanged and disconnected. Inspected root lifecycle removal ordering and the app’s existing checksummed launcher/service manifests. | Root uninstall previews the web resources, revalidates ownership after confirmation, stops/disables the owned background service and removes its desktop entry before deleting Clio roots. Modified/foreign resources and failed service stops abort the purge; config/data retention remains intact. Uses the separately built app entry only when lifecycle files exist; ordinary CLI-only uninstall remains independent of the web bundle. Default state and desktop discovery includes a custom background directory referenced by its entry; fully custom undiscoverable prefixes require their explicit app uninstall command, documented. Two app ownership/removal tests, eleven root lifecycle contracts, app/root typechecks and actual compiled systemd service removal PASS. Native preview returned one JSON document and retained the running PID; removal stopped/disabled only the scratch service, removed state/launcher, preserved config/data, and left the user prototype active. Evidence `/var/tmp/clio-web-verification/R4-{app,root,app-types,build,native}.log`, `R4-native-mp51vaxj/report.json`. No real-user uninstall, Workbench edits, browser launch or push. |

| 2026-09-11 | R3 unified documentation | done | `12e30da4` | `30d0e17b` (pre-commit) | Reviewed docs command/package behavior since R1; the operator explicitly required a single docs experience and refreshed Fable’s bounded docs task. Auth repair, R2 and R4 landed as independent commits during closeout. | Canonical `clio-coder docs [topic]` opens the app and reuses its verified background endpoint. Removed the separate CLI docs server; npm ships all handmade HTML/shared assets. Guides and blueprints share navigation, search, active theme and paired view controls; legacy HTML URLs redirect into the app. Preserved blueprint content/interactions in an opaque sandbox with denied API/storage access. Added resilient loading/retry, settled fragment links and keyboard access. All 59 guides, 59 paired blueprints and 279 internal links verified; handmade files were not regenerated. Actual installed-tarball docs checks pass with no source app or tsx, byte-identical packaged HTML/assets, and clean shutdown. Focused CLI/API/launcher checks and full root release gate PASS. Final app verify PASS: 92 tests and 144 headless Chrome 153 checks at 1600/1050/390 px, zero Axe violations of any severity, overflow, script errors or unexpected failed requests. Axe stylesheet XHR preload disabled only for opaque blueprint checks; every rule and product CSP retained. Incomplete pseudo-element/copy-button contrast cases were separately inspected and their computed colours passed. Evidence `/var/tmp/clio-web-verification/final-app-verify.log`, `clio-web-browser-c0OzI1/report.json`, `R3-{api-launch-tests,docs-command-tests,installed-package}.log`, `R3-background-reuse.json`, `R3-fable-notes.md`. |

| 2026-09-11 | Sprint implementation closeout | done | `12e30da4` | `30d0e17b` (pre-commit) | Final tree includes the separately committed credential recovery (`5dea769e`), shared trace reader (`d1996693`), and owned web uninstall (`30d0e17b`), plus R3. No root dependency upgrade, version change, Workbench change or push. | All 19 implementation/integration slices complete. Full `ci:release` PASS: 2,120 root tests passed, one Windows process-tree test skipped on Linux, 92 web tests passed, all 16 hygiene checks; actual npm install smoke passed. Package: 1,992 files, 10.75 MB compressed / 53.02 MB unpacked, within 12/55 MB limits. Final app verify independently checked both app TypeScript programs; a missing cleanup-plan type annotation was corrected before the passing run. Real compiled REST “hi” on `blade-gateway` / `dynamo/qwen3.8-27b`, with no key environment passed, streamed text and succeeded in 6,784 ms; the operator’s original project session also completed a live turn successfully. Actual compiled service removal passed on Node 24.20.0 and exact 22.19.0; the user’s service was preserved, then deliberately refreshed while idle and its same conversation restored with stable browser authentication. PWA remains enabled at `http://127.0.0.1:4317`. No visible Chrome launched; S9 native PWA-install evidence remains historical. Linux/WSL2 lifecycle verification only; other platform lifecycle claims remain unverified. Evidence `/var/tmp/clio-web-verification/final-ci-release.log`, `live-rest.log`, `live-rest-llnrgrv1/report.json`, `R4-native-node22.log`, `R4-native-k_fggij9/report.json`, `final-prototype.json`. Release-session prompt is outside the repository at `/home/akougkas/.codex/handoffs/clio-coder-v048-release-2026-09-11.md`. Next: version/release preparation for v0.4.8; publication remains unauthorized. |

| 2026-09-11 | Terminal-first pre-release continuation | done | `b185da30` | `15c4a394` (before docs commit) | Rechecked all 24 pre-web runtime/provider commits since `refs/tags/v0.4.7` and final R3 CLI/package seams. Frozen install and root build pass. | Operator confirmed the GUI works and parked further GUI expansion for a later version, prioritizing terminal/harness packaging, pre-release verification and public documentation. Removed the uncommitted file-browser expansion; project-tree and optional-performance deferrals remain explicit. Fresh Fable 5.1 Medium session `aaa04e1b-1969-4052-bea5-f3392603f4e7` reviewed packaging/install, polished README/community onboarding and independently reviewed the resulting fixes. `ef79a11b` makes every installer next step use the exact quoted launcher and pins all four real-home smoke roots after canonical input-path resolution. `15c4a394` replaces obsolete shipped testing guidance and refreshes only its package pins. This docs closeout leads with configure/TUI/headless, covers pre-web harness fixes in Unreleased, aligns handmade blueprints and release protocol, and repairs README-section hygiene extraction. Full `ci:release` PASS on Node 24.20.0 / pnpm 10.34.5: 2,123 root tests passed, one Windows-only process-tree test skipped, 92 web tests passed, all 16 hygiene checks. Focused installer/release/isolation checks: 26 passed. Actual installed-tarball smoke also PASS on exact Node 22.19.0, with optional dependencies omitted and lifecycle scripts disabled. Package audit: 1,992 files, 10.76 MB compressed / 53.03 MB unpacked within 12/55 MB limits. Strict copied-settings headless smoke PASS against `blade-gateway` / `dynamo/qwen3.8-27b`, including doctor and a real read-only turn; optional-tool warnings remain for old local yazi, absent croc and empty scratch paths. Prior 144 browser checks remain historical evidence; no app implementation changed or visible Chrome launched. User background service remains active. Evidence under `/var/tmp/clio-web-verification/`: `pre-release-ci.log`, `pre-release-focused.log`, `pre-release-node22-package.log`, `pre-release-real-home.log`, `pre-release-fable.md`. Final documentation lint/hygiene and package rechecks PASS (`pre-release-final-lint.log`, `pre-release-final-package.log`); two existing lint warnings and one informational finding remain nonfailing. Handoff remains outside the checkout. No package version change, push, tag or publication. Next: authorized v0.4.8 version/release steps, then a fresh v0.4.9 issue-planning session; do not resume deferred GUI work implicitly. |

| 2026-09-11 | Canonical documentation correction | done | `3232b574` | `3232b574` (pre-commit) | Operator explicitly rejected the legacy HTML duplication and requested docs-only correction. | Removed `docs/html/`, public blueprint endpoints, iframe presentation bridge and reading-view toggle. GUI renders canonical Markdown with generated navigation/search/heading outlines and responsive browsing. Removed obsolete lead links from 59 sources, updated docs authoring policy and CLI topic resolution, and replaced HTML parity enforcement with source/retirement guards. Docs tests pass: 59 pages, 220 internal links, every outline target matches rendered headings and no unavailable source references. Root/app types, root build/lint/hygiene, 11 focused CLI/release tests and actual installed-package smoke pass. Package 1,930 files, 10.15 MB compressed / 50.88 MB unpacked. Running app refreshed with stable authentication and no active turns interrupted; full app verify PASS with 92 tests and 142 headless Chrome checks at 1600/1050/390 px, zero Axe findings, overflow, script errors or unexpected failed requests. Evidence stays outside the checkout in `/var/tmp/clio-web-verification/docs-correction-{api,root-tests,app-types,root-types,build,lint,installed,package,verify}.log`. No unrelated feature, new dependency, version bump or push. |

| 2026-09-11 | v0.4.8 release candidate | done | `8a36c114` | `b93f878d` | Operator requested a release cut; inspected current clean HEAD, release protocol, version policy, remote main/tag availability and npm version availability. Frozen install remains unchanged. | Stamped root package and ACP registry 0.4.8, dated the release notes and finalized public install/app wording. No dependencies or application behavior changed. Strict `CLIO_CODER_RELEASE_CONTEXT=publish pnpm run ci:release` PASS on Node 24.20.0 / pnpm 10.34.5: 2,123 root tests passed, one Windows-only test skipped, 92 app tests passed and all 16 hygiene checks passed. Actual installed-tarball smoke also PASS on minimum Node 22.19.0. Strict copied-settings doctor and real read-only turn PASS on `blade-gateway` / `dynamo/qwen3.8-27b`. Package: 1,930 files, 10.15 MB compressed / 50.88 MB unpacked. Prior 142 headless browser checks remain applicable; this cut changes version metadata and documentation only. Evidence under `/var/tmp/clio-web-verification/v048-release-{ci,node22-package,real-home}.log`. Operator authorized GitHub release steps while excluding npm login/publication; next is canonical main CI followed by the annotated release tag and hosted release gate. |

| 2026-09-11 | Hosted release memory check | done | `4119414d` | `4119414d` (pre-commit) | Main CI passed 2,121 harness tests (two skipped) and Windows subprocess checks, then exposed a source-worker startup race in the streaming memory test. No release tag was created. | Reproduced the unchanged 128 MiB RSS limit failure on Node 22.19.0 restricted to two CPU cores: 137.9 MiB growth included asynchronous worker module loading. The test now waits for both existing worker runtime-info replies before taking the streaming baseline, retains both resident workers and the 128/64 MiB RSS/heap budgets, samples at completion, and emits measurements before assertions. Corrected isolated test PASS (17.9 MiB RSS growth); full 92-test web suite PASS on the same two-core Node 22 setup (19.3 MiB RSS / 12.6 MiB heap streaming growth). Both app typechecks and all 16 hygiene checks PASS. No runtime, dependency, package-content or GUI behavior change. Evidence `/var/tmp/clio-web-verification/v048-{github-main-failure,stream-memory-before,stream-memory-after,app-node22-two-cpu,memory-app-types,memory-lint}.log`. The corrected commit `e293baa5` passed GitHub main CI: 2,122 harness tests (two skipped), 92 app tests, the strict package check and 20 Windows subprocess tests (one POSIX-only skip). Linux skips cover the Windows process-tree case and the optional external WTF-P Claude bundle; the latter passed locally with the available bundle. Annotated `v0.4.8` now names this commit. Hosted release workflow `34666876744` performs the final tagged gate and GitHub tarball publication; npm actions remain operator-owned. |

| 2026-09-12 | Normal prepublish gate repair | done | `9e8808e4` | `9e8808e4` (pre-commit) | Operator reported five failures from the real npm prepublish gate. The 4 GiB `/tmp` tmpfs was 98% full; npm extraction logged `ENOSPC` before its empty-package-JSON error. The configuration-reference fixture also recursively copied ignored nested app dependencies and build output. | The fixture now copies Git’s tracked and non-ignored source inventory, preserves source symlinks, reuses only the required root dependencies/build/Git metadata, checks that app dependencies/build output are absent, and verifies the original documentation remains unchanged. Relocated two inactive, user-owned Clio verification directories intact to `/var/tmp/clio-web-verification/tmp-recovery-z2z9kpeu/`, preserving their original paths as symlinks and recovering about 1.4 GiB. Plain `npm run prepublishOnly` with normal `/tmp` and no TMPDIR override PASS in 225.3 s: all five reported failures passed, 2,123 harness tests passed (one Windows-only skip), 92 app tests passed, types/build/all 16 hygiene checks/package audit passed. Additional `/tmp` peak: 197,005,312 bytes (187.9 MiB); minimum free space: 1,398,325,248 bytes; final free space: 1,568,165,888 bytes. Package remains 1,930 files, 10.15 MB compressed / 50.88 MB unpacked. Evidence `/var/tmp/clio-web-verification/publish-default-tmp-{config,prepublish}.log` and `publish-default-tmp-space.json`. Only tests and this ledger change; packaged product inputs and immutable v0.4.8 tag/artifact remain unchanged. No npm login or publication. |
