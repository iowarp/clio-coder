# Clio model benchmark suite

This is the first Clio model-management benchmark harness. It sweeps configured targets/models and records how each model/config combo performs on the same practical coding/design task: read this repository and generate a single-file Clio Coder website in a gitignored run folder.

## Benchmark map

Clio currently has four benchmark tracks:

| Track | Harness | Measures | Run command | Output | Reproducibility |
|---|---|---|---|---|---|
| Model suite | `benchmarks/clio-model-suite.mjs` | Single-file coding/design quality across target/model/sampler settings | `npm run build`; `npm run bench:models -- --target mini --limit 3` | `.clio-benchmark/report.json`, per-run stdout/stderr/config/app.html | Provider-dependent. Deterministic prompt and static scorer, but model output is stochastic unless the runtime pins sampling. |
| Context engine | `benchmarks/bench-context.mjs` | Codewiki coverage, deterministic structural hash, digest size, scout-read token estimate, nav latency | `npm run build`; `node benchmarks/bench-context.mjs --baseline benchmarks/context-baseline-main.json` | JSON report, compared with `benchmarks/context-baseline-main.json` and `benchmarks/context-after.json` | High for local indexing metrics. It copies fixed repos and checks two indexing passes for identical structural hashes. |
| Community coding | `benchmarks/community-benchmarks/swe-bench-lite/` and `benchmarks/community-benchmarks/terminal-bench/` | Repo patch generation and container workflow solving | See `benchmarks/community-benchmarks/README.md` | SWE predictions/metrics JSONL; Terminal-Bench run directories | External dataset, Docker, and local fleet dependent. Historical v0.2.3 calibration is preserved in `community-benchmarks/MANIFEST.md`. |
| Science coding | `benchmarks/community-benchmarks/scicode/scicode_clio.py` plus local SciCode prompt corpus | Stepwise scientific Python synthesis with per-substep numeric grading | `python benchmarks/community-benchmarks/scicode/scicode_clio.py generate-tasks --out .clio-scicode/tasks.yaml --h5py-file /path/to/test_data.h5`; `clio eval run --task-file .clio-scicode/tasks.yaml` | Normal Clio eval artifact plus `scicode-grade.json` per problem | Adapter is wired. Faithful scoring is blocked until the official SciCode HDF5 target file and SciCode Python package are supplied externally. |

## Quick start

```sh
npm run build
node benchmarks/clio-model-suite.mjs --target mini --limit 3
# or
npm run bench:models -- --target mini --limit 3
```

Outputs land in `.clio-benchmark/`:

- `report.json` — sorted results and config metadata.
- one subdirectory per run with `config.json`, `stdout.txt`, `stderr.txt`, and expected `app.html`.

## Matrix

The default matrix is `benchmarks/model-matrix.default.json` and covers:

- thinking: `off`, `low`, `medium`
- sampling: catalog/default, precise, balanced
- context window metadata
- weight quantization metadata
- KV-cache quantization metadata

Clio applies model, thinking, and sampler overrides per request for supported local/OpenAI-compatible runtimes. Context and quantization fields are recorded as run metadata and should match the loaded server preset for that run. This keeps reports ready for q4/q5/q6/IQ/UD and f16-vs-q8 KV sweeps.

## Rubric

`clio-model-suite.mjs` statically scores each generated `app.html` out of 100:

- exists and valid HTML shell
- embedded CSS and responsive layout
- Clio/model/benchmark content coverage
- multiple semantic sections
- accessibility labels/alt/roles
- navigation
- visual polish
- no external network assets

The suite scores run `n-1` while run `n` is executing, then sorts the final report by score.

## Context bootstrap benchmark (`bench-context.mjs`)

`bench-context.mjs` measures the Stage 1 context engine, not a model. It copies a corpus
of real repositories into temp directories and, for each one, runs `clio context-index`
twice, runs `clio context-init --heuristic`, and records coverage, determinism, digest
size, an end-to-end scout-read estimate, codewiki quality, and local nav latency.

```sh
npm run build
node benchmarks/bench-context.mjs --baseline benchmarks/context-baseline-main.json
```

