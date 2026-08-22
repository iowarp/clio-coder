# Working-set replay tables

Replay of the eviction policies in `src/domains/context/working-set/policies/` over the seeded procedural corpora in `src/domains/context/working-set/replay/synthetic.ts`, driven by `clio-coder context replay --synthetic` through the same fold, projection, planner, and summary cut the live session uses. The JSON beside each table carries the configuration, the git revision, and the exact command line; the tables rebuild on any checkout (the committed JSON is then passed through the repository formatter, `npx biome format --write`, which only reflows short arrays).

Each JSON report records the exact source revision used to generate its table. That embedded provenance is authoritative when the two sensitivity runs were generated around an unrelated documentation commit.

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
| 32000 | 108 | **43.7** | 43.4 | 45.2 | 0.066 | **0.067** | 0.065 | 0.490 | **0.496** | 0.194 | **0.490** | 0.562 | 2.22M | 2.57M | holds |
| 64000 | 21.5 | **8.7** | 8.6 | 9.0 | 0.097 | **0.100** | 0.099 | 0.551 | **0.565** | 0.197 | **0.468** | 0.310 | 1.13M | 1.97M | holds |
| 128000 | 8.9 | **3.1** | 3.0 | 3.1 | 0.158 | **0.165** | 0.169 | 0.638 | **0.656** | 0.192 | **0.458** | 0.233 | 0.77M | 1.89M | holds |

At `protectLastTurns: 2` the rule also holds on every cell (retention 0.056/0.088/0.158 against 0.054/0.085/0.151 for `age-horizon`; precision 0.465/0.465/0.450 against 0.189/0.189/0.174 for random; saturation 0.402/0.290/0.227).

## Reading the grid

Eviction is what keeps the summary stage rare. With no eviction a 300-turn science trace at 64k is summarized 21.5 times; with `structural-v1` 8.7 times, and at 128k 3.1 against 8.9. `oracle` barely helps here (18.7 at 64k) because it removes only what is never referenced again, which on a corpus that keeps returning to hot files is a small share: protecting retention and postponing summaries pull in different directions, and the product chooses to postpone summaries.

`structural-v1` leads `age-horizon` on retention and on retention covered at every budget and leads random on precision by 2.3x or more, while saturating between 0.23 and 0.56 of its events, so the target stop and the structural rungs decide something on every row. The absolute retention numbers are low by construction: the corpora return to earlier files across hundreds of turns, and a summary cut counts as loss.

The cold-prefix column is the cost side. `structural-v1` stops at `target` and comes back, so it fires 1.1x to 1.9x more events than `age-horizon`, which drains everything evictable in one event, and it therefore re-prefills 1.2x to 2.5x more tokens under an exact-prefix cache for the same number of summaries. On a llama.cpp backend with `--cache-reuse` that cost is partly recovered by KV shifting; on a cloud provider it is paid at 1.25x write price per event. The number that moves it is event count, not which items an event picks, which is what the provider cache mechanics in `docs/context-engine.md` predict and what a cloud-tier deployment should tune through `context.workingSet.target` rather than through the policy.

The replay estimator excludes `contextUsageInvalidated` from assistant-message cost. That field is ledger metadata used to reject a stale usage anchor; it is not sent as prompt content. Before this correction the post-event projection could cost 79 tokens more than the planner's `tokensAfter` value solely because the stamp had been attached. The contract now requires every event's cold suffix to fit within `tokensAfter`, and both tables were regenerated from that invariant.

## Target and rung-6 stop sweep

The 24 traces were replayed at targets 0.4, 0.5, and 0.6 with `protectLastTurns: 6`. A fourth diagnostic let rung 6 exhaust every usable tool result. The exhaustive result was identical to target 0.4 in every reported cell because protected and otherwise un-evictable residue stopped the policy first.

| target or stop | budget | events | cold prefix | summaries | retention | retention covered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4 or exhaustive | 32000 | 120.21 | 2.559M | 43.708 | 0.06694 | 0.49606 |
| 0.5 | 32000 | 120.21 | 2.559M | 43.708 | 0.06694 | 0.49606 |
| 0.6 | 32000 | 120.42 | 2.565M | 43.708 | 0.06693 | 0.49607 |
| 0.4 or exhaustive | 64000 | 61.83 | 1.852M | 8.708 | 0.09972 | 0.56462 |
| 0.5 | 64000 | 62.08 | 1.867M | 8.708 | 0.09968 | 0.56463 |
| 0.6 | 64000 | 64.21 | 1.972M | 8.708 | 0.09965 | 0.56453 |
| 0.4 or exhaustive | 128000 | 36.67 | 1.747M | 3.083 | 0.16429 | 0.65498 |
| 0.5 | 128000 | 36.88 | 1.774M | 3.083 | 0.16442 | 0.65543 |
| 0.6 | 128000 | 38.08 | 1.894M | 3.083 | 0.16470 | 0.65600 |

