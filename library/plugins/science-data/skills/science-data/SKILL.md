---
name: science-data
description: "Explores HDF5, Parquet and CSV data through the clio-kit hdf5, parquet and pandas MCP servers: structure, slices, statistics and tests, read-only by default. Not for writing or converting data files; those calls ask first."
---

# Scientific data through the clio-kit servers

Read a dataset's structure and values through the `hdf5`, `parquet` and `pandas`
servers. Each tool carries an action class: reads run without asking, and every
tool that can write a file asks the operator first. Never change a data file to
answer a question about it. Pass absolute file paths, because a server's working
directory is not the project.

## Phase 0 - Are the servers there?

`gateway(op="find", query="hdf5")` (likewise `parquet` and `pandas`). Each
pack server needs the operator's one-time `clio-coder mcp trust <id>`. `hdf5`
is not in the pack: the operator declares it from the pack README. A server
that is missing, or listed as `untrusted` or `stale`, cannot launch; tell the operator the remedy the
listing prints, and read the file another way meanwhile. Use
`gateway(op="describe", capability="mcp_hdf5__read_partial_dataset")` once
before a call, and take the parameter names it returns.

## HDF5 (`mcp_hdf5__*`)

The server keeps one open file per session.

1. `open_file` with `path` and `mode="r"`, always. `w` truncates the file, and
   `r+` and `a` can change it. That is why `open_file` asks every time; say
   `mode="r"` in your request so the operator can approve it.
2. `analyze_dataset_structure` or `list_keys` / `visit` map the file. Then
   `get_shape`, `get_dtype`, `get_chunks` and `list_attributes` /
   `read_attribute` for each dataset you need, including units.
3. Read values with `read_partial_dataset` (`start`, `count`) for anything
   large. Use `read_full_dataset` only once `get_size` shows the dataset is
   small.
4. `close_file` when done.

`export_dataset` writes a new file and asks first. Use it only when the user
asks for an export.

## Parquet (`mcp_parquet__*`)

`summarize_tool` gives the schema, the row count and the file size.
`read_slice_tool` reads rows `start_row` to `end_row` with optional `columns`
and `filter_json`, `get_column_preview_tool` pages through one column, and
`aggregate_column_tool` computes min, max, mean and similar statistics over a
row range. All four only read.

## Tables (`mcp_pandas__*`)

`load_data` reads CSV, Excel, JSON, Parquet or HDF5 with optional `columns` and
`nrows`. Use `nrows` to look before loading everything. `statistical_summary`,
`correlation_analysis`, `hypothesis_testing`, `groupby_operations`,
`pivot_table`, `validate_data` and `profile_data` analyze a file and return
results without writing.
`save_data` and `filter_data` (when it is given `output_file`) write files, so
they ask first.

## Offline behavior

These servers make no network calls while they run; they read local files. The
first launch of each one builds its uv environment from PyPI and fails without
network. After that, launches run from the cache under `~/.cache/clio-kit`
offline. On an air-gapped node, warm the cache on a connected node first.

## Final answer

Name each file you read, the dataset paths or columns, and the slice. Quote the
units an attribute declares, and say so when a file declares none. Report every
statistic with the call that produced it.
