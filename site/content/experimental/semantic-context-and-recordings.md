Clio Coder 0.6.2 can keep a local index of your project that you search by meaning instead of exact words. It covers code maps, wiki pages, approved memory, evidence bundles, recorded worker output, and folders of experiment data you register. Clio Coder can also record what a dispatched worker displayed, as a redacted terminal cast in that run's evidence. Both start off.

::: note Beta in v0.6.2
Semantic context and worker recording are new in v0.6.2 and off by default. Commands, supported formats, and the index layout may change between releases. Ordinary startup scans and embeds nothing until you configure the feature.
:::

::: needs
- A Clio Coder target that serves the EmbeddingGemma 2 Q8 model through a llama.cpp embedding server or a LiteLLM proxy you already run. Clio Coder does not start one.
- The SHA-256 of the model file, and of its multimodal projector if you want images or audio.
- `ffmpeg` on `PATH` if you want still frames sampled from GIF or video files.
:::

## Build an index

::: steps
### Pin the model and check the route

```sh
clio-coder semantic configure \
  --target local-embed --model embeddinggemma-2-q8 \
  --asset-identity sha256:<model-sha256> \
  --projector-identity sha256:<projector-sha256> \
  --modality text --modality image --modality audio \
  --qualify
```

Use your own target and model names. `--qualify` sends fixed canary requests for each modality you chose and pins the text canary in the profile. It proves that the route accepts those requests and returns vectors of the expected shape. It does not measure retrieval quality, and it cannot read the model file's actual hash.

### Register a folder

```sh
clio-coder semantic inbox preview ./experiment-data
clio-coder semantic inbox add ./experiment-data --id experiments
```

Preview lists file types and the estimated work before anything is saved. Clio Coder honors ignore files, refuses symlinks and credential-shaped files, and applies the project's read policy. It never indexes a folder you did not register. Add `--scope user` to register an inbox for every project.

### Refresh and search

```sh
clio-coder semantic refresh
clio-coder semantic status
clio-coder semantic search "Which run produced the delayed oscillation?" --limit 5
```

`refresh` is an explicit, bounded job. An interrupted or partly failed refresh keeps the last complete generation and reports what is still pending. An unchanged refresh reuses its vectors.
:::

## Read a result

Each hit names the exact path and, where it applies, the line, page, notebook cell, video frame, or audio offset. It carries a short excerpt and the generation it came from, and evidence and recording hits carry an evidence id. Search narrows where to look. Clio Coder still reads the original file, code, or receipt before it makes a claim.

In a session, the agent searches through its `context` tool with bounded filters for source kind, run, dates, media type, and count. A question that mixes a run manifest, a code symbol, and a plot works better as one search per source. If the embedding route is down, search falls back to lexical candidates from the last complete generation.

::: compare
| Source | Indexed in this beta |
| --- | --- |
| Code and text | Source files, typed code map records, and wiki pages |
| Documents | PDF pages with extractable text, notebook sources and outputs |
| Images | PNG, JPEG, and WebP |
| Audio | Bounded mono 16 kHz WAV |
| Video | Timestamped still frames sampled from GIF, MP4, WebM, and MOV |
| Not supported | Raw video, reasoning across frames, scanned PDF OCR, and other audio formats |
:::

## Keep the index current

Add `--background` to `semantic configure` to refresh at session start and after code map changes. It is off by default, yields to foreground inference, and checkpoints when interrupted. On a shared route that holds one model at a time, weigh the chat load before you turn it on.

The index lives in your cache directory, with one namespace per project and embedding profile. Code, memory, and evidence stay where they are, so deleting the cache removes only derived data.

A changed serving build, model file, projector, or preprocessing recipe needs a new qualification and gets its own namespace. `clio-coder semantic reembed --profile embeddinggemma-2-q8-768 --from <old-profile-identity>` embeds the old records again under the new profile. Old vectors are never copied into it.

## Record a worker run

```sh
clio-coder run --agent scout --record "Check the experiment on the worker node"
```

In a session, the dispatch tool accepts `record: true` for a call or a single task, including work placed on an SSH node. Clio Coder writes a bounded display stream beside the worker's own protocol. It copies a redacted `.cast` into the run's evidence bundle with the run, node, timestamps, byte count, and SHA-256.

A capture error or a partial run is labeled incomplete. The sealed receipt, not the recording, decides whether the worker succeeded.

Capture needs no extra program. For playback, `clio-coder tools install asciinema` installs a checksum-pinned asciinema. `clio-coder fleet nodes tools install <node> asciinema` previews the same user-level install on a worker node, and `--yes` performs it without sudo. asciinema is GPL-3.0-or-later, and its license and exact source ship with the pinned install.

::: limits
- Similarity finds candidates. It is not proof of a scientific result or of a worker's success, and receipts and memory approval rules stay authoritative.
- Matching model and projector hashes do not make vectors compatible across serving stacks. Keep each stack's index separate.
- An extension can request embeddings only when its manifest declares the service and you approve it, and it never receives the target's credentials.
- A recording is bounded, timed terminal output. It is not a video of the screen.
:::

::: next
- [Semantic context beta guide](https://github.com/iowarp/clio-coder/blob/v0.6.2/docs/guide/semantic-context.md)
- [Remote workers and clusters](/experimental/remote-workers-and-clusters.html)
- [Connect a model](/docs/guide/configuration-and-targets.html)
:::
