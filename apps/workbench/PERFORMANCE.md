# Clio Coder GUI rendering performance

Measured numbers for the conversation surface before and after Markdown, code highlighting, Mermaid diagrams, and
follow-latest scrolling were added. Every number below comes from `scripts/perf-workload.ts` output in
`.artifacts/perf/` (gitignored); the tables were generated from those JSON files, not typed in. Nothing here is a claim
about hardware or display rates that were not measured.

## Workload

`deno run -A scripts/perf-workload.ts --label=NAME [--dist=dist-dev]`, pace 4 ms, 2 turns, headless Chrome at 1600×1100,
dark scheme. Per turn the real server runs the deterministic ACP fixture's `stream-workload` scenario:

- about 16 KB of Markdown streamed in 5-character chunks with a 4 ms tick every 4 chunks (1,358 `turn.text` events and
  about 1,420 WebSocket messages per turn; the before runs were recorded at commit `3f6e140d`, whose fixture placed tool
  bursts every 64 chunks regardless of Markdown structure and produced 1,340 text events and about 1,390 messages, so
  the two workloads differ by that fixture change and by nothing else), covering headings, lists, task lists, a table,
  block quotes, inline code, links the renderer must block, raw HTML it must neutralize, three fenced code blocks
  (TypeScript, Python, an unknown language), two Mermaid flowcharts (one deliberately malformed), and two
  reported-reasoning chunks;
- tool bursts of one to four calls between Markdown blocks, with one call failing;
- 64 keystrokes typed into the composer while the stream runs, then the draft checked afterwards;
- the transcript scrolled up by hand mid-stream and checked to have stayed put, with the jump affordance present;
- a Chrome trace of the whole turn, summarized by category;
- after both turns, a resume of a 64-turn session on a fresh host.

"During stream" counts long tasks that started at or before the last `turn.text` event; "after stream" counts those that
started later, which is where diagram layout now runs.

## Environment

Deno 2.9.5, headless Chrome 151.0.7922.169, 24 CPUs, WSL2 (Linux 6.18), 60 Hz headless compositor. The machine was
shared with other test lanes throughout; the 1-minute load average at the start of each run is in the tables, and the
before runs were recorded on 2026-08-30 at 16:11Z (prod) and 16:14Z (dev), the after runs between 17:28Z and 17:30Z.
Because headless Chrome paints at 60 Hz, the frame figures bound the work per frame; they do not demonstrate 120 Hz or
144 Hz behavior on a real display.

## Results

### Production bundle (`dist/`, minified)

| Run           | Load | Turn | Duration ms | Tasks >50 ms (during / after stream) | Longest task ms | Frame p95 / max ms | Frames >33 ms | Key→input p95 ms | Key→frame p95 / max ms | Text→paint p50 / p95 ms | DOM nodes | Heap peak MB | Draft kept | Scroll held / jump pill |
| ------------- | ---: | ---: | ----------: | -----------------------------------: | --------------: | -----------------: | ------------: | ---------------: | ---------------------: | ----------------------: | --------: | -----------: | ---------- | ----------------------- |
| before-prod   |  6.9 |    1 |        4989 |                            0 (· / ·) |            26.4 |        16.7 / 16.8 |             0 |              1.9 |            17.1 / 20.1 |             22.6 / 34.4 |       863 |         10.4 | yes        | yes / no                |
| before-prod   |  6.9 |    2 |        4889 |                            0 (· / ·) |            21.5 |        16.7 / 16.8 |             0 |                2 |            17.6 / 22.9 |               22.3 / 34 |      1371 |         12.1 | yes        | yes / no                |
| after-prod    | 10.3 |    1 |        5360 |                            2 (1 / 1) |            95.2 |       16.8 / 100.1 |             7 |              2.7 |            18.6 / 24.1 |             26.9 / 47.8 |      1221 |         14.4 | yes        | yes / yes               |
| after-prod    | 10.3 |    2 |        5194 |                            1 (0 / 1) |              75 |          16.8 / 50 |             1 |              2.9 |            15.6 / 17.1 |             25.3 / 33.4 |      2051 |         29.3 | yes        | yes / yes               |
| after-prod-r2 |  6.0 |    1 |        5122 |                            1 (0 / 1) |            79.4 |        16.7 / 66.6 |             1 |              2.5 |            16.2 / 18.3 |               24.7 / 33 |      1221 |         13.3 | yes        | yes / yes               |
| after-prod-r2 |  6.0 |    2 |        4986 |                            1 (0 / 1) |            55.9 |        16.8 / 33.4 |             1 |              2.1 |            15.7 / 16.5 |             26.2 / 33.1 |      2051 |         20.2 | yes        | yes / yes               |
| after-prod-r3 |  6.0 |    1 |        5089 |                            1 (0 / 1) |            78.9 |        16.8 / 66.6 |             1 |              2.1 |            15.3 / 16.6 |               27 / 33.3 |      1221 |         13.3 | yes        | yes / yes               |
| after-prod-r3 |  6.0 |    2 |        5092 |                            0 (0 / 0) |            49.3 |        16.7 / 33.4 |             1 |              2.3 |              16.8 / 20 |             24.5 / 34.3 |      2051 |         19.4 | yes        | yes / yes               |

### Development bundle (`dist-dev/`, not minified)

