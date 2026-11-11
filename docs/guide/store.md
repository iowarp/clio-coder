# Store

`runStoreCommand` in [store.ts](../../src/cli/store.ts) implements the CLI; the `store` tool is in [store-tool.ts](../../src/tools/store/store-tool.ts) and backend selection in [selection.ts](../../src/domains/store/selection.ts).

The store keeps files as blobs in named tags outside the working tree, with a record of who put each one, from where, and with which hash. Every checkout and task worktree of one project sees the same store.

## Commands

| Command | What it does |
| --- | --- |
| `clio-coder store tags` | List this project's tags with their class and blob count. |
| `clio-coder store ls <tag> [pattern]` | List blobs in a tag; `pattern` is a regular expression matched against the whole name. |
| `clio-coder store put <tag> <file> [--blob <name>] [--note <text>]` | Store a file; creates the tag (class input) when missing. |
| `clio-coder store get <tag>:<blob> [--to <path>]` | Print the blob's path, or copy it to `--to`. |
| `clio-coder store stat\|history <tag>:<blob>` | Show the blob and its record, or every record for it. |
| `clio-coder store verify <tag> [pattern] [--hash-large]` | Compare blobs with their records; exit 1 unless every blob is ok. |
| `clio-coder store rm-tag <tag> --yes` | Delete a tag; without `--yes` it only prints what it would delete. |
| `clio-coder store adopt [<projectKey>]` | List or adopt store directories whose project moved. |
| `clio-coder store where` | Print where this project's store lives. |
| `clio-coder store backend [local\|clio-core ...]` | Show or choose the backend (below). |

Every command takes `--json`. Exit codes: 0 success, 1 operational failure, 2 invalid usage.

## Workers and tags

A dispatched worker reads the store but does not write it, unless its dispatch grants tags: `dispatch` with `tags: ["results"]` lets the worker `put` and `note` into `results` only. The tag must exist before the dispatch. A parallel writer granted tags that declares no write roots is confined to its tags' store directories; declare `intent.write_roots` when it must also edit the workspace.

## Choosing a backend

The store uses the **local** backend unless you choose otherwise: blobs are plain files under the Clio data directory. Nothing needs to be installed, and `clio-coder doctor` reports `store backend: local (no selection; the default)`.

The **clio-core** backend is **experimental** in 0.8.0. It keeps blobs in an IOWarp clio-core runtime (the `iowarp-core` Python package). It needs clio-core built from its integration branch at PLACEHOLDER-CORE8-SHA or later; no released `iowarp-core` wheel carries the bindings it uses yet. Choose it when the store must live in clio-core's tiers, be shared through its FUSE mount, or sit beside other clio-core data:

```sh
clio-coder store backend clio-core --python /path/to/venv/bin/python3 --config /path/to/clio.yaml --pool 570.0
```

The command probes the interpreter, the daemon and its version, the host and a durable tier, and records the choice only when every row passes. `clio-coder store backend` shows the current choice; `clio-coder store backend local` switches back. Switching never moves data, and a clio-core selection never falls back to local: while the runtime is unavailable, store operations fail with a clear message instead.

### clio-core notes

- After each record put the store syncs the tag, so a record survives a runtime crash. An older `iowarp-core` without `AsyncSyncTag` skips the sync, and records written within about 10 seconds of a crash can then be lost. Reading a lost one afterwards fails with a message that the record was lost at a clio-core restart, instead of returning damaged data.
- A clio-core space reserved over `agentspace/<project key>/` charges both the records and the data blobs.
- A put over an existing blob asks first, as a replace does on the local backend; clio-core keeps no blob versions.
- With a `--mount`, `store get` returns the path inside the mount, and the model may read it.
- Through the FUSE mount, `close()` publishes a file's size asynchronously. A writer that hands a file to a reader outside the mount calls `fsync` before closing it (or the runtime runs with `CLIO_FUSE_ASYNC_FLUSH=0`).
