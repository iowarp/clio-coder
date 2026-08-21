# Working-set replay tables

Replay of the eviction policies in `src/domains/context/working-set/policies/` over the 165 Claude Code transcripts of this repository that pass the default inclusion filter, driven by `clio-coder context replay` through the same fold, projection, and planner the live session uses. The command line is the first comment of each Markdown table; the JSON beside it carries the configuration, the git revision, and the exact command.

Source revision for every table in this directory: `ca3f49b6`.

| File | `protectLastTurns` | Budgets |
| --- | ---: | --- |
| `claude-code-2026-08-21-protect-6.md` / `.json` | 6 | 32000, 64000, 128000 |
| `claude-code-2026-08-21-protect-2.md` / `.json` | 2 | 32000, 64000, 128000 |

## Corpus

`~/.claude/projects/-home-akougkas-iowarp-clio-coder`: 303 transcripts found, 2 unreadable, 17 sidechain or subagent, 14 with fewer than 8 turns, 3 with fewer than 8 tool results, 102 with no file re-read, **165 kept**. The loader folds Claude Code's per-block assistant records into one assistant entry per message, maps its tool names and argument keys onto Clio's, and keeps the recorded cwd for the path index. Clio's own ledgers on the machine were too short to measure anything (129 sessions, 123 under 8 turns, retention 0.997 for every policy), which is why the Claude Code loader exists.

## Metrics

- **retention**: of the (tool result, later turn that re-read or discovered the same file) pairs in the trace, the share whose result was still in the working set at that later turn. `mean` averages per trace; `pooled` counts pairs across all traces. Higher is better.
- **eviction precision**: share of evicted items the session never referenced again. Its complement is what live churn (recalls over items evicted) would count.
- **saturated events**: share of applied eviction events in which the policy exhausted its candidates before reaching `target`. `age-horizon` has no target stop by design, so it reads 1.000; a value below 1.0 means the policy chose, rather than ran out.
- **turns to first summary**: turns until the projection still exceeded the threshold after an eviction and the summary path would have run; `n` is the number of traces that ever reached that point.
- `none` evicts nothing and `oracle` evicts only what the future never references; `random` takes eligible results in seeded random order to the same target.

## Default-policy rule

`context.workingSet.policy` defaults to `structural-v1` if, at the shipped `protectLastTurns: 6`, every budget shows **(a)** `structural-v1` retention (mean) at or above `age-horizon`, **(b)** `structural-v1` precision above `random`, and **(c)** `structural-v1` saturated events below 1.0 at 64k and 128k, meaning the structural rungs and the target stop actually decided something. The `protectLastTurns: 2` table is a sensitivity check, not part of the rule.

## Headline grid

### `protectLastTurns: 6`

| budget | retention mean: age-horizon | structural-v1 | random | retention pooled: age-horizon | structural-v1 | precision: random | structural-v1 | saturated: structural-v1 | rule |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 32000 | 0.479 | **0.480** | 0.485 | 0.426 | **0.426** | 0.947 | **0.953** | 0.963 | holds |
| 64000 | 0.582 | **0.590** | 0.603 | 0.522 | **0.526** | 0.960 | **0.962** | 0.922 | holds |
| 128000 | 0.788 | **0.812** | 0.798 | 0.745 | **0.741** | 0.980 | **0.979** | 0.856 | fails: (b) |

### `protectLastTurns: 2`

| budget | retention mean: age-horizon | structural-v1 | random | retention pooled: age-horizon | structural-v1 | precision: random | structural-v1 | saturated: structural-v1 | rule |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 32000 | 0.387 | **0.389** | 0.397 | 0.309 | **0.309** | 0.942 | **0.949** | 0.945 | holds |
| 64000 | 0.529 | **0.524** | 0.546 | 0.442 | **0.445** | 0.954 | **0.959** | 0.911 | fails: (a) |
| 128000 | 0.759 | **0.787** | 0.781 | 0.714 | **0.710** | 0.979 | **0.977** | 0.849 | fails: (b) |

## Reading the grid

At the shipped `protectLastTurns: 6` the rule holds at 32k and 64k and fails one cell at 128k: `structural-v1` precision 0.979 against random 0.980, a difference of one thousandth on the budget where its retention lead is largest (+0.024 over `age-horizon`, +0.014 over random). Retention (mean), the primary metric, is at or above `age-horizon` on all six cells of both tables except 64k at `protectLastTurns: 2` (0.524 vs 0.529). The default stays `structural-v1` on that basis, and the cell is recorded here rather than the rule being rewritten around it.

Two things the grid says that the rule did not ask about. First, random eviction to target retains more than either real policy at 32k and 64k (0.485 and 0.603 against 0.480 and 0.590 at `protectLastTurns: 6`); both real policies evict about 13 percent more tokens than random because `age-horizon` has no target stop and `structural-v1` runs rungs 1 to 5 whatever the pressure, and every extra eviction is a chance to lose a pair. Second, the retention metric counts every (result, later re-read) pair without asking whether a newer copy of the same file was still in the working set, so a `superseded_read` eviction is charged when the file is read a third time even though the model held the second copy. Both are follow-ups on #179: a cost model that decides whether rungs 1 to 5 should run below threshold, and a retention variant that credits a surviving newer copy.

Tables committed before `ca3f49b6` were produced with a loader that emitted one assistant entry per Claude Code JSONL record, three per message, and priced each with the per-message overhead; those numbers (0.831 / 0.781 / 0.779 at 128k) are superseded by this directory.

## Reproducing

```bash
node --import tsx src/cli/index.ts context replay \
  --sessions ~/.claude/projects/<project> \
  --policies none,random,age-horizon,structural-v1,oracle \
  --budgets 32000,64000,128000 --protect-last-turns 6 \
  --md benchmarks/results/context-replay/<name>.md --json benchmarks/results/context-replay/<name>.json
```

The matrix is deterministic for a given corpus, revision, and `--seed` (default 0). The 165-trace matrix takes roughly 35 minutes per `protectLastTurns` value on the operator machine; the two settings can run in parallel.
