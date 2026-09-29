# TUI boot presentation measurements

Measured September 27, 2026 on the development machine, Node v24.20.0, Linux x64, with the 0.5.7 package version and uncommitted 0.5.8 development changes. Base commit: `3529ab1b1d1eeb5e6dae6f4c6fd81f7046b2ccbb`.

## Behavior under measurement

- Full: demo enabled, truecolor, full stacked wordmark and welcome facts.
- Normal: demo disabled, same color capability and fullscreen/regular renderer, compact identity header. Welcome-only context, quota, recipe inventory, and shortcut reads are skipped. Optional attention animation and streaming pacing are disabled.
- Portable: normal presentation with `NO_COLOR=1`. This exercises color-disabled output; it is not a Chrome OS font test, a dumb-terminal emulator, or a network/SSH transport benchmark.

The Stage 0 welcome caches its fixed render until width changes or it is invalidated. The hydrated dashboard already caches comparable render state. Nerd Font brain marks are opt-in via `CLIO_CODER_NERD_FONT=1`; the default thinking rail uses ordinary filled and hollow dots. Screen-reader mode uses exact effort text. Dumb/unknown terminals and screen-reader mode use a compact welcome even when demo is enabled. Dumb/unknown terminals also disable color.

## End-to-end observations

Medians in milliseconds except the final column, which is UTF-8 bytes received by the pseudo-terminal up to the first observed hydrated footer. Each profile has an isolated home and the same local HTTP model stub, 180 columns × 30 rows, with typing every 20 ms beginning when the Stage 0 editor appears and continuing for 500 ms after hydration is visible. Profiles are interleaved and their order rotates. Each home receives one unreported priming boot, retained separately as `cold` in the JSON. That priming boot is **not** a genuinely cold operating-system boot: setup runs `upgrade`, and caches outside the isolated home may already be warm. No real model generates tokens.

| Campaign | Profile | Runs | Stage 0 commit | Hydrated commit | Longest input block | First key echo | Bytes to hydration |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| session-focused fullscreen | full | 3 | 118 | 861 | 290 | 276 | 22,848 |
| session-focused fullscreen | normal | 3 | 111 | 838 | 296 | 285 | 7,459 |
| session-focused fullscreen | portable | 3 | 112 | 856 | 300 | 287 | 5,711 |
| stable-height fullscreen | full | 3 | 108 | 762 | 250 | 236 | 22,891 |
| stable-height fullscreen | normal | 3 | 97 | 756 | 263 | 249 | 7,178 |
| stable-height fullscreen | portable | 3 | 96 | 740 | 258 | 247 | 5,711 |
| aligned fullscreen | full | 5 | 108 | 770 | 265 | 252 | 21,981 |
| aligned fullscreen | normal | 5 | 103 | 778 | 260 | 250 | 7,178 |
| aligned fullscreen | portable | 5 | 110 | 780 | 269 | 258 | 5,711 |
| fullscreen | full | 7 | 109 | 823 | 284 | 272 | 21,981 |
| fullscreen | normal | 7 | 108 | 804 | 281 | 268 | 7,178 |
| fullscreen | portable | 7 | 106 | 792 | 272 | 259 | 5,711 |
| regular | full | 3 | 116 | 933 | 329 | 322 | 16,551 |
| regular | normal | 3 | 123 | 941 | 339 | 326 | 5,835 |
| regular | portable | 3 | 122 | 939 | 355 | 342 | 4,839 |
| uncached | full | 3 | 125 | 979 | 390 | 378 | 21,981 |
| uncached | normal | 3 | 120 | 946 | 403 | 394 | 7,178 |
| uncached | portable | 3 | 120 | 914 | 370 | 358 | 5,711 |

