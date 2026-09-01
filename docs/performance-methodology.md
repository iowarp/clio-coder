# Performance Measurement Methodology

Clio Coder treats performance observations as diagnostic evidence, not as a
reason to weaken behavior. Event ordering, persistence, permissions, terminal
restoration, accessibility, output contracts, and installed-package behavior
remain blocking correctness gates. The millisecond observations below are
targets and point-in-time measurements; they are not CI timing thresholds.

## Endpoint vocabulary

- **First stdout commit** is the first real TUI render transaction after all of
  that frame's `stdout.write()` calls have returned. It is the event reported as
  `first TUI paint` by the historical boot trace, but its actual endpoint is
  stdout enqueue rather than a displayed pixel.
- **Stage 0 shell commit** is the first stdout commit from the minimal
  single-owner interactive shell. **Stage 1 hydration** is the first committed
  frame after the full application has atomically adopted that same terminal,
  renderer, root host, and editor.
- **Ingress-to-stdout-commit** and **input-to-stdout-commit** correlate a
  canonical event or input sequence with the first committed frame whose high
  water includes that sequence.
- **PTY-observed frame** ends when an external pseudo-terminal reader receives
  the frame bytes. This includes the child-to-PTY boundary, but still does not
  measure terminal-emulator parsing, a remote SSH hop, or monitor presentation.
- **Glass latency** is reserved for an emulator/display harness that observes
  the rendered result. Clio's in-process timestamps do not make that claim.

## Render trace

Set `CLIO_CODER_RENDER_TRACE` to a JSONL path before starting an interactive
session. Version 2 records no conversation text. It records:

- canonical text/thinking ingress sequence, generation, content index, byte
  count, and cumulative UTF-16/grapheme ranges;
- projection-queue admission and dequeue, panel high water, and panel render
  metrics;
- input sequence, semantic action class, byte count, and visual expectation;
- one explicit `frameId` per TUI render transaction, dimensions, regular or
  fullscreen mode, component/layout time, overlay composition, normalization,
  cursor extraction, the combined viewport/diff/ANSI/cursor remainder, and
  terminal-enqueue time;
- every `stdout.write()` return value, including writes outside a frame,
  backpressure, and the matching `drain`;
- every terminal write grouped under its frame, including hardware-cursor and
  IME writes.

The writer truncates the requested path before TUI startup, then uses one
bounded asynchronous queue. Slow storage drops old trace records and emits a
drop count instead of growing without bound. Append failures and append
timeouts disable tracing without failing the application. Normal shutdown
awaits the bounded final flush.

With the instant shell active, textual `[clio:boot]` lines retain timestamps
captured at the Stage 0 commit and Stage 1 committed hydration frame, but their
stderr output is deliberately deferred until after the TUI stops and terminal
protocols are restored. The PTY harness detects the visible Stage 0 bytes and
Stage 1 frame directly, then parses those buffered timestamps after process
exit. This keeps diagnostic output from corrupting the temporary shell without
changing the measured endpoints.

```bash
CLIO_CODER_RENDER_TRACE=/tmp/clio-render.jsonl \
CLIO_CODER_TRACE_BOOT=1 \
CLIO_CODER_INTERACTIVE=1 \
node dist/cli/index.js
```

The deterministic contracts are
`tests/contracts/render-pipeline-trace.test.ts`. The real built-CLI acceptance
harness is `tests/smoke/render-trace-pty.test.ts`; it covers first frame, input
correlation, resize, grouped writes, paused PTY output, adaptive pacing against
a chunked hermetic provider, a controlled `stdout.write() === false`/`drain`
boundary, final-frame settlement, and bounded process cleanup. Set
`CLIO_CODER_PERF_REPORT=1` while running that test to print its observation
records. Real PTY acceptance is currently unavailable on Windows; the
fake-stream frame/backpressure contracts remain cross-platform.

## Import-graph method

The full interactive implementation is the generated `dist/clio-*.js` entry,
not the small fast-path CLI dispatcher. Measure its import with V8's compile
cache disabled when comparing graph cuts:

```bash
entry=$(find dist -maxdepth 1 -type f -name 'clio-*.js' -print -quit)
NODE_DISABLE_COMPILE_CACHE=1 node --input-type=module -e \
  'const t=performance.now(); await import(new URL(process.argv[1], `file://${process.cwd()}/`)); console.log(performance.now()-t)' \
  "$entry"
