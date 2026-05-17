# Scientific Validation Contract

Date: 2026-04-29
Status: advisory spec, active

## Goal

Scientific workflows should not treat file existence as proof of correctness. A
scientific validation contract is a typed artifact record that names artifacts,
formats, tolerances, and runtime assumptions for an expected result.

Contracts are consumed by the `scientific-validator` agent recipe at
`src/domains/agents/builtins/scientific-validator.md`. The current runtime behavior
is advisory: contracts are drafted and reviewed, and enforcement (execution of
the listed validators) is not yet fully wired.

## Validation contract format

The contract is a YAML document. YAML is preferred because the evaluator pipeline
already consumes YAML task files.

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

1. `version` is the integer `1` unless a backward-incompatible field schema change requires bumping to `2`.
2. `task` should restate what this contract is validating in one paragraph.
3. `runtime.kind` records execution mode for downstream interpretation. `local` covers unit commands (`pytest`, `ctest`, plain shell), while `slurm`/`mpi`/`other` are scheduler-orchestration-aware contexts.
4. `artifacts` must be non-empty. Each entry names one path and one format.
5. Empty tolerance objects are rejected; at least one of `relative`, `absolute`, or `ulp` may be supplied.
6. `preserve` controls whether cleanup tools are allowed to delete the artifact under this contract.
7. `validators` should list explicit shell commands today (for example `pytest tests/test_grid.py`) and may later include middleware ids once a validator registry is shipped.
8. `notes` captures operator context that is not machine-owned.

## Supported artifact families

`format` accepts:

- HDF5
- NetCDF
- Zarr
- FITS
- CSV
- Parquet
- VTK and ParaView
- Slurm job output
- MPI rank-sensitive tests
- Checkpoint files
- Simulation restart artifacts
- Plots and generated figures (path+checksum descriptors only)

Artifact-family terms are case sensitive. New families must be added to this spec
and the `scientific-validator` recipe before acceptance.

## Future validator taxonomy

The following ids are design candidates. They are not currently enforced by the
middleware runtime, and they exist only as design direction for future slices:

### `science.no-existence-only-validation`

Intent: reject the pattern of treating a present file as sufficient validation.

### `science.preserve-checkpoints`

Intent: mark validated checkpoint and restart artifacts as protected so cleanup
operations cannot remove them while downstream reuse depends on them.

### `science.unit-vs-scheduler-validation`

Intent: ensure scheduler-backed validations (`sbatch`, `srun`, etc.) are tied to
post-completion artifact checks, not queue status alone.

## Worked example

A minimal contract for a Slurm-backed NetCDF workflow:

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
notes: |
  The run is submitted with sbatch; queue exit status is not a completion check.
  Re-run check_grid.py after job completion is observed.
```

The `scientific-validator` recipe summarizes this contract and the likely strictest
tolerance before operator handoff.

## Numerical tolerances

Accepted tolerance types:

1. `relative`: fractional difference, usually applied per element.
2. `absolute`: additive difference, usually applied per element.
3. `ulp`: integer count of representable float steps between candidates and references.

Default tolerance when omitted is `relative: 1e-6`.

## HPC and scheduler distinctions

Scheduler workflows are a different validation class from unit runs. `sbatch`-style
invocation returns scheduler metadata, not artifact correctness. The contract should
name post-completion checks and validators explicitly.

Current finish-contract safety checks already treat typed validation commands as evidence;
`validate_frontend` is recognized as such a check in safety/evidence workflows, but
there is no automatic contract executor yet.

## Lifecycle

The contract is an artifact file, not a runtime call.

1. Operator defines task goals, build scripts, runtime assumptions, and validation commands.
2. `scientific-validator` drafts the contract from these inputs.
3. Operator commits the contract at a chosen path (no canonical enforced path in this slice).
4. Current tooling reads/uses the contract for documentation and workflow discipline; enforcement is a later slice.
5. `preserve: true` marks artifacts for future cleanup protection once validation enforcement lands.

## Out of scope

This slice does not ship:

- Runtime libraries for scientific artifact parsing/validation families.
- Automatic validator execution of `validators[]`.
- Full scheduler integration checks in this slice (queue completion handling remains operator-driven in workflows).
- A migration linter for malformed contracts.

## References

- `src/domains/agents/builtins/scientific-validator.md`: recipe that drafts contracts.
- `src/domains/middleware/rules.ts`: registry currently remains empty for these validator ids.
- `src/domains/safety/finish-contract.ts`: completion-evidence model used by current safety workflow.
- `docs/.superpowers/IMPROVE.md`, section M10: roadmap entry.
