# Prompt A/B optimization harness

A **development instrument**. Nothing here ships.

`scripts/` is absent from the `package.json` `files` allowlist, so this tree
never enters the npm tarball, `dist/`, the CLI, or any runtime code path. There
is no shipped prompt-ab system, no runtime prompt variant, no feature flag, no
experiment registry, and no candidate selector. The deliverable of an
optimization round is the *winning minimal prompt and descriptor edits*, applied
to `src/` as ordinary production commits; losing variants are discarded and the
harness stays here.

Verify the exclusion at any time:

```
npm pack --dry-run --ignore-scripts --json | node -e 'const f=JSON.parse(require("fs").readFileSync(0,"utf8"))[0].files.map(x=>x.path); console.log(f.filter(p=>p.startsWith("scripts/")).length)'
```

It must print `0`.

## What it measures

Two independently built Clio checkouts (arms) run the same frozen scenarios
against the same pinned Dynamo target, and the harness reports paired
differences under deterministic hard gates. It reuses the eval domain's
`EvalServingConfigurationV1` contract for serving identity rather than inventing
a second vocabulary for the same facts.

Design properties, and where each lives:

| Property | File |
|---|---|
| Balanced seeded AB/BA blocks, reproducible from the seed | `schedule.ts` |
| Arm build / prompt-fragment / tool-catalog hashes, identical-arm refusal | `arms.ts` |
| Fresh isolated `CLIO_CODER_*` home and workspace per trial | `isolation.ts` |
| Deterministic hard-gate scoring, fail-closed on unresolved reads | `scoring.ts` |
| Append-only JSONL records, resume, foreign-experiment refusal | `records.ts` |
| Serving-drift refusal, paired comparison, McNemar, promotion gates | `analyze.ts` |
| Eight development families | `corpus-development.ts` |
| Ten frozen holdout families, locked behind a freeze record | `corpus-holdout.ts` |

Cold and warm strata are measured separately and never pooled: a cold trial is
the first request after a cache reset, a warm trial replays a fixed prefix and
varies only the final turn.

## Holdout isolation

`holdoutCorpus()` cannot be called without a `PromptAbFreezeRecordV1` that pins
the arms' build, prompt-fragment, and tool-catalog hashes. An arm whose prompt
moved after the freeze is refused by name ("post-hoc prompt edit"). During
`phase: "tuning"` the holdout corpus is unreachable at all, so a tuning run
cannot even learn how many holdout scenarios exist.

## Running it

```sh
# Build two independent arms first (each in its own checkout).
git worktree add --detach /tmp/clio-ab-arm-a <baseline-sha>
git worktree add --detach /tmp/clio-ab-arm-b <candidate-sha>
ln -s "$PWD/node_modules" /tmp/clio-ab-arm-a/node_modules   # and arm-b
(cd /tmp/clio-ab-arm-a && npm run build)
(cd /tmp/clio-ab-arm-b && npm run build)

# Plan only. Never touches a model.
node --import tsx scripts/prompt-optimization/run.ts plan \
  --config scripts/prompt-optimization/experiment.dynamo-qwen38-27b.json

# Execute. Requires --live; the default is a dry run.
node --import tsx scripts/prompt-optimization/run.ts run --live \
  --config scripts/prompt-optimization/experiment.dynamo-qwen38-27b.json

# Paired comparison + blinded review export.
node --import tsx scripts/prompt-optimization/run.ts compare \
  --config scripts/prompt-optimization/experiment.dynamo-qwen38-27b.json

# Freeze the arms, then run the holdouts with corpus/phase switched to holdout/frozen.
node --import tsx scripts/prompt-optimization/run.ts freeze --note "B stable" \
  --config scripts/prompt-optimization/experiment.dynamo-qwen38-27b.json

# Promotion gates.
node --import tsx scripts/prompt-optimization/run.ts promote \
  --config scripts/prompt-optimization/experiment.dynamo-qwen38-27b.json
```

`run` is resumable: interrupt it and re-run the same command. The plan is
recomputed from the seed and already-recorded trial ids are skipped.

## Tests

Offline, deterministic, no model and no network:

```sh
npm run test:file -- scripts/prompt-optimization/tests/harness.test.ts
```

They live here rather than in `tests/contracts/` deliberately: that keeps a
development instrument out of the ordinary `npm test` glob and out of the
release gate, as well as out of the tarball.

## What the hard gates will and will not decide

A hard gate reads a bounded, counted observation: tool calls by origin, mutated
paths, forbidden state, skills loaded, receipt fields, a regex over the final
answer. Whether a change was *good* is never a hard gate — those are the
per-scenario `reviewQuestions`, exported arm-blinded by `compare`.

An invariant whose input the observation does not carry is a hard **failure**,
not a pass. An uncollected metric is indistinguishable from a collected metric
that is fine, so the harness refuses to guess.