`stable-height fullscreen` measures the subsequent fixed-height refinement: two reserved usage slots keep the full welcome at 17 rows from Stage 0 through hydration, including overflow and disappearing quota data. In three interleaved runs per profile, full median Stage 0/hydration times were 108/763 ms, compared with 108/770 ms in the earlier aligned sample. That small difference is not evidence of a speed improvement. Bytes to hydration rose from 21,981 to 22,891 (about 4%) in the full profile; normal/portable medians stayed at 7,178/5,711 bytes. Samples and typing redraws vary, so this is an observed transport cost, not a precise fixed byte tax.

`aligned fullscreen` measures the earlier operator-selected three-column layout: shared field-value alignment, aligned command/key descriptions, and indented subscription continuations. The earlier `fullscreen` sample precedes those spacing changes. The five-run aligned sample retained the same full/normal median output-byte counts and showed no consistent hydration advantage for demo-off.

`fullscreen` and `regular` use the compile cache. `uncached` is fullscreen with `NODE_DISABLE_COMPILE_CACHE=1` throughout. Phase timings come from the child's boot trace and are relative to Node process start. Key echoes and the first visible editor use the parent's elapsed time from spawning the child. Raw output bytes include typing redraws and terminal control traffic; they are not a static header payload measurement. Faster hydration can itself mean fewer keys are typed before that cutoff.

The compact path has a clear rendering and transport advantage. In the seven-run fullscreen sample, normal sent about 67% fewer bytes before hydration than full. The Stage 0 and hydration time differences are much smaller and overlap across runs. **These data do not demonstrate a significant overall startup speedup.** The shared hydration graph still dominates input stalls. Removing the welcome must not be presented as removing that cost.

The earlier three-run baseline, before demo-off controlled the welcome, recorded full/normal hydration medians of 873/902 ms. Both modes then rendered the same welcome. Its output-byte measurements used an incorrect live hydration cue and are deliberately excluded here. The original benchmark's obsolete `Ready` cue has been replaced by the hydrated footer's context percentage. Deferred boot trace messages are parsed after exit for phase timings, never used as the live settle signal. Runs fail validity checks when hydration, phase traces, settling, or key echoes are incomplete.

## Isolated renderer cost

The fixed-height follow-up is recorded separately in [stable-height-render-cost.txt](../../benchmarks/tui-boot/2026-09-27/stable-height-render-cost.txt); it measures the rebuilt 17-row full welcome. The older renderer sample below uses the 15-row initial welcome before reservation.

See [render-cost.txt](../../benchmarks/tui-boot/2026-09-27/render-cost.txt). These are warm loops of 2,000 calls, not startup measurements. In this sample, constructing a fresh full Stage 0 header averaged 1.60 ms; the compact header averaged 0.058 ms. Cached Stage 0 calls simply reused the rendered lines. Truecolor wordmark coloring averaged about 8 microseconds per call, much smaller than wrapping, framing, and width accounting for the complete panel. Colors are static; the wordmark does not animate or allocate a timer. Color-disabled painting now bypasses interpolation entirely.

An earlier renderer loop overlapped part of the initial regular-screen timing campaign, so that three-run campaign should be treated as exploratory. The final seven-run fullscreen, three-run uncached, and five-run aligned fullscreen campaigns ran after that earlier loop. The saved render-cost file was regenerated after the final alignment pass, separately from the timing campaigns. They remain local observations, not release latency guarantees.

## Worker boundary and remaining work

Following static imports in the emitted esbuild metadata finds no welcome artwork or dashboard module in the native worker entry's loaded graph. Workers do not initialize this interactive presentation. This establishes separation for the welcome cost; it is not a measurement of total worker startup or remote worker latency.

A separate normal-mode CPU profile sampled module compilation, filesystem metadata work, child-process spawning, and terminal width calculations among the larger non-idle costs. The profiles cover the entire short session, not just hydration, and profiling changes timing. They suggest where to investigate the shared input stall; they do not apportion the hydration pause exactly. No production worker or user session was stopped for these measurements.