The shipped default stays at 0.6. Moving every target, including local backends with reusable KV state, to 0.4 saved only 6.1% of cold-prefix tokens at 64k and 7.8% at 128k. It did not change summary count and reduced retention covered by 0.00102 at 128k. A tier-aware default is not justified by this sweep. Reopen the decision when target 0.4 cuts cold-prefix tokens by at least 10% at both 64k and 128k without increasing summaries or lowering retention covered by more than 0.002. Operators on exact-prefix cloud tiers can still select 0.4 through the existing setting; no new setting or stop rule is needed.

## Summary residue and the eviction floor

The residue probe replayed `structural-v1` at 64k and recorded the projected entries immediately before every modeled summary. The table reports mean tokens per summary point. Size class is estimated body tokens for an un-evicted tool result and projected entry tokens for every other kind. The sample contains 66 summary points for `science-long`, 49 for `refactor`, and 94 for `exploration`.

| corpus | entry kind | <50 | 50–99 | 100–199 | ≥200 | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| science-long | user | 1320 | 0 | 0 | 0 | 1320 |
| science-long | assistant | 2111 | 1122 | 0 | 0 | 3232 |
| science-long | tool call | 7244 | 963 | 0 | 0 | 8207 |
| science-long | tool-result body | 2560 | 484 | 2952 | 23282 | 29278 |
| science-long | eviction marker | 0 | 0 | 14323 | 0 | 14323 |
| refactor | user | 1173 | 0 | 0 | 0 | 1173 |
| refactor | assistant | 1900 | 1021 | 0 | 0 | 2921 |
| refactor | tool call | 7487 | 603 | 0 | 0 | 8090 |
| refactor | tool-result body | 2915 | 412 | 1368 | 28072 | 32766 |
| refactor | eviction marker | 0 | 0 | 13556 | 0 | 13556 |
| exploration | user | 577 | 0 | 0 | 0 | 577 |
| exploration | assistant | 799 | 827 | 0 | 0 | 1626 |
| exploration | tool call | 6627 | 245 | 0 | 0 | 6872 |
| exploration | tool-result body | 654 | 237 | 4479 | 44845 | 50214 |
| exploration | eviction marker | 0 | 0 | 9199 | 0 | 9199 |

The floor sweep separates marker break-even from the retention decision. Floors 0 and 50 were identical because the engine already refuses an eviction whose marker saves no tokens. Lowering the floor from 200 to 0 changed summaries from 43.708 to 43.042 at 32k, from 8.708 to 8.583 at 64k, and from 3.083 to 3.042 at 128k. It reduced covered retention from 0.5645 to 0.5550 at 64k and from 0.6560 to 0.6424 at 128k. The default stays at 200 as a low-yield churn guard, not as the literal marker break-even point.

Widening the unit set is not proposed on these numbers. Clearing only tool-call arguments after their paired result was evicted would free 1020, 873, and 517 tokens per summary point on the three corpora, just 1.8%, 1.5%, and 0.8% of residue. Reducing the existing protection horizon from six turns to two cut 64k summaries from 8.708 to 6.750. That does not approach the 4.354 needed to halve summaries. The dominant residue is already an existing unit kind: tool-result bodies of at least 200 tokens account for 41% to 65% of the projected tokens at summary points, but the protection and unresolved-failure rules keep them in context. Deleting operator text, assistant text, call envelopes, or recall markers would violate the current owner contract for a larger but lossy gain.

## Why recall remains a demand metric

The reference graph is not a record of recall decisions. It links every earlier readable observation to every later reread or discovery of the same path. Across the eight traces in each corpus, that produces 7,172 refs and 159,220 future pairs for `science-long`, 5,058 refs and 73,321 pairs for `refactor`, and 11,882 refs and 283,434 pairs for `exploration`. One earlier ref has 292 later pairs, and the corpus means are 22.2, 14.5, and 23.9 pairs per ref.

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
