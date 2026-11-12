You changed some code and it feels faster, or one model's answer looks better than another's. CLIO Coder has two commands that replace that impression with a record. `clio-coder research` keeps a change only when a measurement shows a real gain and every correctness check still passes. `clio-coder arena` shows you answers from several models without their names, and records your vote.

::: note Version scope
This guide describes v0.8.0. The output below comes from one recorded session with a single model, Qwen 3.8 27B, on a small Python project. One model is enough to learn both commands. It is not enough to rank models, and the arena section shows why.
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
campaign r20261112-192812-1d5d (stopped: max-iterations)
objective: min wall_ms from check bench; min improvement +5.00%, 5 pairs
gates: correct; scope: stats.py
protected: .clio-coder/verifiers.yaml, bench.py, check.py, tests/reference/stats.json
agent: autonomy default
branch: clio/research/r20261112-192812-1d5d at 37407c7dee9e (base 39930e6fbfbf, 2 ratchets)
budget: 2/2 iterations, 25 min wall; spend not measured; 2 run(s) had unknown spend
A/A: quiet; unchanged, median delta +4.04%, 95% CI [-0.96%, +6.93%]
  it-0001  ratcheted; improved, median delta -99.74%, 95% CI [-99.76%, -99.71%]; gates correct pass; cost unknown
  it-0002  ratcheted; improved, median delta -17.69%, 95% CI [-27.80%, -12.04%]; gates correct pass; cost unknown
stopped: max-iterations: ran 2 of 2 iterations
```
:::

## Read the result line by line

Start with the A/A line. Before any change, CLIO Coder timed the unchanged code against itself in five interleaved pairs. The medians moved 4.04%, and the 95% interval spans zero, so the noise stayed under the 5% threshold. If the base against itself already looked like a change, the campaign would have stopped there unless you passed `--allow-noisy`.

Each iteration counts as improved only when the median moves at least 5% the right way and the bootstrap interval excludes zero. The first iteration removed almost all the time. The second found a further 17.69%, a gain that would be invisible by eye. Both passed the `correct` gate.

`spend not measured` is honest. This model was reached through a gateway with no price, so CLIO Coder cannot know what the runs cost, and it does not count unknown spend as zero. With `--max-cost-usd` on such a route, the campaign stops as `budget-unenforceable` unless you also pass `--allow-unpriced`.

## Audit it and take the change

```sh
clio-coder research report r20261112-192812-1d5d
git diff HEAD clio/research/r20261112-192812-1d5d
```

`report` regrades the A/A check and every iteration from the stored samples with the recorded seed. In the recorded session each line ended `agrees with the journal`, and the command exited 0. It exits 1 when a grade disagrees.

The result lives on the branch `clio/research/<id>`, and your checkout is never touched. Here the branch replaced an insertion sort with `sorted()`, stopped `variance` from recomputing the mean for every element, and used `sum()` for the mean. Review the diff and merge it yourself.

## Compare answers blind

```sh
clio-coder arena run --suite speed --check correct \
  --contender litellm/qwen3.8-27b --contender litellm/qwen3.8-27b \
  -- "Make summary() in stats.py faster without changing any answer. Keep the change minimal."
```

A contender is `<target>/<model>`. Each one runs as a normal `clio-coder run` in its own worktree from `HEAD`, and `--check` runs the named check on each result. Naming the same model twice is an A/A match: it shows how much two runs of one model differ before you read anything into a difference between two models.

To name your own contenders, `clio-coder targets` lists each target id with its model, a local server's target included.

::: compare
| | Contender A | Contender B |
| --- | --- | --- |
| Change | One line: `variance` reuses the mean it already computed | Two edits: the same fix, and `sorted()` for the median |
| Diff | `+1 -1` | `+2 -7` |
| `correct` check | Pass, every answer bit-identical | Pass, every answer bit-identical |
| Its own timing claim | 155 ms to 69 ms | 176 ms to 0.465 ms |
:::

One model, one prompt and one starting commit gave two different readings of "keep the change minimal". That spread is the noise any model comparison has to beat.

## Vote, then reveal

```sh
clio-coder arena show 20261112-193135-2727
clio-coder arena vote 20261112-193135-2727 B --note "both exact; B removes the quadratic sort too, still a small diff"
clio-coder arena show 20261112-193135-2727 --reveal
clio-coder arena standings --suite speed
```

Before a vote, `show` lists A and B in a seeded random order and hides the target, model, duration, tokens and cost. `--reveal` before a vote is refused. CLIO Coder never grades a contender; the vote is yours, and so is the note.

::: result What the recorded session printed
```text
recorded B for match 20261112-193135-2727; arena show 20261112-193135-2727 reveals who is who
```

After the reveal, `standings` printed:

```text
no voted matches yet (1 recorded)
```
:::

That is the inconclusive result, reported as it is. A match that pits a model against itself says nothing about the model, so standings skip it. To rank models, run matches with two or more different contenders. A rating appears once a model has 5 votes, and one vote is one person's judgment on one prompt.

::: limits
- A campaign is only as good as its checks. A benchmark that measures the wrong thing will be optimized anyway.
- The `correct` gate checks one holdout input. Iteration answers that pass it can still differ elsewhere.
- Research runs one candidate per iteration and optimizes one number at a time.
- A single vote, and a single A/A match, are anecdotes. Standings mean something only after many matches with different contenders.
:::

::: next
- [Work from a laptop with remote workers](/tutorials/work-from-a-laptop-with-remote-workers.html)
- [Research campaigns and the arena](/docs/guide/research-and-arena.html)
- [Check a change against your repository](/tutorials/check-a-change-against-your-repository.html)
- [Pre-register a benchmark](/tutorials/pre-register-a-benchmark.html)
:::
