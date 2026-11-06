# Science data pack

A skill for reading scientific data without changing it, and two clio-kit MCP
servers for the analysis Clio's built-in `data` tool does not do. The skill
answers with `data` first: structure, CF attributes, hyperslabs and summary
statistics for HDF5, NetCDF and Parquet, plus CSV and JSON, read-only and with
no Python. It moves to `parquet` (row slices, filtered column aggregates) and
`pandas` (group-by, correlations, hypothesis tests, pivots) only for questions
`data` cannot answer. A third server, `hdf5`, is an optional operator entry
(below), and h5py through `run_script` is the last resort. Installing the pack
launches nothing.

```bash
clio-coder library install plugin:science-data --project
clio-coder mcp list                 # shows each server and its declared per-tool classes
clio-coder mcp trust parquet
clio-coder mcp trust pandas
```

## Read-only by default

`mcp.json` gives every tool an action class (`toolActionClasses`).
`clio-coder mcp list` and `clio-coder mcp trust` print the map before you trust
a server, and the trust record covers it, so changing a class in the installed
pack makes the server untrusted again.

| Server | Asks first (`destructive`) | Everything else |
| --- | --- | --- |
| `hdf5` (operator entry below) | `open_file` (its `mode` can be `w`, `r+` or `a`), `export_dataset` (writes a file) | `read` |
| `pandas` | `save_data`, `filter_data` (writes `output_file` when given) | `read` |
| `parquet` | none | `read` |

A `read` tool runs without asking at `default` and `yolo`. A `destructive` tool
asks at `default`, and a headless run denies it. Trust a server without
`--action-class`: the per-tool map already classifies every tool it ships, and
a tool a later clio-kit release adds stays `unknown`, which asks.

The pack needs Clio Coder 0.7.0 or later, the first release whose plugin
`mcp.json` accepts `toolActionClasses`.

## HDF5: an operator entry, not a pack declaration

The clio-kit `hdf5` server writes its index files to `data/` under its
working directory on every launch, and that path is fixed. A plugin's server
runs in the installed plugin tree, so those writes would change the pinned
package and stop it loading. Declare `hdf5` yourself in the user file
`<Clio config directory>/mcp.yaml` instead, with an absolute `cwd` that exists
and that you do not mind it writing to, such as a directory under Clio's state
directory (`clio-coder paths` prints it). The classes match the table above:

```yaml
version: 1
servers:
  - id: hdf5
    command: clio-kit
    args: [mcp-server, hdf5]
    cwd: /absolute/path/to/clio-state/mcp/hdf5
    timeoutMs: 120000
    toolActionClasses:
      analyze_dataset_structure: read
      close_file: read
      export_dataset: destructive
      find_similar_datasets: read
      get_by_path: read
      get_chunks: read
      get_dtype: read
      get_filename: read
      get_mode: read
      get_shape: read
      get_size: read
      hdf5_aggregate_stats: read
      hdf5_batch_read: read
      hdf5_parallel_scan: read
      hdf5_stream_data: read
      identify_io_bottlenecks: read
      list_attributes: read
      list_available_hdf5_files: read
      list_keys: read
      open_file: destructive
      optimize_access_pattern: read
      read_attribute: read
      read_full_dataset: read
      read_partial_dataset: read
      refresh_hdf5_resources: read
      suggest_next_exploration: read
      visit: read
```

A user entry is trusted by authorship, so no `mcp trust` step is needed.

## Requirements and environment

`clio-kit` must be on `PATH` (`uv tool install clio-kit`). Clio passes an MCP
server only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, the temp and
`XDG_*` directories and a few platform variables. The servers need nothing
else. `CLIO_KIT_CACHE_DIR` from your shell does not reach them, so their cache
is `$XDG_CACHE_HOME/clio-kit` or `~/.cache/clio-kit`.

## Offline behavior

The servers read local files and make no network calls while they run. The
`data` tool's HDF5 and Parquet readers download once from the npm registry on
first use and are cached; offline with a cold cache it refuses and names the
cache path. clio-kit runs each
server from its own lock file in a uv environment. The first launch downloads
that environment from PyPI and fails without network. Every later launch from
the warm cache works offline. A plugin's servers run with the installed plugin
directory as their working directory, so the skill passes absolute file paths.
On an air-gapped node, warm the cache once on a
connected machine that shares the home directory, or copy the cache over.

## Licenses and terms

The pack is Apache-2.0 and bundles no code or data. It queries no external data
service, so no data terms of use apply. clio-kit is BSD-3-Clause; its servers
pull h5py, NumPy, pandas and PyArrow under their own licenses into the uv
environment.