```

For cache fill versus hit, create one empty temporary directory, set it as
`NODE_COMPILE_CACHE`, import once to fill it, and import a second time without
changing the build or Node version. Use a different empty directory for each
pair. A warm hit is not a cold-disk measurement. Record the operating-system
page-cache state separately.

Module counts come from unique file URLs in `NODE_DEBUG=esm` lines matching
`Translating StandardModule` or `Translating CJSModule`. Generated chunks are
located by stable source markers or source maps, never by assuming a hashed
chunk name. Every lazy-graph contract must prove the heavyweight marker absent
before first use and present after a real invocation, then repeat from a packed
installation in a foreign working directory.

## Corrected 0.3.3 baseline

These observations were recorded on 2026-08-19 in WSL2 Linux
`6.18.33.2-microsoft-standard-WSL2`, x86-64, with an 80x24 `xterm-256color`
PTY, a declared localhost target that was never contacted, warm operating-system
page cache, and the built source checkout at the corrected-instrumentation
slice. Samples are independent processes. `p90` over five samples is the
largest observation and is included only to describe this small sample, not to
claim a population percentile.

With `NODE_DISABLE_COMPILE_CACHE=1`, five real-PTY samples produced:

| Node | First stdout commit median / p90 | PTY-observed frame median / p90 | First-frame build median | Writes in first frame |
| --- | ---: | ---: | ---: | ---: |
| 22.22.3 | 1013.9 / 1120.3 ms | 1030.615 / 1136.960 ms | 7.068 ms | 3 |
| 24.9.0 | 1061.5 / 1082.3 ms | 1079.001 / 1102.019 ms | 6.549 ms | 3 |

The corresponding command was:

```bash
NODE_DISABLE_COMPILE_CACHE=1 CLIO_CODER_PERF_REPORT=1 \
  node --import tsx --import ./tests/harness/tmp-root.ts --test \
  tests/smoke/render-trace-pty.test.ts
