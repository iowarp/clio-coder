# Semantic context beta

Clio can keep a local, project-scoped search index for code maps, wiki pages, approved memory, authorized evidence, recorded worker output, and folders you register as artifact inboxes. The index uses a separate embedding target. Search returns source paths and locations; Clio must inspect the original file, code, or receipt before making a claim.

The beta starts disabled. Semantic indexing makes no embedding request or source scan during ordinary startup until you configure it. Vector generations live in the XDG cache under `semantic/<project-hash>/<profile-identity>/`. Canonical code, memory, and evidence stay in their existing locations. Deleting the cache only removes derived data.

## Configure the model and an inbox

Create a Clio target for the existing embedding route first. For example, the model may already be exposed as `mini/embeddinggemma-2-q8` through a configured LiteLLM target; this feature does not start a server or add a production port. Use the GGUF and multimodal projector SHA-256 values when available. An operator label is accepted but reported as an unverified asset identity.

```sh
clio-coder semantic configure \
  --target litellm --model mini/embeddinggemma-2-q8 \
  --asset-identity sha256:<gguf-sha256> \
  --projector-identity sha256:<projector-sha256> \
  --modality text --modality image --modality audio --modality mixed \
  --qualify

clio-coder semantic inbox preview ./experiment-data
clio-coder semantic inbox add ./experiment-data --id experiments
clio-coder semantic refresh
clio-coder semantic status
clio-coder semantic search "Which run produced the delayed oscillation?" --limit 5
```

`--qualify` checks fixed text canaries and sends small image, audio, and mixed requests for the modalities selected. It pins the resulting text canary in the profile. It checks request acceptance and vector shape, not scientific retrieval quality or the actual GGUF hash. Requalify after changing the serving build, model asset, projector, or preprocessing recipe. A different recipe gets a separate index namespace even when its vectors are also 768 dimensional.

Inbox registration previews file types and estimated work before saving the path. Project inboxes are visible only in that canonical project; `--scope user` registers a global inbox. Clio honors ignore files, refuses symlinks and credential-shaped sources, and applies the project's read policy. An inbox is never inferred from arbitrary nearby folders. `refresh` is an explicit bounded job; incomplete jobs retain the last complete generation and report pending or failed pieces. An unchanged refresh reuses vectors.

To permit session-scoped refresh after code map changes and at session start, add `--background` to `semantic configure`. The default is off. Background work yields to in-process foreground inference and checkpoints on interruption. Search does not wait for a refresh to finish, although local extraction still uses CPU and disk. The mini router may have only one resident model; assess chat load before enabling this option on a shared route.

## Ask Clio

The agent can call `context(scope="semantic", query="retry after checkpoint")` or, on a gateway-only tool surface, `gateway(op="call", capability="context", args={scope:"semantic", query:"retry after checkpoint"})`. The tool accepts bounded filters for source kinds, run ID, dates, media type, and result count. It returns a generation timestamp, retrieval method, short excerpt, exact path, and line, page, cell, frame, or seconds where available. It does not put all matching text into every prompt.

Ask for a specific source when a broad question mixes several needs: a run manifest, code symbol, plot, and note may each deserve a separate query. Clio can then follow their references using `read`, `code_nav`, and `evidence`. Semantic similarity is a candidate locator, not proof of a scientific result or worker success. Evidence receipts and existing memory approval rules remain authoritative. If the embedding route is unavailable, searches use lexical candidates from the last complete generation.

Supported ingestion in this beta is text/code, typed code map and wiki records, extractable PDF pages, notebook source/text/image outputs, PNG/JPEG/WebP images, and bounded mono 16 kHz WAV audio. The embedding transport also accepts ordered text/image/audio mixtures; a single mixed corpus item is available through the typed `embed()` service, while the inbox indexes its individual extracted pieces. GIF/video frame sampling, scanned PDF OCR, and other audio formats are reported as unsupported until a qualified sampler is supplied. A `.cast` is timed terminal output, not visual video.

## Reembed and move data

`clio-coder semantic reembed --profile embeddinggemma-2-q8-768` forces a manual rebuild of the current profile. After changing the configured profile, `--from <old-profile-identity>` loads the previous checksummed canonical records and embeds them into the new namespace; it never copies old vectors into the new space. Original media paths must still be readable under the current policy. `semantic status --json` displays the exact profile identity. To move an index to another machine, move its complete cache directory only when the model, projector, profile identity, canonical project path, and checksums match; otherwise reembed from the source artifacts. There is no automatic live migration.

## Record dispatched work

```sh
clio-coder run --agent scout --record "Check the experiment on the worker node"
clio-coder tools install asciinema
clio-coder fleet nodes tools install seven asciinema
clio-coder fleet nodes tools install seven asciinema --yes
```

The agent-facing dispatch tool also accepts `record: true` on a call or individual task, including SSH placement. Native Clio workers keep their `ssh -T` NDJSON protocol; Clio writes a separate bounded asciicast v2 display stream. A recording reference appears in the dispatch result and a redacted `.cast` is copied into a built evidence bundle with run, node, timestamps, byte count, and SHA-256. Capture errors and partial runs are labeled incomplete. The sealed receipt still determines worker outcome.

Native capture does not require an external executable. `asciinema` is useful for local playback and is installed only by the explicit checksum-pinned tool command. The remote command first previews the target and version checks; `--yes` performs a user-level install through the node's Clio tool installer. No sudo or service is involved. The separately installed asciinema program is GPL-3.0-or-later, and its license, README, and exact release source accompany the pinned install.
