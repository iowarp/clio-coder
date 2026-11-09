## What it does

Semantic context is a beta local search index for code maps, wiki pages, approved memory, authorized evidence, recorded worker output, and folders you register. It uses a separate embedding target. It starts disabled, and ordinary startup scans and embeds nothing until you configure it.

## Set it up and search

Create a target for an embedding route you already run. Clio Coder does not start a server for it. Then configure, refresh, and search:

```sh
clio-coder semantic configure --help
clio-coder semantic inbox preview ./experiment-data
clio-coder semantic inbox add ./experiment-data --id experiments
clio-coder semantic refresh
clio-coder semantic status
clio-coder semantic search "Which run produced the delayed oscillation?" --limit 5
```

`--qualify` checks that a route accepts requests and returns vectors of the right shape. It does not check retrieval quality. A result is a candidate to read, and it does not prove anything by itself.

Follow [the tutorial](/tutorials/semantic-context-and-recordings.html) for a full walkthrough.

## Configure the embedding model

`configure` pins a target, model, and asset identity. Prefer a `sha256:<hash>` of the model file; a plain label is reported as unverified.

```sh
clio-coder semantic configure \
  --target litellm --model mini/embeddinggemma-2-q8 \
  --asset-identity sha256:<gguf-sha256> \
  --modality text --modality image \
  --qualify
```

`--background`, off by default, allows refreshes at session start and after code map changes. Run `clio-coder semantic qualify` again after changing the serving build or model.

## Register inboxes

`inbox add` previews the work before saving a folder, which stays private to its project unless you pass `--scope user`. Ignore files and the project's read policy apply, and symlinks and credential-shaped files are refused. `inbox list` and `inbox remove <id>` manage them. An interrupted `refresh` keeps the last complete generation.

## Search and ask

| Filter | Narrows to |
| --- | --- |
| `--kind` | `code`, `wiki`, `memory`, `evidence`, `inbox`, or `recording`; repeatable |
| `--run <id>` | One parent run |
| `--since`, `--until` | Source dates, inclusive |
| `--media-type <MIME>` | One media type |

Search returns five results by default and at most 20, each with a path and a line, page, or timestamp. In a session, ask a specific question; the agent searches the same index, then reads the source. Worker output saved with `clio-coder run --agent <id> --record` is searchable as `recording`.

## Change the model

A new profile gets its own index. `clio-coder semantic reembed --profile <id>` rebuilds it; add `--from <old-profile-sha256>` to embed the previous profile's records. Old vectors are never copied.

## When something fails

If the embedding route is down, search returns lexical candidates from the last complete generation. Video frames need a qualified image route and `ffmpeg` on PATH. Scanned PDFs, raw video, and audio other than mono 16 kHz WAV are not indexed.
