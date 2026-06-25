# Clio Coder Scientific Validation Contracts

> [!TIP]
> **Interactive Spec Available:** An interactive numerical tolerance calculator and HPC queue execution simulator is located at [docs/html/validation_blueprint.html](html/validation_blueprint.html) (Version: 0.2.7).

Scientific software development cannot treat simple file presence as proof of correctness. A simulation script that crashes on rank 48, or writes out NetCDF arrays filled with `NaN`s, may still successfully write a file to the disk. 

Clio Coder introduces **Scientific Validation Contracts**: declarative, typed YAML documents that declare the exact expected dimensions, attributes, numerical tolerances, and verification checks for scientific artifacts. Developed at the [Gnosis Research Center (GRC)](https://grc.iit.edu) at Illinois Tech as part of the NSF-funded scientific-software context (NSF Award [#2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318)), these contracts link execution metadata with physical output checks.

---

## 📋 The Validation Contract Schema

A validation contract is stored as a YAML document (matching version `1` schema). A custom or project-level agent (such as a local `scientific-validator` agent example under `.clio/agents/`) or the developer drafts these contracts, which are then committed next to the research code.

### Example netCDF / Slurm validation contract:
```yaml
version: 1
task: "Regenerate the regional climate output and confirm grid metadata."
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

### Schema Rules:
1. **`version`:** Set to `1`.
2. **`runtime.kind`:** Specifies execution mode (`local`, `slurm`, `mpi`, or `other`).
3. **`artifacts`:** Non-empty list of output files.
4. **`preserve`:** Boolean flag. When `true`, cleanup tools are forbidden from deleting the validated checkpoint or restart file.
5. **`validators`:** List of shell commands run to verify the generated files.

---

## 🧮 Numerical Tolerances

Comparing floating-point values in scientific computations must accommodate round-offs, hardware differences, and compiler optimizations. Clio validation contracts support three tolerance checks:

| Tolerance Type | Formula / Check | Purpose |
| :--- | :--- | :--- |
| **`relative`** | $\frac{|val - ref|}{|ref|} \le relative$ | Fractional difference check. Crucial for scaling datasets. |
| **`absolute`** | $|val - ref| \le absolute$ | Additive difference check. Used when reference value is close to `0`. |
| **`ulp`** | $StepsBetween(val, ref) \le ulp$ | Unit in the Last Place. Measures floating-point representation steps. |

> [!NOTE]
> If numerical tolerances are omitted in the contract, the engine defaults to a relative tolerance of `relative: 1e-6`.

---

## 📂 Supported Scientific Artifact Families

Clio Coder’s domain logic categorizes scientific output files into a set of case-sensitive formats:

- **`HDF5` / `NetCDF` / `Zarr`:** Multi-dimensional scientific array files.
- **`FITS`:** Flexible Image Transport System (used in astrophysics).
- **`CSV` / `Parquet`:** Structured tabular data and datasets.
- **`VTK and ParaView`:** Visualizations and mesh outputs.
- **`Slurm job output`:** Standard logs emitted by Slurm queue managers.
- **`MPI rank-sensitive tests`:** Diagnostic outputs matching multi-rank jobs.
- **`Checkpoint files` / `Simulation restart artifacts`:** Stateful binary dumps.
- **`Plots and generated figures`:** Output graphics (verified via path + checksum metadata).

## HPC Schedulers and Validation Lifecycle

Scheduler-driven runs require distinct validation handling compared to local unit tests:
- **Queue status is not validation**: Checking if a Slurm command like `sbatch` exits successfully only proves that the Slurm scheduler accepted the job script. The validation contract is designed to execute post-completion, checking the actual simulation artifacts inside `out/` or `ckpt/`.
- **Environment module loading**: The `runtime.modules` array lists the exact software stack dependencies (such as `intel/2024`, `openmpi/5.0`) that must be loaded before running the validators.
- **HPC and Data Integration**: For large-scale allocations such as those at the Argonne Leadership Computing Facility (ALCF), verification logs can be transferred and archived via Globus endpoints, allowing provenance collection across distributed scientific clusters.
- **Validator execution**: In the current alpha version, contract validation is advisory. Quality/verification agents (such as the base `verifier` agent or custom project-level agents) read the contract to guide developers and write out verification receipts. Automated in-harness contract execution is not implemented yet.

### How a Validation Contract Raises Session Rigor

Clio Coder integrates scientific validation contracts directly into its safety model to raise the evidence standard automatically:
- **Automatic Escalation**: At startup, Clio scans the workspace root. The presence of any validation contract (e.g. `.clio/validation.yaml`, `.clio/validation.yml`, `validation.yaml`, `validation.yml`, or `VALIDATION.md`) automatically escalates the session's rigor level from `normal` to `high`.
- **High-Rigor Gate Requirements**: Once the rigor is raised to `high`, the finish gate is active. If the agent claims to be finished, the gate intercepts the turn-end event. If no recent validation evidence is found in the last 80 history entries, Clio blocks the completion claim:
  - Clio issues a `request_continuation` middleware effect to keep the session running.
  - Clio injects a dynamic warning reminder (`HIGH_RIGOR_REVALIDATION_MESSAGE`) instructing the agent to run a verification command or to declare a limitation before it can conclude the turn.
