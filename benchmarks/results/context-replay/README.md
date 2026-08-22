# Working-set replay tables

Replay of the eviction policies in `src/domains/context/working-set/policies/` over the seeded procedural corpora in `src/domains/context/working-set/replay/synthetic.ts`, driven by `clio-coder context replay --synthetic` through the same fold, projection, planner, and summary cut the live session uses. The JSON beside each table carries the configuration, the git revision, and the exact command line; the tables rebuild on any checkout (the committed JSON is then passed through the repository formatter, `npx biome format --write`, which only reflows short arrays).

Source revision for every table in this directory: `3af2f9d9`.

| File | `protectLastTurns` | Budgets |
| --- | ---: | --- |
| `synthetic-2026-08-22-protect-6.md` / `.json` | 6 | 32000, 64000, 128000 |
| `synthetic-2026-08-22-protect-2.md` / `.json` | 2 | 32000, 64000, 128000 |

## Corpus

Three corpora, 24 traces, every byte a function of the spec and the trace index. `science-long` is eight traces of 300 operator turns over a 48-file simulation repository (about 3.6k tokens per turn); `refactor` is eight traces of 200 turns over 64 files with a high return rate to earlier files (2.5k tokens per turn); `exploration` is eight traces of 200 turns over 120 files, listing-heavy (4.7k tokens per turn). Each turn plays one of four scripts: explore (a listing or grep whose surfaced paths are then read), implement (read, edit, read back), validate (a failing test run, an edit, the same command passing), and analyze (a simulation whose stdout exceeds the result cap and is offloaded, then a results read). Every assistant turn carries a thinking block. Trace 0 of `science-long` fires all six structural reasons and all three reference-edge kinds, which `tests/contracts/working-set-synthetic.test.ts` pins.

The first tables in this directory were built from 165 private Claude Code transcripts. That loader is gone: the corpora replace it so the numbers are reproducible, and so the traces are long enough to measure what a long science session actually does to a window, which no corpus on a developer machine was.

## The summary stage is modeled

Over hundreds of turns, operator text, call arguments, assistant text, markers, and results below `minEvictableTokens` accumulate past any budget, and no policy can evict them. Live, Clio then summarizes. The replay applies the same cut (`findCutPoint` at `keepRecentTokens: 20000`), appends a stand-in `compactionSummary` of 1,500 tokens, counts it, and treats what the cut removed as lost for retention. Without this the long traces spend most of their length in a regime the product never enters, and every policy converges on the same numbers.

## Metrics

- **retention**: of the (tool result, later turn that re-read or discovered the same file) pairs in the trace, the share whose result was still in the working set at that later turn, counting both evictions and summary cuts as removal. `mean` averages per trace; `pooled` counts pairs across all traces. Higher is better.
- **retention covered**: the same pairs, also counted when a newer successful read of the same path covers the original range and survives to the reference turn.
- **eviction precision**: share of evicted items the session never referenced again.
- **recall tokens**: tokens freed by evicting items the session referenced again; what a perfect recall would read back. The token-weighted complement of precision.
- **cold prefix tokens**: after each event, the projected working set from the earliest evicted position to the end, summed per trace. Under an exact-prefix cache (Anthropic, OpenAI, vLLM) this is what the next request re-prefills.
- **saturated events**: share of applied events in which the policy exhausted its candidates before reaching `target`. `age-horizon` has no target stop by design and reads 1.000.
- **turns to first summary** and **summaries**: when the summary stage first ran, and how many times it ran per trace. Summaries are the one lossy, token-spending stage; fewer is the point of eviction.
- `none` evicts nothing, `oracle` evicts only what the future never references, and `random` takes eligible results in seeded random order to the same target.

## Default-policy rule

`context.workingSet.policy` defaults to `structural-v1` if, at the shipped `protectLastTurns: 6`, every budget shows **(a)** `structural-v1` retention (mean) at or above `age-horizon`, **(b)** `structural-v1` precision above `random`, and **(c)** `structural-v1` saturated events below 1.0 at 64k and 128k. The `protectLastTurns: 2` table is a sensitivity check.

## Headline grid, `protectLastTurns: 6`

| budget | summaries: none | structural-v1 | age-horizon | random | retention mean: age-horizon | structural-v1 | random | retention covered: age-horizon | structural-v1 | precision: random | structural-v1 | saturated: structural-v1 | cold prefix: age-horizon | structural-v1 | rule |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 32000 | 108 | **45.3** | 44.4 | 46.9 | 0.066 | **0.067** | 0.065 | 0.490 | **0.495** | 0.194 | **0.492** | 0.556 | 2.25M | 2.60M | holds |
| 64000 | 21.5 | **8.8** | 8.7 | 9.2 | 0.096 | **0.099** | 0.099 | 0.549 | **0.565** | 0.195 | **0.468** | 0.312 | 1.13M | 1.98M | holds |
| 128000 | 8.9 | **3.1** | 3.1 | 3.1 | 0.158 | **0.166** | 0.169 | 0.637 | **0.660** | 0.195 | **0.456** | 0.243 | 0.78M | 1.82M | holds |

