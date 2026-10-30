# TUI boot presentation and measurement

This page describes how the interactive terminal UI starts, what the three presentation modes change, and which source-owned trace points can measure boot on a given machine. Startup cost depends on hardware, filesystem caches, terminal, plugin inventory and the build; this page asserts no measured timings. Layout, colors and rendering rules are in [TUI Design](tui-design.md).

## Boot sequence

The CLI selects an interactive start when stdin is a TTY and no headless or ACP mode is active. An explicit `CLIO_CODER_INTERACTIVE=1` also permits a non-TTY interactive start. It then runs in this order ([clio.ts](../../src/cli/clio.ts), [terminal-lease.ts](../../src/interactive/terminal-lease.ts)):

1. Probe the terminal background with an OSC 11 query followed by DA1, capped at 200 ms, so the theme picks a dark, light or neutral palette ([terminal-background.ts](../../src/core/terminal-background.ts)). `CLIO_CODER_THEME=dark|light|neutral` skips the probe. Color-disabled and non-TTY starts skip it too.
2. Stage 0, the instant shell. The terminal lease mounts the real composer and a welcome built by `createBootWelcome` from the settings already read, before any domain loads. The welcome is cached per width. The first committed frame is the `Stage 0 shell commit` trace point.
3. Stage 1, hydration. The orchestrator loads the domains and builds the full application. It adopts Stage 0's editor and keybinding manager instead of constructing new ones, and the first committed frame that contains the hydrated root is the `Stage 1 hydration` trace point. The hydrated welcome caches its render by width and a signature of the facts it prints.
4. Input typed during Stage 0 is held in a visible pending list and drained once hydration completes (see [Typing before Clio has finished starting](../guide/commands-and-modes.md#typing-before-clio-coder-has-finished-starting)).

`CLIO_CODER_INSTANT_SHELL=0` disables Stage 0 and waits for the fully hydrated first frame. Unset or any other value keeps it on.

`CLIO_CODER_TRACE_BOOT=1` writes `[clio-coder:boot] +<ms>ms <phase>` lines to stderr, with the milliseconds counted from process start ([boot-trace.ts](../../src/core/boot-trace.ts)). The interactive phases include `cli entry`, `Stage 0 shell commit`, `Stage 1 hydration` and `Stage 0 input blocked (max=<ms>)`. The last one is the longest event-loop block between the two frames, which is how long a key typed at Stage 0 can wait for its echo. While the terminal lease owns the screen it captures diagnostics, trace lines included, and writes them after the terminal is restored. `CLIO_CODER_TIMING=1` prints a boot-phase summary with each phase's elapsed milliseconds.

### Stage 0 import budget

Stage 0 draws before the application loads, so its static module closure is kept small. `tests/contracts/instant-shell-import-graph.test.ts` walks the built chunk that contains `src/interactive/terminal-lease.ts` and fails when that closure exceeds 32 chunks, 1,400,000 total bytes or 350,000 Clio Coder source bytes. It needs a full build. Rule 6 of `tests/boundaries/check-boundaries.ts` stops a second importer from splitting that chunk. Modules the first frame needs, such as the welcome, the composer and the context rail, therefore stay leaves that do not import the footer dashboard, task, dispatch or worker modules.

### Compile cache

The interactive session, `clio-coder run` and `clio-coder acp` enable Node's module compile cache under Clio Coder's cache directory once it exists ([compile-cache.ts](../../src/core/compile-cache.ts)). Read-only commands such as `paths` and bare `doctor` never enable it, so they write nothing to a home Clio has not set up. A dispatched native worker resolves its whole static graph before its first statement, so the parent hands it the same cache directory through `NODE_COMPILE_CACHE` in the worker's environment, enabling the cache first when no boot entrypoint did, as a direct `fleet run` does ([worker-spawn.ts](../../src/domains/dispatch/worker-spawn.ts)). The worker removes the variable from its own environment once Node has read it, so the cache serves only Clio Coder's entry graph and never the operator's own Node processes. `NODE_DISABLE_COMPILE_CACHE` turns it off.

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

## Measuring an interactive boot

Clio Coder exposes boot and render traces; it ships no standalone boot/welcome benchmark with profile, run-count or key-injection flags. Build the CLI when measurements require a fresh executable. Set `CLIO_CODER_TRACE_BOOT=1` for the process-relative phase markers implemented by [boot-trace.ts](../../src/core/boot-trace.ts). `CLIO_CODER_RENDER_TRACE=<path>` records the content-free frame timeline through [render-trace.ts](../../src/interactive/render-trace.ts). Both toggles are described in [environment variables](../guide/environment-variables.md).

Compare the `Stage 0 shell commit`, `Stage 1 hydration` and `Stage 0 input blocked` trace points under the same terminal geometry, renderer, workspace, route and plugin inventory. Record whether the Node compile cache was enabled and whether filesystem caches were warm. A startup trace measures that boot; it does not establish keystroke echo latency or actual glyph painting in a terminal emulator.

The source-owned deterministic guards are [instant-shell-import-graph.test.ts](../../tests/contracts/instant-shell-import-graph.test.ts) for the built Stage 0 import budget and [plugin-discovery-fs-scaling.test.ts](../../tests/contracts/plugin-discovery-fs-scaling.test.ts) for discovery filesystem-call growth. Neither promises a wall-clock startup threshold.
