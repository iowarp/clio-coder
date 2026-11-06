---
name: hpc-parallel-io
description: "Writes or reviews parallel HDF5 and MPI-IO code so many ranks share one file correctly and collectively, and checks the result with Darshan counters. Not for serial file reading; not for choosing the science stored in the file."
---

# Parallel HDF5 and MPI-IO

Get many MPI ranks writing or reading one shared file correctly first, then
quickly. Correctness rules come first because breaking them hangs a job or
corrupts a file. Everything here runs on the cluster with no network access.

## Phase 0 - Check the stack

- Parallel HDF5 is a separate build. `h5pcc -showconfig` (or `h5cc -showconfig`)
  must print `Parallel HDF5: yes`. Load it with the same MPI the program uses
  (see the hpc-modules skill).
- For Python, `python3 -c 'import h5py; print(h5py.get_config().mpi)'` must
  print `True`, and `mpi4py` must import. A pip-installed h5py is serial unless
  it was built against a parallel HDF5.
- The MPI used to build HDF5 must be the MPI that launches the job.

## Phase 1 - Correctness rules

Parallel HDF5 (C or h5py):

- Every rank opens the file together: `h5py.File(path, "w", driver="mpio",
  comm=MPI.COMM_WORLD)`, or in C a file access list with
  `H5Pset_fapl_mpio(fapl, comm, info)`.
- Anything that changes the file's structure or metadata is collective: every
  rank calls it, with the same arguments, in the same order. That covers
  creating groups, datasets and attributes, resizing, and closing. A dataset
  created on rank 0 only is the classic hang.
- Writing data can be independent, and that is the default. Each rank writes
  its own slab, and the slabs must not overlap.
- For collective data transfer, use `with dset.collective: dset[lo:hi] = block`
  in h5py, or in C a transfer list with
  `H5Pset_dxpl_mpio(dxpl, H5FD_MPIO_COLLECTIVE)`. Every rank must then take part
  in each collective write, including a rank whose selection is empty.
- Compressed (filtered) datasets accept parallel writes only through collective
  I/O, from HDF5 1.10.2 on.

MPI-IO:

- `MPI_File_open` is collective over its communicator.
- `MPI_File_write_at_all` and `MPI_File_read_at_all` are collective;
  `MPI_File_write_at` and `MPI_File_read_at` are independent. With many small
  per-rank pieces, prefer the collective forms. They let ROMIO aggregate the
  pieces into large requests (two-phase I/O).
- Describe a strided layout once, with `MPI_File_set_view` and a derived
  datatype, instead of looping over many small writes.

## Phase 2 - Tuning knobs

Change one knob at a time and measure each change (Phase 3).

- ROMIO hints go in the `MPI_Info` passed at open (`H5Pset_fapl_mpio` passes
  one through): `romio_cb_write` / `romio_cb_read` (`enable`, `disable`,
  `automatic`), `cb_nodes` (aggregator count), `cb_buffer_size`.
- On Lustre, `lfs getstripe <file or dir>` shows the striping. Set a new
  file's striping on its directory with `lfs setstripe -c <stripe count> -S <stripe size> <dir>`,
  or through the `striping_factor` and `striping_unit` hints at creation. An
  existing file keeps the striping it was created with.
- HDF5 metadata: `H5Pset_coll_metadata_write(fapl, true)` and
  `H5Pset_all_coll_metadata_ops(fapl, true)` make metadata writes and reads
  collective, which helps at high rank counts. Chunk shapes that align with each
  rank's slab avoid sharing chunks between ranks.

## Phase 3 - Check what actually happened

Run the smallest real case first, with the same code path and a few ranks
(`mpirun -n 4 python3 write.py`), before the full-scale job. Then:

- Read the file back with `h5dump -H <file>` or `h5ls -r <file>`. Check that the
  shapes and dtypes are as intended, and that the values in each rank's slab
  match what that rank wrote.
- With Darshan enabled for the run, summarize its log with the hpc-darshan
  skill. `MPIIO_COLL_WRITES` against `MPIIO_INDEP_WRITES` shows whether the
  collective path was taken, and the POSIX request-size histogram shows whether
  aggregation produced large requests.

## Final answer

State the rank count, the access mode (independent or collective), the hints
and striping used, and the readback or Darshan counters that support each claim.
A throughput number without the log it came from is a guess.