```

One fresh compile-cache fill followed by five warm-cache PTY samples produced
the following noisy observations. The first-fill column is one observation;
the warm column is the median of five. These are recorded so cache state is not
silently conflated with boot improvements.

| Node | First stdout commit, fill / warm | PTY-observed frame, fill / warm |
| --- | ---: | ---: |
| 22.22.3 | 1506.0 / 1139.6 ms | 1526.995 / 1157.743 ms |
| 24.9.0 | 1165.0 / 980.0 ms | 1186.487 / 997.062 ms |

Ten direct full-entry imports with V8 compile caching disabled, and five fresh
fill/hit pairs, produced:

| Node | Disabled median / p90 | Fresh-cache fill median | Warm-cache hit median |
| --- | ---: | ---: | ---: |
| 22.22.3 | 670.680 / 803.053 ms | 733.324 ms | 527.618 ms |
| 24.9.0 | 656.781 / 674.592 ms | 740.214 ms | 570.765 ms |

The pre-graph-cut built entry translated 1,332 unique file-backed modules: 54
Clio `dist/` modules, 128 `pi-ai` modules, 660 modules from `pi-ai`'s nested
TypeBox graph, 40 `pi-agent-core` modules, and 37 `pi-tui` modules. Built
JavaScript was 93 files and 6,859,244 bytes. `npm pack --dry-run --json`
reported 6,273,921 packed bytes, 37,637,776 unpacked bytes, and 1,081 entries.
The eager Undici-bearing chunk was 2,552,692 bytes and the eager
tree-sitter/codewiki chunk was 295,539 bytes.

The former 1,054 ms “first TUI paint” figure is not a before value: that mark
was taken before `startInteractive()` and therefore did not measure a frame.
It must not be compared numerically with this corrected baseline.

## Graph-cut observations

Each graph reduction is measured and committed independently. Counts below use
the import-graph method above with V8 compile caching disabled and a warm
operating-system page cache. An unchanged translated-module count can still
hide a meaningful bundled-code reduction: esbuild represents all bundled
sources in one translated Clio chunk.

### Node built-in fetch

Replacing the eager userland Undici import with Node's supported built-in
`fetch` left the translated file-module count unchanged at 1,332 (54 Clio
modules), because Undici had been embedded inside one existing Clio chunk. It
did remove every `node_modules/undici/` source marker and reduced built
JavaScript from 6,859,244 to 5,801,755 bytes. The eager tool-bearing chunk
containing `web_fetch` changed from 2,552,692 to 1,494,333 bytes, a 1,058,359
byte reduction.

Ten full-entry imports changed as follows:

| Node | Before median / p90 | After median / p90 | Observation |
| --- | ---: | ---: | --- |
| 22.22.3 | 670.680 / 803.053 ms | 605.907 / 646.730 ms | lower in this sample |
| 24.9.0 | 656.781 / 674.592 ms | 668.652 / 896.238 ms | no reproducible timing improvement; host noise dominated |

The cut is justified by the deterministic graph and package-size reduction,
not by claiming a universal boot saving. Localhost transport contracts cover
methods, headers, bodies, redirects, streamed UTF-8 truncation and cancellation,
external abort, timeout, HTTP preview errors, binary rejection, and transport
errors on Node 22 and Node 24. The packed-install test invokes `web_fetch`
through a real installed headless tool turn from a foreign working directory
and asserts that neither the packed chunks nor the installed dependency tree
contains userland Undici.

### Lazy codewiki and tree-sitter

Codewiki's schema, artifact parser, synchronous/asynchronous cached reads, and
path classification are now separate from the builder. Interactive startup
loads those lightweight surfaces but does not evaluate the builder or the
bundled tree-sitter runtime. A real build runs in a dedicated worker thread,
which dynamically imports tree-sitter and the requested grammar. Session-start
freshness, parallel `code_nav` demand, incremental mutations, explicit index and
refresh, bootstrap checkpoints, wiki grounding, and reset share one
per-workspace FIFO plus a cross-process file lease. The artifact and its state
metadata commit under that lease, shutdown drains admitted session work, and a
reset cannot be overtaken by an older build.

The deterministic runtime-graph test locates the generated tree-sitter chunk by
its bundled source marker, never its hash. V8 coverage proves that nested
`context index --help` reaches the built index command without evaluating that
chunk or creating `.clio-coder`, while a real one-file build evaluates it and
extracts a generator declaration the regex fallback does not recognize. The
same proof runs against an installed tarball from a foreign working directory.

The after-Undici graph was the before point for this cut. The translated module
count changed from 1,332 files (54 Clio chunks) to 1,336 (58 Clio chunks): the
new lightweight coordinator/worker boundary adds four file modules, while the
formerly bundled tree-sitter code was already represented by one Clio chunk.
The useful deterministic reduction is evaluation, not file count: the former
295,539-byte eager tree-sitter/codewiki chunk is absent from the interactive
graph, and the now-lazy tree-sitter runtime is a 217,988-byte chunk loaded only
inside the build worker. The current interactive import evaluates 5,015,343
bytes across its 58 Clio files. Total built JavaScript is 99 files and
5,812,402 bytes; keeping the worker and lazy chunk in the package is required
for first-use correctness, so total package bytes are not expected to fall.

Ten independent full-entry imports, with V8 compile caching disabled and a warm
operating-system page cache on the same WSL2 host, produced:

| Node | Before median / p90 | After median / p90 | Observation |
| --- | ---: | ---: | --- |
| 22.22.3 | 605.907 / 646.730 ms | 525.656 / 539.633 ms | lower in this sample |
| 24.9.0 | 668.652 / 896.238 ms | 539.056 / 574.139 ms | lower in this sample |

These are local import observations, not a universal startup saving or a CI
threshold. `npm pack --dry-run --json` at this slice reports 6.08 MB packed,
36.65 MB unpacked, and 1,095 entries. The independently blocking
evidence is the source-built and installed runtime-coverage contract plus the
coordinator's generation-order, reset-resurrection, lease-failure, demand,
incremental, wiki, refresh, and shutdown suites.

### Lazy heavyweight tool implementations

`context`, `code_nav`, `verify`, and `web_fetch` now register immutable schema
and policy surfaces while importing their implementations only after registry
admission. The runtime-graph harness makes a real tool-capable provider request
and asserts that all four schemas were serialized while every implementation
file stayed absent from V8 coverage. Four fresh processes then invoke one tool
each, assert its implementation is covered and its semantic result reaches the
provider, and assert the other three remain absent. The exact same harness runs
against an installed tarball from a foreign working directory. A second copied
install deletes the emitted `web_fetch` implementation by stable behavior
provenance and proves the resulting tool error names the missing chunk and the
two standard reinstall commands. No hash, size, source-map, or timing value is
used as a correctness assertion.

The after-codewiki graph is the before point for this cut. Translated modules
changed from 1,336 files (58 Clio chunks) to 1,357 files (79 Clio chunks), as
the split surfaces and dynamic-import boundaries create more, smaller generated
modules. The evaluated Clio JavaScript nevertheless fell from 5,015,343 to
4,929,030 bytes. The four discoverable implementation entries total 104,804
bytes (`context` 33,919; `web_fetch` 24,979; `verify` 24,063; `code_nav`
21,843) and are absent until invoked. Total built JavaScript rose from 99 files
and 5,812,402 bytes to 125 files and 5,840,309 bytes because the package must
ship every first-use path. `npm pack --dry-run --json` reports approximately
6.09 MB packed, 36.69 MB unpacked, and 1,127 entries, versus the previous
rounded 6.08 MB, 36.65 MB, and 1,095 entries.

Ten independent full-entry imports, with V8 compile caching disabled and a warm
operating-system page cache on the same WSL2 host, produced:

| Node | Before median / p90 | After median / p90 | Observation |
| --- | ---: | ---: | --- |
| 22.22.3 | 525.656 / 539.633 ms | 545.576 / 565.551 ms | no timing improvement in this sample |
| 24.9.0 | 539.056 / 574.139 ms | 553.733 / 582.703 ms | no timing improvement in this sample |

The cut is justified by the deterministic absence/presence contract and the
smaller evaluated graph, not by a startup-time claim. Registration, listing,
provider serialization, and a safety-rejected call are separately held against
loading in the registry contract; surface parity, single-flight first use,
ordinary exception semantics, and Clio-owned versus external missing-module
diagnostics are covered there as well.

### Narrow Pi API registration and dispatch

Ordinary engine startup no longer evaluates the deprecated `pi-ai/compat`
aggregate. Clio composes the ten supported lazy API factories in Pi's canonical
order and constructs a `Models` collection from the nine provider factories
backing Clio's current built-in runtimes: Bedrock, Anthropic, DeepSeek, Google,
Groq, Mistral, OpenAI, OpenAI Codex, and OpenRouter. Their full model catalogs,
Bedrock path, OAuth flows, image registration, and provider-owned request policy
remain Pi-owned. Clio's synchronous environment-key mapping is pinned to Pi 0.84
and parity-tested for every provider id, Anthropic precedence, Vertex ADC, and
Bedrock ambient credentials. A configured external runtime activates a dynamic
bridge before plugin evaluation; it deliberately restores the shared Pi
registry universe only for that plugin-bearing process.

The source-built and installed-tarball foreign-working-directory harness runs
real OpenAI-compatible turns under V8 coverage. It proves `compat.js` and
`legacy-api-aliases.js` are absent, the invoked OpenAI implementation is
present, and unrelated Anthropic, Bedrock, Google, Mistral, OAuth, and image
implementation files remain absent. It also proves `providers/all` and sample
unconfigured provider catalogs remain absent. A separate fresh-process contract
registers a known-API override from an out-of-tree module and proves its result
wins after the bridge; the installed-tarball lane repeats that semantic and
coverage proof from a foreign working directory.

The after-lazy-tools graph is the before point for this cut. Translated modules
changed from 1,357 files (79 evaluated Clio chunks) to 1,289 files (80 Clio
chunks); direct `pi-ai/dist` evaluation fell from 128 files to 59. Evaluated
Clio JavaScript changed from 4,929,030 to 4,941,023 bytes because the local
dispatcher and explicit configured-provider boundary are auditable Clio code.
Total built JavaScript is 126 files and 5,853,293 bytes. `npm pack --dry-run
--json` reports approximately 6.11 MB packed, 36.73 MB unpacked, and 1,132
entries. Package bytes are not the success criterion;
all Pi packages remain external and every first-use implementation still ships.

Ten independent full-entry imports used `NODE_DISABLE_COMPILE_CACHE=1`, a warm
operating-system page cache, and the same WSL2 host as the preceding cuts:

| Node | Before median / p90 | After median / p90 | Observation |
| --- | ---: | ---: | --- |
| 22.22.3 | 545.576 / 565.551 ms | 518.345 / 534.925 ms | lower in this sample |
| 24.9.0 | 553.733 / 582.703 ms | 522.001 / 554.388 ms | lower in this sample |

These are local import observations, not a startup guarantee or CI threshold.
The independently blocking evidence is the absence/presence graph contract,
credential parity, plugin registry identity, provider behavior suites, and the
installed foreign-cwd turn.

### Lazy orchestrator controls and worker graph separation

`dispatch`, `monitor`, and `steer` now advertise their unchanged schemas,
descriptions, source provenance, policy metadata, and execution modes without
evaluating their runners. Dispatch keeps synchronous plan admission in a
lightweight controller: the exact argument object and its six identity-sensitive
WeakMap/WeakSet stores cross into the first-use runner, so dynamic loading cannot
reconstruct an approval, parsed request, Scout plan, or capacity reservation. A
deeply frozen discriminated snapshot selects list, ordinary dispatch, or winner
application and pins the admission-time plan view, normalized requests,
review/compete settings, detach, timeout, output limit, winner branch, and
absolute repository destination. The destination is rendered into the approval
text and hash, so middleware or a permission observer cannot substitute it after
the prompt.
The registry owns admission disposal across middleware guard blocks and runner
settlement. Monitor and steer use the same immutable-surface loader as the
earlier four lazy tools. The worker entry imports the core bootstrap directly
and therefore never registers or evaluates these orchestrator-only runners.

The V8 coverage harness now advertises all seven lazy tool schemas in one real
provider request, proves every implementation root absent, and invokes each in
a fresh process. For the three orchestrator controls it recursively follows the
emitted static-import graph, classifies the surface/worker-shared closure, and
proves the whole runner-exclusive closure absent before admission and present
after invocation. The three discoverable runner entries total 113,983 bytes
(`dispatch` 83,800; `monitor` 27,209; `steer` 2,974). A separate run of the real
built worker entry proves both those roots and their runner-exclusive closures
absent. The complete proof repeats from an installed tarball in a foreign
working directory; stable behavior markers, rather than chunk hashes or file
sizes, identify each entry. Shared dispatch-domain modules are reported as
shared and are not misrepresented as runner-exclusive savings.

The after-Pi graph is the before point for this cut. Translated modules changed
from 1,289 files (80 evaluated Clio chunks) to 1,307 files (98 Clio chunks), as
the stable catalog, worker/core split, admission controller, and first-use
boundaries add small independently testable modules. Evaluated Clio JavaScript
fell from 4,941,023 to 4,874,478 bytes because the three runner entries are no
longer evaluated at startup. Total built JavaScript changed from 126 files and
5,853,293 bytes to 148 files and 5,914,960 bytes; the package must still ship
every first-use path. `npm pack --dry-run --json` reports 6,143,415 packed
bytes, 36,873,628 unpacked bytes, and 1,169 entries.

Ten independent full-entry imports used `NODE_DISABLE_COMPILE_CACHE=1`, a warm
operating-system page cache, and the same WSL2 host as the preceding cuts:

| Node | Before median / p90 | After median / p90 | Observation |
| --- | ---: | ---: | --- |
| 22.22.3 | 518.345 / 534.925 ms | 541.559 / 556.417 ms | no timing improvement in this sample |
| 24.9.0 | 522.001 / 554.388 ms | 529.888 / 558.958 ms | no timing improvement in this sample |

These are import observations, not a startup claim or CI threshold. This cut is
justified by the deterministic absence/presence and worker-exclusion contracts,
the smaller evaluated graph, exact registration-order and surface contracts,
and the dispatch reservation, approval, gate, detach, monitor, and steer suites.

## Adaptive stream-pacer observations

`interface.smoothStreaming` is presentation-only. `off` is the exact existing
16 ms coalescer and remains the 0.3.3 default. `auto` uses the pacer only on a
capable local TTY with no accessibility, remote/multiplexer, CI, or observed
backpressure signal. `on` requests pacing, but frame construction still stops
behind stdout backpressure. The pacer never republishes slices on the public
event bus: canonical events, persistence, replay/export, tool formation, and
cumulative tool state remain synchronous while one presentation queue owns
only derived visible text/thinking mutations.

The deterministic fake-clock contracts cover semantic classification, FIFO
generation/epoch ordering, abort and stale-admission rejection, grapheme
clusters, fractional arrival credit, event-loop suspension, catch-up, the
oldest-visible deadline, absolute queue byte/grapheme bounds, idle shutdown,
folded-thinking fidelity, reset/discard accounting, mode changes, final-frame
settlement, fullscreen frozen scrolling through resize, and bounded no-drain
cleanup. The PTY arm uses a built CLI, a four-delta localhost provider, a
4 KiB reply, an 80x24 `xterm-256color` PTY whose reader is paused, and a
test-only writable shim that makes exactly one real child `stdout.write()`
return `false` before emitting a delayed `drain`. This is deterministic
backpressure acceptance, not a claim about a particular SSH kernel buffer.

Five independent processes per supported Node line were measured on the same
2026-08-19 WSL2 host as the corrected baseline, with the operating-system page
cache warm and V8 compile caching disabled. Values are median / largest of the
five observations; they are diagnostic observations, not timing gates.

| Node | Input-to-stdout commit | First ingress-to-stdout commit | Final ingress-to-stdout commit | Controlled backpressure wait |
| --- | ---: | ---: | ---: | ---: |
| 22.22.3 | 5.530 / 8.896 ms | 62.909 / 70.274 ms | 37.798 / 56.412 ms | 403.809 / 426.570 ms |
| 24.9.0 | 5.468 / 7.225 ms | 67.878 / 74.021 ms | 27.901 / 35.750 ms | 402.582 / 418.783 ms |

The command was:

```bash
NODE_DISABLE_COMPILE_CACHE=1 CLIO_CODER_PERF_REPORT=1 \
  node --import tsx --import ./tests/harness/tmp-root.ts --test \
  --test-name-pattern 'paces provider deltas' \
  tests/smoke/render-trace-pty.test.ts
