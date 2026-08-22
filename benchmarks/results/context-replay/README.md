# Working-set replay tables

Replay of the eviction policies in `src/domains/context/working-set/policies/` over the seeded procedural corpora in `src/domains/context/working-set/replay/synthetic.ts`, driven by `clio-coder context replay --synthetic` through the same fold, projection, planner, and summary cut the live session uses. The JSON beside each table carries the configuration, the git revision, and the exact command line; the tables rebuild on any checkout (the committed JSON is then passed through the repository formatter, `npx biome format --write`, which only reflows short arrays).

Each JSON report records the exact source revision used to generate its table. That embedded provenance is authoritative when the two sensitivity runs were generated around an unrelated documentation commit.

| File | `protectLastTurns` | Budgets |
| --- | ---: | --- |
| `synthetic-2026-08-22-protect-6.md` / `.json` | 6 | 32000, 64000, 128000 |
| `synthetic-2026-08-22-protect-2.md` / `.json` | 2 | 32000, 64000, 128000 |

## Corpus

Three corpora, 24 traces, every byte a function of the spec and the trace index. Each turn plays one of four scripts: explore (a listing or grep whose surfaced paths are then read), implement (read, edit, read back), validate (a failing test run, an edit, the same command passing), and analyze (a simulation whose stdout is offloaded after 200 displayed lines, then a results read). Every assistant turn carries a thinking block. Trace 0 of `science-long` fires all six structural reasons and all three reference-edge kinds, which `tests/contracts/working-set-synthetic.test.ts` pins.

| corpus | traces × turns | files | script weights E/I/V/A | return probability | turn tokens mean / p50 / p90 / p99 / max | calls p90 / max | offloaded results |
| --- | ---: | ---: | --- | ---: | --- | --- | ---: |
| science-long | 8 × 300 | 48 | 1/3/2/2 | 0.30 | 2.90k / 2.67k / 4.38k / 17.16k / 19.55k | 8 / 52 | 541 |
| refactor | 8 × 200 | 64 | 1/5/2/0 | 0.40 | 3.10k / 2.53k / 5.18k / 17.42k / 19.85k | 8 / 52 | 0 |
| exploration | 8 × 200 | 120 | 4/1/1/1 | 0.15 | 3.49k / 2.82k / 4.37k / 17.96k / 18.79k | 8 / 52 | 215 |

The return probabilities are scenario bounds, not estimates of user behavior: refactoring deliberately revisits prior focus sets most often, broad exploration least often, and science work sits between them. New focus sets select file rank from a bounded power law. At the configured exponent 1, zero-based rank `r` has probability `ln((r + 2) / (r + 1)) / ln(N + 1)`, the discrete log-uniform form whose tail is asymptotically Zipf-1. The `N + 1` bound matters: it keeps the last file reachable instead of silently dropping the coldest rank.

The corpus is now bounded by the same ceilings as live Clio. A rare fully consumed tree listing exposes at most 48 paths and samples each with 20 lines. Across all 5,600 generated turns that keeps the maximum at 52 tool calls against the shipped 60-call backstop. The largest aggregate result payload in one turn is 59,068 bytes, so its observation subset is below the shared 192 KiB pool. Individual maxima are 6,212 bytes for `read` against its 50 KiB/2,000-line cap, 2,041 for content `grep` against 16 KiB, 2,316 for `find` or `ls` against 8 KiB, and 7,825 for displayed `bash` output against 16 KiB. Simulation originals remain far below the 16 MiB capture ceiling; their deliberately smaller 200-line display threshold exists to exercise offload provenance rather than to imitate that hard safety cap.

These conclusions have a preregistered invalidation test for the first real multi-hour Clio ledger. Revisit the corpus and rerun the policy rule if the ledger's focus-set return rate falls outside 0.10–0.50, a maximum-likelihood fit of its file-rank distribution falls outside exponent 0.7–1.3, its median shaped prompt growth per operator turn falls outside 2k–6k tokens, or its p90 falls outside 3.5k–12k. Also revisit if more than 30% of turns carry an offloaded result, beyond the 0–22.5% span represented here. Until such a ledger exists, the grid is a reproducible sensitivity experiment, not a claim that these are production frequencies.

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
| 32000 | 108.0 | **42.0** | 41.7 | 43.8 | 0.066 | **0.067** | 0.065 | 0.481 | **0.488** | 0.191 | **0.478** | 0.561 | 2.20M | 2.56M | holds |
| 64000 | 20.3 | **7.5** | 7.4 | 7.7 | 0.099 | **0.103** | 0.103 | 0.547 | **0.563** | 0.169 | **0.434** | 0.346 | 1.13M | 2.01M | holds |
| 128000 | 7.8 | **2.7** | 2.7 | 2.7 | 0.163 | **0.175** | 0.175 | 0.625 | **0.655** | 0.184 | **0.445** | 0.274 | 0.69M | 1.76M | holds |

