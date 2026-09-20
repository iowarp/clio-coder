# GUI performance baseline and v0.5.0 regression budgets

The tables below are the only measured rendering evidence this repository holds. They
were recorded against the retired Deno/Preact workbench, not against
`apps/clio-coder-gui`, so they are a starting budget rather than a current reading.

Conditions: 1600x1100 headless dark, Deno 2.9.5, headless Chrome 151.0.7922.169, 24 CPUs, WSL2 Linux 6.18, 60 Hz headless compositor, machine shared with other test lanes; before runs 2026-08-30 16:11Z prod and 16:14Z dev, after runs 17:28Z-17:30Z.

## 1. Workbench baseline, verbatim

### Production bundle (`dist/`, minified)

Columns: Run | Load | Turn | Duration ms | Tasks >50 ms (during/after stream) | Longest task ms | Frame p95/max ms | Frames >33 ms | Key→input p95 ms | Key→frame p95/max ms | Text→paint p50/p95 ms | DOM nodes | Heap peak MB | Draft kept | Scroll held / jump pill

before-prod | 6.9 | 1 | 4989 | 0 (·/·) | 26.4 | 16.7/16.8 | 0 | 1.9 | 17.1/20.1 | 22.6/34.4 | 863 | 10.4 | yes | yes/no
before-prod | 6.9 | 2 | 4889 | 0 (·/·) | 21.5 | 16.7/16.8 | 0 | 2 | 17.6/22.9 | 22.3/34 | 1371 | 12.1 | yes | yes/no
after-prod | 10.3 | 1 | 5360 | 2 (1/1) | 95.2 | 16.8/100.1 | 7 | 2.7 | 18.6/24.1 | 26.9/47.8 | 1221 | 14.4 | yes | yes/yes
after-prod | 10.3 | 2 | 5194 | 1 (0/1) | 75 | 16.8/50 | 1 | 2.9 | 15.6/17.1 | 25.3/33.4 | 2051 | 29.3 | yes | yes/yes
after-prod-r2 | 6.0 | 1 | 5122 | 1 (0/1) | 79.4 | 16.7/66.6 | 1 | 2.5 | 16.2/18.3 | 24.7/33 | 1221 | 13.3 | yes | yes/yes
after-prod-r2 | 6.0 | 2 | 4986 | 1 (0/1) | 55.9 | 16.8/33.4 | 1 | 2.1 | 15.7/16.5 | 26.2/33.1 | 2051 | 20.2 | yes | yes/yes
after-prod-r3 | 6.0 | 1 | 5089 | 1 (0/1) | 78.9 | 16.8/66.6 | 1 | 2.1 | 15.3/16.6 | 27/33.3 | 1221 | 13.3 | yes | yes/yes
after-prod-r3 | 6.0 | 2 | 5092 | 0 (0/0) | 49.3 | 16.7/33.4 | 1 | 2.3 | 16.8/20 | 24.5/34.3 | 2051 | 19.4 | yes | yes/yes

### Development bundle (`dist-dev/`, not minified)

Same columns:
before-dev | 17.7 | 1 | 4989 | 0 (·/·) | 26.6 | 16.8/33.3 | 0 | 2.1 | 16.9/22.1 | 23.3/33.2 | 863 | 10.5 | yes | yes/no
before-dev | 17.7 | 2 | 5085 | 0 (·/·) | 19 | 16.7/16.8 | 0 | 2.3 | 20.8/23.1 | 22.7/34.6 | 1371 | 14.4 | yes | yes/no
after-dev | 8.8 | 1 | 5305 | 1 (0/1) | 86.2 | 16.8/66.6 | 4 | 2.7 | 17.7/18.6 | 25.9/36.9 | 1221 | 20.2 | yes | yes/yes
after-dev | 8.8 | 2 | 5078 | 0 (0/0) | 46.9 | 16.8/33.4 | 1 | 2.3 | 16.3/21.7 | 26.5/32.9 | 2051 | 19.7 | yes | yes/yes
after-dev-r2 | 6.4 | 1 | 5019 | 1 (0/1) | 68.6 | 16.8/66.7 | 1 | 2.5 | 17/19.2 | 26.6/33.5 | 1221 | 13.6 | yes | yes/yes
after-dev-r2 | 6.4 | 2 | 4994 | 0 (0/0) | 44.1 | 16.7/33.3 | 0 | 2.2 | 16.6/17 | 26.2/34.7 | 2051 | 19.5 | yes | yes/yes

### Resume of a 64-turn session