| Run          | Load | Turn | Duration ms | Tasks >50 ms (during / after stream) | Longest task ms | Frame p95 / max ms | Frames >33 ms | Key→input p95 ms | Key→frame p95 / max ms | Text→paint p50 / p95 ms | DOM nodes | Heap peak MB | Draft kept | Scroll held / jump pill |
| ------------ | ---: | ---: | ----------: | -----------------------------------: | --------------: | -----------------: | ------------: | ---------------: | ---------------------: | ----------------------: | --------: | -----------: | ---------- | ----------------------- |
| before-dev   | 17.7 |    1 |        4989 |                            0 (· / ·) |            26.6 |        16.8 / 33.3 |             0 |              2.1 |            16.9 / 22.1 |             23.3 / 33.2 |       863 |         10.5 | yes        | yes / no                |
| before-dev   | 17.7 |    2 |        5085 |                            0 (· / ·) |              19 |        16.7 / 16.8 |             0 |              2.3 |            20.8 / 23.1 |             22.7 / 34.6 |      1371 |         14.4 | yes        | yes / no                |
| after-dev    |  8.8 |    1 |        5305 |                            1 (0 / 1) |            86.2 |        16.8 / 66.6 |             4 |              2.7 |            17.7 / 18.6 |             25.9 / 36.9 |      1221 |         20.2 | yes        | yes / yes               |
| after-dev    |  8.8 |    2 |        5078 |                            0 (0 / 0) |            46.9 |        16.8 / 33.4 |             1 |              2.3 |            16.3 / 21.7 |             26.5 / 32.9 |      2051 |         19.7 | yes        | yes / yes               |
| after-dev-r2 |  6.4 |    1 |        5019 |                            1 (0 / 1) |            68.6 |        16.8 / 66.7 |             1 |              2.5 |              17 / 19.2 |             26.6 / 33.5 |      1221 |         13.6 | yes        | yes / yes               |
| after-dev-r2 |  6.4 |    2 |        4994 |                            0 (0 / 0) |            44.1 |        16.7 / 33.3 |             0 |              2.2 |              16.6 / 17 |             26.2 / 34.7 |      2051 |         19.5 | yes        | yes / yes               |

### Resume of a 64-turn session

| Run           | Load | Load ms | DOM nodes | Long tasks | Frame max ms | Heap MB |
| ------------- | ---: | ------: | --------: | ---------: | -----------: | ------: |
| before-prod   |  6.9 |     191 |       934 |          0 |         16.8 |     5.5 |
| after-prod    | 10.3 |     172 |       683 |          0 |         16.8 |     6.1 |
| after-prod-r2 |  6.0 |     130 |       683 |          0 |         16.8 |     5.9 |
| after-prod-r3 |  6.0 |     150 |       683 |          0 |         16.8 |     5.9 |
| before-dev    | 17.7 |     203 |       934 |          0 |         16.8 |     6.1 |
| after-dev     |  8.8 |     141 |       683 |          0 |         16.8 |     6.5 |
| after-dev-r2  |  6.4 |     119 |       683 |          0 |         16.8 |     6.6 |

## Reading the numbers

- **Streaming stays clean in production.** In the two quieter after runs (load 6.0) no task over 50 ms started while
  text was arriving, in either turn. The 51 ms during-stream task in the load-10.3 run did not reproduce in the two runs
  that followed it; it is reported rather than discarded.
- **The remaining long task is Mermaid, after the turn.** A raw trace (`--keep-trace=1`) attributed the first-turn task
  to a 76 ms microtask checkpoint immediately after the `flowDiagram` and `dagre` chunks compiled, that is, diagram
  layout. Diagrams now wait until the turn has settled and render one at a time with a macrotask between them, so that
  task lands after the stream (55–79 ms in turn 1, which includes loading the ~2.5 MB of lazy chunks; 49–56 ms in turn
  2). Before this work there were no diagrams at all, which is why the before rows have none.
- **Input stayed responsive.** Keystroke to `input` p95 is 2–3 ms in every run; keystroke to the next frame p95 is 15–19
  ms, within the 60 Hz frame, versus 17–21 ms before. The draft survived every turn.
- **Event to paint grew by about 3 ms at p50** (22–23 → 25–27 ms) and stayed at 33–35 ms at p95 in the quiet runs; the
  47.8 ms p95 belongs to the load-10.3 run.
- **DOM and heap grew as expected** for rendered Markdown: 1,221 nodes after turn 1 and 2,051 after turn 2 versus 863
  and 1,371 for plain text; heap peak 13–20 MB versus 10–12 MB (the 29.3 MB reading is from the load-10.3 run).
- **Resume got cheaper**: 64 replayed turns load in 119–172 ms with 683 nodes, versus 191–203 ms and 934 nodes, because
  settled turns render as compact conversation blocks and are memoized.
- **Follow-latest is now real.** The before rows show `jump pill: no` only because there was no autoscroll to hold
  against. After this work the transcript stayed put through the rest of a fast stream after a manual scroll and the
  jump affordance was present every time.

## Not measured

- Real displays at 120 Hz or 144 Hz, and any GPU-composited path; the harness runs a 60 Hz headless compositor.
- Long code fences that never close during a stream (the tail re-lex grows with the unsettled block; the workload's
  fences are short).
- Diagrams larger than a seven-node flowchart, or more than two per turn.
- A machine without concurrent load; every run above shared the CPU with other test lanes.
- Production Clio Coder output; the workload is a fixture whose shape was chosen to be representative, not recorded.
