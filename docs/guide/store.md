# Store

`runStoreCommand` in [store.ts](../../src/cli/store.ts) implements the CLI; the `store` tool is in [store-tool.ts](../../src/tools/store/store-tool.ts) and backend selection in [selection.ts](../../src/domains/store/selection.ts).

The store keeps files as blobs in named tags outside the working tree, with a record of who put each one, from where, and with which hash. Every checkout and task worktree of one project sees the same store.

## Commands

| Command | What it does |
| --- | --- |
| `clio-coder store tags` | List this project's tags with their class and blob count. |
| `clio-coder store ls <tag> [pattern]` | List blobs in a tag; `pattern` is a regular expression matched against the whole name, at most 256 characters, with no backreferences and no quantified group that contains another quantifier (such as `(a+)+`). |
| `clio-coder store put <tag> <file> [--blob <name>] [--note <text>]` | Store a file; creates the tag (class input) when missing. |
| `clio-coder store get <tag>:<blob> [--to <path>]` | Print a path to a read-only copy of the blob, or copy it to `--to`. Edits to that path never reach the stored blob. |
| `clio-coder store stat\|history <tag>:<blob>` | Show the blob and its record, or every record for it. |
| `clio-coder store verify <tag> [pattern] [--hash-large]` | Compare blobs with their records; exit 1 unless every blob is ok. `pattern` follows the `ls` limits. |
| `clio-coder store rm <tag>:<blob> --yes` | Delete one blob; without `--yes` it only prints what it would delete. |
| `clio-coder store rm-tag <tag> --yes` | Delete a tag; without `--yes` it only prints what it would delete and exits 0. |
| `clio-coder store adopt [<projectKey>]` | List or adopt store directories whose project moved. |
| `clio-coder store where` | Print where this project's store lives. |
| `clio-coder store backend [local\|clio-core ...]` | Show or choose the backend (below). |

Every command takes `--json`. Exit codes: 0 success, 1 operational failure, 2 invalid usage.

## Workers and tags

A dispatched worker reads the store but does not write it, unless its dispatch grants tags: `dispatch` with `tags: ["results"]` lets the worker `put` and `note` into `results` only. The tag must exist before the dispatch. A worker's `get` result says the path is a read-only store copy outside the workspace that it may read with `read`, `data` or `run_script`, so a worker in a task worktree reads it instead of stopping at the boundary. A parallel writer granted tags that declares no write roots is confined to its tags' store directories; declare `intent.write_roots` when it must also edit the workspace.

To run several granted writers at once on the local node, check the worker limit first. `fleet.concurrency: auto` sizes the local node from free memory, and in a container the clio-core runtime's shared memory counts against the cgroup headroom, so a small container beside the runtime can get one worker and refuse the rest (`capacity exceeded (3/1)`). Set `fleet.concurrency` to the number of writers you dispatch, for example `3`, when the host has room for them ([Worker limits](fleet-dispatch.md#worker-limits-and-fleetconcurrency-auto)).

## Concurrent writers

Puts and removes of one blob are serialized across processes, whether they come from the CLI or the `store` tool, so a put's record always lands before the next writer starts. Each put record identifies the bytes that put stored: the sha256, size and modification time it computed while streaming them, never a later read of the blob's name, which another writer may already own. A put whose record was written exits 0. On either backend, the record's hash is omitted above 64 MiB, as for other observed files, and `store verify --hash-large` hashes such a blob and records its digest as a note.

## Choosing a backend

The store uses the **local** backend unless you choose otherwise: blobs are plain files under the Clio data directory. Nothing needs to be installed, and `clio-coder doctor` reports `store backend: local (no selection; the default)`.

The **clio-core** backend is **experimental** in 0.8.0. It keeps blobs in an IOWarp clio-core runtime (the `iowarp-core` Python package). It needs iowarp-core 2.4.0 built from clio-core 6c54cdbf or later, with the agentspace operator 01d8a7d or later; no released `iowarp-core` wheel carries the bindings it uses yet. Choose it when the store must live in clio-core's tiers, be shared through its FUSE mount, or sit beside other clio-core data:

```sh
clio-coder store backend clio-core --python /path/to/venv/bin/python3 --config /path/to/clio.yaml --pool 570.0
```

The command probes the interpreter, the daemon and its version, the host and a durable tier, and records the choice only when every row passes. `clio-coder store backend` shows the current choice; `clio-coder store backend local` switches back. Switching never moves data, and a clio-core selection never falls back to local: while the runtime is unavailable, store operations fail with a clear message instead.

### clio-core notes

- After each record put the store syncs the tag, so a record survives a runtime crash. An older `iowarp-core` without `AsyncSyncTag` skips the sync, and records written within about 10 seconds of a crash can then be lost. Reading a lost one afterwards fails with a message that the record was lost at a clio-core restart, instead of returning damaged data.
- A clio-core space reserved over `agentspace/<project key>/` charges both the records and the data blobs, so its space usage covers records and data (agentspace operator 01d8a7d or later).
- A put over an existing blob asks first, as a replace does on the local backend; clio-core keeps no blob versions.
- `rm-tag` removes the tag's blob files from the clio filesystem along with its records, so their space is freed and a re-created tag starts empty. A runtime whose filesystem binding cannot remove directories leaves the empty directories behind.
- With a `--mount`, `store get` still hands back a read-only copy, as without one: a write through the mount would change the blob with no record or lock. A script may still read blobs through the mount.
- Through the FUSE mount, `close()` publishes a file's size asynchronously. A writer that hands a file to a reader outside the mount calls `fsync` before closing it (or the runtime runs with `CLIO_FUSE_ASYNC_FLUSH=0`).