```

These endpoints end at stdout commit. Even the PTY reader assertion stops at
the pseudo-terminal boundary; none of these values is literal token-to-glass
latency.

## Instant-shell observations

The instant-shell slice uses one `TerminalLease`; Stage 1 does not start a
second terminal or reconstruct editor state. The built Stage 0 static closure
is 5 JavaScript chunks and 90,654 bytes. Its regression limit is 6 chunks and
110,000 bytes, and the closure must contain no orchestrator, provider, tool,
codewiki, tree-sitter, or Pi implementation marker. The pre-Stage 0 target/auth
check uses a data-only runtime manifest, checked against every canonical
built-in descriptor, and a read-only credential-presence path; it evaluates no
provider implementation or OAuth flow.

Five independent processes per supported Node line were measured on the same
2026-08-19 WSL2 x86-64 host, built source checkout, 80x24 `xterm-256color` PTY,
declared unreachable localhost target, warm operating-system page cache, and
`NODE_DISABLE_COMPILE_CACHE=1`. Values are median / largest of five diagnostic
observations, never CI timing gates.

| Node | Stage 0 stdout commit | PTY-observed Stage 0 frame | Stage 1 hydration | Stage 0 frame build |
| --- | ---: | ---: | ---: | ---: |
| 22.22.3 | 147.9 / 155.3 ms | 162.946 / 172.604 ms | 926.2 / 956.9 ms | 5.240 / 5.860 ms |
| 24.9.0 | 148.4 / 157.8 ms | 164.809 / 172.480 ms | 959.7 / 1001.9 ms | 5.386 / 5.791 ms |

The comparable corrected pre-instant-shell first stdout commit baseline was
1013.9 / 1120.3 ms on Node 22.22.3 and 1061.5 / 1082.3 ms on Node 24.9.0 under
the same compile-cache-disabled, warm-page-cache method. Stage 1 remains a full
hydration endpoint; the earlier visible/editor-ready Stage 0 does not erase or
rename that work.

The command was run five times for each explicit Node binary:

```bash
NODE_DISABLE_COMPILE_CACHE=1 CLIO_CODER_PERF_REPORT=1 \
  /path/to/node --import tsx --import ./tests/harness/tmp-root.ts --test \
  --test-name-pattern 'correlates input and resize' \
  tests/smoke/render-trace-pty.test.ts
```

The built-CLI PTY suite additionally covers immediate typing, multiple
submit-before-hydration admissions, a retained post-submit draft, resize across
hydration, Ctrl+C on both sides of attachment, SIGTERM during hydration,
injected Stage 1 failure, protocol-query single execution, raw-mode
restoration, diagnostics, and bounded process cleanup. The fake lease contract
checks object identity, FIFO admission, epoch rejection, signal-delegate
transfer, and idempotent close. PTY receipt is still not literal glass latency.

## Reporting checklist

Every published observation records:

1. commit and whether the measurement used a source build or packed install;
2. operating system, architecture, terminal mode and dimensions;
3. exact Node version;
4. V8 compile-cache state: disabled, fresh fill, or warm hit;
5. operating-system page-cache state, without calling a warm page cache cold;
6. sample count and summary statistic;
7. endpoint name from the vocabulary above;
8. whether PTY, emulator, SSH, or backpressured-output behavior was involved;
9. the correctness and package gates run beside the observation.

Stage 0 shell commit and Stage 1 hydration are separate endpoints. A report
must state whether `CLIO_CODER_INSTANT_SHELL` selected the lease or the legacy
fully hydrated first-frame path.