`--baseline <report.json>` recomputes before/after deltas against a recorded run, so the
pre-context-engine numbers in `context-baseline-main.json` stay reproducible without
rebuilding the old CLI. Pass `--before <cli.js>` instead to measure a live before/after.
Tracked records: `context-baseline-main.json` (main, before the engine) and
`context-after.json` (current).

### Determinism, coverage, quality

On the current corpus every repository indexes at 100% coverage with the correct language
detected, and the structural hash is identical across the two indexing passes. The
recorded baseline on `main` detected `language: unknown` and indexed 0 files on all six
repositories, so the engine moved every repo from no structural grounding to full
coverage. The three small quality repos (rendergit, quipslop, mac-mini-agent) each score
3/3 on the heuristic-handbook rubric, up from 2/1/1 on the baseline.

### Token accounting: read this honestly

The `promptTokens` column counts the bootstrap payload, and that payload now includes the
bounded codewiki digest. So the delta versus the no-index baseline is positive on every
repo. That is the digest being added to the prompt, not a regression, and it is not a
token reduction. The baseline indexed nothing, so a baseline agent pays for grounding the
other way: it reads files ad hoc at runtime, a cost the bootstrap payload never counts.

The `scout` block estimates that displaced cost. It compares the digest against the tokens
an un-indexed agent would spend reading the entry-point files, and against reading the
whole source tree, to reach the same structural picture the digest already contains:

| repo | lang | files | digest tok | entry-file reads | full-source reads | digest vs full |
|------|------|-------|-----------|------------------|-------------------|----------------|
| rendergit | python | 1 | 415 | 4,342 | 4,342 | 9.6% |
| quipslop | typescript | 12 | 586 | 23,833 | 46,070 | 1.3% |
| mac-mini-agent | python | 17 | 901 | 1,362 | 8,839 | 10.2% |
| clio-coder | typescript | 584 | 1,195 | 12,655 | 1,034,154 | 0.1% |
| once | go | 146 | 1,205 | 656 | 139,157 | 0.9% |
| opentui | typescript | 676 | 1,204 | 21,692 | 1,969,137 | 0.1% |

For five of six repos the digest is a small fraction of even reading just the entry files,
and a tiny fraction of reading the whole tree. The honest exception is `once`: its Go entry
files total only 656 tokens, less than the ~1.2k digest, so for that repo the bounded
digest costs more than reading the handful of entry files. The digest still buys what those
656 tokens do not: every one of the 146 files, all symbols, and the full import graph, at a
fixed cost.

The conclusion is not "fewer tokens." It is bounded, deterministic grounding with full
structural coverage at a digest cost that stays near 1.2k tokens even for a 676-file repo,
in place of unbounded ad-hoc reads against an empty index.

## SciCode science benchmark

The local `benchmarks/data/science-problems/` folder is the SciCode prompt corpus from
Tian et al. It is ignored by git except for its manifest because the official target
outputs are a separate artifact. Verified upstream sources:

- GitHub: `scicode-bench/SciCode`, Apache-2.0.
- Hugging Face: `SciCode1/SciCode`, revision `4510f6a6aa27c43fad7b43da2c59602a86e88480`, Apache-2.0.
- Official scoring: execute generated Python per sub-step with `target` values loaded
  from `eval/data/test_data.h5`; a main problem passes only when every sub-step passes.

Adapter commands:

```sh
python benchmarks/community-benchmarks/scicode/scicode_clio.py inspect-data \
  --data benchmarks/data/science-problems/problems_all.jsonl

python benchmarks/community-benchmarks/scicode/scicode_clio.py generate-tasks \
  --data benchmarks/data/science-problems/problems_all.jsonl \
  --h5py-file /path/to/test_data.h5 \
  --out .clio-scicode/tasks.yaml \
  --limit 3

clio eval run --task-file .clio-scicode/tasks.yaml
```

Without `test_data.h5` or a small JSON target manifest, `grade-problem` exits with
`DATA_BLOCKED` semantics and the generated Clio eval task fails honestly. Do not commit
the HDF5 target file into this repository; mount or fetch it by checksum for official runs.
