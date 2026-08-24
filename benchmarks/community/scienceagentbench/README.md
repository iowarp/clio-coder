# ScienceAgentBench

102 data-driven discovery tasks extracted from 44 peer-reviewed publications and
validated by subject-matter experts, across Bioinformatics (27), Geographical
Information Science (27), Psychology and Cognitive Science (28), and
Computational Chemistry (20). The agent writes one self-contained Python program
that reads the task's dataset and saves a specified output file. The program is
then executed and its output is scored by the task's own evaluation program.

## Data

The benchmark is split in two on purpose. The annotation sheet is public and
carries everything an agent needs. The datasets, gold programs, and evaluation
programs are withheld from Hugging Face to slow contamination, and upstream asks
that the unzipped files not be redistributed.

```sh
uv run --no-project python \
  benchmarks/community/scienceagentbench/scienceagentbench_clio.py ensure-data
```

That fetches the public sheet and then tells you whether the private half is in
place. To supply it: download `benchmark_verified.zip` from the
[project page](https://osu-nlp-group.github.io/ScienceAgentBench/), unzip it
with the password `scienceagentbench`, and put its `benchmark/` directory at
`benchmarks/community/scienceagentbench/data/benchmark`, or point
`--benchmark-dir` at it. `SCIENCEAGENTBENCH_BENCHMARK_DIR` does the same through
the environment.

`inspect-data` reports how many task datasets actually resolve against that
directory, so a partial unzip is caught before a campaign spends model time.
A run without the artifacts stops with a message naming the download, the
password, and the destination. `--dry-run` still works without them, because it
only renders prompts and lays out workspaces.

## Run

```sh
uv run --no-project python \
  benchmarks/community/scienceagentbench/scienceagentbench_clio.py run \
  --target dynamo --model qwen3.8-27b --domain Bioinformatics --limit 5 \
  --out benchmarks/community/scienceagentbench/runs/bioinfo-smoke
```

`--domain` is repeatable. `regrade` rescores a finished run directory without
calling a model again.

## Task contract

Each workspace holds a real copy of only that task's dataset under
`benchmark/datasets/`, plus empty `pred_programs/` and `pred_results/`
directories and a `dataset.md` describing the layout. The copy is deliberate:
a symlink into the withheld benchmark tree would provide a path to sibling
datasets and evaluator source. The agent writes
`pred_programs/pred_<gold_program_name>`, which is run as a module from the
workspace root and must save the task's `output_fname`.

Grading first executes the generated program in a fresh directory containing
only the declared task dataset. After that process exits and produces a regular
output file, the adapter copies the output to a second fresh directory and only
then exposes the upstream evaluation programs to the scorer. Gold programs and
evaluator source are therefore absent both while the agent is solving and while
its generated program is running.

Grading dependencies are resolved from the imports of the generated program and
the evaluation program, then handed to uv, which gives each task its own
environment without a conda install. Upstream does the same thing with pipreqs
and pip-compile. `--with` pins the environment for a comparable campaign and
replaces the derived set.

## Reading the score

Two numbers come out and they are not the same claim.

- `validExecutionRate` counts programs that ran to completion and wrote the file
  they were asked to write.
- `resolved` counts programs whose output the evaluation program accepted.

The gap between them is the difference between code that runs and science that
is right, and it is the interesting number on this suite.

`canaryHits` counts generated programs containing upstream's canary string. That
string appears only in the gold programs, so a hit means the answer was not
derived. Investigate rather than report the score.

CodeBERTScore is part of upstream's reported triple and is not computed here. It
is a soft similarity score against the gold program that needs a model download,
and it is not the headline metric.

## Safety

Grading executes model-generated Python against real scientific libraries. Run
this adapter in a container or other sandbox for untrusted models or prompts.
