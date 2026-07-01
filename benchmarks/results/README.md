# Benchmark results and tracked artifacts

This directory is the committed home for benchmark **baseline** artifacts: the
small, curated JSON records a run is compared against. Everything else a run
produces is ephemeral and gitignored.

## Tracked (commit these)

- **Baselines** placed here, e.g. a recorded `bench-context` report used with
  `--baseline`, or a model-suite reference report. Keep them small and name them
  by track + provenance (e.g. `context-<branch>-<date>.json`).
- **Manifests and configs** that define a run (these live next to their track,
  not here): `benchmarks/context-corpus.json`, `benchmarks/model-matrix.*.json`,
  `benchmarks/community-benchmarks/fleet.json`.

The two historical context-engine baselines predate this convention and stay at
the `benchmarks/` root because their recorded artifacts reference each other by
that path: `context-baseline-main.json` (main, before the context engine) and
`context-after.json` (current). New baselines should land here.

## Untracked (gitignored, regenerated per run)

- `benchmarks/.clio-benchmark/` — model-suite and context-engine run outputs.
- `benchmarks/.corpus-cache/` — repos cloned from `context-corpus.json`.
- `benchmarks/.clio-scicode/` — SciCode per-problem run dirs.
- `benchmarks/community-benchmarks/runs/` — SWE-bench / Terminal-Bench outputs.
- Live-track capture dirs passed to `bench:turns --capture-dir`.
