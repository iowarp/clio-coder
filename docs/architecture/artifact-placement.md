# Artifact Placement

Clio Coder assigns generated harness artifacts a home according to who reads them.
The placement convention is that **the repo working tree holds files a human asked for.**
The `artifact` tool defaults to the project-local `.clio-coder/` directory; other
harness stores use the project-local or XDG paths listed below. This convention
does not constrain every file an admitted `write`, `bash`, or script call can create.
Clio writes `.clio-coder/.gitignore` itself, so generated files stay out of Git and
what an operator authors there can be committed.

This page is the contract. [artifact-paths.ts](../../src/core/artifact-paths.ts) is the code that
implements the part of it the `artifact` tool owns, and [xdg.ts](../../src/core/xdg.ts) resolves the
four per-machine roots.

## Three audiences

| Audience | What it means | Where it goes |
| --- | --- | --- |
| Human deliverable | A file the user asked to keep, and will read and commit | Repo working tree, at the path the user named |
| Human transient | Something a human may want to read once; losing it costs nothing | Project-local `.clio-coder/` (normally gitignored) |
| Agent-to-agent state | Machine-read plumbing between turns, workers, and sessions | `.clio-coder/` for per-project state; XDG data/state/cache for per-machine state |

A class is human-facing only if a person is expected to open it. A plan an
agent wrote for its own next step is agent-to-agent state even though it is
Markdown.

## Placement by class

