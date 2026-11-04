---
title: "Command-line surfaces for GUI checks, brand tokens and OpenAPI"
summary: "Describes the developer-facing scripts under apps/clio-coder-gui/scripts: the browser smoke run, the visual review captures, the performance workload, the brand-token and contrast checks, the brand asset projection, and the OpenAPI regeneration. Read this page to decide which script to run and what it checks."
sources:
  - "apps/clio-coder-gui/scripts/browser-smoke.ts"
  - "apps/clio-coder-gui/scripts/visual-review.ts"
  - "apps/clio-coder-gui/scripts/perf-workload.ts"
  - "apps/clio-coder-gui/scripts/check-contrast.mjs"
  - "apps/clio-coder-gui/scripts/sync-brand.mjs"
  - "apps/clio-coder-gui/scripts/sync-brand-assets.py"
  - "apps/clio-coder-gui/scripts/openapi.ts"
  - "apps/clio-coder-gui/package.json"
  - "apps/clio-coder-gui/tests/harness/app.ts"
  - "apps/clio-coder-gui/tests/harness/trace-fixture.ts"
  - "apps/clio-coder-gui/tests/harness/library-fixture.ts"
  - "apps/clio-coder-gui/tests/fixtures/evidence-seed.ts"
  - "apps/clio-coder-gui/tests/fixtures/library-seed.ts"
  - "apps/clio-coder-gui/tests/fixtures/reports-seed.ts"
  - "apps/clio-coder-gui/tests/openapi.test.ts"
symbols:
  - "harness"
  - "SHOTS"
  - "INSTRUMENTATION"
  - "CHECKS"
  - "roles"
  - "openapiText"
tests:
  - "apps/clio-coder-gui/tests/openapi.test.ts"
invariants:
  - "The browser smoke run records a failure when a checked page has a serious or critical axe violation, a horizontal overflow at a checked width, or a request to an origin other than the server's. Its 200% zoom run asserts outerWidth 1600, innerWidth 800, devicePixelRatio 2 and visualViewport scale 1, and fails on any other measurement."
  - "check-contrast.mjs exits nonzero when any listed foreground/background token pair in either theme falls below its WCAG floor, or when the explicit dark palette and the system-preference dark palette in tokens.css disagree."
  - "sync-brand.mjs --check throws when the generated brand.css differs from its formatted projection, when the provenance design hash is stale, when a projected asset hash differs from provenance.projection.sha256, when a listed font or notice differs from site/assets/fonts, or when the mark's hash differs from site/assets/brand/clio-mark.png."
  - "sync-brand-assets.py exits before writing any output unless pngquant 2.18.0, Pillow 12.1.0 and libwebp 1.6.0 are the detected encoders."
  - "The committed contracts/openapi.json must equal openapiText() output; openapi.test.ts fails if it is stale, and it also checks that the document validates as OpenAPI 3.1."
validate:
  - "pnpm --filter @iowarp/clio-coder-gui run check:brand"
  - "pnpm --filter @iowarp/clio-coder-gui run openapi && git diff --exit-code apps/clio-coder-gui/contracts/openapi.json"
  - "pnpm --filter @iowarp/clio-coder-gui exec node --import tsx --test tests/openapi.test.ts"
---

# Command-line surfaces for GUI checks, brand tokens and OpenAPI

This directory holds the scripts a developer runs against the GUI client and server outside the normal test run. Use it when you need to check the GUI in a real browser, capture screenshots for review, measure streaming performance, verify the brand tokens and their contrast, regenerate brand assets, or regenerate the OpenAPI document. The scripts are not part of the application runtime. The header of `apps/clio-coder-gui/scripts/sync-brand.mjs` states that the installed app reads only its bundled assets.

## Script inventory and entry points

The package scripts in `apps/clio-coder-gui/package.json` wire each file to a name:

