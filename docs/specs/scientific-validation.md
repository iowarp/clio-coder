# Scientific Validation Contract

Date: 2026-04-29
Status: spec, advisory in v0.1.4

## Goal

Agents working in scientific or HPC repositories must produce a typed validation contract instead of relying on file-existence checks. The contract is a declarative document that names artifacts, formats, tolerances, runtime assumptions, and validators. It is consumed by the `scientific-validator` agent recipe at `src/domains/agents/builtins/scientific-validator.md` and informs middleware reminders that nudge agents away from existence-only validation. The contract is data, not code; v0.1.4 ships the format, three declarative middleware rules, and one agent recipe. Runtime enforcement and validator implementations land in a later slice.

## Validation contract format

The contract is a YAML document. YAML is preferred because the eval suite at `src/domains/eval/` already accepts YAML task files and the same parser path can be reused.

Top-level fields:

```yaml
version: 1
task: <free text description of the scientific task>
runtime:
  kind: local | slurm | mpi | other
  nodes: <integer, optional>
  ranks: <integer, optional>
  walltime: <duration string, optional>
  modules: [<module spec>, ...]    # optional, environment modules required
artifacts:
  - path: <repo-relative or absolute artifact path>
    format: <artifact family from the list below>
    expected_shape: <tuple of dimensions, optional>
    expected_attributes: { <key>: <value>, ... }   # optional
    expected_dimensions: { <name>: <size>, ... }   # optional
    numerical_tolerances:
      relative: <float, optional>
      absolute: <float, optional>
      ulp: <integer, optional>
    preserve: true | false
validators:
  - <command string or middleware rule id>
notes: <free text, optional>
```

Field rules:

1. `version` is the integer `1`. Bump when a backwards-incompatible field lands.
2. `task` is a single-paragraph restatement of what the contract validates.
3. `runtime.kind` declares the execution surface so middleware can distinguish local unit runs from scheduler-backed runs. `local` covers `pytest`, `ctest`, plain shell invocations. `slurm` covers `sbatch`, `srun`, `salloc`. `mpi` covers `mpirun`, `mpiexec`, `flux run`. `other` is a documented escape hatch.
4. `artifacts` is non-empty. Each entry names exactly one path and exactly one format. Per-element checks belong on the artifact entry; aggregate metrics belong on a separate validator command.
5. `numerical_tolerances` may carry any subset of `{relative, absolute, ulp}`. Empty tolerance objects are rejected at validation time.
6. `preserve` declares whether destructive cleanup tools may remove the artifact after validation. Checkpoint and restart artifacts default to `preserve: true`.
7. `validators` lists either explicit shell commands (`pytest tests/test_grid.py`) or middleware rule ids (`science.no-existence-only-validation`).
8. `notes` carries operator-facing context that is not machine consumed.

## Supported artifact families

The `format` field accepts one of:

- HDF5: validate group hierarchy, dataset shape, dtype, attributes.
- NetCDF: validate variables, dimensions, attributes, CF conventions when declared.
- Zarr: validate group hierarchy, chunk shape, dtype, attributes.
- FITS: validate HDU list, header cards, image axes, data dtype.
- CSV: validate header schema, row count, per-column dtype.
- Parquet: validate schema, partition layout, row count, dictionary encoding when declared.
- VTK and ParaView output: validate mesh topology, field array names, field array shapes.
- Slurm job output: parse `stdout`, `stderr`, exit code, sacct fields when available.
- MPI rank-sensitive tests: per-rank artifact comparison, often paired with a rank count from `runtime.ranks`.
- Checkpoint files: opaque binary blobs. Validate size, checksum, and format magic bytes; declare `preserve: true`.
- Simulation restart artifacts: a stricter checkpoint family. The validator confirms the artifact loads and that a downstream step can resume from it. `preserve: true` is mandatory.
- Plots and generated figures: path-and-checksum descriptors only. Visual inspection is operator scope, not validator scope.

Artifact families are case sensitive. New families must be added to this spec and to the `scientific-validator` recipe before the contract accepts them.

## Rule taxonomy

v0.1.4 ships three declarative middleware rules in `src/domains/middleware/rules.ts`. They are advisory metadata. The middleware runtime consumes them to compute `ruleIds` per hook; effect emission is the next slice.

### `science.no-existence-only-validation`

Intent. Reminds agents that file existence does not validate scientific artifacts. A NetCDF file that is the wrong shape, an HDF5 dataset with missing attributes, or a checkpoint that does not load are failures regardless of `ls` output.

Hooks observed: `before_finish`, `after_tool`.
Effect kinds permitted: `inject_reminder`, `annotate_tool_result`.
Status: declarative metadata only in v0.1.4; the middleware runtime emits no effects yet.

### `science.preserve-checkpoints`

Intent. Marks validated checkpoint and restart artifacts as protected so destructive cleanup tools (`rm`, `git clean`, `find -delete`, `> file`) cannot remove them. Pairs with the protected-artifacts state in `src/domains/safety/protected-artifacts.ts` once enforcement lands.

