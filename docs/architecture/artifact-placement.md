# Artifact Placement

Every file Clio Coder generates has one home, decided by who reads it. The rule that
follows from that: **the repo working tree holds files a human asked for.**
Anything Clio produced on its own initiative lands in the project-local
`.clio-coder/` directory or under the XDG directories, never beside your source.
`context init` can add the recommended blanket ignore for `.clio-coder/`.

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
| Script runs | `.clio-coder/runs/<runId>/` | Human transient and provenance |
| Tool-result and harness scratch | XDG state `scratch/`, with tool offloads grouped by session | Agent-to-agent |
| Evidence bundles | XDG data `evidence/` | Human transient (`clio-coder evidence`) |
| Approved memory | XDG data `memory/records.json` | Human transient (`clio-coder memory`) |
| Memory step log | XDG state `memory/steps.jsonl` | Human transient (`/memory`) |
| Session ledgers | XDG state `sessions/` | Agent-to-agent |
| Dispatch receipts | XDG state `receipts/` | Human transient (`clio-coder trace`) |
| Audit records | XDG state `audit/` | Human transient |
| Interview transcripts | XDG state `interviews/` | Agent-to-agent |
| Caches | XDG cache | Agent-to-agent |

`clio-coder paths` prints the resolved XDG directories for your machine. The
`/view` command browses a session's artifacts and verifies receipts.

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

### Config root: files an operator authors

| Path | Contents |
| --- | --- |
| `settings.yaml` | Saved settings |
| `credentials.yaml` | Credentials managed by `clio-coder auth`, mode `0600` |
| `profile.yaml` | Operator profile, overridden field by field by the project `.clio-coder/profile.yaml` |
| `agents/`, `skills/`, `prompts/`, `fleets/`, `extensions/`, `runtimes/` | User-tier resources of each kind |
| `plugins/` | Library package state (`state.json`) and one directory per installed package |
| `library.yaml`, `skill-marketplace.json`, `skill-promotion-declines.json` | Library catalog, marketplace registry and declined skill promotions |
| `mcp.yaml`, `mcp-trust.json` | User MCP servers and the trust records for project-declared servers |

### Data root: durable artifacts

| Path | Contents |
| --- | --- |
| `memory/records.json` | Reviewed long-term memory; see [evidence-and-memory.md](evidence-and-memory.md) |
| `evidence/<evidenceId>/` | Evidence bundles |
| `tools/<id>/<version>/<binary>` | Pinned external programs installed by `clio-coder tools install`, such as `cliamp`. The version is part of the path, so a pin bump installs beside the old copy. |

### State root: machine-produced state

| Path | Contents |
| --- | --- |
| `sessions/<cwdHash>/<sessionId>/` | `meta.json`, `current.jsonl`, `tree.json` and `prompt-manifest.jsonl`. `<cwdHash>` is the first 16 hex characters of the SHA-256 of the resolved working directory. |
| `audit/<YYYY-MM-DD>.jsonl` | Audit rows, one file per local day |
| `receipts/<runId>.json` | Sealed dispatch receipts |
| `runs.json`, `fleet-runs/<runId>.json`, `assignments.json`, `batches.json`, `agent-ledgers.json` | The run ledger, fleet run records and the durable dispatch stores |
| `gate-decisions/<id>.json` | Review and compete gate decisions; undecided ones sit in `gate-decisions/pending/` |
| `dispatch-admission.json`, `checkout-writer-leases/`, `cancel-requests/`, `code-steps/`, `write-boundaries/`, `runs/` | Capacity leases, writer leases, cancel requests, code-step state, write-boundary records and the run event journal |
| `dispatch-verification-memo.json`, `artifacts/<runId>/verification/` | Host verification memo and its captured artifacts |
| `route-history.json` | Route outcome history, a ring of 4,096 records, each with a `settled` label |
| `route-decisions/observations.jsonl` | Shadow-mode route observations, rotated to `.1` past a size bound |
| `evidence-index.json` | One row per built run bundle, a ring of 1,000 rows |
| `memory/steps.jsonl` | Proactive-memory step log, rotated to `.1` past 1 MiB |
| `usage/out-of-turn.jsonl` | Side-question, handoff, prewarm, background-memory, System One and failed-compaction usage |
| `trace.sqlite` | Dispatch trace mirror |
| `scratch/<sessionId>/` | Offloaded tool output and harness scratch |
| `interviews/` | Interview transcripts |
| `context-observations/`, `context-seeds/` | Recallable observations and worker context seeds |
| `protected-artifact-pending/<key>/` | Write-ahead records for pending protected artifacts |
| `workspace-trust/` | Per-workspace trust records |
| `systemone/` | The System One decision dataset |
| `cliamp/` | The `/music` player home: `config.toml`, `themes/clio.toml`, `playlists/clio.toml`, `plugins/clio-dock.lua`, `plugins/.trust.json`, `dock-taps`, and cliamp's own socket, log and history files. Clio Coder rewrites its generated files on each open, and never reads or writes the operator's own `~/.config/cliamp`. |
| `gui/` | Graphical application state: `workspaces.json`, `children.json` with `<name>.locks/` directories, and `background/` (`server.json`, `owner.json` and the generated `clio-coder-gui-<id>.service` unit) |
| `install.json`, `migrations.json`, `migration-reports/` | Install metadata and applied migration ids |
| `settings-shortcuts.json`, `recent-models.json`, `harness-profile.json`, `interop.json`, `hook-receipts.json`, `endpoint-slots.json` | Small per-machine stores |
| `lmstudio-ownership/`, `residency-locks/`, `git-hooks/v3/`, `startup/`, `watch-selection`, `watch-dock-taps` | Runtime ownership markers, locks, the managed Git hook, startup diagnostics, and the request and tap files shared with the workers dashboard |

