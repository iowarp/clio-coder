# Reference evals

These are maintained, source-checkout inputs for Clio's production evaluation
engine. They are excluded from the npm package. Results, temporary workspaces
and local campaigns belong outside this directory.

## One engine, three kinds of inputs

| Inputs | What they measure | Execution |
| --- | --- | --- |
| `behavioral-machinery.yaml` | Production dispatch admission, prompt compilation, result contracts and receipt sealing with scripted workers | Offline, model-free; shared `tests/harness` isolation and dispatch fixtures |
| `behavioral-model.yaml`, negative control, `tool-surface-model.yaml` | Observed model behavior through the real Clio runner and event stream | Explicit model requests; pass your configured `--target` and optional `--model` |
| `tool-bench/` | Production tool registry execution, behavior digests, admission decisions and resource measurements for edit, read, write, grep, find and bash | Offline; default correctness in contract tests, large profiles explicitly invoked |
| `tracked-metrics-suite.yaml` | Ten coding tasks against a fixed historical source revision | Explicit model requests; Git clone and pnpm dependency setup per fresh workspace |
| `scalar-decision-machinery.ts` and its Python grader | Decision/commit attribution with a NumPy scalar fixture | Optional offline integration run with an existing Python + NumPy interpreter |

`src/domains/eval` owns suite validation, workspace preparation, runners,
protected grader files, metrics, artifacts and comparisons. Drivers here only
prepare scenarios and assert task-specific outcomes. The behavioral driver uses
the shared test harness instead of maintaining a second dispatch environment;
that harness delegates prompt compilation to the production prompts domain.
The tool benchmark likewise calls the production registry, not a copied tool.

Run `pnpm evals:check` to validate all suites without running commands or models.
It is included in lint. `pnpm typecheck` explicitly includes these drivers.

```sh
node dist/cli/index.js eval run --suite evals/behavioral-machinery.yaml --clio-coder-entry dist/cli/index.js
node dist/cli/index.js eval run --suite evals/behavioral-model.yaml --target YOUR_TARGET --clio-coder-entry dist/cli/index.js
node --import tsx evals/scalar-decision-machinery.ts /path/to/python-with-numpy
```

The tracked-metrics suite pins commit
`3ae1ea3a8279472f8585e424d6daca254698e85c` of this repository. Its source and grader
come from that revision; there is no second current copy of the historical grader.
It uses the engine's Git workspace and `protectedFiles` support, replacing the
old shell checksum guards. Dependency setup disables lifecycle scripts and
requires Git, pnpm and network access; it can be substantially slower than local
suites. The candidate Clio binary is selected with `--clio-coder-entry` and does
not come from the historical checkout. Updating the source pin changes the
benchmark and must be reviewed as a corpus change.

## Tool-bench baselines

`evals/tool-bench/baselines/<tool>.<split>.json` records, per scenario, the
three values that are a property of the harness rather than of the machine:
`task.solved`, the `custom.digest.behavior` fingerprint of the tool call's
result and post-state, and `custom.counters.fs_ops`. The default-profile suites
declare them; the full profiles carry the largest cases, are invoked
deliberately and stay unpinned. Six tools are covered: `edit`, `read`, `write`,
`grep`, `find` and `bash`, for 232 pinned scenarios across both splits.

```sh
node dist/cli/index.js eval baseline check  --suite evals/tool-bench/read.yaml
node dist/cli/index.js eval baseline record --suite evals/tool-bench/read.yaml
```

`check` is the loop worth running after touching `src/tools` or anything the
tool path reaches. It names the scenarios whose behavior moved instead of
reporting a suite average, and `eval run` performs the same check inline. When
a change is intended, `record` rewrites the file and the diff is what a reviewer
reads. The file is sorted and one value per line for exactly that reason.

### Autonomy is a property of the scenario

An execute-plane call parks for confirmation below `full-auto`, so a bash
scenario that measured what the tool does would measure the park instead. Each
scenario therefore declares the autonomy its call runs at, defaulting to
`auto-edit`, which is what every observe and mutate scenario has always used.
The bash suite runs its execution scenarios at `full-auto` and keeps
`parked-at-auto-edit` and `parked-read-only` at lower levels, so the admission
decision an execute call receives is itself pinned. Raising the driver's
autonomy globally instead would have silently changed what all 186 previously
recorded scenarios exercise.

No bash scenario removes a path or reaches the network, and a contract test
enforces that. A bench that depends on the safety net to stop a destructive
command is one admission change away from deleting the checkout it runs in.

The former `behavioral-machinery-baseline.json` was historical output, not a gate.
It is available in Git history. Generate fresh results through `clio-coder eval`
and keep them in its state/evidence directories or an explicitly selected output
location. Fixtures and graders remain versioned inputs; synthetic safety decoys
are labeled as such.

The single-system boundary is the engine under `src/domains/eval`: suites, verdict validation, artifact envelopes, comparison, and reporting belong there, while `evals/` contains source-checkout reference inputs and deterministic drivers. In v0.5.0, external-benchmark adapters such as SWE-bench and Terminal-Bench should translate their cases and grader observations into this engine's suite, execution, and verdict contracts, then consume its artifacts and comparison reports instead of adding a parallel harness.

`tool-surface-model.yaml` is a dedicated model-required suite for read tail arguments, bash working-directory reset between calls, and rejection of a non-HTTP web_fetch URL. Run it with a configured target using `node dist/cli/index.js eval run --suite evals/tool-surface-model.yaml --target <target-id> --model <model-id> --trials 3 --clio-coder-entry dist/cli/index.js`. This invokes the selected model and incurs its normal inference cost. The URL case deliberately expects one tool error; it requires no successful web request. The target must expose all three tools, and local policy blocks are measured separately from execution errors.

Each trial records `tools.calls.<tool>`, `tools.succeeded.<tool>`, `tools.failed.<tool>`, and `tools.blocked.<tool>` from terminal tool events, plus grader correctness. Compare repeated runs with the same target, model, and settings when evaluating a description change; no arbitrary text perturbation is guaranteed to worsen model behavior. CI executes the suite and real graders against controlled successful and failing event fixtures without calling a model. Those contracts validate the evaluation machinery and are not live model scores.

A `verify.measure` grader can report its own numbers by printing `{"schema":"clio-coder.eval.measure.v1","metrics":{...}}` lines. Keys must start with `custom.` followed by at least one character and match `^[A-Za-z0-9._-]{1,128}$`. Values must be finite numbers or booleans, except under `custom.digest.`, where the only accepted value is a lowercase hex SHA-256 string. They land per trial in `results[].metrics`, where `verify.assertions` and `thresholds` can name them, and the last line wins for each key within a trial. A custom key the artifact redactor would rewrite, such as `custom.io_token_bytes`, fails the item. Only the first 20,000 and roughly the last 180,000 characters of each measure command's stdout are kept, so a metric line printed in between is lost. See `docs/process/eval-runner.md` for the full rules.