At `protectLastTurns: 2` the rule also holds on every cell (retention 0.057/0.094/0.167 against 0.053/0.086/0.151 for `age-horizon`; precision 0.440/0.443/0.437 against 0.173/0.167/0.148 for random; saturation 0.419/0.330/0.282).

## Reading the grid

Eviction is what keeps the summary stage rare. With no eviction a long trace at 64k is summarized 20.3 times on average; with `structural-v1` 7.5 times, and at 128k 2.7 against 7.8. `oracle` barely helps here (17.4 at 64k) because it removes only what is never referenced again, which on a corpus that keeps returning to hot files is a small share: protecting retention and postponing summaries pull in different directions, and the product chooses to postpone summaries.

`structural-v1` leads `age-horizon` on retention and on retention covered at every budget and leads random on precision by 2.4x or more, while saturating between 0.27 and 0.56 of its events, so the target stop and the structural rungs decide something on every row. The absolute retention numbers are low by construction: the corpora return to earlier files across hundreds of turns, and a summary cut counts as loss.

The cold-prefix column is the cost side. `structural-v1` stops at `target` and comes back, so it fires 1.1x to 1.6x more events than `age-horizon`, which drains everything evictable in one event, and it therefore re-prefills 1.2x to 2.6x more tokens under an exact-prefix cache for the same number of summaries. On a llama.cpp backend with `--cache-reuse` that cost is partly recovered by KV shifting; on a cloud provider it is paid at 1.25x write price per event. The number that moves it is event count, not which items an event picks, which is what the provider cache mechanics in `docs/context-engine.md` predict and what a cloud-tier deployment should tune through `context.workingSet.target` rather than through the policy.

The replay estimator excludes `contextUsageInvalidated` from assistant-message cost. That field is ledger metadata used to reject a stale usage anchor; it is not sent as prompt content. Before this correction the post-event projection could cost 79 tokens more than the planner's `tokensAfter` value solely because the stamp had been attached. The contract now requires every event's cold suffix to fit within `tokensAfter`, and both tables were regenerated from that invariant.

## Target and rung-6 stop sweep

The 24 traces were replayed at targets 0.4, 0.5, and 0.6 with `protectLastTurns: 6`. A fourth diagnostic let rung 6 exhaust every usable tool result. The exhaustive result was identical to target 0.4 in every reported cell because protected and otherwise un-evictable residue stopped the policy first.

| target or stop | budget | events | cold prefix | summaries | retention | retention covered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4 or exhaustive | 32000 | 125.33 | 2.560M | 42.000 | 0.06705 | 0.48837 |
| 0.5 | 32000 | 125.33 | 2.560M | 42.000 | 0.06705 | 0.48837 |
| 0.6 | 32000 | 125.33 | 2.560M | 42.000 | 0.06706 | 0.48848 |
| 0.4 or exhaustive | 64000 | 67.38 | 1.956M | 7.542 | 0.10343 | 0.56293 |
| 0.5 | 64000 | 67.46 | 1.960M | 7.542 | 0.10342 | 0.56294 |
| 0.6 | 64000 | 68.29 | 2.013M | 7.542 | 0.10349 | 0.56338 |
| 0.4 or exhaustive | 128000 | 35.79 | 1.628M | 2.667 | 0.17519 | 0.65474 |
| 0.5 | 128000 | 35.79 | 1.628M | 2.667 | 0.17519 | 0.65474 |
| 0.6 | 128000 | 36.96 | 1.756M | 2.667 | 0.17550 | 0.65546 |

The shipped default stays at 0.6. Moving every target, including local backends with reusable KV state, to 0.4 saved only 2.8% of cold-prefix tokens at 64k and 7.3% at 128k. It did not change summary count and reduced retention covered by 0.00072 at 128k. A tier-aware default is not justified by this sweep. Reopen the decision when target 0.4 cuts cold-prefix tokens by at least 10% at both 64k and 128k without increasing summaries or lowering retention covered by more than 0.002. Operators on exact-prefix cloud tiers can still select 0.4 through the existing setting; no new setting or stop rule is needed.

## Summary residue and the eviction floor