The clean-exit session summary is built from an in-memory snapshot and is not
persisted. Sealed receipt facts (`src/domains/dispatch/receipt-facts.ts`) are read
back from `receipts/` and `runs.json` and have no file of their own.

### Cache root: disposable derived files

| Path | Contents |
| --- | --- |
| `v8-compile-cache/` | Node compile cache |
| `provider-target-models/<key>.json` | Per-target model discovery snapshots |
| `mcp-catalogs/<key>.json` | Cached MCP tool catalogs |
| `yazi/profile/` | The managed file-browser profile for the files pane |
| `system-one/julia-1-<revision>/tokenizer.json` | The Julia-1 tokenizer, downloaded when a `julia-1` engine is bound |
| `update-<fingerprint>.json` | Update-check state |
| `fleet-install-*` | Temporary directories while a fleet node installs Clio Coder |

## The project `.clio-coder/` directory

Generated content is listed in the placement table above. A project also keeps
authored files there, which the operator writes and may commit deliberately:

| Path | Contents |
| --- | --- |
| `settings.yaml`, `settings.local.yaml` | Project settings layer and its local, uncommitted counterpart |
| `safety.yaml` | Project safety policy |
| `rules/` | Path-scoped project rules |
| `profile.yaml` | Project operator profile |
| `agents/`, `skills/`, `prompts/`, `fleets/`, `extensions/`, `plugins/` | Project-tier resources; `fleets/commands.yaml` holds fleet commands |
| `library.yaml` | Project library catalog |
| `hooks.yaml`, `hooks.local.yaml` | Project hooks and their local counterpart |
| `mcp.yaml` | Project MCP servers, which need an explicit trust record |
| `verifiers.yaml`, `validation.yaml` | Declared project checks and the validation contract |
| `user-tasks.json` | The operator task list |
| `model-catalog.d/` | Project model-catalog overlays |

## The `artifact` tool default

`gateway(op="call", capability="artifact", args={kind: "plan"|"review"|"report", content: ...})` without a `path` writes to
`.clio-coder/artifacts/` under the workspace root. Passing `path` writes exactly
there instead, working tree included, because a path the user named is a file
the user asked for. A path that escapes the workspace is refused.

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

`clio-coder context init` checks for a blanket `.clio-coder/` ignore. With
confirmation, or with `--yes`, it appends `.clio-coder/` to `.gitignore` and prints
`.gitignore: added '.clio-coder/'`; without confirmation it warns, names `--yes`, and
leaves the file unchanged. A `.gitignore` that lists the four earlier narrow rules
(`.clio-coder/codemap.json`, `.clio-coder/codewiki.json`, `.clio-coder/state.json` and
`.clio-coder/handoffs/`) is rewritten to the single `.clio-coder/` rule without a
prompt, and init prints `.gitignore: updated '.clio-coder/' rule`. If the written
`CLIO-CODER.md` is itself ignored by Git, init warns and leaves that ignore rule alone. A project that has never
accepted or authored that rule can therefore see generated local state in
`git status`.

`clio-coder context reset` removes the accumulated context state
(`.clio-coder/codemap.json`, `codewiki.json`, `state.json`, `handoffs/` and `proposals/`) and
keeps `CLIO-CODER.md`, `CLIO-CODER.override.md`, `agents/`, `skills/` and `wiki/`.

Some `.clio-coder/` content is authored rather than generated, and a project
that wants it reviewed and shared commits exact files deliberately. With the
blanket parent directory ignored, child negations alone are ineffective because
Git does not descend into an excluded parent. Force-add an intentional asset,
for example:

```bash
git add -f .clio-coder/fleets/build-review.md
git add -f .clio-coder/rules/backend.md
git add -f .clio-coder/safety.yaml
```

Review the forced path before committing it.

## Finding what was hidden

Hiding transient output from the working tree must not mean losing it.

- `.clio-coder/artifacts/` is a plain directory; open it.
- `clio-coder evidence` lists and inspects evidence bundles.
- `clio-coder trace` queries the dispatch trace mirror and its receipts.
- `clio-coder memory` lists proposed and approved memory.
- `clio-coder paths` locates every XDG root.

Related: [evidence-and-memory.md](evidence-and-memory.md),
[trace-store.md](trace-store.md), [observability.md](observability.md),
[artifact-versions.md](artifact-versions.md),
[CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution rules.
