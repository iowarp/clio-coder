# TUI boot presentation and measurement

This page describes how the interactive terminal UI starts, what the three presentation modes change, and which source-owned trace points can measure boot on a given machine. Startup cost depends on hardware, filesystem caches, terminal, plugin inventory and the build; this page asserts no measured timings. Layout, colors and rendering rules are in [TUI Design](tui-design.md).

## Boot sequence

The CLI selects an interactive start when stdin is a TTY and no headless or ACP mode is active. An explicit `CLIO_CODER_INTERACTIVE=1` also permits a non-TTY interactive start. It then runs in this order ([clio.ts](../../src/cli/clio.ts), [terminal-lease.ts](../../src/interactive/terminal-lease.ts)):

1. Probe the terminal background with an OSC 11 query followed by DA1, capped at 200 ms, so the theme picks a dark, light or neutral palette ([terminal-background.ts](../../src/core/terminal-background.ts)). `CLIO_CODER_THEME=dark|light|neutral` skips the probe. Color-disabled and non-TTY starts skip it too.
2. Stage 0, the instant shell. The terminal lease mounts the real composer and a welcome built by `createBootWelcome` from the settings already read, before any domain loads. The welcome is cached per width. The first committed frame is the `Stage 0 shell commit` trace point.
3. Stage 1, hydration. The orchestrator loads the domains and builds the full application. It adopts Stage 0's editor and keybinding manager instead of constructing new ones, and the first committed frame that contains the hydrated root is the `Stage 1 hydration` trace point. The hydrated welcome caches its render by width and a signature of the facts it prints.
4. Input typed during Stage 0 is held in a visible pending list and drained once hydration completes (see [Typing before CLIO Coder has finished starting](../guide/commands-and-modes.md#typing-before-clio-coder-has-finished-starting)).

`CLIO_CODER_INSTANT_SHELL=0` disables Stage 0 and waits for the fully hydrated first frame. Unset or any other value keeps it on.

`CLIO_CODER_TRACE_BOOT=1` writes `[clio-coder:boot] +<ms>ms <phase>` lines to stderr, with the milliseconds counted from process start ([boot-trace.ts](../../src/core/boot-trace.ts)). The interactive phases include `cli entry`, `Stage 0 shell commit`, `Stage 1 hydration` and `Stage 0 input blocked (max=<ms>)`. The last one is the longest event-loop block between the two frames, which is how long a key typed at Stage 0 can wait for its echo. While the terminal lease owns the screen it captures diagnostics, trace lines included, and writes them after the terminal is restored. `CLIO_CODER_TIMING=1` prints a boot-phase summary with each phase's elapsed milliseconds.

### Stage 0 import budget

Stage 0 draws before the application loads, so its static module closure is kept small. `tests/contracts/instant-shell-import-graph.test.ts` walks the built chunk that contains `src/interactive/terminal-lease.ts` and fails when that closure exceeds 32 chunks, 1,400,000 total bytes or 350,000 CLIO Coder source bytes. It needs a full build. Rule 6 of `tests/boundaries/check-boundaries.ts` stops a second importer from splitting that chunk. Modules the first frame needs, such as the welcome, the composer and the context rail, therefore stay leaves that do not import the footer dashboard, task, dispatch or worker modules.

### Stage 1 work in slices

While Stage 0 takes keys, the boot path gives the event loop a full turn, input poll included, between its larger pieces of work. [stage1-preload.ts](../../src/entry/stage1-preload.ts) imports the composition root's largest subgraphs one slice at a time. At its last phase boundary, before the chat loop starts producers whose notices reach only the built application, the orchestrator also reads the fleet board's earlier worker runs, one run's journal per turn ([fleet-run-history.ts](../../src/interactive/fleet-run-history.ts)). A closed lease stops that read before the next journal and stops boot at the boundary. The board's first read during the build takes those rows instead of reading every journal in one block. A read for another directory or worktree root ignores the primed rows and reads the ledger itself.

Recovery of the compete groups and task worktrees a hard-killed coordinator left behind starts once the hydrated frame is committed, so its terminate grace and git calls never hold the first frame. Dispatch waits for that recovery to settle before it scans its ledger or admits a run ([boot-recovery.ts](../../src/domains/dispatch/boot-recovery.ts)).

### Skill frontmatter cache

Loading the skill catalog parses each `SKILL.md` file's YAML frontmatter, which boot and every `context(scope="skills")` call repeat. Parsed frontmatter is cached across processes in `skill-frontmatter.json` under CLIO Coder's cache directory ([frontmatter-cache.ts](../../src/domains/resources/skills/frontmatter-cache.ts)). An entry is keyed by file path and is used only when the file's mtime and size match and the frontmatter text is byte-identical to what was parsed, so an edit within one mtime tick still reparses. The whole file is dropped when the CLIO Coder version changes, the cache holds at most 2,048 entries, and frontmatter whose parsed value JSON cannot carry exactly is parsed every time. Without a usable cache directory, parsing runs uncached.

### Compile cache

The interactive session, `clio-coder run` and `clio-coder acp` enable Node's module compile cache under CLIO Coder's cache directory once it exists ([compile-cache.ts](../../src/core/compile-cache.ts)). Read-only commands such as `paths` and bare `doctor` never enable it, so they write nothing to a home that has not been set up. A dispatched native worker resolves its whole static graph before its first statement, so the parent hands it the same cache directory through `NODE_COMPILE_CACHE` in the worker's environment, enabling the cache first when no boot entrypoint did, as a direct `fleet run` does ([worker-spawn.ts](../../src/domains/dispatch/worker-spawn.ts)). The worker removes the variable from its own environment once Node has read it, so the cache serves only CLIO Coder's entry graph and never the operator's own Node processes. `NODE_DISABLE_COMPILE_CACHE` turns it off.

## Presentation modes

| Mode | How it is selected | Behavior |
| --- | --- | --- |
| Minimal | `interface.outputDetail: compact` | One identity header; no welcome-only reads or optional learning tips. |
| Default | `interface.demo: true` with `interface.outputDetail: standard` (defaults) | Seven-row launchpad with model, autonomy, awareness and the next action, plus an `Instructions` row when a project preload exists. Under 48 columns or 20 rows it keeps the route and the next action only. Workspace facts remain in the footer. |
| Detailed | `interface.demo: true` with `interface.outputDetail: detailed` | Artwork, route and autonomy, project facts, two reserved account-usage rows, tagline and shortcut hints where space allows. The artwork needs at least 48 columns and 30 rows; a smaller terminal gets the Default launchpad. |
| Quiet | `interface.demo: false` or `--no-demo` | One identity header and no welcome-only reads or learning tips. Immediate controls and warnings remain. |
| No color | `NO_COLOR=1` | Same labels and meters without color. |

Demo guidance never overrides `interface.smoothStreaming` or terminal motion preferences.

The ASCII glyph set (`CLIO_CODER_ASCII=1`, `TERM=dumb` or `TERM=unknown`) and screen-reader mode (`CLIO_CODER_SCREEN_READER=1`) always get the identity header, even with demo on. `TERM=dumb` and `TERM=unknown` also disable color. The thinking meter uses ordinary filled and hollow dots; the Nerd Font brain glyph is opt-in with `CLIO_CODER_NERD_FONT=1` (ignored for screen readers and dumb terminals). Screen-reader mode replaces the meter with exact effort text.

The Stage 0 welcome and the hydrated welcome share the tier policy. Detailed subscription rows are reserved from the first paint, so hydrating account data moves nothing. Idle footer tips stay off while a launchpad is visible. Layout details are in [Welcome launchpad and session header](tui-design.md#41-welcome-launchpad--session-header).

Demo-off is a presentation mode. It removes artwork, welcome-only reads and learning tips, which lowers the bytes written before hydration, but it runs the same hydration as full. Treat it as a rendering and transport saving, and measure before claiming a startup speedup.

## Worker boundary

The native worker entry (`src/worker/entry.ts`) and the rest of `src/worker/` import nothing from `src/interactive/`. Workers do not load the welcome, the dashboard or any other interactive presentation, so presentation mode has no effect on worker startup. Rule 6 of `tests/boundaries/check-boundaries.ts` lets importers outside the interactive trees, workers included, reach `src/interactive/` only through declared seams.

## Measuring an interactive boot

CLIO Coder exposes boot and render traces; it ships no standalone boot/welcome benchmark with profile, run-count or key-injection flags. Build the CLI when measurements require a fresh executable. Set `CLIO_CODER_TRACE_BOOT=1` for the process-relative phase markers implemented by [boot-trace.ts](../../src/core/boot-trace.ts). `CLIO_CODER_RENDER_TRACE=<path>` records the content-free frame timeline through [render-trace.ts](../../src/interactive/render-trace.ts). Both toggles are described in [environment variables](../guide/environment-variables.md).

Compare the `Stage 0 shell commit`, `Stage 1 hydration` and `Stage 0 input blocked` trace points under the same terminal geometry, renderer, workspace, route and plugin inventory. Record whether the Node compile cache was enabled and whether filesystem caches were warm. A startup trace measures that boot; it does not establish keystroke echo latency or actual glyph painting in a terminal emulator.

The source-owned deterministic guards are [instant-shell-import-graph.test.ts](https://github.com/iowarp/clio-coder/blob/main/tests/contracts/instant-shell-import-graph.test.ts) for the built Stage 0 import budget and [plugin-discovery-fs-scaling.test.ts](https://github.com/iowarp/clio-coder/blob/main/tests/contracts/plugin-discovery-fs-scaling.test.ts) for discovery filesystem-call growth. Neither promises a wall-clock startup threshold.
