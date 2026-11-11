---
name: cluster-sbatch
description: "Writes Slurm batch scripts (sbatch files) for this site's cluster: the account, module and launch lines every job here must carry. Use before writing or editing any job script."
triggers:
  - write a slurm batch script
  - write an sbatch script
  - job script for the cluster
version: 0.1.0
license: Apache-2.0
---

# Batch scripts for this cluster

The scheduler rejects a job script that lacks any of these.

1. `#SBATCH --account=gridlab-sim` on every job.
2. `#SBATCH --output=logs/%x-%j.out`; the `logs/` directory must exist before submission.
3. `module purge`, then `module load gcc/13 openmpi/4.1`, before the launch line.
4. Launch MPI programs with `srun --mpi=pmix`, never `mpirun`.