Columns: Run | Load | Load ms | DOM nodes | Long tasks | Frame max ms | Heap MB
before-prod | 6.9 | 191 | 934 | 0 | 16.8 | 5.5
after-prod | 10.3 | 172 | 683 | 0 | 16.8 | 6.1
after-prod-r2 | 6.0 | 130 | 683 | 0 | 16.8 | 5.9
after-prod-r3 | 6.0 | 150 | 683 | 0 | 16.8 | 5.9
before-dev | 17.7 | 203 | 934 | 0 | 16.8 | 6.1
after-dev | 8.8 | 141 | 683 | 0 | 16.8 | 6.5
after-dev-r2 | 6.4 | 119 | 683 | 0 | 16.8 | 6.6

METHODOLOGY, carried over exactly:
- `before` = plain-text transcript, no Markdown/highlighting/diagrams/follow-latest. `after` = all of those present. The workload fixture differed between them (before at commit 3f6e140d: tool bursts every 64 chunks regardless of Markdown structure, 1,340 text events, ~1,390 messages; after: bursts between Markdown blocks, 1,358 text events, ~1,420 messages) and by nothing else.
- "During stream" counts long tasks whose `startTime <= lastTextAt`; "after stream" counts those that started later. That split is where diagram layout shows up.
- Load column is the 1-minute load average at run start. The machine was shared with other test lanes throughout; the 51 ms during-stream task in the load-10.3 run did not reproduce in the two runs that followed it and is reported rather than discarded.
- The 64-turn resume runs on a fresh server and a fresh home.

FINDINGS worth carrying (they are what the design decisions rest on):
- Streaming stays clean: in the two quiet after runs (load 6.0) no task over 50 ms started while text was arriving, in either turn.
- The only remaining long task is Mermaid layout, after the turn. `--keep-trace=1` attributed the first-turn task to a 76 ms microtask checkpoint immediately after the `flowDiagram` and `dagre` chunks compiled. Diagrams therefore wait until the turn settles and render one at a time with a macrotask between them (already ported: `client/render/mermaid.ts` queue, `StreamingContext` in `client/render/Markdown.tsx`). Turn 1 costs 55–79 ms including ~2.5 MB of lazy chunk loading; turn 2 costs 49–56 ms.
- Input stays responsive: keystroke→`input` p95 is 2–3 ms in every run; keystroke→next frame p95 is 15–19 ms after versus 17–21 ms before. The draft survived every turn.
- Event→paint grew ~3 ms at p50 (22–23 → 25–27 ms) and stayed 33–35 ms at p95 in the quiet runs; the 47.8 ms p95 is the load-10.3 run.
- DOM and heap: 1,221 nodes after turn 1 and 2,051 after turn 2, versus 863 and 1,371 for plain text; heap peak 13–20 MB versus 10–12 MB (29.3 MB is the load-10.3 run).
- Resume got cheaper — 119–172 ms and 683 nodes versus 191–203 ms and 934 — because settled turns render as compact conversation blocks and are memoized.

BUDGETS FOR THE NEW GUI. State them as fixed-before-measurement thresholds; the workload script should exit non-zero when a quiet-machine run (load average below 8.0) breaks one:
- Zero long tasks over 50 ms starting at or before the last text event, per turn.
- Frame p95 at or below 16.8 ms; at most 2 frames over 33.4 ms per turn.
- Keystroke→`input` p95 at or below 5 ms; keystroke→next frame p95 at or below 20 ms.
- Text→paint p50 at or below 30 ms, p95 at or below 40 ms.
- DOM nodes after turn 2 at or below 2,400; heap peak at or below 24 MB.
- `draftPreserved` true, `scrollHold.stayedPut` true, `scrollHold.jumpAffordanceVisible` true, every turn.
- 64-turn resume at or below 220 ms with at most 800 DOM nodes and zero long tasks.
- Complementary server-side budget already enforced by `tests/stream-load.test.ts`: over a 1,400-event turn, RSS growth under 128 MiB, heap growth under 64 MiB, event ring under 8 MiB.

NOT MEASURED — keep this list and extend it, do not quietly drop it:
- Real displays at 120 Hz or 144 Hz, and any GPU-composited path. The harness runs a 60 Hz headless compositor, so the frame figures bound work per frame and say nothing about 120 Hz behaviour. The rAF coalescing buffer is the mechanism that makes a 120 Hz display meaningful (it delivers per real frame, so a 120 Hz monitor gets ~600 commits per turn instead of ~300), but that has not been measured and must not be claimed. Measuring it needs a headed Chrome on a high-refresh display, which is a separate lane.
- Long code fences that never close during a stream: the tail re-lex grows with the unsettled block, and the workload's fences are short.
- Diagrams larger than a seven-node flowchart, or more than two per turn.
- A machine without concurrent load; every run above shared the CPU.
- Production Clio Coder output. The workload is a fixture whose shape was chosen to be representative, not recorded.
