## Improve a number, and keep only real gains

`clio-coder research start` runs Clio Coder's agent repeatedly to move one measured number in your project, such as the wall time of a benchmark. The number is a key in the JSON that a check in `.clio-coder/verifiers.yaml` prints. Correctness checks run as gates.

```bash
clio-coder research start --check bench --metric wall_ms --direction min \
  --max-iterations 5 --gate correct --scope stats.py --max-wall-minutes 30
```

Each attempt runs in its own Git worktree. Before the first attempt, an A/A check measures the base against itself and refuses a noisy measurement. A change is kept only when it clears both measurement tests and every gate passes:

- **Measurement:** across interleaved trials, the median improves by at least 5% and a seeded bootstrap interval excludes zero.
- **Gates:** every gate check passes in the change's worktree.

Kept changes go to the branch `clio/research/<id>`; your own branch is never touched. Unknown spend never counts as zero. `clio-coder research report <id>` regrades every verdict from the stored samples.

## Compare models blind

`clio-coder arena run` gives one prompt to 2 to 4 target/model pairs, each in its own worktree. `arena show` hides which model produced which answer until you vote with `arena vote`. `arena standings` counts the votes and adds a Elo rating once a model has 5 votes. Clio never grades a contender. The desktop app's Arena page runs the same commands.

Research and the arena are new in 0.7.0. Neither runs at autonomy `yolo`, and a stopped campaign cannot be resumed yet.
