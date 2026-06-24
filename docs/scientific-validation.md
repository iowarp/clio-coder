# Clio Coder Scientific Validation Contracts

> [!TIP]
> **Interactive Spec Available:** An interactive numerical tolerance calculator and HPC queue execution simulator is located at [docs/html/validation_blueprint.html](html/validation_blueprint.html) (Version: 0.2.5).

Scientific software development cannot treat simple file presence as proof of correctness. A simulation script that crashes on rank 48, or writes out NetCDF arrays filled with `NaN`s, may still successfully write a file to the disk. 

Clio Coder introduces **Scientific Validation Contracts**: declarative, typed YAML documents that declare the exact expected dimensions, attributes, numerical tolerances, and verification checks for scientific artifacts.

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

---

## 🚀 HPC Schedulers & Validation Lifecycle

Scheduler-driven runs require distinct validation handling compared to local unit tests:
- **Queue status is not validation:** Checking if `sbatch` exits successfully only proves that the Slurm scheduler accepted the script. The validation contract is designed to execute *post-completion*, checking the actual simulation artifacts inside `out/` or `ckpt/`.
- **Environment module loading:** The `runtime.modules` array lists the exact software stack dependencies (e.g., `intel/2024`, `openmpi/5.0`) that must be loaded before running the validators.
- **Validator execution:** In the current alpha version, contract validation is **advisory**. Quality/verification agents (such as the base `verifier` agent or custom project-level agents) read the contract to guide developers and write out verification receipts. Automated in-harness contract execution is not implemented yet.
