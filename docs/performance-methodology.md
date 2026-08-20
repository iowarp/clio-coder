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

```bash
CLIO_CODER_RENDER_TRACE=/tmp/clio-render.jsonl \
CLIO_CODER_TRACE_BOOT=1 \
CLIO_CODER_INTERACTIVE=1 \
node dist/cli/index.js
```

The deterministic contracts are
`tests/contracts/render-pipeline-trace.test.ts`. The real built-CLI acceptance
harness is `tests/smoke/render-trace-pty.test.ts`; it covers first frame, input
correlation, resize, grouped writes, paused PTY output, and bounded process
cleanup. Set `CLIO_CODER_PERF_REPORT=1` while running that test to print its
observation record. Real PTY acceptance is currently unavailable on Windows;
the fake-stream frame/backpressure contract remains cross-platform.

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

## Corrected 0.3.2 baseline

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

Stage 0 shell commit and Stage 1 hydration are reported as separate endpoints
once the single-owner instant-shell path is enabled. Until then there is one
fully hydrated first-frame endpoint.
