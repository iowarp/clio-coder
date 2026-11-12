# Keep results in the store

Keep datasets and results outside the working tree, with a record of where each came from.

## Keep results out of your working tree

Long analyses produce files you want to keep but not commit: datasets, model outputs, figures. The project store holds them outside the working tree. The main session, its workers and every linked worktree of the project see the same store, and each file keeps a record of where it came from.

A tag is a named container, classed input, output, cache or archive. A blob is a file in a tag. A reference reads `<tag>:<blob>`, such as `results:summary.parquet`.

## Store a file from your shell

```sh
clio-coder store put results out/summary.parquet --note "baseline run"
clio-coder store tags
clio-coder store ls results
clio-coder store stat results:summary.parquet
```

`put` creates a missing tag as an input tag. `stat` shows the record and whether the bytes have drifted since: `none`, `changed`, `missing` or `unrecorded`. `get` prints the path of a read-only copy, or copies the blob elsewhere with `--to <path>`. Every command takes `--json`.

## Ask CLIO Coder to use it

> Run the analysis script on `data:measurements.h5`, put its summary into the `results` tag, and tell me whether the stored baseline has drifted.

The agent reaches the store through its `store` tool. Reads run without asking. Creating a tag, a put and a note are judged as writes. Removing a blob, or a put that replaces one, asks first and names the blob; a replacing put also states its size. The store keeps no earlier versions.

When a `run_script` run declares a store blob as an input and its output is put back, the record names the script and that input.

## Let workers write

Dispatched workers read the store. They write only into the tags their dispatch grants, and a granted tag must exist first. The built-in coder, researcher and scout workers use the store without extra setup.

## Limits

- The store lives in CLIO Coder's data directory on one host; `clio-coder store where` prints its folder. A worker on an SSH fleet node sees that node's own store.
- `put` copies bytes, and no backend keeps earlier versions of a blob.
- `clio-coder reset --data`, `reset --all` and `uninstall` without `--keep-data` delete the store for good.
- The store has been exercised on Linux only.
- The clio-core backend is experimental in 0.8.0 and needs a clio-core build from source. The full guide covers choosing it.
