## Improve a number, and keep only real gains

`clio-coder research start` runs Clio Coder's agent repeatedly to move one measured number in your project, such as the wall time of a benchmark. The number is a key in the JSON that a check in `.clio-coder/verifiers.yaml` prints. Correctness checks run as gates.

```yaml
version: 2
checks:
  - id: bench
    kind: command
    command: [python3, bench.py]   # prints {"wall_ms": 12.3}
  - id: correct
    kind: numeric-compare
    command: [python3, check.py]
    reference: tests/reference/stats.json
```

Commit this file so every research worktree contains it.

```bash
clio-coder research start --check bench --metric wall_ms --direction min \
  --max-iterations 5 --gate correct --scope stats.py --max-wall-minutes 30
```

Each attempt runs in its own Git worktree. Before the first attempt, an A/A check measures the base against itself and refuses a noisy measurement. A change is kept only when it clears both measurement tests and every gate passes:

- **Measurement:** across interleaved trials, the median improves by at least 5% and a seeded bootstrap interval excludes zero.
- **Gates:** every gate check passes in the change's worktree.

Kept changes go to the branch `clio/research/<id>`; your own branch is never touched. Unknown spend never counts as zero. `clio-coder research report <id>` regrades every verdict from the stored samples.

## Budgets and stopping

| Flag | Effect |
| --- | --- |
| `--max-iterations <N>` | Required hard stop on iterations |
| `--max-wall-minutes <M>` | Deadline that also ends the step in flight |
| `--max-cost-usd <X>` | Spend cap; an unpriced run stops the campaign unless you pass `--allow-unpriced` |
| `--min-improvement <frac>` | Relative gain to clear; default 0.05 |
| `--trials <N>` | Interleaved base and candidate pairs; default 5 |

## Where results go

Campaigns live in `.clio-coder/research/<id>/` and arena matches in `.clio-coder/arena/<match-id>/`. Check progress with `clio-coder research status` or `research list`.

| Exit code | `research start` |
| --- | --- |
| 0 | A budget cap ended the campaign |
| 1 | An error, a noisy A/A check, or unenforceable spend |
| 2 | Usage error |
| 130, 143, 129 | Stopped by Ctrl-C, SIGTERM, or SIGHUP |

## Compare models blind

`clio-coder arena run` gives one prompt to 2 to 4 target/model pairs, each in its own worktree. `arena show` hides which model produced which answer until you vote with `arena vote`. `arena standings` counts the votes and adds an Elo rating once a model has 5 votes. Clio never grades a contender. The desktop app's Arena page runs the same commands.

```sh
clio-coder arena run --check unit \
  --contender copilot/claude-haiku-5.5 --contender litellm/mini/qwen3.8-27b-iq4r-v4 \
  -- "Fix the bug in calc.py so test_calc.py passes."
clio-coder arena show <match-id>
clio-coder arena vote <match-id> A --note "smaller diff"
clio-coder arena show <match-id> --reveal
```

Before a vote, `show` hides each target, model, cost, and duration, and `--reveal` is refused. Vote with a label, `tie`, or `both-bad`; `--replace` changes your vote.

Research and the arena are new in 0.7.0. With `--autonomy yolo` both run contained yolo: the sandbox, the safety judge, and your autonomous caps stay on, and unconfined yolo is refused. `clio-coder research resume <id>` continues a stopped campaign from its journal with the same spec and budget.