The residue probe replayed `structural-v1` at 64k and recorded the projected entries immediately before every modeled summary. The table reports mean tokens per summary point. Size class is estimated body tokens for an un-evicted tool result and projected entry tokens for every other kind. The sample contains 65 summary points for `science-long`, 46 for `refactor`, and 70 for `exploration`.

| corpus | entry kind | <50 | 50–99 | 100–199 | ≥200 | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| science-long | user | 1370 | 0 | 0 | 0 | 1370 |
| science-long | assistant | 2521 | 823 | 0 | 0 | 3344 |
| science-long | tool call | 7900 | 1019 | 0 | 0 | 8919 |
| science-long | tool-result body | 2670 | 453 | 3023 | 17592 | 23738 |
| science-long | eviction marker | 0 | 0 | 16144 | 0 | 16144 |
| refactor | user | 1271 | 0 | 0 | 0 | 1271 |
| refactor | assistant | 2305 | 828 | 0 | 0 | 3133 |
| refactor | tool call | 8553 | 581 | 0 | 0 | 9134 |
| refactor | tool-result body | 3126 | 434 | 1487 | 16947 | 21994 |
| refactor | eviction marker | 0 | 0 | 17442 | 0 | 17442 |
| exploration | user | 837 | 0 | 0 | 0 | 837 |
| exploration | assistant | 1385 | 822 | 0 | 0 | 2207 |
| exploration | tool call | 8138 | 348 | 0 | 0 | 8486 |
| exploration | tool-result body | 1017 | 332 | 5235 | 22566 | 29150 |
| exploration | eviction marker | 0 | 0 | 15312 | 0 | 15312 |

The floor sweep separates marker break-even from the retention decision. Floors 0 and 50 were identical because the engine already refuses an eviction whose marker saves no tokens. Lowering the floor from 200 to 0 changed summaries from 42.000 to 41.458 at 32k, from 7.542 to 7.375 at 64k, and left 128k at 2.667. It reduced covered retention from 0.5634 to 0.5558 at 64k and from 0.6555 to 0.6318 at 128k. The default stays at 200 as a low-yield churn guard, not as the literal marker break-even point.

Widening the unit set is not proposed on these numbers. Clearing only tool-call arguments after their paired result was evicted would free 1222, 1197, and 1074 tokens per summary point on the three corpora, just 2.3%, 2.3%, and 1.9% of residue. Reducing the existing protection horizon from six turns to two cut 64k summaries from 7.542 to 5.917. That does not approach the 3.771 needed to halve summaries. Large tool-result bodies remain the biggest existing unit class, at 33% to 40% of projected tokens at summary points; eviction markers are now 27% to 33%, the durable cost of preserving recall identity. Deleting operator text, assistant text, call envelopes, or recall markers would violate the current owner contract for a larger but lossy gain.

## Why recall remains a demand metric

The reference graph is not a record of recall decisions. It links every earlier readable observation to every later reread or discovery of the same path. Across the eight traces in each corpus, that produces 7,310 refs and 152,140 future pairs for `science-long`, 5,456 refs and 80,619 pairs for `refactor`, and 9,820 refs and 266,932 pairs for `exploration`. One earlier ref has 300 later pairs, and the corpus means are 20.8, 14.8, and 27.2 pairs per ref.

Appending a `contextRecall` for those edges would invent behavior. The later turn already performs a fresh read and appends the current body at the tail; injecting the older body as well duplicates it, and is specifically wrong for a result evicted as stale or superseded. A diagnostic that limited the invention to one recall per ref still exceeded 1,018,488 KB RSS after 52.6 seconds before a single-policy three-budget sweep completed. That resource growth is a consequence of duplicating thousands of bodies, not a product cost observed in a ledger.

`recallTokens` therefore remains the one-time token-weighted demand bound: each evicted item that has any future critical path use contributes its freed tokens once. The tables do not report fabricated recall count, churn, or tail growth. Reopen simulation when a long ledger records explicit model-issued `contextRecall` entries, or when a corpus labels recall decisions separately from ordinary rereads. Those records identify which ref was chosen, whether its returned tail was still visible, and when a repeated recall actually occurred.

## Regenerating

```
node --import tsx src/cli/index.ts context replay --synthetic science-long,refactor,exploration \
  --policies none,random,age-horizon,structural-v1,oracle --budgets 32000,64000,128000 \
  --protect-last-turns 6 --json benchmarks/results/context-replay/synthetic-<date>-protect-6.json \
  --md benchmarks/results/context-replay/synthetic-<date>-protect-6.md
```

Each run takes about a minute; run `npx biome format --write` on the JSON before committing. The JSON `provenance.commandLine` is the exact invocation.
