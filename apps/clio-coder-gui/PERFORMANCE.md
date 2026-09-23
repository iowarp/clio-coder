# Streaming performance

Measured numbers for the conversation while a response streams, against the reference budgets in
DESIGN.md "Streaming cadence". Every figure below was generated from the JSON that
`scripts/perf-workload.ts` wrote; none was typed in. Nothing here is a claim about a display rate that
was not measured.

## Workload

```sh
npx vite build --outDir <scratch>/client-build --emptyOutDir
pnpm run perf --client <scratch>/client-build/ --out <scratch>/perf --label <name>                 # 6.7 KB
pnpm run perf --client <scratch>/client-build/ --out <scratch>/perf --label <name> --bytes 16384   # 16.7 KB
```

The script serves a production build against the ACP fixture (`markdown` scenario, with the route
facts on so the composer shows a reported target and model) and drives Chrome at 1600×1100 in the dark
theme through three turns in one new conversation. Each turn's prompt reaches the fixture's workload
turn (`tests/fixtures/stream-workload.mjs`):

- The reference answer is the retired workbench's `stream-workload` text: 6,704 bytes, 33 blocks and
  1,358 five-character `agent_message_chunk` updates. It covers headings, nested and task lists, a
  block quote, a table, three fences (TypeScript, Python and an unknown language), two Mermaid
  diagrams (one deliberately malformed), raw HTML and unsafe links the renderer must neutralise, and
  six long paragraphs. `--bytes 16384` adds 21 more paragraphs: 16,739 bytes, 54 blocks, 3,374 chunks.
- The fixture sends four chunks, then waits 4 ms, which delivers the reference answer in about 1.5 s
  and the long one in about 3.7 s. That is faster than any model streams, on purpose.
- Before every third block it sends a burst of one to four tool calls (`read` or `bash`, each started
  and settled 4 ms apart; the seventh fails), and two reasoning chunks arrive, one first and one
  halfway.
- Turn 1 is quiet: nobody types or scrolls. Turns 2 and 3 type a 64-character follow-up into the
  composer 700 ms after sending (35 ms between keys), then scroll the transcript to its middle and
  hold for 1.2 s, then check that the scroll stayed put, the jump pill appeared, and the draft
  survived the turn.
- After the turn settles the script waits until the turn's valid diagram has drawn and the malformed
  one shows its failure, then keeps measuring for one more second, because diagram layout runs after
  the stream.

What each column means:

- **Tasks over 50 ms**: `longtask` entries that started up to the last text event (during) or after it.
- **Frame**: intervals between consecutive animation frames while the turn ran. A **missed** frame is
  an interval longer than 1.5 times the median.
- **Key→input**: `keydown` to the `input` event of the character it typed. **Key→frame**: `keydown`
  to the next animation frame after that `input`.
- **Event→paint**: from the first `turn.text` event received after a paint to the animation frame
  after the DOM next changed.
- **Composer / settled-turn renders**: calls to those components' render functions between the 100th
  and the last text event, counted by `client/render/render-probe.ts`. The window opens at the 100th
  delta because sending renders the composer on its own for about 50 ms (the draft is acknowledged,
  the send settles, the turn starts, the steering queue is read); a temporary log of changed inputs
  confirmed that each of those renders came from one of these and none from a delta.

## Environment

AMD Ryzen AI MAX+ PRO 395 with 24 logical CPUs and 31 GB visible to WSL2 (Linux 6.18.33.2), Node
24.20.0, Google Chrome 153.0.8010.52. Recorded on 2026-09-23 between 15:09Z and 15:16Z on a build of
`1b0c41e9` plus the change that adds this file. The 1-minute load average at the start of each run is
in the tables.

**Display rate.** The measured animation-frame interval was 16.7 ms at the median in every run,
headless and headed alike: Chrome headless and Chrome headed under WSLg both paint at 60 Hz on this
machine. No run here demonstrates behaviour at 120 Hz or above, and keystroke→frame cannot fall
below the frame interval that bounds it.

## Results

### Reference answer, 6.7 KB in 1,358 chunks

