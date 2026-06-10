# Clio model benchmark suite

This is the first Clio model-management benchmark harness. It sweeps configured targets/models and records how each model/config combo performs on the same practical coding/design task: read this repository and generate a single-file Clio Coder website in a gitignored run folder.

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
