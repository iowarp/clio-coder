# MultiPL-E

MultiPL-E translates HumanEval and MBPP into other programming languages by
compiling their prompts, doctests, and unit tests through per-language
translators. Every other suite in this tree is Python. This one is the reason a
report can say anything about the languages scientific and HPC code is actually
written in.

This adapter supports C++, Rust, and Julia. Adding another of MultiPL-E's
languages is a row in `LANGUAGES` plus its build and run commands.

| Language | `--language` | Tasks (humaneval) | Toolchain | Override |
| --- | --- | --- | --- | --- |
| C++ | `cpp` | 161 | `g++` | `CXX` |
| Rust | `rs` | 156 | `rustc` | `RUSTC` |
| Julia | `jl` | 159 | `julia` | `JULIA` |

MultiPL-E's C++ prompts include `<bits/stdc++.h>`, which is a GCC header. A
`clang++` toolchain needs it supplied separately.

## Data

```sh
uv run --no-project python benchmarks/community/multipl-e/multiple_clio.py \
  ensure-data --language cpp
uv run --no-project python benchmarks/community/multipl-e/multiple_clio.py \
  inspect-data --language cpp
```

`inspect-data` reports whether the language's toolchain is on PATH, so a
missing compiler is found before a campaign spends model time. `--benchmark`
selects `humaneval` or `mbpp`.

## Run

```sh
uv run --no-project python benchmarks/community/multipl-e/multiple_clio.py run \
  --target dynamo --model qwen3.8-27b --language cpp --limit 20 \
  --out benchmarks/community/multipl-e/runs/cpp-smoke
```

A missing toolchain blocks the run before the first model call rather than
failing task by task. `regrade` rescores a finished run directory without
calling a model again, which is what makes a toolchain upgrade cheap to
evaluate.

## Task contract

The agent gets `solution.<ext>` seeded with the signature and its
documentation, and completes the implementation. A task is graded by
concatenating the prompt, the completion, and the task's own test block, then
compiling and running the result. A non-zero exit is a failure, exactly as
upstream treats it.

Completions are truncated at the language's `stop_tokens` before grading, which
is what upstream does. That truncation is also what lets an agent write a whole
function naturally in C++ and Rust, where the test block supplies the closing
brace: a completion that closes the function is cut back at `\n}`, and the test
block closes it instead of the program carrying two. Julia's test block does
not close the function, so a Julia completion writes its own `end`. Which
languages behave which way is read from the data rather than hardcoded, so a
newly added language cannot get it silently wrong.

## Reading the score

`buildFailures` and `runFailures` are reported separately in the summary. In a
compiled language that distinction is the whole point: a build failure means
the model cannot write the language, and a run failure means it wrote the wrong
algorithm. Folding them together hides which problem a target actually has.

## Safety

Grading compiles and runs model-generated native code with no sandbox of its
own. Run this adapter in a container for untrusted models or prompts.