| Class | Location | Audience |
| --- | --- | --- |
| `artifact` tool plan / review / report | `.clio-coder/artifacts/PLAN.md`, `REVIEW.md`, `REPORT.md` | Human transient |
| Any artifact the user named a path for | that path, inside the workspace | Human deliverable |
| RCA write-ups for fixes | An issue comment posted only with the operator's confirmation, never a committed file (the `fix-issue` skill) | Human deliverable |
| Codemap index | `.clio-coder/codemap.json` (a legacy `.clio-coder/codewiki.json` is read when it is absent) | Agent-to-agent |
| Markdown wiki | `.clio-coder/wiki/` | Human transient |
| Codebase maps: native `context map` HTML | `.clio-coder/artifacts/maps/` | Human transient |
| Session exports from `/export` | `.clio-coder/exports/<sessionId>-<date>.html` unless a path is named | Human transient |
| Session context state | `.clio-coder/state.json` | Agent-to-agent |
| Task-memory handoffs | `.clio-coder/handoffs/handoff-YYYY-MM-DD[-slug].md` | Agent-to-agent |
| `CLIO-CODER.md` proposals from `context init` | `.clio-coder/proposals/CLIO-CODER-<timestamp>-<uuid>.md` with a `.json` provenance sidecar | Human transient |
| Task worktrees | `.clio-coder/worktrees/<runId>/` by default; `fleet.worktrees.root` can move the working tree to tmpfs or another directory, except when fleet nodes are configured | Agent-to-agent |
| Compete worktrees | `.clio-coder/worktrees/<group>/candidate-<n>/`, always under the project root | Agent-to-agent |
| Arena matches | `.clio-coder/arena/<matchId>/` (`match.json`, `contender-<n>.ndjson`, `contender-<n>.diff`, `vote.json`, and `vote.json.lock` only while a vote is being written) and the append-only `.clio-coder/arena/votes.jsonl`; contender worktrees use the compete layout, numbered by blind slot (A is `candidate-1`), and are removed after the match | Human transient |
| Research worktrees | `.clio-coder/worktrees/research-<id>-base/` and `research-<id>-it-NNNN/`, detached checkouts removed when the iteration is graded unless `--keep` | Agent-to-agent |
| Research campaigns | `.clio-coder/research/<id>/`: `campaign.json` (the frozen objective, budget, gates, scope, protected paths and check specs), `journal.jsonl` (one event per step, appended and synced), `samples/` (raw base and candidate measurements) and `slate.json` (each iteration's hypothesis), read by `clio-coder research`; the best commit is the branch `clio/research/<id>` | Human transient and provenance |
| Script runs | `.clio-coder/runs/<runId>/` | Human transient and provenance |
| Tool-result and harness scratch | XDG state `scratch/`, with tool offloads grouped by session | Agent-to-agent |
| Run evidence | XDG state `telemetry/runs/<runId>/`, the run's sealed telemetry scope | Human transient (`clio-coder evidence`) |
| Session evidence bundles | XDG data `evidence/` | Human transient (`clio-coder evidence`) |
| Approved memory | XDG data `memory/records.json` | Human transient (`clio-coder memory`) |
| Session ledgers | XDG state `sessions/` | Agent-to-agent |
| Telemetry journals, objects and seals | XDG state `telemetry/` | Human transient (`clio-coder telemetry`) |
| Interview transcripts | XDG state `interviews/` | Agent-to-agent |
| Caches | XDG cache | Agent-to-agent |

`clio-coder paths` prints the resolved XDG directories for your machine. The
`/view` command browses a session's artifacts.

## The four roots

`clio-coder paths [--json]` prints `config`, `data`, `state` and `cache` and creates nothing
(`src/cli/paths.ts`). Each root resolves in this order: the root's own variable
(`CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`,
`CLIO_CODER_CACHE_DIR`), then `CLIO_CODER_HOME/<role>`, then the platform default.

| Platform | config | data | state | cache |
| --- | --- | --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/clio-coder` (`~/.config/clio-coder`) | `$XDG_DATA_HOME/clio-coder` (`~/.local/share/clio-coder`) | `$XDG_STATE_HOME/clio-coder` (`~/.local/state/clio-coder`) | `$XDG_CACHE_HOME/clio-coder` (`~/.cache/clio-coder`) |
| macOS | `~/Library/Application Support/clio-coder/config` | `.../clio-coder/data` | `.../clio-coder/state` | `~/Library/Caches/clio-coder` |
| Windows | `%APPDATA%\clio-coder\config` | `%APPDATA%\clio-coder\data` | `%LOCALAPPDATA%\clio-coder\state` | `%LOCALAPPDATA%\clio-coder\cache` |

The roots must be absolute, distinct and non-nesting; every writer refuses an
unsafe layout before it creates or removes a root, and `clio-coder doctor` names the
problem.

### Config root: files an operator authors, and the records that vouch for them

| Path | Contents |
| --- | --- |
| `settings.yaml` | Saved settings |
| `credentials.yaml` | Credentials managed by `clio-coder auth`, mode `0600` |
| `profile.yaml` | Operator profile, overridden field by field by the project `.clio-coder/profile.yaml` |
| `agents/`, `skills/`, `prompts/`, `playbooks/`, `extensions/`, `runtimes/` | User-tier resources of each kind |
| `plugins/` | Library package state (`state.json`) and one directory per installed package |
| `library.yaml`, `skill-marketplace.json`, `skill-promotion-declines.json` | Library catalog, marketplace registry and declined skill promotions |
| `mcp.yaml`, `mcp-trust.json` | User MCP servers and the trust records for project-declared servers |
| `workspace-trust/` | Per-workspace approvals from `clio-coder config trust` |
| `migrations.json` | Applied migration ids, machine-written and kept beside the settings whose shape it records |

### Data root: durable artifacts

| Path | Contents |
| --- | --- |
| `memory/records.json` | Reviewed long-term memory; see [evidence-and-memory.md](evidence-and-memory.md) |
| `evidence/session-<sessionId>/` | Session evidence bundles |
| `tools/<id>/<version>/<binary>` | Pinned external programs installed by `clio-coder tools install`, such as `cliamp`. The version is part of the path, so a pin bump installs beside the old copy. |

### State root: machine-produced state

| Path | Contents |
| --- | --- |
| `sessions/<cwdHash>/<sessionId>/` | `meta.json`, `current.jsonl` and `tree.json`. `<cwdHash>` is the first 16 hex characters of the SHA-256 of the resolved working directory. |
| `telemetry/` | Every telemetry journal, object, seal and bundle, plus `consent.json`, `install.json` and `imported/`; see [telemetry.md](telemetry.md#layout) |
| `runs.json`, `fleet-runs/<runId>.json`, `assignments.json`, `batches.json`, `agent-ledgers.json` | The run ledger, fleet run records and the durable dispatch stores |
| `gate-decisions/<id>.json` | Review and compete gate decisions; undecided ones sit in `gate-decisions/pending/` |
| `dispatch-admission.json`, `checkout-writer-leases/`, `cancel-requests/`, `code-steps/`, `write-boundaries/`, `runs/` | Capacity leases, writer leases, cancel requests, code-step output logs, write-boundary records and run recordings |
| `dispatch-verification-memo.json`, `artifacts/<runId>/verification/` | Host verification memo and its captured artifacts |
| `settings-changes.jsonl` | One line per settings change `configure_clio` saved after operator approval: time, session, path and the changed `path: old → new` lines; never a secret ([configure-clio.ts](../../src/tools/configure-clio.ts)) |
| `claims/<sha256(project root)>.jsonl` | The append-only claims log of one project, read by `clio-coder claims`. It holds six line types: `claim` (a judged reproduce or numeric-compare verdict with its conditions), `edge`, `regression`, `hypothesis`, `check-start` and `hypothesis-test` ([store.ts](../../src/domains/claims/store.ts)). The project root is the realpath of the repository root, so every subdirectory shares one log. |
| `memory/banks/<sessionId>.json` | Same-session task-bank snapshot, consumed on resume; newest 64 retained ([task-bank-store.ts](../../src/domains/memory/task-bank-store.ts)) |
| `memory/recall-use-v1.json` | Per-record recall and use counts that demote memory a session keeps carrying unused ([recall-use.ts](../../src/domains/memory/recall-use.ts)) |
| `scratch/<sessionId>/` | Offloaded tool output and harness scratch |
| `interviews/` | Interview transcripts |
| `tui/` | The terminal renderer's crash dump `pi-tui-crash.log` (every rendered row, so the transcript), in a directory created mode `0700` |
| `context-observations/`, `context-seeds/` | Recallable observations and worker context seeds |
| `protected-artifact-pending/<key>/` | Write-ahead records for pending protected artifacts |
| `cliamp/` | The `/music` player home: `config.toml`, `themes/clio.toml`, `playlists/clio.toml`, `plugins/clio-dock.lua`, `plugins/.trust.json`, `dock-taps`, and cliamp's own socket, log and history files. Clio Coder rewrites its generated files on each open, and never reads or writes the operator's own `~/.config/cliamp`. |
| `mux/<hash>/`, `mux/locks/<hash>` | The private pane host of one project, keyed by a hash of its canonical Clio state root and project directory: `config/herdr/config.toml` with `clio-coder-workspace.json` (the managed herdr config, plus herdr's log and handoff socket, since herdr keeps its data beside its config), `state/` and the `pane-shell` shim; the lock serializes launches of that host. `mux/herdr-install-failed.json` records a failed launch-time herdr install (pinned version and time) so launches skip the download for a day or until the pin changes; a successful install removes it. Clio Coder rewrites the config on every launch, removes the whole root when the host stops, and never reads or writes the operator's own `~/.config/herdr`. The host socket and exit markers live in the runtime directory: on Linux `$XDG_RUNTIME_DIR/clio-coder/`, then `$TMPDIR/clio-coder-<uid>/`; on macOS `$TMPDIR/clio-coder/`; then `mux/run/` here and `run/` in the cache root, for a launch whose write fence makes the runtime directory read-only; else `/tmp/clio-coder-<uid>/`. A directory is skipped when the socket path in it would pass 100 bytes or it cannot be made owner-only and written. A clean quit's exit marker carries that Clio's exit summary to the launcher, which prints it after the host is gone. |
| `gui/` | Graphical application state: `workspaces.json`, `children.json` with `<name>.locks/` directories, and `background/` (`server.json`, `owner.json` and the generated `clio-coder-gui-<id>.service` unit) |
| `home.json`, `migration-reports/`, `workspace-conversions.json`, `restart-intent.json` | Install metadata, migration reports, per-workspace layout conversions and a pending relaunch |
| `live/`, `peer-inbox/`, `running-builds/`, `fleet-locks/` | Open-session heartbeats, messages between sessions, the builds running processes loaded, and fleet locks |
| `jobs/`, `provider-checkpoints/`, `sandbox/`, `fleet-preflight.json` | Background job records, provider checkpoints, sandbox state and the last fleet preflight |
| `extension-workspaces/`, `extension-dev-roots.json`, `library-receipts.json` | Extension working directories, registered dev roots and library install receipts |
| `settings-shortcuts.json`, `recent-models.json`, `harness-profile.json`, `interop.json`, `endpoint-slots.json` | Small per-machine stores |
| `lmstudio-ownership/`, `residency-locks/`, `git-hooks/v9/`, `git-hooks/v9-shim/`, `watch-selection`, `watch-dock-taps` | Runtime ownership markers, locks, the managed Git hooks and git shim, and the request and tap files shared with the workers dashboard |

The clean-exit session summary is built from an in-memory snapshot and is not
persisted. Route history is a fold over `run.settled` records in the run journals
(`src/domains/telemetry/route-history.ts`) and has no file of its own.

### Cache root: disposable derived files

| Path | Contents |
| --- | --- |
| `v8-compile-cache/` | Node compile cache |
| `provider-target-models/<key>.json` | Per-target model discovery snapshots |
| `copilot-sdk/sessions/<session id>/` | The Copilot runtime's records for one live `copilot-sdk` conversation, written through the SDK's `sessionFs`; removed when Clio closes the conversation |
| `mcp-catalogs/<key>.json` | Cached MCP tool catalogs |
| `yazi/profile/` | The managed file-browser profile for the files pane |
| `yazi/sessions/` | Per-pane DDS/chooser transports and owner receipts (host, PID and birth token). Removed on close; old receipts are swept only after their local owner is confirmed dead. |
| `system-one/julia-1-<revision>/tokenizer.json` | The Julia-1 tokenizer, downloaded when a `julia-1` engine is bound |
| `grammars/<package>@<version>/` | The Ruby and C# tree-sitter grammars for the code index, downloaded on first use and pinned by SHA-256. A failed download is recorded beside the cache path, and no process retries it for 10 minutes while that record exists; an unwritable cache directory lets the next process try again ([fetched-grammars.ts](../../src/domains/context/codewiki/fetched-grammars.ts)). |
| `data-readers/<package>@<version>/` | The HDF5, NetCDF and Parquet readers of the `data` tool, fetched as pinned npm tarballs on first use, with the same 10-minute retry window after a failure ([reader-assets.ts](../../src/tools/data/reader-assets.ts)) |
| `run/` | The pane host's socket directory when neither the runtime directory, `$TMPDIR` nor the state root's `mux/run/` can hold it (see `mux/<hash>/` above) |
| `skill-frontmatter.json` | Parsed `SKILL.md` frontmatter keyed by file path, mtime and size; dropped whole when the Clio version changes ([frontmatter-cache.ts](../../src/domains/resources/skills/frontmatter-cache.ts)) |
| `update-<fingerprint>.json` | Update-check state |
| `fleet-install-*` | Temporary directories while a fleet node installs Clio Coder |

## The project `.clio-coder/` directory

Generated content is listed in the placement table above and stays under the
working directory. A project also keeps authored files there, which the operator
writes and may commit deliberately. Inside a Git repository each authored entry
comes from the nearest `.clio-coder/` that has it, from the working directory up
to the repository root, and a new one is written at the root (`clioProjectRoot`
in `src/core/project-root.ts`). A `.clio-coder/` holding only generated files never
hides the root's configuration. Outside a repository only the working directory
counts. `verifiers.yaml` stays with the working directory because its commands run there:

| Path | Contents |
| --- | --- |
| `settings.yaml`, `settings.local.yaml` | Project settings layer and its local, uncommitted counterpart |
| `safety.yaml` | Project safety policy |
| `rules/` | Path-scoped project rules |
| `profile.yaml` | Project operator profile |
| `agents/`, `skills/`, `prompts/`, `playbooks/`, `extensions/`, `plugins/` | Project-tier resources; `playbooks/commands.yaml` holds the playbook command registry |
| `library.yaml` | Project library catalog |
| `hooks.yaml`, `hooks.local.yaml` | Project hooks and their local counterpart |
| `mcp.yaml` | Project MCP servers, which need an explicit trust record |
| `verifiers.yaml`, `validation.yaml` | Declared project checks and the validation contract |
| `user-tasks.json` | The operator task list |
| `model-catalog.d/` | Project model-catalog overlays |

## The `artifact` tool default

`gateway(op="call", capability="artifact", args={kind: "plan"|"review"|"report", content: ...})` without a `path` writes to
`.clio-coder/artifacts/` under the workspace root. Passing `path` writes exactly
there instead, working tree included. The tool accepts the caller's explicit path; it does not establish that the operator requested that path.
Normal tool admission still applies, and a path that escapes the workspace is refused.

The default is a pure function of `kind`, and has to stay that way. The action
classifier, the policy engine's write-root check, and the protected-artifacts
guard all predict where a pathless call will write, from its arguments alone,
before the tool runs. A default keyed on a session id or a timestamp would make
that prediction impossible and leave the safety layer guarding a path nobody
writes. The consequence is one file per kind: a second report overwrites the
first. Keep several by naming explicit paths.

## Task worktree placement

`fleet.worktrees.root` (default `disk`) chooses where a dispatched task's working tree lives
(`src/tools/worktree-root.ts`). `disk` is `<root>/.clio-coder/worktrees/<runId>`. `tmpfs`
uses `<base>/clio-coder-<uid>/worktrees/<sha256(root)[:16]>/<runId>` on `/dev/shm`, or on
`$XDG_RUNTIME_DIR` when that is an absolute path. `auto` uses tmpfs when it exists and has room,
and the project root otherwise. An absolute path uses `<path>/<sha256(root)[:16]>/<runId>`. Any
off-disk root needs free space for twice the tracked tree plus 256 MiB. Only the working tree moves; git
objects, the index and the branch stay with the repository on disk. A tmpfs that is missing or
too small falls back to the project root with a notice (`auto` with no tmpfs at all falls back silently), and any configured fleet node keeps
every task worktree under the project root, because a remote node reaches a worktree by the
project-root path alone.

## Script run records and retention

`run_script` creates `.clio-coder/runs/<runId>/` with `stdout.log`, `stderr.log`, and an atomically written `run.json` manifest (version 1). The id is a UTC timestamp plus six random hexadecimal characters. Source: [run-records.ts](../../src/core/run-records.ts) and [run-script.ts](../../src/tools/run-script.ts).

The manifest records script path, canonical path, byte size and SHA-256, interpreter name/resolved path/arguments, exact argv, workspace-relative cwd, timeout, start/end times and duration, environment key names, outcome, effective `exitCode`, observed `leaderExit`, signal, stream byte counts, log paths, input identities, output status, `cleanup`, and `pipeDrainIncomplete`. Environment values are never recorded there. Regular-file hashes cover at most 64 MiB; omitted hashes carry `too-large`, `cancelled`, or `unreadable`. These are observed identities, not immutable snapshots. Logs stream to disk and have no total byte ceiling; bounded terminal tails are not the full log.

Failure does not erase partial logs or outputs. Outcomes include `cleanup-incomplete` and `pipe-drain-incomplete`, with effective failure even if the leader exited zero. The first means original-group teardown could not be confirmed; the second means the one-second post-exit drain bound expired. Escaped processes can remain alive and outputs can still change. See [execution and cleanup](../guide/tool-usage.md#runscript-stream-a-scientific-processing-step-to-disk).

After each run, `sweepRunRecords` keeps the newest 100 completed records by completion time. Recent manifest-less directories are treated as active; those at least 24 hours old are orphan candidates. Retention reads at most 64 KiB per manifest. Oversized or malformed regular manifests fall back to opened-file mtime for ordering. Nonregular manifests, symlinked run directories, changed identities, and inaccessible entries are explicitly skipped and counted, not followed or silently removed. The sweep reports `removed`, `kept`, `active`, and `skipped`. This bounds metadata reads, not total directory enumeration or disk usage. Preserve needed evidence outside this retention tree before it ages out.

## `.clio-coder/` and git

Clio writes `.clio-coder/.gitignore` the first time it generates a file there, and
at session start for a `.clio-coder/` without one (`ensureProjectIgnore` in
`src/core/project-root.ts`). It ignores everything except `settings.yaml`, `safety.yaml`,
`hooks.yaml`, `mcp.yaml`, `verifiers.yaml`, `quality.yaml`, `validation.yaml`, `validation.yml`,
`profile.yaml`, `library.yaml`, `rules/`, `agents/`,
`skills/`, `prompts/`, `playbooks/`, `extensions/`, `plugins/` and `model-catalog.d/`, and `*.local.yaml`
stays ignored inside those too. An allow-list means a generated path added later stays
out of Git by default. The file ignores itself, so a project with only generated files
shows nothing in `git status`. Clio never replaces an existing copy, so an edit is kept.
The `grep` and `find` tools ignore this file for a search rooted inside `.clio-coder/`, because
it keeps generated files out of Git rather than out of reach.

Clio never edits the project's own `.gitignore`. A blanket `.clio-coder/` rule there, which
earlier versions of `context init` added, still wins, because Git does not descend into an
excluded parent. `context init` names such a rule; remove the line to commit authored files.

`clio-coder context reset` removes the accumulated context state
(`.clio-coder/codemap.json`, `codewiki.json`, `state.json`, `handoffs/` and `proposals/`) and
keeps `CLIO-CODER.md`, `CLIO-CODER.override.md`, `agents/`, `skills/` and `wiki/`.

Review the forced path before committing it.

## Finding what was hidden

Hiding transient output from the working tree must not mean losing it.

- `.clio-coder/artifacts/` is a plain directory; open it.
- `clio-coder evidence` lists and inspects evidence bundles.
- `clio-coder telemetry` reads, verifies and shares the telemetry journals.
- `clio-coder memory` lists proposed and approved memory.
- `clio-coder paths` locates every XDG root.

Related: [evidence-and-memory.md](evidence-and-memory.md),
[telemetry.md](telemetry.md#layout), [observability.md](observability.md#view),
[artifact-versions.md](artifact-versions.md),
[CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution rules.
