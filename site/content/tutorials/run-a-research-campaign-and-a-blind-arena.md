You changed some code and it feels faster, or one model's answer looks better than another's. CLIO Coder has two commands that replace that impression with a record. `clio-coder research` keeps a change only when a measurement shows a real gain and every correctness check still passes. `clio-coder arena` shows you answers from several models without their names, and records your vote.

::: note Version scope
This guide describes v0.8.1. The output below comes from one recorded session on a small Python project. The campaign's agent ran on Claude Haiku 5.5 through the `anthropic-max` route, and the arena put Claude Haiku 5.5 against GPT-6 Luna on the `openai-codex` route. One match is enough to learn both commands. It is not enough to rank models, and the arena section shows why.
:::

::: needs
- CLIO Coder installed, with a connected model.
- A Git repository with a check that prints a number as JSON, and a second check that proves the answers are still right.
- Whatever the checks need installed before you start. The agent cannot install it during the campaign.
:::

## Declare what to measure and what must not break

The project here has a `summary()` function that returns a mean, a median and a variance. It is correct and slow. `bench.py` times it on 3000 values and prints `{"wall_ms": ...}`. `check.py` prints the answers for a holdout input, and `tests/reference/stats.json` holds the expected values.

```yaml title=.clio-coder/verifiers.yaml
version: 2
checks:
  - id: bench
    description: Wall time of summary() on 3000 values (min is better)
    tags: [perf]
    kind: command
    command: [python3, bench.py]
    cwd: .
    timeoutMs: 60000
  - id: correct
    description: summary() answers match the reference on a holdout input
    tags: [correctness]
    kind: numeric-compare
    command: [python3, check.py]
    reference: tests/reference/stats.json
    tolerance: { relative: 1.0e-9 }
    cwd: .
    timeoutMs: 60000
```

Every check needs `id`, `description`, `command`, `cwd`, `timeoutMs` and `tags`; an empty `tags: []` is allowed. Commit the catalog and every file the checks run or name. Each campaign worktree starts from `HEAD`, so an uncommitted `bench.py` or reference file is not there.

Keep build output such as `__pycache__/` out of Git: a tracked `.pyc` rewritten by a check run counts as a change outside `--scope`, and the iteration is archived without being measured.

The tolerance is your definition of the same answer. Here, a relative difference up to one part in a billion still passes.

## Run a short campaign

```sh
clio-coder research start --check bench --metric wall_ms --direction min \
  --max-iterations 2 --gate correct --scope stats.py --max-wall-minutes 25 \
  --goal "make stats.py faster without changing any answer"
```

`--scope` limits which files the agent may change, and an iteration that changes anything outside it is archived without being measured. The checks and every file they name are protected the same way, so the agent cannot speed up the benchmark by editing it.

::: result What the recorded session printed
```text
campaign r20261114-233756-1d28 (stopped: max-iterations)
objective: min wall_ms from check bench; min improvement +5.00%, 5 pairs
gates: correct; scope: stats.py
protected: .clio-coder/verifiers.yaml, bench.py, check.py, tests/reference/stats.json
agent: autonomy default
branch: clio/research/r20261114-233756-1d28 at f94cd0f0c1dc (base f68a37ce7951, 2 ratchets)
budget: 2/2 iterations, 25 min wall; spend ~$0.0032 est
A/A: quiet; unchanged, median delta +0.55%, 95% CI [-8.30%, +4.42%]
  it-0001  ratcheted; improved, median delta -57.05%, 95% CI [-57.83%, -55.97%]; gates correct pass; cost ~$0.0018 est
  it-0002  ratcheted; improved, median delta -99.44%, 95% CI [-99.45%, -99.38%]; gates correct pass; cost ~$0.0014 est
stopped: max-iterations: ran 2 of 2 iterations
```
:::

## Read the result line by line

Start with the A/A line. Before any change, CLIO Coder timed the unchanged code against itself in five interleaved pairs. The medians moved 0.55%, and the 95% interval spans zero, so the noise stayed under the 5% threshold. If the base against itself already looked like a change, the campaign would have stopped there unless you passed `--allow-noisy`.

Each iteration counts as improved only when the median moves at least 5% the right way and the bootstrap interval excludes zero. The first iteration cut the time by 57.05%. The second, measured against the first iteration's commit, removed almost all of what was left. Both passed the `correct` gate.

`~$0.0032 est` is an estimate, marked as one. The `anthropic-max` route is a subscription, so CLIO Coder priced its tokens from its catalog instead of a bill.