| Run | Load | Turn | Stream ms | Tasks >50 ms during / after | Frame p50 / p95 / max ms | Missed frames | Key→input p95 / max ms | Key→frame p50 / p95 / max ms | Event→paint p50 / p95 / max ms | Composer / settled-turn renders | DOM nodes | Heap peak MB | Draft kept | Scroll held / jump pill |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| headless a | 3.0 | 1 (quiet) | 1559 | 0 / 0 | 16.7 / 16.8 / 33.3 | 1 | — | — | 28.2 / 30.8 / 34.2 | 0 / 0 | 924 | 17.5 | — | — |
| headless a | 3.0 | 2 | 1542 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | 1.3 / 1.4 | 8.8 / 15.9 / 17.4 | 26.4 / 30.9 / 32.1 | 18 typing / 0 | 1633 | 20.9 | yes | yes / yes |
| headless a | 3.0 | 3 | 1536 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | 1.3 / 1.3 | 8.8 / 16.7 / 18.8 | 26.8 / 30.6 / 39.5 | 18 typing / 0 | 2340 | 25.8 | yes | yes / yes |
| headless b | 3.0 | 1 (quiet) | 1551 | 0 / 0 | 16.7 / 16.8 / 33.4 | 1 | — | — | 28.6 / 31.1 / 33.5 | 0 / 0 | 924 | 23.9 | — | — |
| headless b | 3.0 | 2 | 1566 | 0 / 0 | 16.7 / 16.8 / 16.8 | 0 | 1.3 / 1.3 | 9.4 / 17.0 / 17.6 | 26.3 / 30.7 / 31.4 | 19 typing / 0 | 1633 | 21.9 | yes | yes / yes |
| headless b | 3.0 | 3 | 1535 | 0 / 0 | 16.7 / 16.8 / 16.8 | 0 | 1.2 / 1.3 | 9.5 / 16.8 / 17.8 | 26.5 / 31.6 / 37.9 | 18 typing / 0 | 2340 | 27.1 | yes | yes / yes |
| headless c | 3.1 | 1 (quiet) | 1547 | 0 / 0 | 16.7 / 16.8 / 33.4 | 1 | — | — | 29.3 / 31.2 / 33.7 | 0 / 0 | 924 | 24.3 | — | — |
| headless c | 3.1 | 2 | 1536 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | 1.0 / 1.5 | 8.9 / 15.6 / 17.3 | 26.7 / 31.0 / 31.8 | 18 typing / 0 | 1633 | 21.9 | yes | yes / yes |
| headless c | 3.1 | 3 | 1552 | 0 / 0 | 16.7 / 16.8 / 33.3 | 1 | 1.4 / 1.5 | 10.1 / 17.3 / 18.9 | 25.4 / 32.2 / 33.2 | 17 typing / 0 | 2340 | 28.0 | yes | yes / yes |
| headed (WSLg) | 3.5 | 1 (quiet) | 1564 | 0 / 0 | 16.7 / 16.8 / 33.3 | 2 | — | — | 28.8 / 31.2 / 39.7 | 0 / 0 | 924 | 20.3 | — | — |
| headed (WSLg) | 3.5 | 2 | 1556 | 0 / 0 | 16.7 / 16.8 / 16.8 | 0 | 1.4 / 2.6 | 8.4 / 16.0 / 17.8 | 26.8 / 31.0 / 33.3 | 18 typing / 0 | 1633 | 18.9 | yes | yes / yes |
| headed (WSLg) | 3.5 | 3 | 1546 | 0 / 0 | 16.7 / 16.8 / 33.3 | 1 | 1.4 / 1.7 | 8.4 / 16.2 / 17.7 | 24.8 / 30.3 / 33.9 | 17 typing / 0 | 2340 | 30.0 | yes | yes / yes |

### Long answer, 16.7 KB in 3,374 chunks