Hooks observed: `before_tool`, `after_tool`.
Effect kinds permitted: `protect_path`, `inject_reminder`.
Status: declarative metadata only in v0.1.4.

### `science.unit-vs-scheduler-validation`

Intent. Distinguishes local unit validation (`pytest`, `ctest`, `make test`) from scheduler-backed validation (`sbatch`, `srun`, `qsub`, `flux run`). A scheduler exit code does not validate the produced artifacts; the contract must say which artifacts each path produces and how each one is checked after the queue completes.

Hooks observed: `after_tool`, `before_finish`.
Effect kinds permitted: `inject_reminder`, `annotate_tool_result`.
Status: declarative metadata only in v0.1.4.

## Worked example

A minimal contract for a NetCDF post-processing task on a Slurm cluster:

```yaml
version: 1
task: Regenerate the regional climate output and confirm grid metadata.
runtime:
  kind: slurm
  nodes: 4
  ranks: 64
  walltime: "01:30:00"
  modules:
    - "intel/2024"
    - "openmpi/5.0"
    - "netcdf-c/4.9"
artifacts:
  - path: out/region_west.nc
    format: NetCDF
    expected_dimensions:
      time: 8760
      lat: 360
      lon: 720
    expected_attributes:
      Conventions: "CF-1.10"
    numerical_tolerances:
      relative: 1.0e-6
    preserve: false
  - path: ckpt/run-0042.chk
    format: Checkpoint files
    preserve: true
validators:
  - "ncdump -h out/region_west.nc"
  - "python tools/check_grid.py out/region_west.nc"
  - science.no-existence-only-validation
  - science.unit-vs-scheduler-validation
notes: |
  The job is submitted with sbatch; the queue exit code is not a validator.
  Re-run check_grid.py after sacct reports COMPLETED.
```

The contract is consumed by the `scientific-validator` recipe, which restates the task, lists artifact families covered, and names the strictest tolerance and the most likely silent-regression check before handing off.

## Numerical tolerances

Scientific validation must declare tolerance type explicitly. Three types are admitted:

1. `relative`: fractional difference, applied per element unless declared aggregate.
2. `absolute`: additive difference, applied per element unless declared aggregate.
3. `ulp`: unit in the last place, integer count of representable floats between the candidate and the reference.

Default tolerance when nothing is stated is `relative: 1e-6`. The default is conservative enough to catch silent regressions in single-precision and double-precision pipelines, and loose enough to absorb non-determinism in fused multiply-add and parallel reductions.

Comparisons must distinguish per-element from aggregate metrics. A field that passes a per-element relative tolerance can still fail an aggregate L2 norm check, and the contract must say which one is the gating check.

## HPC and scheduler distinctions

A scheduler-backed run is not the same as a unit validation. `sbatch script.sh` returns a job id, not a result; the queue exit status is a property of the queue, not of the artifacts the job produced. Polling completion (`squeue`, `sacct`, `flux jobs`) returns scheduler success or failure but says nothing about the scientific correctness of the produced files.

The `science.unit-vs-scheduler-validation` rule is the canonical reminder. The contract must:

1. Declare `runtime.kind` so middleware can tell which path is in play.
2. Name a post-job validator that reads the produced artifacts after the queue reports completion.
3. Refuse to claim success when only the queue exit code is available.

## Lifecycle

The contract is an artifact, not a runtime call. Its lifecycle:

1. The operator names a scientific task and points the agent at the relevant repository, build files, run scripts, and reference outputs.
2. The `scientific-validator` recipe drafts the contract as a YAML document, restating the task and listing every artifact and validator.
3. The contract is committed under the operator's chosen repository path. v0.1.4 does not impose a canonical location.
4. Downstream slices add a contract validator and middleware effect emission. Until they ship, the contract is read by humans and by the agent recipe; the middleware rules are advisory metadata.
5. When enforcement lands, the `validators[]` list executes after artifact production, and `preserve: true` paths are admitted to the protected-artifacts state.

The contract is versioned by its `version` field; field additions that preserve backward compatibility do not bump the version. Removing or renaming a field is a `version: 2` change and requires a migration path for in-tree contracts.

## Out of scope

This slice does not ship:

- HDF5, NetCDF, Zarr, FITS, Parquet, or VTK runtime libraries. No new dependencies enter the package.
- Live cluster integration. No Slurm, no MPI, no flux, no sacct calls.
- Enforcement code. The three middleware rules are declarative metadata; the runtime emits no effects from them in v0.1.4.
- Validator implementations. The `validators[]` field accepts strings; nothing executes them yet.
- A linter for malformed contracts. The agent recipe drafts contracts; checking them is a later slice.

## References

- `src/domains/agents/builtins/scientific-validator.md`: the agent recipe that drafts contracts in this format.
- `src/domains/middleware/rules.ts`: the declarative built-in middleware rules, including the three `science.*` rules described above.
- `docs/.superpowers/IMPROVE.md`, section M10: the roadmap entry that scoped this milestone.