| Package script | Entry file | Purpose |
| --- | --- | --- |
| `smoke:browser` | `apps/clio-coder-gui/scripts/browser-smoke.ts` | Drives Chrome through the GUI and asserts on accessibility, layout and behaviour. |
| `visual` | `apps/clio-coder-gui/scripts/visual-review.ts` | Captures named fixture pages as PNGs, or serves the fixture API for `dev:client`. |
| `perf` | `apps/clio-coder-gui/scripts/perf-workload.ts` | Streams a fixture turn and reports frame, input, long-task, and render-count figures. |
| `openapi` | `apps/clio-coder-gui/scripts/openapi.ts` | Writes `apps/clio-coder-gui/contracts/openapi.json` from `openapiText()`, then formats it with Biome. |
| `check:brand` | `apps/clio-coder-gui/scripts/sync-brand.mjs` and `apps/clio-coder-gui/scripts/check-contrast.mjs` | Runs `sync-brand.mjs --check`, then `apps/clio-coder-gui/scripts/check-contrast.mjs`. |

The `typecheck` script in the same file also runs `check:brand`, so brand drift fails a typecheck run. `verify` chains `typecheck`, `lint`, `test:full`, `build` and `smoke:browser`, which places the browser smoke in the full verification path.

`apps/clio-coder-gui/scripts/sync-brand-assets.py` has no package script in `apps/clio-coder-gui/package.json`. Its docstring gives the invocation: run `site/export-brand.mjs` to write a kit, then run the Python script with `--kit` pointing at that kit.

`apps/clio-coder-gui/scripts/browser-smoke.ts`, `apps/clio-coder-gui/scripts/visual-review.ts` and `apps/clio-coder-gui/scripts/perf-workload.ts` each build the app through `harness()` in `apps/clio-coder-gui/tests/harness/app.ts`. The harness is called with a scenario, a `clientDir` and an `origin` getter, and returns the Hono app together with a scratch `home` and helper methods such as `post`. Each script then seeds fixture state and serves the app on a local port with `@hono/node-server`.

The three capture scripts differ in how they seed state:

- `apps/clio-coder-gui/scripts/browser-smoke.ts` calls `seedSettings`, `seedFleet`, `seedEvidence`, `seedReports`, `seedLibrary` and `traceFixture`, with `harness()` given `pwa: true` and `scenario: "markdown"`.
- `apps/clio-coder-gui/scripts/visual-review.ts` seeds settings, fleet, evidence, library and trace state unless `--state empty` is set, then calls `seedHistory` to create a `field-notes` project with saved conversations.
- `apps/clio-coder-gui/scripts/perf-workload.ts` seeds settings only, writes a `convergence-notes.md` file into an `atlas-field-study` project in the scratch home, and opens it through `POST /api/workspaces`.