At `protectLastTurns: 2` the rule also holds on every cell (retention 0.056/0.088/0.157 against 0.053/0.084/0.149 for `age-horizon`; precision 0.465/0.465/0.451 against 0.190/0.191/0.176 for random; saturation 0.393/0.279/0.205).

## Reading the grid

Eviction is what keeps the summary stage rare. With no eviction a 300-turn science trace at 64k is summarized 21.5 times; with `structural-v1` 8.8 times, and at 128k 3.1 against 8.9. `oracle` barely helps here (18.9 at 64k) because it removes only what is never referenced again, which on a corpus that keeps returning to hot files is a small share: protecting retention and postponing summaries pull in different directions, and the product chooses to postpone summaries.

`structural-v1` leads `age-horizon` on retention and on retention covered at every budget and leads random on precision by 2.3x or more, while saturating between a quarter and a half of its events, so the target stop and the structural rungs decide something on every row. The absolute retention numbers are low by construction: the corpora return to earlier files across hundreds of turns, and a summary cut counts as loss.

The cold-prefix column is the cost side. `structural-v1` stops at `target` and comes back, so it fires 1.1x to 1.8x more events than `age-horizon`, which drains everything evictable in one event, and it therefore re-prefills 1.2x to 2.3x more tokens under an exact-prefix cache for the same number of summaries. On a llama.cpp backend with `--cache-reuse` that cost is partly recovered by KV shifting; on a cloud provider it is paid at 1.25x write price per event. The number that moves it is event count, not which items an event picks, which is what the provider cache mechanics in `docs/context-engine.md` predict and what a cloud-tier deployment should tune through `context.workingSet.target` rather than through the policy.

## Target and rung-6 stop sweep

The 24 traces were replayed at targets 0.4, 0.5, and 0.6 with `protectLastTurns: 6`. A fourth diagnostic let rung 6 exhaust every usable tool result. The exhaustive result was identical to target 0.4 in every reported cell because protected and otherwise un-evictable residue stopped the policy first.

| target or stop | budget | events | cold prefix | summaries | retention | retention covered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4 or exhaustive | 32000 | 121.25 | 2.590M | 45.292 | 0.06660 | 0.49547 |
| 0.5 | 32000 | 121.25 | 2.590M | 45.292 | 0.06660 | 0.49547 |
| 0.6 | 32000 | 121.50 | 2.596M | 45.292 | 0.06660 | 0.49547 |
| 0.4 or exhaustive | 64000 | 61.75 | 1.863M | 8.792 | 0.09910 | 0.56511 |
| 0.5 | 64000 | 62.42 | 1.891M | 8.750 | 0.09908 | 0.56496 |
| 0.6 | 64000 | 64.00 | 1.984M | 8.750 | 0.09902 | 0.56514 |
| 0.4 or exhaustive | 128000 | 35.58 | 1.708M | 3.083 | 0.16542 | 0.65657 |
| 0.5 | 128000 | 35.92 | 1.737M | 3.083 | 0.16553 | 0.65704 |
| 0.6 | 128000 | 36.46 | 1.821M | 3.125 | 0.16607 | 0.66011 |

The shipped default stays at 0.6. Moving every target, including local backends with reusable KV state, to 0.4 saved only 6.1% of cold-prefix tokens at 64k and 6.2% at 128k. It did not materially change summary count and reduced retention covered by 0.00354 at 128k. A tier-aware default is not justified by this sweep. Reopen the decision when target 0.4 cuts cold-prefix tokens by at least 10% at both 64k and 128k without increasing summaries or lowering retention covered by more than 0.002. Operators on exact-prefix cloud tiers can still select 0.4 through the existing setting; no new setting or stop rule is needed.

## Regenerating

```
node --import tsx src/cli/index.ts context replay --synthetic science-long,refactor,exploration \
  --policies none,random,age-horizon,structural-v1,oracle --budgets 32000,64000,128000 \
  --protect-last-turns 6 --json benchmarks/results/context-replay/synthetic-<date>-protect-6.json \
  --md benchmarks/results/context-replay/synthetic-<date>-protect-6.md
```

Each run takes about a minute; run `npx biome format --write` on the JSON before committing. The JSON `provenance.commandLine` is the exact invocation.
