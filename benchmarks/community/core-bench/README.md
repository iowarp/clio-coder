# CORE-Bench

CORE-Bench asks an agent to reproduce the published computational result of a
real paper. Each task is a Code Ocean capsule holding the paper's code and
data; the agent has to get it running and report the numbers the paper
reported, into `report.json`. That is close to a restatement of what Clio is
for, which is why it is here.

45 capsules in the scored `test` split and 45 more in the public `train` split,
with no overlap. Three gold runs per capsule, spanning Computer Science, Social
Sciences, and Medical Sciences, in Python and R.

## Data

```sh
uv run --no-project python benchmarks/community/core-bench/corebench_clio.py \
  ensure-data --split test
uv run --no-project python benchmarks/community/core-bench/corebench_clio.py \
  inspect-data --split test
```

Upstream ships the test split GPG-encrypted to slow contamination.
`ensure-data` downloads and decrypts it, which needs `gpg` on PATH.
`CORE_BENCH_GPG_PASSPHRASE` overrides the passphrase if upstream changes it.
Capsules are downloaded on demand from `corebench.cs.princeton.edu` into
`data/capsules/` and cached; they run from tens to hundreds of megabytes each.

## Difficulty levels

The level decides what the capsule contains when the agent starts, mirroring
upstream's preparation exactly.

| `--level` | `results/` | `REPRODUCING.md` and `environment/` | What the agent does |
| --- | --- | --- | --- |
| `easy` | kept | removed | reads the published outputs; executes nothing |
| `medium` | emptied | kept | follows written reproduction instructions |
| `hard` | emptied | removed | works out the environment from the README |

`hard` is the default and the headline setting.

## Run

```sh
uv run --no-project python benchmarks/community/core-bench/corebench_clio.py run \
  --target dynamo --model qwen3.8-27b --split test --level hard --limit 3 \
  --out benchmarks/community/core-bench/runs/hard-smoke
```

`--field` and `--language` are repeatable. The per-task Clio timeout defaults to
two hours because reproducing a capsule is a long agent run. `regrade` rescores
a finished run directory without calling a model again, which matters here more
than anywhere else in this tree: the reports are cheap to rescore and extremely
expensive to regenerate.

## Grading

Scoring reimplements upstream's `eval_result_json` exactly. A numeric answer is
correct when it falls inside the 95% prediction interval computed from the three
gold runs, which is how the benchmark absorbs the run-to-run variance of real
scientific code. List answers compare exactly; string answers compare
case-insensitively; a reported string that parses as a number, with or without a
percent sign, is coerced first. A task is resolved only when every question is
right.

The summary reports `questionAccuracy` beside `resolved`. On this suite the
per-question rate is the more informative number: a capsule with six questions
can be almost reproduced and still score zero at the task level.

The prompt asks for `report.json` beside the capsule. An agent that writes it
inside the capsule instead is still scored, and `reportsInsideCapsule` counts
those, so a formatting slip is visible rather than being charged as a
reproduction failure.

## Safety

Upstream isolates each agent run in a Docker container. This adapter runs Clio
in a prepared workspace on the host, because that is what the rest of this tree
does and because Clio's own tool policy is part of what is being measured.

At `easy` the agent only reads files. At `medium` and `hard` it is expected to
install software and run a stranger's scientific code. Run those levels inside
a container.