| Run | Load | Turn | Stream ms | Tasks >50 ms during / after | Frame p50 / p95 / max ms | Missed frames | Key→input p95 / max ms | Key→frame p50 / p95 / max ms | Event→paint p50 / p95 / max ms | Composer / settled-turn renders | DOM nodes | Heap peak MB | Draft kept | Scroll held / jump pill |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| headless a | 0.8 | 1 (quiet) | 3719 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | — | — | 29.8 / 31.5 / 33.1 | 0 / 0 | 980 | 20.1 | — | — |
| headless a | 0.8 | 2 | 3709 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | 1.0 / 1.1 | 8.4 / 14.8 / 15.2 | 27.1 / 31.0 / 42.6 | 64 typing / 0 | 1745 | 28.3 | yes | yes / yes |
| headless a | 0.8 | 3 | 3713 | 0 / 0 | 16.7 / 16.8 / 16.8 | 0 | 1.2 / 1.2 | 9.6 / 13.5 / 14.4 | 26.7 / 31.2 / 40.4 | 64 typing / 0 | 2508 | 30.2 | yes | yes / yes |
| headless b | 0.7 | 1 (quiet) | 3741 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | — | — | 29.6 / 31.3 / 33.8 | 0 / 0 | 980 | 18.8 | — | — |
| headless b | 0.7 | 2 | 3719 | 0 / 0 | 16.7 / 16.8 / 16.8 | 0 | 1.0 / 1.1 | 8.8 / 14.7 / 15.6 | 27.1 / 31.2 / 41.9 | 64 typing / 0 | 1745 | 29.0 | yes | yes / yes |
| headless b | 0.7 | 3 | 3719 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | 1.1 / 1.3 | 9.8 / 13.2 / 14.8 | 25.9 / 31.4 / 47.4 | 64 typing / 0 | 2508 | 30.0 | yes | yes / yes |
| headless c | 0.8 | 1 (quiet) | 3723 | 0 / 0 | 16.7 / 16.7 / 33.4 | 1 | — | — | 29.4 / 30.9 / 33.0 | 0 / 0 | 980 | 18.0 | — | — |
| headless c | 0.8 | 2 | 3706 | 0 / 0 | 16.7 / 16.7 / 16.8 | 0 | 0.9 / 1.2 | 8.6 / 14.1 / 14.4 | 26.7 / 31.2 / 43.2 | 64 typing / 0 | 1745 | 29.1 | yes | yes / yes |
| headless c | 0.8 | 3 | 3696 | 0 / 0 | 16.7 / 16.8 / 16.8 | 0 | 1.0 / 1.6 | 8.1 / 14.2 / 15.4 | 27.6 / 31.4 / 33.9 | 64 typing / 0 | 2508 | 30.2 | yes | yes / yes |

## Reading the numbers

- **No long task during any stream.** Across 21 measured turns no task over 50 ms started while text
  arrived or in the second after the diagrams drew. One earlier run of the same build, made before
  the script waited for diagrams, recorded a single 53 ms task during its first turn's stream; five
  later runs did not repeat it. The workbench reference had diagram layout at 55–79 ms after the
  stream; here both diagrams drew with no task over 50 ms.
- **Input is inside the budget.** Keystroke→`input` p95 is 0.9–1.4 ms (budget 2–3 ms).
  Keystroke→next frame p95 is 15.6–17.3 ms on the reference answer and 13.2–14.8 ms on the long one
  (budget 15–19 ms at 60 Hz). A 60 Hz frame is 16.7 ms, so that figure mostly measures where in the
  frame the key landed; the work behind it is the 1 ms to `input`. The 120 Hz target of under 10 ms
  cannot be tested on this display.
- **Event→paint** p50 is 24.8–29.8 ms and p95 30.3–32.2 ms, against 25–27 ms and 33–35 ms. A text
  event waits for the next animation frame by design, so this is one frame plus the delivery.
- **The composer does not render on streamed deltas.** In every quiet turn the composer rendered 0
  times between the 100th and the last text event (1,258 and 3,274 deltas, tool bursts and reasoning
  included), while it carries a reported route. In the typing turns every composer render is a
  keystroke: 17–19 renders in the reference answer's 1.5 s window and 64 in the long one's 3.7 s,
  which holds all 64 keys. Settled turns rendered 0 times during every stream. The smoke asserts the
  composer half on every run (see below).
- **Follow-latest held.** In every typing turn the transcript stayed at the offset it was scrolled to
  while text kept arriving, the jump pill appeared, and the draft survived the turn.
- **DOM and heap grow linearly with the record:** about 710 nodes per reference turn and 760 per long
  turn, and a heap peak of 17–30 MB after three turns.

## Guarded in the smoke

`scripts/browser-smoke.ts` turns the render probe on and sends the reference workload at each width.
Between the "Results" heading and the "How the levels relate" heading of the live answer (Markdown,
code, a table, tool bursts and the failed call) it asserts the composer's render count did not move.
A change that gives the composer a prop with a new identity per delta fails the gate.

## Not measured

- A display at 120 Hz or above. Both headless Chrome and Chrome under WSLg paint at 60 Hz here.
- A machine without concurrent load; the other agent's work shared this machine throughout.
- Resuming a long saved conversation. The fixture's `session/load` replays one turn.
- A fence that stays open for a long stretch of the stream; the workload's fences are short, and the
  tail re-lex grows with the unsettled block.
- More than two diagrams per turn, or a diagram larger than a seven-node flowchart.
- Real Clio Coder output. The workload is a fixture chosen to be representative, not a recording.