The operator selected welcome-panel spacing, density, and hierarchy as the design focus, preserving three columns and the existing wordmark size, and ordinary dots as the portable thinking meter. The first alignment pass has been implemented and tested at 160, 200, and 240 columns. The cyan-over-copper treatment remains the accepted baseline. Concrete issues for that design review:

- Subscription hydration now uses two fixed slots: the full welcome stays at 17 rows, usage keeps its position, and overflow points to `/usage`. This intentionally adds two rows to the earlier 15-row initial shell.
- The subsequent session-focused pass replaces the slogan, route, permission, target, and fleet inventory with a fixed session-start date/time, workspace, Git state, project awareness, and account usage. Artwork has one blank body row above and below. Wide terminals retain rotating shortcuts; narrower panels show a compact `/help` and `/usage` guide. Contextual actions distinguish missing, stale, malformed, and current project awareness. Idle footer teaching pauses while the full welcome is visible; operational notices retain priority.
- Fullscreen leaves intentionally open transcript space; the welcome should not expand just to fill it.
- Significant demo-off startup acceleration remains an open performance goal. Rendering and terminal traffic are already cheaper, but eliminating shared synchronous hydration work needs a separate, measured change.

## Reproduce

```bash
pnpm run build
pnpm run bench:boot -- --runs 7 --json /tmp/clio-boot-fullscreen.json
pnpm run bench:boot -- --runs 3 --mode regular --json /tmp/clio-boot-regular.json
pnpm run bench:boot -- --runs 3 --no-compile-cache --json /tmp/clio-boot-uncached.json
node --import tsx scripts/bench-welcome.ts
```

Use `--profile full`, `--profile normal`, or `--profile portable` to isolate one mode, `--cli /path/to/another/dist/cli/index.js` to measure another build, or `--user-plugins /path/to/plugins` to include a realistic plugin inventory. Keep the same workspace and plugin set across builds. `--cpu-profile-dir /tmp/clio-boot-cpu` records Node CPU profiles; keep those observations separate from unprofiled timings.

Raw results: [stable-height fullscreen](../../benchmarks/tui-boot/2026-09-27/stable-height-fullscreen.json), [aligned fullscreen](../../benchmarks/tui-boot/2026-09-27/aligned-fullscreen.json), [fullscreen](../../benchmarks/tui-boot/2026-09-27/fullscreen.json), [regular](../../benchmarks/tui-boot/2026-09-27/regular.json), [uncached](../../benchmarks/tui-boot/2026-09-27/uncached.json). Hardware load, filesystem caches, terminal implementations, fonts, plugin inventories, actual model routes, and SSH bandwidth/latency can change these results. The pseudo-terminal does not prove glyph rendering on Crostini or behavior of every remote terminal.

## Session-focused welcome refinement

The session-start time is captured from the process start and shared by Stage 0 and hydration; it is not an animated clock. Workspace facts come from the existing session snapshot, and project awareness uses the existing deferred context reader. Account usage remains the latest cached provider reading, not a frozen or guaranteed simultaneous quota snapshot. `/usage` retains complete limits, reset times, and reading status. The welcome shortens percentage labels under an explicit “used” heading without inventing missing windows or account data.

The 17-row envelope remains fixed. Centering the 11-row artwork reserves one body row above and below it. Configuration inventory and recipe reads are no longer needed by the welcome. This pass makes no institutional or funding attribution claims.

Three interleaved runs per profile for this pass are saved in [session-welcome-fullscreen.json](../../benchmarks/tui-boot/2026-09-27/session-welcome-fullscreen.json). Median full/normal hydration was 861/838 ms, with 22,848/7,459 bytes to hydration (about 67% less traffic for normal). The small timing difference does not establish significant startup acceleration, and comparisons against earlier campaigns are affected by machine load. The measured build includes the visual and footer changes; subsequent removal of an unused submit-binding read and cache-signature cleanup do not change the rendered output. Fresh and cached renderer observations are saved in [session-welcome-render-cost.txt](../../benchmarks/tui-boot/2026-09-27/session-welcome-render-cost.txt).