On a route with no price at all, such as a gateway target without `targets[].pricing`, the line reads `spend not measured`, because CLIO Coder does not count unknown spend as zero. With `--max-cost-usd` on such a route, the campaign stops as `budget-unenforceable` unless you also pass `--allow-unpriced`.

## Audit it and take the change

```sh
clio-coder research report r20261114-233756-1d28
git diff HEAD clio/research/r20261114-233756-1d28
```

`report` regrades the A/A check and every iteration from the stored samples with the recorded seed. In the recorded session each line ended `agrees with the journal`, and the command exited 0. It exits 1 when a grade disagrees.

The result lives on the branch `clio/research/<id>`, and your checkout is never touched. Here the branch replaced an insertion sort with `sorted()` and stopped `variance` from recomputing the mean for every element. Review the diff and merge it yourself.

## Compare answers blind

```sh
clio-coder arena run --suite speed --check correct \
  --contender anthropic-max/claude-haiku-5-5 --contender openai-codex/gpt-6-luna \
  -- "Make summary() in stats.py faster without changing any answer. Keep the change minimal."
```

A contender is `<target>/<model>`. Each one runs as a normal `clio-coder run` in its own worktree from `HEAD`, and `--check` runs the named check on each result. Naming the same model twice instead makes an A/A match, which shows how much two runs of one model differ before you read anything into a difference between two models.

To name your own contenders, `clio-coder targets` lists each target id with its model, a local server's target included.

::: compare
| | Contender A | Contender B |
| --- | --- | --- |
| Change | `variance` reuses the mean it already computed | The same edit, line for line |
| Diff | `+1 -5` | `+1 -5` |
| `correct` check | Pass, every answer bit-identical | Pass, every answer bit-identical |
| Work shown | 10 turns, 13 tool calls | 4 turns, 5 tool calls |
| Its own timing claim | `correct` and `bench` checks passed | Speed not measured, said so |
:::

Both contenders made the same edit and both left the quadratic insertion sort alone, citing the minimal-change instruction. What separated them was how they reported: one claimed a passing benchmark, the other said plainly that it had not timed anything.

## Vote, then reveal

```sh
clio-coder arena show 20261114-233756-7102
clio-coder arena vote 20261114-233756-7102 tie --note "same one-line fix, both exact; B said up front it did not time it"
clio-coder arena show 20261114-233756-7102 --reveal
clio-coder arena standings --suite speed
```

Before a vote, `show` lists A and B in a seeded random order and hides the target, model, duration, tokens and cost. `--reveal` before a vote is refused. CLIO Coder never grades a contender; the vote is yours, and so is the note.

::: result What the recorded session printed
```text
recorded tie for match 20261114-233756-7102; arena show 20261114-233756-7102 reveals who is who
```

The reveal named the contenders:

```text
   A = openai-codex/gpt-6-luna  22.5s  tokens 77.4k  cost ~$0.0020 est  session 31viz4dfrb0k
   B = anthropic-max/claude-haiku-5-5  10.3s  tokens 51.7k  cost ~$0.0019 est  session 36ja80a9wg03
```

`standings` then printed:

```text
TARGET/MODEL                    VOTES  WINS  LOSSES  TIES  BOTH-BAD  ELO
anthropic-max/claude-haiku-5-5  1      0     0       1     0         n/a (<5 votes)
openai-codex/gpt-6-luna         1      0     0       1     0         n/a (<5 votes)

1 voted of 1 matches in suite speed. These are your recorded votes; Clio does not judge.
```
:::

That is the inconclusive result, reported as it is. Two models gave the same code, and one tie says nothing about either. A rating appears once a model has 5 votes, and one vote is one person's judgment on one prompt. A match that pits a model against itself is never counted in standings.

::: limits
- A campaign is only as good as its checks. A benchmark that measures the wrong thing will be optimized anyway.
- The `correct` gate checks one holdout input. Iteration answers that pass it can still differ elsewhere.
- Research runs one candidate per iteration and optimizes one number at a time.
- A single vote is an anecdote. Standings mean something only after many matches with different contenders.
:::

::: next
- [Work from a laptop with remote workers](/tutorials/work-from-a-laptop-with-remote-workers.html)
- [Research campaigns and the arena](/docs/guide/research-and-arena.html)
- [Check a change against your repository](/tutorials/check-a-change-against-your-repository.html)
- [Pre-register a benchmark](/tutorials/pre-register-a-benchmark.html)
:::