The seed helpers are thin wrappers around fixture scripts that run as child processes with the scratch workspace as their argument. `seedLibrary` in `apps/clio-coder-gui/tests/harness/library-fixture.ts` runs `apps/clio-coder-gui/tests/fixtures/library-seed.ts` under `tsx`. That script initializes the Clio home, writes a prompt template and a skill into the config directory, installs a read-only user-scope extension from a generated source, and writes a `package.json` with a `test` script into the workspace. It prints the installed extension id. The `libraryOracle` export in the same harness file runs the built CLI (the package's compiled CLI entry, not verified) with `library components`, `library list`, `agents`, `extensions list --all` and `verifiers inspect`, each with `--json`, and returns the parsed results. That oracle needs a built CLI; this page does not verify that build exists at run time.

`seedEvidence` in `apps/clio-coder-gui/tests/harness/evidence-fixture.ts` runs `apps/clio-coder-gui/tests/fixtures/evidence-seed.ts` with the workspace path. That script appends forty finished run envelopes to the run ledger in the state directory, each with a sealed settled run written by `writeSettledRun`, a pipeline provenance record, and an end time one minute after the previous one, so the inventory order is fixed. `seedReports` in `apps/clio-coder-gui/tests/harness/reports-fixture.ts` runs `apps/clio-coder-gui/tests/fixtures/reports-seed.ts`; that script was read only at its top-level structure, and its specific record contents are not described here.

`seedSettings` and `seedFleet` run `apps/clio-coder-gui/tests/fixtures/settings-seed.ts` and `apps/clio-coder-gui/tests/fixtures/fleet-seed.ts` in the same way; their contents were not read and are not described on this page. `seedHistory` writes three conversation directories under `state/sessions/<cwdHash>/`, each with a `docs/wiki/meta.json` and a `current.jsonl` ledger. The rows are a named closed conversation, a closed conversation known only by its first message, and an unended conversation whose `endedAt` is null.

`traceFixture` in `apps/clio-coder-gui/tests/harness/trace-fixture.ts` writes twelve run journals by default, with `run-0000` as a settled run carrying a full journal and a checked result (typed validation, a result contract, and grounding of two claims with one ungrounded), and every third other run left in the `running` state. Its `writtenMs` default sets each journal's write time from the index. The fixture also appends the same rows to the run ledger under the state directory, as the ledger path in that file shows. Its `writeSettledRun` and `seedRunJournal` helpers come from `tests/harness` and `apps/clio-coder-gui/tests/harness/telemetry-fixture.ts`; those were not read.

Each script's `--client` argument points at a built client directory. `apps/clio-coder-gui/scripts/browser-smoke.ts` defaults `--client` to `dist/client`; `apps/clio-coder-gui/scripts/perf-workload.ts` requires `--client`; `apps/clio-coder-gui/scripts/visual-review.ts` requires it unless `--serve` is set. With `--serve`, `apps/clio-coder-gui/scripts/visual-review.ts` keeps the fixture API on port 4317 (its `--port` default). The Vite dev server in `apps/clio-coder-gui/vite.config.ts` proxies to `http://127.0.0.1:4317`, so `pnpm dev:client` pairs with it.

## Browser smoke

`apps/clio-coder-gui/scripts/browser-smoke.ts` parses `--chrome`, `--widths`, `--zoom-only`, `--client` and `--out`. The `widths` values are asserted against 1600, 1440, 1050, 400, 390 and 320; the default is `1600,1050`. The `runs` list holds one run per width at zoom 1, plus a final run at an 800 CSS pixel layout width, which the source tags with `zoom: 2`. Passing `--zoom-only` drops the width runs and keeps only the zoom run.

The final run is a zoom run. The script creates a fresh temporary profile, writes `Default/Preferences` with `partition.default_zoom_level` set to log base 1.2 of 2, and launches a persistent context. After navigating, the script measures `outerWidth`, `innerWidth`, `devicePixelRatio` and `visualViewport.scale`, and asserts `{ outerWidth: 1600, innerWidth: 800, devicePixelRatio: 2, visualScale: 1 }` and a computed body `zoom` of `"1"`. Any other measurement fails the run. The zoom run's phase checks use 800 in place of the window width where layout depends on it.

Every non-zoom context routes requests: same-origin requests continue, and other origins are recorded in `failures` and aborted. Request failures are also recorded, except for aborted event streams, aborted images, and aborted client-initiated GET reads under `/api/`. Responses of status 400 or above are collected in `statuses`. Non-GET API requests are collected in `apiWrites`.

The `check` helper waits until the computed body colour matches the active theme, runs `AxeBuilder`, and asserts that no `aria-allowed-role` violation occurs, that no serious or critical violation remains, and that the document does not overflow horizontally. It writes each violation list to a file named from the width and page name under the output directory. Minor and moderate violations are recorded in `checks` but do not fail the run.

The script then walks the application in one sequence per width. Its phases, in source order, begin with the skip link and focus order on the general settings page, the home composer and the system and explicit dark themes, the reduced-motion preference, and the navigation drawer on phone widths. Later phases cover the settings pages, a simulated stale bundle, traces and run replay, fleet runs, evidence and its inspectors, the help overlay, the rail collapse, the workspace dialog, settings writes and their confirmation gates, the Models, Library, Usage and System pages, the conversation, the task pane, permission approvals, plan dispatch and fleet steering, the context window and timeline, branches and handoff, and the connection-refused stale-token path with reconnection. The individual assertions in the later phases were read but are not each described here.

At the end the script asserts that the page reported no script errors and no request failures, and that the response statuses contain no unexpected errors. The 401 responses from the stale-token step are allowed once per width for the first reads. The report is written to `report.json` in the output directory, and on failure `failure.png` is saved from the failing page.

## Visual review

`apps/clio-coder-gui/scripts/visual-review.ts` defines a fixed `SHOTS` list of nineteen names: home, history, delete, empty, picker, conv, help, traces, trace-detail, fleet-history, evidence, library, toolchain, settings, system, approval, fleet, steer and pane. `--only` takes a comma-separated subset, and an unknown name throws before any browser work starts. `--state` accepts `populated`, `empty`, or `error`. The `error` state fulfils `/api/**` requests other than `/api/meta` and `/api/events` with a 503 problem response whose type is `urn:clio-coder:problem:unavailable`. `--views` takes `WxH:theme` strings with a default of three views. The theme is written to `localStorage` under `clio-coder-gui-theme` before the page loads. The `history` and `delete` shots open the `field-notes` workspace's sessions list; `delete` opens the delete confirmation and then clicks Keep. The `help` shot opens the shortcuts overlay with Control+/. Prompts containing `[approval]`, `[fleet]` and `[stream]` reach those fixture turns. The `picker` shot is taken only when `--route` is set. Without `--serve`, the script captures the selected shots, writes them under `--out`, and prints the collected page errors. The conversation, approval, fleet, steer and pane shots are taken from the conversation the home composer starts; the fleet and steer shots use the `[fleet]` prompt.

## Performance workload

`apps/clio-coder-gui/scripts/perf-workload.ts` installs `INSTRUMENTATION` as a context init script before any app code runs. It records long tasks through a `PerformanceObserver`, frame intervals through `requestAnimationFrame`, keystroke-to-input timing by pairing a `keydown` with an `input` event whose `data` equals the key, and text-event-to-paint latency with a `MutationObserver`. It wraps `EventSource.prototype.addEventListener` for `turn.text` so that it can count streamed deltas, and opens a render-count measurement window at the hundredth delta.

The main loop runs `--turns` turns, at least two (`Math.max(2, Number(values.turns))`). The first turn is quiet. Later turns type a follow-up while the answer streams, scroll the transcript to the middle, and check that the draft is kept and the scroll position stays put. Each turn reports duration, long tasks, a frame-interval summary with a count of frames past 1.5 times the median, render deltas from the composer and turn components, and DOM and heap figures. `--bytes` sets the workload marker to `[workload N]`; the default of 0 streams the reference answer. The report is written to the `--out` directory as a JSON file named by `--label`, and an end-of-run screenshot is written beside it with an `-end.png` suffix.

## Brand tokens and contrast

`apps/clio-coder-gui/scripts/sync-brand.mjs` reads `site/design-system.json`. Its `roles` map picks a palette entry for each CSS custom property, and it writes `apps/clio-coder-gui/client/design/brand.css` with light, explicit dark, and system-dark blocks, the motion tokens, and five `@font-face` rules whose sources point to `/fonts/` woff2 files. The output passes through `biome format` before it is compared or written. Without `--check` the script writes the file. With `--check` it throws when the file drifts from the formatted projection, when the provenance file under `apps/clio-coder-gui/client/public/brand/` names a different design hash, when any entry in `projection.sha256` differs from its file under `apps/clio-coder-gui/client/public`, when one of the listed fonts or notices differs from `site/assets/fonts`, or when the mark's hash differs from `site/assets/brand/clio-mark.png`. That provenance file is rewritten by `apps/clio-coder-gui/scripts/sync-brand-assets.py`.

`apps/clio-coder-gui/scripts/check-contrast.mjs` reads `apps/clio-coder-gui/client/design/tokens.css` and `brand.css`. It computes WCAG relative luminance for each pair in `CHECKS` and compares it to a floor: 4.5 for body text, 3 for large text and non-text boundaries. Each pair is checked in both the light and dark token sets. The `CHECKS` list covers the body, status tones (`TONES`: neutral, running, success, warn, fail, unverified), code syntax kinds, and the setup scene. It also asserts that the explicit dark block and the `prefers-color-scheme: dark` block in `apps/clio-coder-gui/client/design/tokens.css` agree; the two copies exist because CSS cannot share one declaration block between a selector and a media query. `--verbose` prints every pair. The script's comments explain why `--ink-subtle` is checked only as a large-text token.

## Brand asset projection

`apps/clio-coder-gui/scripts/sync-brand-assets.py` takes `--kit` (a directory produced by `site/export-brand.mjs`) and `--out`, which defaults to `apps/clio-coder-gui/client/public`. It locates `pngquant` on `PATH` and stops unless `pngquant`, Pillow and libwebp report the versions it names. It copies the fonts from the kit, verifies that the canonical mark matches the kit's provenance, writes `clio-coder-logo.webp` from a 128-pixel thumbnail, and writes `favicon.png`, `icon-192.png` and `icon-512.png`. Each icon is colour-adjusted, centred in a 94 percent safe area, and then compressed with `pngquant`. It finally rewrites the provenance file under `--out`'s `brand` directory with the encoder versions, the design hash and the output hashes that `sync-brand.mjs --check` reads.

## OpenAPI regeneration

`apps/clio-coder-gui/scripts/openapi.ts` writes the output of `openapiText()`, imported from `apps/clio-coder-gui/contracts/openapi.ts`, to `apps/clio-coder-gui/contracts/openapi.json`. `openapiText()` serializes the document returned by `openapi()`, which walks the `routes` table in `apps/clio-coder-gui/contracts/routes.ts`, converting `:param` path segments to `{param}`. The package script then formats the file with Biome.

`apps/clio-coder-gui/tests/openapi.test.ts` has two tests. The first checks that the committed file equals `openapiText()` (the assertion message points to the `openapi` package script), that it validates as OpenAPI 3.1 through `@apidevtools/swagger-parser`, that every route in `routes` has a matching path and method, that `/api/events` declares the `after` query parameter, and that `/api/operations/{id}` declares a required `id`. The second checks that component names are sorted, that `hoistSharedSchemas` from `apps/clio-coder-gui/contracts/openapi-hoist.ts` is idempotent on the generated document, and that every operation's default response references `Problem`.

## Things to watch when editing

- `apps/clio-coder-gui/scripts/browser-smoke.ts` and `apps/clio-coder-gui/scripts/perf-workload.ts` depend on exact text, labels, and identifiers in the client, for example the `Message Clio Coder` label, the `Stop turn` button, and the `turn.text` event name. A client rename breaks these scripts without a type error.
- `apps/clio-coder-gui/scripts/check-contrast.mjs` lists pairs by token name. A token the client uses for text or a boundary is covered only if its pair appears in `CHECKS`.
- `apps/clio-coder-gui/scripts/sync-brand.mjs` and `apps/clio-coder-gui/scripts/sync-brand-assets.py` both produce files that `--check` compares by hash. Regenerating one without the other, or changing a source asset, leaves the provenance stale.
- `apps/clio-coder-gui/scripts/sync-brand-assets.py` requires the named encoder versions to produce byte-identical assets. Other versions stop it before any output is written.
- `apps/clio-coder-gui/scripts/browser-smoke.ts` and `apps/clio-coder-gui/scripts/visual-review.ts` default the Chrome path to `/usr/bin/google-chrome`. Pass `--chrome` to use another build.
- Scratch output goes under `TMPDIR` when it is set, in a `clio-coder-gui-validation` subdirectory. Without it, the scripts use a `tmp/gui-validation` path resolved relative to the repository.
- The browser smoke, visual review and perf scripts reach the harness through `apps/clio-coder-gui/tests/harness/app.ts`, which is also imported by the test suite. Changes to the harness signature affect every script that calls `harness()`.
- `libraryOracle` requires the built CLI. Without a build, the oracle call fails; this page does not verify the build output.

