# TUI boot presentation and measurement

This page describes how the interactive terminal UI starts, what the three presentation modes change, and how to measure boot on a given machine. It records no timings. Startup cost depends on hardware, filesystem caches, terminal, plugin inventory and the build, so every number comes from running the benchmark below on the build in question. Layout, colors and rendering rules are in [TUI Design](tui-design.md).

## Boot sequence

An interactive start needs a TTY (the CLI sets `CLIO_CODER_INTERACTIVE=1` when stdin is a terminal). It then runs in this order ([clio.ts](../../src/cli/clio.ts), [terminal-lease.ts](../../src/interactive/terminal-lease.ts)):

1. Probe the terminal background with an OSC 11 query followed by DA1, capped at 200 ms, so the theme picks a dark, light or neutral palette ([terminal-background.ts](../../src/core/terminal-background.ts)). `CLIO_CODER_THEME=dark|light|neutral` skips the probe. Color-disabled and non-TTY starts skip it too.
2. Stage 0, the instant shell. The terminal lease mounts the real composer and a welcome built by `createBootWelcome` from the settings already read, before any domain loads. The welcome is cached per width. The first committed frame is the `Stage 0 shell commit` trace point.
3. Stage 1, hydration. The orchestrator loads the domains and builds the full application. It adopts Stage 0's editor and keybinding manager instead of constructing new ones, and the first committed frame that contains the hydrated root is the `Stage 1 hydration` trace point. The hydrated welcome caches its render by width and a signature of the facts it prints.
4. Input typed during Stage 0 is held in a visible pending list and drained once hydration completes (see [Typing before Clio has finished starting](../guide/commands-and-modes.md#typing-before-clio-coder-has-finished-starting)).

`CLIO_CODER_INSTANT_SHELL=0` disables Stage 0 and waits for the fully hydrated first frame. Unset or any other value keeps it on.

`CLIO_CODER_TRACE_BOOT=1` writes `[clio-coder:boot] +<ms>ms <phase>` lines to stderr, with the milliseconds counted from process start ([boot-trace.ts](../../src/core/boot-trace.ts)). The interactive phases include `cli entry`, `Stage 0 shell commit`, `Stage 1 hydration` and `Stage 0 input blocked (max=<ms>)`. The last one is the longest event-loop block between the two frames, which is how long a key typed at Stage 0 can wait for its echo. While the terminal lease owns the screen it captures diagnostics, trace lines included, and writes them after the terminal is restored. `CLIO_CODER_TIMING=1` prints a boot-phase summary with each phase's elapsed milliseconds.

### Stage 0 import budget

Stage 0 draws before the application loads, so its static module closure is kept small. `tests/contracts/instant-shell-import-graph.test.ts` walks the built chunk that contains `src/interactive/terminal-lease.ts` and fails when that closure exceeds 32 chunks, 1,400,000 total bytes or 350,000 Clio Coder source bytes. It needs a full build. Rule 6 of `tests/boundaries/check-boundaries.ts` stops a second importer from splitting that chunk. Modules the first frame needs, such as the welcome, the composer and the context rail, therefore stay leaves that do not import the footer dashboard, task, dispatch or worker modules.

### Compile cache

The interactive session, `clio-coder run` and `clio-coder acp` enable Node's module compile cache under Clio Coder's cache directory once it exists ([compile-cache.ts](../../src/core/compile-cache.ts)). Read-only commands such as `paths` and bare `doctor` never enable it, so they write nothing to a home Clio has not set up. `NODE_DISABLE_COMPILE_CACHE` turns it off.

## Presentation modes

| Mode | How it is selected | Behavior |
| --- | --- | --- |
| Full | `interface.demo: true` (default) | Stacked cyan-to-copper wordmark, session-start time, workspace, Git and project-awareness facts, two reserved account-usage rows, a rotating tagline, footer tips and rotating key hints, attention animation and smooth-streaming pacing where the terminal allows. |
| Normal | `interface.demo: false` or `--no-demo` | One compact identity header line instead of the launchpad. Welcome-only reads (account usage, project-awareness readings) are skipped, and attention animation, smooth-streaming pacing, footer tips and key hints are off. The editor and the chosen regular or fullscreen layout are unchanged. |
| Portable | Normal plus `NO_COLOR=1` | Color-disabled output with the same labels and meters. |

Dumb or unknown terminals (`TERM=dumb` or `TERM=unknown`) and screen-reader mode (`CLIO_CODER_SCREEN_READER=1`) always get the compact header, even with demo on, and those two terminal types also disable color. The thinking meter uses ordinary filled and hollow dots; the Nerd Font brain glyph is opt-in with `CLIO_CODER_NERD_FONT=1` (ignored for screen readers and dumb terminals). Screen-reader mode replaces the meter with exact effort text.

The Stage 0 welcome and the hydrated welcome share one geometry, and the subscription rows are reserved from the first paint, so hydrating account data moves nothing. Idle footer tips stay off while the full welcome is visible. Layout details of the launchpad are in [Welcome launchpad and session header](tui-design.md#41-welcome-launchpad--session-header).

Demo-off is a presentation mode. It removes artwork, welcome-only reads and animation, which lowers the bytes written before hydration, but it runs the same hydration as full. Treat it as a rendering and transport saving, and measure before claiming a startup speedup.

## Worker boundary

The native worker entry (`src/worker/entry.ts`) and the rest of `src/worker/` import nothing from `src/interactive/`. Workers do not load the welcome, the dashboard or any other interactive presentation, so presentation mode has no effect on worker startup. Rule 6 of `tests/boundaries/check-boundaries.ts` lets importers outside the interactive trees, workers included, reach `src/interactive/` only through declared seams.

## Reproduce

Build the CLI with `pnpm run build`. The measurement harnesses are maintainer-local and are not included in a source checkout.

The maintainer’s local boot benchmark launches the built CLI (`dist/cli/index.js`) in a pseudo-terminal of 180 columns by 30 rows against an isolated home and a local HTTP stub that serves one model. It runs the `full`, `normal` and `portable` profiles, which differ only in `interface.demo` and `NO_COLOR`. Each profile's home gets one unreported priming boot, kept as `cold` in the JSON. Because setup runs `upgrade` and caches outside the isolated home may be warm, that boot is not a cold operating-system boot. The measured runs interleave the profiles and rotate which goes first.

The harness types one marker character every `--interval` milliseconds (default 20) as soon as the Stage 0 editor paints, caps the typing at `--keys` characters (default 160), and keeps typing until the hydrated footer has been visible for `--settle` milliseconds (default 500). The hydrated footer is recognized by the parenthesized context percentage it alone prints. Per run it reports:

| Field | Meaning |
| --- | --- |
| `stage0` | Milliseconds from process start to the Stage 0 shell commit, from the boot trace. |
| `hydrated` | Milliseconds from process start to the Stage 1 hydrated frame, from the boot trace. |
| `input-blocked-max` | Longest event-loop block between the two frames. |
| `first-echo`, `max-echo` | Latency from a typed marker to its echo, measured by the parent from spawn. |
| `bytes-to-hydration` | UTF-8 bytes the pseudo-terminal received up to the first hydrated footer. This includes typing redraws and control traffic, so it is not a static header payload. |

The summary prints per-profile medians. A run is invalid when hydration, the phase traces, the settle window or a key echo is incomplete; the script then prints a warning and exits 1.

| Option | Effect |
| --- | --- |
| `--runs <n>` | Measured runs per profile (default 5). |
| `--mode regular\|fullscreen` | Renderer under test (default `fullscreen`). |
| `--profile full\|normal\|portable\|all` | Limit the profiles (default `all`). |
| `--no-compile-cache` | Set `NODE_DISABLE_COMPILE_CACHE=1` for the whole campaign. |
| `--cli <path>` | Measure another build's entry file. Keep the workspace and plugin set the same across builds. |
| `--user-plugins <dir>` | Copy a plugin inventory into the isolated home. |
| `--cwd <dir>` | Working directory of the launched session (default: the current directory). |
| `--cpu-profile-dir <dir>` | Record Node CPU profiles. Profiling changes timing, so keep those runs separate from unprofiled ones. |
| `--json <file>` | Write every run, including the priming boots. |

The maintainer’s local welcome benchmark is a separate loop, not a startup measurement. It renders the full and normal Stage 0 headers, cached and fresh, and paints the wordmark in truecolor, indexed and monochrome terminals, and prints milliseconds per iteration (`--iterations`, default 2000, after 100 warm-up calls), rows and encoded bytes.

Timings are observations, not thresholds. Hardware load, filesystem caches, terminal implementations, fonts, plugin inventories, real model routes and SSH latency change them, and a pseudo-terminal does not prove glyph rendering on any particular terminal. The deterministic guard on discovery cost is the file-system call count in `tests/contracts/plugin-discovery-fs-scaling.test.ts`, and the deterministic guard on Stage 0 size is the import budget above.
