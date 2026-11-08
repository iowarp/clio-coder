---
name: science-data
description: "Explores HDF5, NetCDF, Parquet and CSV data read-only: Clio's data tool for structure, slices and summary statistics, then the clio-kit parquet and pandas servers for aggregation, correlations and statistical tests, and the hdf5 server or h5py only for what those cannot do. Not for writing or converting data files."
---

# Scientific data, one tool at a time

Answer questions about a data file without changing it, and use the lightest
tool that can answer. Each step down this list costs more: a server launch, an
approval, or a Python environment. Never write to a data file to answer a
question about it. Pass absolute file paths.

## 1. The `data` tool first

`gateway(op="call", capability="data", args={...})` is built in, read-only,
bounded, and needs no Python and no approval. It covers:

- `op="inspect"` on HDF5, NetCDF (classic and NetCDF-4), Parquet, CSV/TSV,
  JSON, JSON Lines and SQLite. For a scientific file it gives the group and
  variable tree, dtype, shape, dimensions, attributes with their CF metadata
  (`units`, `_FillValue`, `scale_factor` and the rest), chunking and
  compression. For Parquet it gives the schema, row groups and footer
  statistics. Use `variable` to narrow to one dataset or group.
- `op="select"` reads a hyperslab (`variable`, `start`, `count`, `stride`; at
  most 2000 elements) or a Parquet row window (`offset`, `limit` up to 1000,
  `columns`). Values come back raw, with `scale_factor` and `add_offset` not
  applied. Say so when you quote them.
- `op="stats"` gives min, max, mean, std and the NaN, infinity, fill and
  missing counts over a selection. It streams up to `max_bytes` and says when
  that cap cut the scan short.

The HDF5 and Parquet readers download once from the npm registry on first use,
pinned and cached. Offline with a cold cache, the refusal names the URL and the
cache path: say that, and go to step 4.

## 2. The clio-kit `parquet` and `pandas` servers for analysis

Use these only when `data` cannot answer: grouped or filtered aggregates,
correlations, statistical tests, pivots, profiling. Find them with
`gateway(op="find", query="pandas")`. Each needs the operator's one-time
`clio-coder mcp trust <id>`. If a server is missing, untrusted or stale, give
the remedy the listing prints.

- `mcp_parquet__aggregate_column_tool` (min, max, mean and so on over a row
  range, with `filter_json`) and `read_slice_tool` with a filter.
- `mcp_pandas__correlation_analysis`, `hypothesis_testing`, `profile_data`
  and `statistical_summary`, each on a `file_path`.

These are `read` and run without asking. Every other pandas tool writes a file,
so it asks first: `save_data`, and `clean_data`, `filter_data`,
`groupby_operations`, `handle_missing_data`, `merge_datasets`,
`optimize_memory`, `pivot_table` and `time_series_operations`, which write a
CSV beside the input and replace one of the same name (`handle_missing_data`
writes for every strategy except `detect`). Use them
only when the user asks for a file; for a grouped aggregate without one, use
`mcp_parquet__aggregate_column_tool`.

## 3. The operator's `hdf5` server, rarely

The operator may have declared the clio-kit `hdf5` server (the pack README has
the entry). Use it only for what `data` lacks, such as its access-pattern
analysis. Its `open_file` asks every time, because its `mode` could truncate the
file. Request `mode="r"` and say so. `close_file` when done.

## 4. h5py, netCDF4 or pyarrow through `run_script`, last

When no tool above can answer, for example `data`'s reader is offline and not
cached, write a short read-only script that opens the file in read mode (`"r"`)
and run it with `run_script`, declaring the file in `inputs`. That records the
command and the file's hash. Never open the file in a writable mode.

## Final answer

Name each file, the dataset paths or columns, the slice, and the tool that read
it. Quote the units an attribute declares, and say when there are none. Report
each statistic with the call that produced it, and say when a scan was capped
or values are raw.
