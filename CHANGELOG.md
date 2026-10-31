# Changelog

Notable changes to Clio Coder, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## 0.6.6 - 2026-10-31

Clio Coder 0.6.6 rebuilds telemetry as one system: one `telemetry` namespace, one event registry and hub, and journals per process, session and run under `<stateDir>/telemetry/` (#434). Every record names the acting agent, every journal is hash-chained, and a sealed scope directory is a self-contained bundle that `clio-coder telemetry verify` can check on another machine. `clio-coder telemetry share` prepares a redacted archive with a content-free, structural or research profile, and `telemetry import` verifies it into a separate namespace. Every TUI, CLI, ACP and desktop app usage figure comes from the same read model, with measured, estimated and unknown values kept distinct. Sealed run records replace receipt files, and journaled assessments replace the evidence directory. A hosted prompt cache stays warm while a turn waits on its tools (#423), a session cost ceiling stop reaches ACP clients and the desktop app with the raise that clears it (#424), and `clio-coder fleet land` lands the task branches a run kept. `@path` references inline only text Clio can bound (#438), workers refresh a rejected OAuth token (#427), gateway memory targets no longer derive a relevance engine (#429), and the ACP registry's auth check passes (#418). The desktop app opens on a desk of every project's sessions, explains usage from the number itself and shows session timelines and run replay. The Pi SDK moves to 1.4.0, and Clio names itself to providers and on its own sign-in pages.

### Upgrade notes

- Telemetry now lives only under `<stateDir>/telemetry/`: `process/<processId>/`, `sessions/<sessionId>/` and `runs/<runId>/` each hold `journal.jsonl`, rotated journal segments and their own `objects/`. Closing a scope writes its seal and `bundle.json`; resuming a session continues its chain and withdraws the bundle manifest until the next close. Session ledgers remain the conversation, and their embedded provider usage is no longer an accounting source.
- The first boot on an existing home runs a one-time cleanup that deletes `trace.sqlite` and its WAL and SHM files, `usage/` (including `out-of-turn.jsonl`), `receipts/`, the old evidence directory and `evidence-index.json`, `audit/`, `route-history.json`, `route-decisions/`, memory step and observation-event logs, `systemone/`, `startup/` and `telemetry/research/`. It also deletes old session call journals, objects, prompt manifests and context snapshots, old run event journals, and the `usage` field in each session's `meta.json`. Session conversations, memory state and run recordings remain. Copy any old telemetry you need before launching 0.6.6; the cleanup deletes it rather than importing it. Symlinks are left alone, and cleanup errors do not fail boot.
- There are no readers for retired telemetry formats, receipt versions, plain-line run journals or legacy ledger accounting. A session or run without a current journal reads as not measured. `clio-coder telemetry import-legacy` and `telemetry rebuild` are removed, and the session selector no longer shows spend from `meta.json`. Route history is a fold over run journals, with no route-history file or version migration.
- `clio-coder trace` is removed, including `trace inspect`, `sql` and `prune`. Read a session with `clio-coder telemetry inspect <session-id>`, a run with `telemetry inspect --run <run-id>`, and a live run with `clio-coder fleet view <run-id> --follow`. `trace code-steps <rootId> [--json]` moves to `clio-coder fleet code-steps <rootId> [--json]`. `CLIO_CODER_TRACE_RETENTION_DAYS` and `CLIO_CODER_TRACE_MAX_BYTES` are removed; `CLIO_CODER_TRACE_BOOT` still prints boot timing.
- `clio-coder telemetry export` and `import-bundle` are replaced by `telemetry share` and `telemetry import <archive>`. Select scopes with `--session`, `--run`, `--repo`, `--since` and `--until`, and choose `--profile content-free|structural|research`; `--out` names the archive and `--dry-run` previews it. The old `--structural` and `--research` export flags are gone. Sharing writes a local tar.gz and uploads nothing. Imported scopes live under `telemetry/imported/<installId>/telemetry/`; read them with `--imported <installId>` on telemetry read commands, separately from local totals.
- `clio-coder telemetry verify <scope-dir|archive> [--json]` verifies all covered journal segments, objects and seals. `fleet verify`, `/view verify`, evidence inspection and desktop run checks now verify the run scope. Receipt files, tombstones, the receipt integrity coverage map and `telemetry prune --receipts` are removed. `clio-coder evidence build` and `evidence inventory` are removed; `evidence list` and `evidence inspect <runId> --json` read the journaled assessment by run id.
- `clio-coder fleet inspect` is removed. Use `fleet status --json [--all]` for the run board and `telemetry inspect --run <runId> --json` for one run. Headless `run --agent --json` ends with a `{"type":"result","result":...}` frame carrying the run result instead of a `receipt` frame. Consumers of fleet, run and evidence output must use settled run facts and seal verdicts in place of saved receipt documents and paths.
- `telemetry.mode` (default `standard`, applies at the next turn) controls capture. Standard admits accountability and operational events with content-free or structural payloads. `research` adds the records selected by `telemetry.research.content` (default `false`), `deltas` (`true`), `providerHeaders` (`true`), `systemOneDataset` (`true`) and `busTrace` (`false`). Content also needs `clio-coder telemetry consent` for the workspace, stored in the state directory, and research capture has a 256 MiB cap per session. Project and local settings can lower capture but cannot raise it above user settings.
- `systemOne.record` is removed. System One dataset capture requires research mode, `telemetry.research.systemOneDataset`, content capture and workspace consent. `CLIO_CODER_BUS_TRACE`, `CLIO_CODER_MEMORY_TRACE` and `CLIO_CODER_OBSERVATION_TRACE` are removed with their file and stderr aliases. Memory, observation and bus research records use the telemetry journals and capture policy.
- `chat.cacheKeepalive` (default `true`, applies without a restart) controls hosted prompt cache refreshes. Each refresh is a paid request, journaled under the prewarm agent role (#423). `safety.limits.sessionCostUsd` now applies live, so raising it releases a request already parked at the ceiling (#424).
- `clio-coder telemetry prune` remains a dry run unless `--apply`. Its defaults are 90 days or 1 GiB for standard telemetry and 30 days or 4 GiB for research content, adjustable with `--days`, `--max-gib`, `--research-days` and `--research-max-gib`. Run pruning accounts for complete scopes, including objects and manifests. Live or locked scopes, fork parents a kept child reads and referenced runs are held. Nothing is pruned automatically.
- The exit card's tokens and cost cover the whole session on every branch, read from the read model, with this visit's call count beside the turns; in 0.6.5 they covered the current visit. Cost wording is shared across surfaces: `$0.42`, `~$0.42 est`, `$0.42 +?` for partly unpriced spend, `$0.00 local` and `not measured`. Sub-cent amounts keep up to eight decimals, and partial token totals read as lower bounds. Claude Code and Claude Agent SDK cost reports are estimates because they use client-side price tables. Scripts parsing CLI, `/export` or ACP display text must account for the new wording.
- `clio-coder usage report --json` emits the read model's report DTO for the selected repository and time window. The earlier fact rows, including `tokens`, `all-recorded-tokens`, `model-usage`, `session-cache`, `worker-tokens`, `worker-model-usage` and `worker-audience-usage`, are gone. Token and cost fields across telemetry, fleet and GUI contracts use facts and quantities with coverage and server-rendered displays; missing measurements no longer imply zero.
- ACP `_clio-coder/usage/read` v1, its types and capability advertisement are removed. Clients use `_clio-coder/telemetry/session`, `calls`, `cost`, `cache`, `timeline`, `run`, `runs`, `quota`, `health`, `why_stopped` and `explain`, advertised under `_meta["clio-coder/telemetry"]` version 1 and requiring authentication. Quantities carry facts, displays and explanation references; `_clio-coder/telemetry/update` coalesces invalidations to at most 10 per second. `usage_update` and prompt usage carry read-model quantities, and first-token timing refers to the first main-agent response. Terminal fleet frames and replay read the sealed run DTO. Evidence assessment notices identify `runId` instead of `evidenceId`.
- ACP `_clio-coder/context/ledger` adds `expectedColdReasons`, backend prefill timings and `uncachedPrefillTokens`. A cost ceiling stop arrives under `clio-coder/notice` and `clio-coder/budget` metadata, advertised in `initialize` and replayed on `session/load`, with the setting and raise that clear it (#424).
- Desktop HTTP telemetry routes serve session and run DTOs, costs, calls, cache, timelines, stop reasons and explanations. `GET /api/traces/status` and run `/phases`, `/gates`, `/processes`, `/events` and `/live` routes are removed, along with their trace-table types and the trace list's `source` filter. Fleet and trace rows carry read-model telemetry, settled run facts and seal verdicts instead of copied trace totals or receipt files. `GET /api/sessions/:id/usage` now contains `telemetry` and `telemetryQuota`; `LiveUsage` and turn usage use quantities with server displays. Evidence views and notifications use run ids. Rebuild API clients against the new contracts.
- Desktop `GET /api/sessions/overview` and `GET` and `POST /api/workspaces/:id/machines` are new; removal of a machine uses that `POST`. Session telemetry gains autonomy and budget state, problems can carry replacement model selections, and `telemetry.updated` names topics to re-read. Mutations may send `X-Clio-Epoch`; a request from an earlier server epoch is refused as a conflict.
- System One no longer derives a relevance engine from `context.memory` when the memory target is a `litellm` or `openrouter` target, a gateway, or a cloud or subscription runtime, even at a private address. Declare one under `systemOne.engines` to keep it (#429).
- The Azure OpenAI Responses API family is removed. No built-in runtime used it, a worker spec declaring `azure-openai-responses` fails validation, and the engine registers no adapter for it.

### Telemetry

- One event registry drives live delivery and journal capture with `subject.past_participle` names. Events cover calls, tools and final safety decisions, approvals, run admission and routing, gates and code steps, config and context changes, memory and observations, hooks and Library operations, worker middleware, lifecycle, boot, health and account quota. Each envelope carries the acting agent's role and instance, separate from the journal owner. A fork opens its own session scope and references its parent (#434).
- Every model call records its start and settlement, including main turns, workers, compaction, memory, System One, prewarm and keepalive, `/btw`, handoff, helpers and the safety judge. Settlement keeps disposition, stop reason, per-field facts, pricing source, admission and provider timings, first token, transport and cache evidence. Sessionless calls belong to the process journal. A call never sent counts no spend; interrupted streams keep reported lower bounds or explicit estimates, and a call settled before a crash still counts without a conversation-ledger message.
- A finished run persists `run.settled`, its result object, `evidence.assessed` and a terminal seal. The assessment keeps trust, findings, gate verdicts and failure attribution; later authenticated review-gate records are composed with the sealed assessment. Seals cover the journal and objects, and readers report verified, unsealed or failed integrity instead of accepting a second copy of the run's facts.
- The read model folds facts once for the footer, `/usage`, `/context`, `/health`, turn summaries, exit card, dispatch board, CLI reports, ACP and desktop app. Quantities retain measured subtotals when some calls are unknown, show measured zeros and expose the records and fold rule behind their explanations. `/usage` includes harness overhead and working-set recall cost; `/loop` and job cards read the turns their jobs ran (#422).
- `telemetry inspect`, `calls`, `cost`, `cache`, `timeline`, `why-stopped` and `explain` serve session or run data, with JSON DTOs and stable explanation references. Session spend covers its own branches and referenced worker runs; lineage is shown separately. Timelines include decisions, gates and memory activity. `why-stopped` names budget holds, their release and limited account windows. `telemetry doctor` reports capture, consent, journal health and seal state.
- `/health` reads process health samples, writer pressure, gaps, transport, quota, route breakers and System One breakers. Health and quota are journaled once per process. Shared-account quota consumption between readings is an estimate because other devices can spend from the same window; account credits, refresh failures and shared subscription identity remain visible. Lost journal records raise a bounded warning pointing at `/health`.
- Share profiles re-apply secret redaction and project records and structural objects through allowlists. Below research, free prose is withheld and private identities and paths are anonymized; the structural profile adds projected manifests, and research content requires the capture consent recorded for its scope. Each filtered scope is resealed over the archive's actual contents. Verification and import enforce the declared profile and scope integrity, and import refuses overwrites and symlink escapes.
- Research capture stores redacted prompt and request content in scope-local objects. Provider headers are allowlisted, delta capture keeps inter-delta timing histograms, and prefix and health samples record structural cache and timing detail. Accountability capture continues past the research cap, and gaps distinguish policy filtering from lost records. `telemetry consent [--workspace <dir>] [--revoke | --list]` manages content consent; revocation applies to subsequent capture and leaves already captured content on disk.
- `/context` uses the newest main call's cache evidence. Missing cache counts stay unknown, partial backend reuse is worded as partial, and llama.cpp timing-only cache reports use backend timings. The footer, thinking marker and transcript summary use journaled reasoning, with an estimate marker when needed. The board and fleet views use the run's first generated token and coverage-aware token and cost displays, and unknown context draws no zero meter.
- A Ctrl+D during a finished turn's persistence tail waits up to two seconds for settlement before exiting when no other work remains. A plan-close reminder held in a context of at least 128K tokens is delivered only on a continuation or a follow-up such as `continue` within five minutes in the same session (#431).

### Prompt cache

- While a turn waits on its own tools, above all an attached dispatch, Clio replays the turn's last request at 90% of the route's cache lifetime when the refresh is expected to save at least $0.05, with a capped output. It runs on routes with a known cache lifetime, including Anthropic, OpenAI Responses and Codex, for up to two hours behind an attached dispatch and one hour behind any other tool. It stands down while a permission ask or `ask_user` waits on you, between turns, on a runtime change and when a refresh would reach the session cost ceiling. Anthropic requests with budget thinking are skipped (#423).
- A cache break the host cannot otherwise name is attributed to idle expiry once the gap since the previous call reached the route's lifetime, or to a transport reset after a full frame followed a delta or a transport recovery. A target or model change, a rewrite of the replayed instructions after compaction, a tool-choice change and a Codex socket reset are now recorded as expected cold reasons. On Codex a `/thinking` change is no longer a candidate break cause, because the effort change travels as a configuration update and keeps the prefix (#423).
- The footer warns of a pending prompt recompile only when the compiled system prompt actually changed, so the second turn of a new session no longer reads `reuse uncertain`, and the pre-send reuse estimate clears once the call it describes settles (#423).

### Budget

- A session cost ceiling stop reaches ACP clients with the same notice the TUI prints, live while the prompt waits and again when the session is loaded. The desktop app shows it in a banner above the transcript with the spend against the ceiling, a `Raise ceiling to $X` button and a link to the setting, and clears it once model text, reasoning or a tool call arrives (#424).
- The raise a ceiling stop names is rounded up at four decimals, so typing it clears the stop, and the stop names its spend as estimated or partly unpriced when it was.
- Each `/btw`, `/draft` and `/handoff` attempt, a retry included, is admitted against the session cost ceiling inside its own call instead of once per round, and one whose session changed while it was held is refused (#424).
- `fleet run`'s preflight and the fleet preview word the remaining session budget with the spend's provenance, as an estimate or as `at most` when part of the spend is unpriced.

### Dispatch and fleet

- `clio-coder fleet land` lists the task branches finished runs kept, previews one with its commits, changes, destination and conflicts without changing anything, and with `--yes` lands it on the branch it was dispatched from, then removes its branch, worktree and claim unless `--keep`. `--squash` lands one commit and `--plan <id>` refuses a landing that drifted from its preview. A conflict is refused before the checkout changes, and the only step that touches the checkout is a fast-forward. Task branches record their base and source branch in Git config, and a withheld or rejected merge names `clio-coder fleet land <branch>` instead of `git merge`.
- When the orchestrator leaves a worker's stdout unread past its drain bound after a clean exit, the run now ends with exit 1 and its run result reports tool telemetry coverage partial, instead of a clean exit or a truncated frame blamed on the worker. That gap and a worker's own undrained stdout retry on the same route without charging its breaker (#425).
- A worker refreshes an OAuth token the server rejects and retries the round once, as main turns and side calls already did; a failed refresh names the target and the login command (#427).
- `run --agent` names `@file` attachments inside the workspace by their relative path, so they no longer fail admission with `legacy_scope_path_absolute`.
- `clio-coder agents validate [--json]` checks project and user agent recipes, project and user skills and the fleet profiles, rosters and bindings in `.clio-coder/settings.local.yaml` in one pass, prints each problem as one `file: field: message` line and exits 1 when any exist. `doctor` gains a `harness` row for each file with problems, and a write or edit that lands a recipe under `.clio-coder/agents/` appends that recipe's issues.

### Providers and models

- Pi 1.4.0 moves `pi-ai`, `pi-agent-core` and `pi-tui` together. Every request carries a `clio-coder/<version> (<platform> <release>; <arch>)` User-Agent and Clio Coder attribution, so OpenRouter, NVIDIA NIM and OpenCode no longer attribute it to pi, while Anthropic subscription OAuth keeps its Claude Code headers. A Codex body keeps its previous shape, so cached continuations survive the upgrade. On OpenAI-compatible runtimes a tool call whose arguments are not valid JSON fails with the parse error instead of an empty-arguments fault. Prompt templates keep a quoted empty argument's position, and `${ARGUMENTS:-default}` falls back when there is no argument or a single empty one.
- Logins identify as clio-coder: OpenAI's authorize URL carries `originator=clio-coder`, the loopback page shows the Clio mark, Anthropic's browser sign-in runs in Clio, and the `openai-codex` runtime sends a clio-coder originator and User-Agent. A target's own `auth.headers` still win.
- The OpenAI Codex quota row reads Clio's own `openai-codex` login, without a refresh and in a relocated home too, instead of the Codex CLI's `auth.json`, which showed another program's account. A separate Codex CLI row reads that file under the interop rules.
- A compaction summary's output cap divides the summary room by one minus the reasoning share recently seen on that route, at most 0.9, up to the model's output limit, and a reasoning route with no observation yet gets the whole limit, so the summary is no longer cut off before the checkpoint is saved. The fixed 8,192-token ceiling is gone on every route.
- A successful catalog or embedding probe reads at most 16 MiB of its body and fails with `response body exceeds the 16 MiB probe limit` past it.
- Bare `clio-coder auth status` lists each configured target that keeps its own credential, such as a `litellm` key stored as `target:litellm`, under its runtime.
- A System One breaker probe that is cancelled, or whose preflight spends its deadline, returns the breaker to half-open instead of leaving it refusing calls as `breaker-open` until the probe deadline.

### Attachments

- An `@path` reference reads only the first 4 KiB to classify a file. A zip, tar or gzip archive renders as `read` would list it, bounded at 32 KiB with the call that continues it; a binary file is named with its size and how to inspect it instead of refusing the submit; a text file over 256 KiB, a notebook included, is named and pointed at `read` with an offset and limit. Smaller text, non-UTF-8 text and notebooks still inline whole, and a PDF keeps its bounded extraction (#438).
- When poppler is missing, the PDF message names `brew install poppler` on macOS, `scoop install poppler` on Windows and poppler-utils elsewhere, and `doctor` gains a `pdf attachments` row that checks `pdftotext` and `pdfinfo` (#438).
- SIGINT while a headless run reads an `@path` inside its prompt stops the extraction, prints that nothing was sent and exits 130, as it already did for file arguments (#438).

### Updates

- Homebrew and winget installs now show the update notice with `brew upgrade clio-coder` or `winget upgrade --id IOWarp.ClioCoder --exact`, and never install an update themselves. A source checkout at a release version is told when a newer release exists, and the notice points at `clio-coder upgrade` for the git steps (#436).

### Tools and safety

- Bash output masks the exact values of credentials in the environment a command inherits and of keys Clio resolved, as `[redacted:known]`, in progress cards, model context, offloads and the operator shell record. Values shorter than 8 characters are not masked, and neither are `run_script` output and live `!cmd` progress.

### ACP

- Clio offers its `clio-login` terminal method to clients that announce terminal auth through `clientCapabilities._meta["terminal-auth"]` as well as `clientCapabilities.auth.terminal`, so the ACP registry's auth check passes, and the registry icon is the Clio mark (#418).

### Desktop app

- A figure the read model words opens its explanation from the number itself: the value, its coverage, the fold rule, and the calls, attempts, runs and records it came from. Trace run totals, a call's tokens and cost in the waterfall and the replay, the session overview's spend, the usage pane's totals and model rows, the usage page's window figures and the timeline's details carry it, and Escape or a press outside closes it (#434).
- A task's Timeline view, under Resources, lists every call, turn, tool, setting, budget and quota record its journal holds, newest first, in the server's words, with an entry-kind filter, stage bars on calls and each call's cache break billed from the session's cache report (#434).
- Trace history lists run journals newest first with the task, agent, route and status, and a run without a journal reads `not journaled`. A trace run page replays its journal's calls, run feed, worker process and settlement with play, pause, speed, entry search, an entry-kind filter and Home and End keys, draws each call attempt's recorded stages, and follows a live run by re-reading its journal every 2 seconds; it runs no commands (#434).
- A trace run page's Tokens and spend panel shows the run's input, output, cache, reasoning and total tokens, cost and model calls from its journal, then the same spend by the model each call settled on. Fleet and trace run rows read tokens, cost and model calls from the run journal too (#434).
- A run's checks come from the read model's seal-checked assessment and settled facts. Loading the full run record refreshes the integrity verdict beside it, so a changed or missing object cannot leave an earlier verified label on the panel (#434).
- The usage page ranks models by calls, tokens or cost with a per-model accounting panel that splits each model's spend into the sessions' own calls and the worker runs, shows each model's call share, and adds an Observed prefill work table per session. The conversation memory panel shows prompt cache evidence (#434).
- Every spend figure, quota share and context legend is the server's own wording, usage views refresh when the agent reports new telemetry, and a missing count reads `not recorded` instead of `0`. Evidence lists and pages show tokens, as a lower bound when calls or runs are unmeasured, and cost (#434).
- A window whose bundle was built for another Clio Coder version than the server's says so and offers Reload this window; it never reloads on its own. A bundle built before 0.6.6 carries no version and gets no notice.
- The Sessions page is a desk across every project, with counts for Needs you, Working, Ready to continue and active workers, search, a project filter and a Show more button. It replaces the Workspaces page at the same address.
- A Machines page registers an SSH machine with its host, user, port, worker capacity and labels, removes one after confirmation, and checks its readiness for the project picked on the page only when you ask; opening the page contacts no host. A project's task list gains sorting, the filters All work, Open sessions, Needs you and Saved history, and a link to the project's machines.
- The start page turns its starter prompts into cards, shows the project folder, connection and approvals before you start, and keeps the first task you typed in that browser tab through a workspace or connection failure, with Retry original request. The sidebar's New task opens the start page even with no workspace open, its search icon becomes a labelled Search action that opens the command palette, and a new Explore dialog groups every page with keyword search; the Library link moved into it.
- The composer's Actions dialog lists slash commands as plain-language cards whose forms keep their values and leave the message draft alone. An attachment can be previewed before sending, a note under the composer says what will happen to the message, and a picked PDF is refused with a pointer to type `@` and its path instead of "not UTF-8 text" (#438).
- Task details lead with changes, files and tasks, with model, context, usage and branches under More details. Stop turn and Close session work the same from the conversation, the desk and the menu, Close asks for confirmation, and a status notice follows the outcome across pages.
- A long conversation opens on its latest 24 turns with a button for earlier ones and returns to your reading position within the same window. Find in conversation searches requests and replies, long requests fold behind Read full request, branch history gains search and a filter, and a failed handoff keeps its edited draft.
- Settings tabs are renamed Model settings, Effective values and Sources & timing, Sources & timing gains search, and a setting saved elsewhere while you edit shows its saved value beside your draft. Connections group credentials and removal under one disclosure, and routing becomes tabs with Cached models. Toolchain, Skills and Other coding agents gain filters, Evidence gains search and a verdict filter, Evidence, Fleet and Traces gain sorting, and Help is organized into guides.
- A repeated identical background error shows once with its count, the autonomy indicator follows mode changes made through runtime commands, and a parked session that wakes keeps its own model and thinking choices instead of the app's cached ones. A refused turn names its reason, the model picker offers the replacements a refusing connection reports and points at Manage saved connections when the agent reports no connection selector, and model and thinking controls stay available without a configured target.
- A command sent before a server restart is refused instead of applied, the usage panel no longer shows figures from a previous runtime or branch, opening a detail while a reply streams keeps its place, and a failed saved-history read gives its reason and Try again instead of "No tasks yet". The task details body scrolls from the keyboard, and focus now lands on the branch history heading after Continue.

### Dependencies

- With Pi 1.4.0, `marked-cjk-friendly` 0.1.2 is bundled for pi-tui's CJK-aware Markdown emphasis, and its MIT notice ships in the package and `NOTICE`.

## 0.6.5 - 2026-10-29

Clio Coder 0.6.5 keeps itself current and is easier to run on shared machines. Native installs update in the background under a new `interface.autoUpdate` switch, and on Linux and macOS, npm, pnpm, bun and volta installs whose prefix the operator owns update after an interactive session quits and no other process of that install remains (#436). `clio-coder session list` and `clio-coder session terminate` find and stop sessions from any host that shares the state directory (#439). Long Codex sessions can hand compaction to the provider with `context.compaction.provider: native` (#423). Several reported rough edges are fixed: copies that never reached the clipboard (#437), `@`-attached PDFs that blew past the context window (#438), a startup of nearly a minute in large C trees (#441), Codex runs ended by a rejected `tool_choice` or an expired OAuth token (#426, #427), and gpt-oss on vLLM losing its reasoning and tool calls (#435). Durable dispatch settlement and transcript rendering left the main thread's hot path, so the TUI stays within its 50 ms p99 and 250 ms maximum lag bounds with three streaming workers (#428).

### Upgrade notes

- `interface.autoUpdate` (default `true`, applies without a restart) controls background updates. `CLIO_CODER_AUTO_UPDATE=0` and an install made with `--no-auto-update` still turn them off, and a version pin in the installer record still holds an install at its version. `clio-coder doctor` names whichever of these holds updates off and the last background result.
- `clio-coder upgrade` now prints the exact command it runs, or would run with `--dry-run`, and the version it installed. Installer upgrades no longer pass `--no-auto-update`, so an install whose auto-update was off only because it was pinned turns it back on when it moves to a channel.
- The `tui.input.newLine` keybinding now defaults to `ctrl+j`, `shift+enter` and `alt+enter`, so Alt+Enter inserts a newline under the kitty keyboard protocol as it already did in legacy terminals (#389). An `interface.keybindings` entry for `tui.input.newLine` replaces the default list as before.
- Every open session now writes a heartbeat record under `<stateDir>/live/` every 15 seconds; a record older than 180 seconds is stale.
- The System One relevance engine is derived from `context.memory` only when the memory target is local (a `local-native` runtime or a localhost or private address). A remote memory target no longer gets an implicit relevance engine; declare one under `systemOne.engines` to keep it (#429).
- `context.semantic.enabled` takes effect only when `context.semantic.target`, `context.semantic.model` and `context.semantic.assetIdentity` are all set. Otherwise semantic search stays off, the `context` tool does not offer it, and a one-time warning names the missing keys and `clio-coder semantic configure` (#432).
- `--api-key` binds to the target the run resolves after `--target` and `--model`. When no target resolves, `clio-coder run` exits 2 instead of ignoring the key.
- `clio-coder run` reads piped stdin even when a task argument or files are given, after the files. With another prompt source it waits 2 seconds for stdin and then continues with a note; redirect `</dev/null` to skip the wait.
- A host-assigned result contract that fails validation is now `result_contract_invalid` and retried as a model-quality failure. `result_contract_exhausted` is reserved for a worker whose own repair loop ran out (#425).
- A worker loop that ends without a final answer, including after a tool result or an aborted response, now fails with `worker_final_output_missing` and is retried on another runtime instead of ending the run as deterministic (#425).
- Traces no longer store text, thinking or tool-call deltas, and trace writes are batched per tick (#428).
- After a resume, eviction or compaction, replay resends the stored bytes of operator messages and tool results in full instead of the replay-capped copy, so a resumed context can be larger than in 0.6.4 (#423).
- Session-scope `/settings` overrides stay with the conversation that made them: a resume uses that conversation's overrides and a fork copies them. Each conversation also records its starting thinking level, which a resume restores.

### Updates

- Native installs from the installer update in the background once a day per install root, outside the idle gate. The notice says when an update is installing, when it landed (the running session keeps its version until restart, and `upgrade --rollback` undoes it) and when it failed, with the installer's last error line (#436).
- On Linux and macOS, npm, pnpm, bun and volta global installs whose prefix and `bin` directory belong to the operator now update after the session exits instead of only showing a notice; an in-place overwrite would break a running session's next lazy import. When an update is available, quitting an interactive session starts one detached wrapper that waits up to 30 minutes for every other process of that install to exit, runs the package manager for the exact version without sudo, and logs under the cache directory. The next launch reports `Updated` or the failure with its log path. A launch that starts while the update runs waits up to 120 seconds, then exits 75 and names the update log. Workspace panes and `/restart` children register with the launcher so the update waits for them too. Root-owned prefixes, Homebrew, winget and Windows keep the update notice with the exact command (#436).
- On those installs `/upgrade` no longer replaces the package while the session runs. It asks to install after you quit, arms the same deferred update, and names the other sessions of the install it will wait for, or says that an update is already pending. Qualifying pnpm, bun and volta installs get this too instead of only the manager command (#436).
- `clio-coder upgrade` from a shell on such an npm install refuses with exit 75 while another session, update or process of the install holds it, and lists each holder as pid@host. Otherwise it holds the update lease for the whole npm run, so a launch waits for it, and releases the lease when npm ends or the command is interrupted (#436).
- The version check reads `npm_config_registry`, so a mirror announces the version its package manager installs.
- `upgrade --post-install` migration notices are kept until the next interactive launch shows them.
- `install.sh` and `install.ps1` reclaim an installer lock whose pid is dead on this host and that is older than 10 minutes, along with its dead staging prefixes.

### Sessions and CLI

- `clio-coder session list [--json] [--stale]` lists sessions with their host, pid and last heartbeat, across every host that shares the state directory (#439).
- `clio-coder session terminate <id> [--reason <text>]` asks the owning process to exit; a session on another host sees the request on its next heartbeat and exits with the reason, and one on this host also gets SIGTERM. `--force` releases a session whose host stopped beating: it fences the old writer, frees the capacity leases and locks owned by that exact process and prints how to resume the session. It is refused while the owner is alive here, while a foreign heartbeat is fresh, or when the local clock disagrees with the state directory's file times (#439).
- `run --session` accepts a unique id prefix, `--continue` skips sessions without a model turn, and resuming a session that another live process holds is refused with its host and pid.
- A run that fails before any output still ends `run --json` with a `turn_end` frame, and `run --steer-channel` keeps UTF-8 split across writes and a final line with no newline.
- Workspace snapshots restore a file that was replaced by a directory, and replay keeps tool calls paired with their results when it skips failed turns.
- A session cost ceiling is persisted as a block that re-renders on resume and names the value to raise. A ceiling wait is no longer reported as a provider stall and retried (#424).
- Project-type detection classifies at most 256 C headers, evenly sampled, from their first 64 KiB, so a session in the Linux kernel reaches its first event in about 2.5 seconds instead of 54 (#441).

### Providers and models

- `openai-codex`: a rejected forced `tool_choice` is retried once with `auto` and remembered per target and model; Codex sends `auto` on required rounds. Receipts and `run --json` record each forced round's kind, choice and downgrade (#426).
- OAuth logins refresh five minutes before expiry, and a token the server rejects is refreshed once under the lock and the request retried, for main turns and for side calls such as compaction, `/btw` and memory. A failed refresh names the target and the login command (#427).
- gpt-oss on vLLM: reasoning and tool calls that arrive as raw Harmony frames are recovered into thinking and tool calls. A HarmonyError 500 before any output ends in `provider_harmony_error`, and a stop with neither text nor a tool call, such as a reasoning-only reply, ends in `provider_harmony_incomplete` instead of an empty answer; each gets one engine retry first. `clio-coder targets --probe --tools` reports the server's Harmony parsing level and the vLLM flags it is missing (#435).
- Inception targets serve Mercury 3 (`mercury-3`, the runtime's new default model) for chat and workers, and `mercury-decide` can back a System One decisions engine.
- A Codex WebSocket session that fell back to SSE tries the WebSocket again at an idle request boundary, backing off from 30 seconds to 5 minutes.
- A typed HTTP 408 is a transient target failure and retries on another target.
- `anthropic-max` quota windows are read from the rate-limit headers of each response for the account in use, and the served model id from `message_start` is recorded.

### Prompt cache and compaction

- `context.compaction.provider` (`off` by default, `native` to opt in) compacts an `openai-codex` session with Codex's own compaction on models that support it and stores the provider checkpoint under the state directory. Any other route, a `context.compaction.model` override or an unsupported model falls back to Clio's portable summary, and turning the setting off rebuilds a portable summary from retained history (#423).
- A mid-session autonomy change appends a policy message instead of recompiling the prompt, a Codex reasoning-effort change is sent as an inline configuration update, Anthropic required-tool rounds keep the full tool array, and the pinned prompt layer gets its own Anthropic cache breakpoint, so these no longer re-prefill the cached prefix (#423).
- Each call records why its cache prefix broke, and `clio-coder usage report`, `/usage` and `doctor` show estimated re-prefilled tokens. The footer warns before a send when cache reuse is uncertain after 5 idle minutes or a pending recompile (#423).
- Automatic compaction no longer runs on a session's first prompt, a split-turn summary states the active request as its goal, and working-set eviction is priced from the live request size (#422, #438).

### TUI

- Copy confirms through the system clipboard tools (`clip.exe` or `powershell.exe` on WSL and Windows, `pbcopy`, `wl-copy`, `xclip`, `xsel`, and the native clipboard on macOS and Windows) and flashes `Copied!` only when one succeeded. When OSC 52 is all it has, it flashes `Copy unconfirmed: <reason>; OSC 52 sent` (#437). A toolchain path the user cannot stat no longer crashes startup.
- `@`-attached PDFs reach the model as extracted text bounded at 32 KiB. A truncated attachment names the pages it includes and points at `read` for the rest; a binary file is refused before any model call (#438).
- Reading `@`-attached files can be canceled. While a PDF is extracted, the status line names it and the cancel key; Esc or Ctrl+C stops the read, sends nothing and puts the message back in the editor, and quitting stops it too. ACP `session/cancel` during the read ends the prompt with `stopReason: cancelled`, and Ctrl+C while `clio-coder run` reads its file arguments exits 130 before any model request (#438).
- Alt+Enter inserts a newline under the kitty keyboard protocol (#389), and Ctrl-Z suspends from overlays such as search, side questions, the context view and permission cards (#413).
- Worker-card repaints are coalesced, and transcript prose, reasoning and worker cards are reused across frames (#428).

### Dispatch and fleet

- Receipt, ledger, assignment, capacity and reservation settlement fsync through libuv instead of blocking the main thread, keeping the same durability; a run's terminal row lands in the same step as its receipt (#428).
- A read-only Scout may read one operator-approved checkout outside the workspace per run, with writes refused; headless runs refuse the read with `external_read_approval_required`. Worker write scope binds to the selected workspace under `run --cwd` and ACP (#433).
- Canceling the main turn leaves detached workers running with a notice on how to collect or rerun them (#425).
- A task merge into a checkout with a merge, rebase or other operation in progress is refused with `worktree_destination_busy` and leaves the operator's state alone.
- A fleet check step without its own gate also runs the test files earlier code steps changed, and changed `node --test` files under `test/` count.

### Tools and safety

- `verify` refuses a `Makefile`, `justfile` or `package.json` that resolves outside the workspace, is not a regular file or exceeds the size cap, and lists it under "Skipped during discovery" with the reason instead of running it.
- A project skills root (`.clio-coder/skills` or an interop root) that is a symlink pointing outside the repository loads nothing and warns, and a `SKILL.md` that is not a regular file is refused.
- `run_script` refuses to keep run records when its records directory resolves outside the workspace, describing an MCP tool in a read-only turn starts the server read-only, and write-target parsing skips literal heredoc bodies.
- Fuzzy `edit` no longer deletes the rest of a matched line, `find` and `grep` limits count visible results, typed git `diff`, `log` and `show` end revisions with `--`, and `web_fetch` honours the response charset.
- The plan-close nudge ignores pasted documents and quoted text, and the exploration advisory is dropped after an edit or an unrelated turn (#431).

### Settings

- A cyclic YAML settings layer is refused instead of aborting startup, the project settings watcher reattaches after its directory is replaced, approved layer errors are surfaced, `config inspect` keeps dotted map keys and true origins, and `/settings` exposes `context.compaction.maxTokens` as the context token ceiling.

### ACP

- Board, jobs, session tree, usage, extensions, context ledger, settings, queue and artifact methods require authentication.
- `session/load` restores the session's target and model, the model list includes catalog models, an undeclared model is refused with `model_not_declared` and a remedy, and malformed request ids, `initialize` calls, prompt blocks and permission replies are refused instead of crashing.

### Dependencies

- Shipped dependencies move to zod 4.6.6 (GHSA-mrhx-c7xc-m3w5), body-parser 2.4.0 with qs 6.17.1 (GHSA-27r3-jxmh-p828), and DOMPurify 3.4.17 in the bundled desktop client (GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr).
- fast-uri moves to 3.1.9 (GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp), ip-address to 10.7.4 (GHSA-rxp7-6hxx-x8q5) and @hono/node-server to 2.1.3 (GHSA-rmxm-3fg6-px4f), so `pnpm audit --prod` reports no advisories.
- The release gate also audits every package bundled into the desktop client at the exact version it ships, under the same policy as the shipped CLI dependencies: a high or critical advisory fails the release, and moderate and low ones are reported as notes.

### Usage and observability

- Failed calls record whether they were sent and where they failed; usage reports separate calls with unknown usage from calls never sent, and never-sent calls no longer count toward spending or a resumed session's cost (#430).
- Worker call counts and carried cost summaries fold correctly, and the exit summary covers only the current visit (#434).

## 0.6.4 - 2026-10-20

Clio Coder 0.6.4 rebuilds autonomy around two levels. At `default`, the main session's shell commands run contained in the OS sandbox, destructive workspace steps run after a workspace snapshot that `/rewind` can restore, and a safety judge reviews what would otherwise ask against the operator's own messages, so Clio asks only when the judge has no verdict or the decision belongs to the operator. `yolo` becomes a true skip-permissions mode: nothing asks, and only a short catastrophe floor, approved project rules and the run's ceilings block. It needs a one-time acceptance and is refused as root outside a container. Approval cards and questions nobody answers resolve after `safety.unattendedAfterSeconds`, so a long job no longer parks while the operator is away (#407, #419, #421). Compaction no longer stalls behind a skill turn (#422), memory lessons rest on exact command receipts, and dispatch admission, worker output and long session histories take bounded, faster paths. Long sessions also cost less: automatic compaction stops at a 200,000-token economic ceiling that stays under long-context price boundaries, a turn's scope, newly approved memory and re-probed workspace facts no longer rewrite the cached system prompt between turns, and a Claude subscription's main thread keeps its prompt cache for an hour (#422, #423).

### Upgrade notes

- `yolo` is now a skip-permissions mode, and damage-control confirmations and hard blocks other than the floor no longer apply at it (#407, #421). Only three things block a `yolo` call. The floor blocks deleting or shredding `/`, the home directory or an ancestor of it, or a system tree; `mkfs` and `wipefs`; writes to a block device; fork bombs; writes and deletes in Clio's own config, data, state and cache directories; a workspace trust grant from a tool call; and reads of Clio's credential store. Path rules in an approved `.clio-coder/safety.yaml` are evaluated alone, without the built-in defaults, and keep that file read-only while they hold. The run's ceilings are a read-only run, the turn's tool scope, an armed skill's tool surface, write roots and `safety.sandbox: required` on a host with no backend. Built-in zero-access paths such as `.env` and `~/.ssh/`, project settings, library changes, plan-scale dispatch, outward actions and information-flow refusals of mediated outbound tool calls no longer stop a `yolo` call, while a model request to a destination the session's labels refuse is still refused. A call admitted past a rail is audited as `yolo-admitted:<reason code>` and a floor block as `yolo-floor:<rule id>`.
- Under `safety.sandbox: auto`, `yolo` runs commands and scripts unsandboxed with the operator's credentials, where 0.6.3 ran yolo scripts in the OS sandbox. Set `safety.sandbox: required` to keep scripts sandboxed at `yolo`; with no backend it refuses them. At `yolo`, `ask_user` resolves at once with each question's first option and records the choice on the decision board as Clio's decision.
- The first interactive activation of `yolo`, from the leader key, `/settings`, `--autonomy yolo` or a saved `safety.autonomy: yolo`, shows a one-time acceptance card, and only an explicit accept records `safety.yoloAccepted: true` in user settings. A saved `safety.autonomy: yolo` that was never accepted starts the TUI at `default` and shows the card. Headless `clio-coder run --autonomy yolo` and an ACP client's mode choice count as acceptance and write nothing.
- `yolo` is refused for an effective uid 0 outside a detected container. Clio reads the `container` variable, `KUBERNETES_SERVICE_HOST`, `/.dockerenv`, `/run/.containerenv` and the cgroup of PID 1 as container evidence, and `CLIO_CODER_SANDBOXED=1` attests a sandbox the detection misses. A TUI that would start at `yolo` starts at `default` with the refusal as a notice, headless `clio-coder run --autonomy yolo` exits 2, and an ACP mode change fails with `yolo_refused`. Windows is never refused.
- At `default`, the main session's `bash` and `run_script` now run inside the OS sandbox whenever a backend exists and `safety.sandbox` is not `off`: bubblewrap on Linux, and on macOS a Seatbelt profile that has not been verified on a real macOS build. Windows has no backend, so nothing is contained there. A contained command may write the workspace, the scratch roots (`$TMPDIR`, `/tmp`, `/var/tmp`, `/var/folders` on macOS, and `safety.scratchRoots`), `~/.cache`, `~/.npm` and the repository's git directories other than hooks and config. It runs in its own PID namespace with the network on. Writes anywhere else fail, `~/.local` included. Credential variables are removed before the sandbox starts, secret files such as `.env`, private keys and `.netrc` under the workspace and scratch roots fail to open, SSH keys and the SSH agent are hidden, and new Unix-domain sockets are refused, so the `tsx` CLI, Python's `forkserver` start method (the Linux default from Python 3.14), local database sockets, Docker, and X11 and D-Bus clients fail with `Operation not permitted`. Clio reruns such a command with `unsandboxed: true`, which the safety judge reviews. `safety.sandboxPassEnv` lists variables to keep and `safety.sandboxUnixSockets: allow` turns the socket refusal off, both from user settings only; `safety.sandbox: off` returns the main session to the uncontained rails.
- Sandboxed worker commands also start without credential variables and cannot open secret files in their worktree and checkouts. The Unix-socket refusal applies to every bubblewrap sandbox Clio launches: the main session at `default`, workers, the MCP servers a worker starts and the extension runtime. `safety.sandboxUnixSockets: allow` lifts it in each of them, including an extension runtime started from the terminal session, a headless run, ACP, a worker's hook host, `clio-coder extensions run` or `clio-coder extensions validate`. A worker check that needs a local socket or a credential variable needs `safety.sandboxUnixSockets: allow` or a `safety.sandboxPassEnv` entry.
- At `default`, a main-session call that would park for approval is first reviewed by the safety judge, a model request on the chat route and model unless `safety.judge.target` or `safety.judge.model` names another. An allow runs the call with no card, and a block returns the judge's rule and reason to the model as a refused result. No verdict, such as a 30-second timeout, no route or an unreadable answer, falls back to the card when attended and to the denial in a headless run. Set `safety.judge.enabled: false` in user settings to have every such call ask the operator instead.
- At `default`, damage-control rules that blocked in 0.6.3, `delete-outside-workspace` and destructive git now ask, so the judge decides them against the operator's messages. Worktree discards (`git reset --hard`, a whole-tree checkout or restore, `git stash drop`, `git clean` without `-x`) and deletes inside the workspace or a scratch root run after a workspace snapshot instead. With no Git work tree or `safety.snapshots: off` they ask, and when the snapshot or a ref pin it needs fails they are refused with `snapshot-required`. The floor, path policy, authority rails and write roots still block, and workers keep the 0.6.3 blocks.
- `fleet.permissions.mode` gains `judge`, now the default. With the main session at `default` and the judge on, a native local worker's ordinary ask goes to the main session's judge, and an allow runs the call once inside the worker's permit and OS sandbox. Settings files created from an earlier template hold `fleet.permissions.mode: deny`, which Clio cannot tell apart from a deliberate choice, so the upgrade migrates a user-layer `deny` to `judge` once, at the first start of 0.6.4 or from `clio-coder upgrade`, and prints a notice naming the change and how to restore it. The rewrite keeps the file's comments, key order and quoting. A `deny` reached through a YAML anchor or alias is left as written and reported, and project settings are never changed. An operator who wants workers to keep refusing those asks sets `fleet.permissions.mode: deny` again; the migration does not run a second time.
- Automatic compaction is now bounded by an economic token ceiling, `context.compaction.maxTokens` (default `200000`), as well as by `context.compaction.threshold` times the serving window, whichever is smaller. Sessions on 1M-window models, which compacted near 800K tokens at the default threshold in 0.6.3, now compact much earlier, near 200K. Raise `context.compaction.maxTokens` to compact later. A model whose input price rises above a long-context boundary also caps the ceiling at 98% of that boundary, which the setting cannot raise: 98,000 tokens on `claude-haiku-5-5` and 196,000 on Gemini Pro models priced higher above 200K tokens.
- On `anthropic-max` (Claude subscription) targets, the main session's turn requests and the prewarm that replays them now write the prompt cache with the 1-hour TTL, as Claude Code does on the same subscription, so an approval wait or a long tool run no longer lets the cached prefix expire after 5 minutes. A 1-hour cache write is priced at twice the base input rate, against 1.25 times for a 5-minute write. Only the main thread uses it: workers, compaction, memory, the safety judge and side questions keep the 5-minute TTL, and the API-key `anthropic` runtime is unchanged. A target's `cache.retention` or `CLIO_CODER_ANTHROPIC_CACHE_RETENTION` still takes precedence; set either to `short` to keep 5-minute writes on the main thread.
- Optional background memory work on a subscription route Clio reads quota for, such as `anthropic-max`, `openai-codex` or the Claude Code and Codex CLI runtimes, now defers until a fresh quota reading exists. A step is skipped as `quota_unknown` until Clio holds a successful reading of that account with an unexpired window, and the next cadence tick decides again, where 0.6.3 ran the step with no reading at all. On `openai-codex` the reading comes from the rate-limit event on the session's own Codex responses, kept per target and per stored login for 5 minutes, so the Codex CLI's login no longer stands in for Clio's.
- `safety.unattendedAfterSeconds` (default `300`, user settings only, `0` waits forever) bounds how long a TUI approval card or `ask_user` round waits for the operator. An unanswered card is denied, never approved, and the turn continues, with the model told to take a route that needs no approval or record the open decision. An unanswered question takes its first, recommended option, a free-text question proceeds on the model's judgment, and an outward question resolves to not approved. ACP clients, the GUI, headless runs and worker escalations are unchanged, and harness cards and settings confirmations never time out.
- With `safety.snapshots: auto` (the default), Clio writes snapshot commits of a Git work tree under `refs/clio-coder/snapshots/<session>/` in the repository, with a private index under the state directory, on every surface and at both levels. The operator's index, HEAD and branches are not touched. Set `safety.snapshots: off` to take none.
- At `default`, typed `write`, `edit` and `artifact` calls on git control files ask under `git-control-file`, which the judge decides. A typed `git` add or commit, an uncontained `bash` call naming `git`, `gh`, `glab` or `hub`, or an uncontained `run_script`, after a hook file or command-running git config value changed during the session asks the operator under `git-hooks-changed`; the judge never decides it, and a headless run denies it.
- Clio's own git calls always disable `core.fsmonitor` and signature display, and its `diff`, `log` and `show` calls pass `--no-ext-diff --no-textconv`, so a configured fsmonitor, external diff or textconv driver no longer runs for Clio's status probes, receipts and views.

### Autonomy, containment and the safety judge

- The judge reads only the operator's typed messages on the session's active path, through the turn the judged call serves, and the proposed call with its secrets redacted, its action class, the asking rule and the consequence sentences Clio computes for the card. It never sees assistant text, thinking, tool results, project instruction files, a dispatch task or a worker transcript, so content the agent read cannot argue past it.
- The judge blocks destroying data outside the workspace and scratch roots, publishing, rewriting history, sending workspace data or secrets to an unrelated host, changing shared or system configuration, weakening Clio's safety, killing a foreign process, mass cloud deletes and running code fetched from the network, unless an operator message names that action. It allows actions the operator named, reads, installing a declared dependency, work in the scratch roots and task-local actions that plainly serve the stated task.
- `safety.judge.environment` lines describe the operator's machine in their own words, and `safety.judge.allow` and `safety.judge.deny` add rules to the judge's defaults. Every `safety.judge` key is read only from user settings and applies at the next review.
- Three consecutive or twenty total judge blocks in a session send the next eligible call to the operator with a card that says why, and an operator approval turns review back on. Worker and main-session blocks share the counts.
- The judge never answers these asks: `ask_user`, `configure_clio`, worker escalations and operator-authority asks, plan-scale dispatch, session consent, project settings, fleet routing, library installs, Clio-owned state and `git-hooks-changed`.
- Every review writes a `safety_judge` audit row with the verdict (`allow`, `block`, `none` or `escalated`), rule, reason, latency, route, the worker run id for a worker's ask and `operatorMessages`, the number of operator messages the judge received.
- A contained call no longer asks for an unrecognized command, hidden script content, command substitution, hidden quoting, a system change, a `cwd` outside the workspace or the session's one-time test-runner consent. Authored confirmation rules, a project command's `requireConfirmation`, library changes, project settings and deletes without a snapshot still ask.
- `bash` and `run_script` accept `unsandboxed: true` for a command the sandbox broke. That call, and outward actions such as `git push`, publishing commands, code-host and cloud CLIs, `ssh` and network writes, run outside the sandbox after the ordinary rails and the judge.
- A typed `write` or `edit` that lands strictly inside a scratch root, with no `.git` or `.clio-coder` directory on the way, is a plain write at `default` with no ask and no judge call.
- Headless `clio-coder run` at `default` gets containment, snapshots and the judge; every ask the judge does not allow, and every operator-only ask, is denied.
- The unattended countdown shows on the card and the interview, and any key stops it. A timed-out card is audited with `decidedBy: unattended`, an identical retry later in the turn is refused without parking again, timed-out `ask_user` answers appear on the decision board as Clio's decisions, and the exit summary gains an `Unattended` row.
- Project settings cannot set `safety.sandboxPassEnv`, `safety.sandboxUnixSockets`, `safety.unattendedAfterSeconds`, `safety.yoloAccepted` or any `safety.judge` key; a project value is ignored and reported as a layer issue.
- `clio-coder doctor` replaces the `yolo script sandbox` row with a `shell sandbox` row: contained with the backend, the writable roots, the number of masked secret files and the Unix-socket treatment, or uncontained with the reason. It warns when the secret-file search stopped at its limit or when sockets fall back to masks because the seccomp filter cannot load.
- Secret-file masks leave templates such as `.env.example`, tracked files with no uncommitted change, and dependency, build and virtualenv trees readable. The socket filter keeps `socketpair`, pipes, TCP and Node IPC working.

### Yolo

- Besides the command text, the floor reads each shell script the call runs by literal path, `run_script` with the `bash` or `sh` interpreter included, following `source`, `.`, `bash`, `sh` and `exec` up to three levels.
- The yolo prompt tells the model the operator is away, to take reasonable defaults, never to wait for an answer and to state every assumption in its final reply. The turn-ending contract ends turns `Done` and stops a requested plan at its stated assumptions instead of an approval card, and the plan-close nudge is off.
- A worker whose permit inherits `yolo` gets it for every action class inside its dispatch scope and OS sandbox, and its prompt carries a yolo worker fragment. A read-only or unmediated worker, or one whose recipe or task declares `asks: deny` or `asks: fail`, stays at `default`.
- `configure_clio` applies a fleet routing change directly at `yolo`, as it does every other setting.
- Workspace snapshots, the audit log and receipts stay on at `yolo`, so `/rewind` can still restore files.

### Workspace snapshots and /rewind

- Clio snapshots the work tree before the main agent's first mutating call of each turn and before every destructive call, bash delete, git discard, branch delete and `git reset` to another commit. Tracked files and untracked files that are not ignored are captured; ignored files, untracked files over 16 MiB and nested repositories are skipped and recorded. An unchanged tree reuses the last snapshot. Dispatched workers take no snapshots.
- Every snapshot pins HEAD and each stash entry, and a branch delete pins the branch tips it names, so `git gc` keeps those commits. Each session keeps its 50 newest snapshots, and sessions idle for 14 days are pruned.
- A snapshot that cannot be taken never holds an ordinary call; its result notes why.
- `/rewind` in the TUI lists the session's snapshots with how many files each differs by, previews a restore, takes a pre-rewind snapshot so the rewind can itself be rewound, then restores modified and deleted files and removes files the snapshot did not have. It never changes the index, HEAD or branches: it marks each pinned ref as in place, moved or gone and prints the `git branch`, `git reset` or `git stash store` command that brings it back without running it.

### Git hooks and Clio's own git

- The `git-control-file` ask covers a `.git` pointer file and, below any `.git` segment, `hooks/**`, `config`, `config.worktree`, `commondir`, `info/attributes` and linked-worktree and submodule control files, matched by name in any repository, one created mid-run included. It also covers the workspace repository's resolved set, including every `core.hooksPath` directory such as husky's `.husky`, which the shell sandbox keeps read-only. A worker at `default` asks for the same paths through `fleet.permissions.mode`.
- Clio fingerprints the hook files and the command-running git config values (`core.fsmonitor`, `core.sshCommand`, pagers, editors, diff, filter and merge drivers, credential helpers, gpg programs, shell aliases, `core.hooksPath` and others) of the workspace repository and the repositories a bounded walk finds in it, at session start. After drift, a typed `git` add or commit, an uncontained bash call naming `git`, `gh`, `glab` or `hub`, or an uncontained `run_script` asks the operator, whose allow accepts exactly the files the card showed. The transcript notes the first detection and the exit summary gains a `Git hooks` row.
- Under `fleet.permissions.mode: judge`, a worker's git call after drift goes to the operator and is denied with nobody attached. The worker sandbox keeps every hooks directory inside a writable root read-only.
- After drift at `default`, Clio's own hook-running operations, such as worktree add, merge, commit, branch delete and library sync, run with hooks pointed at an empty directory and each changed key overridden to run nothing, and its read-only git gets the same per-key overrides. Drivers present at the baseline, such as git-lfs filters, keep working. A key git cannot override from the command line makes Clio skip its own status and diff probes in that repository while the drift stands. The transcript notes it once and the exit summary gains an `Internal git` row. At `yolo` Clio's own git runs as configured and the drift is still recorded.

### Inference economy

- `context.compaction.maxTokens` (default `200000`) is an economic input ceiling independent of the serving window. Automatic compaction and working-set reduction trigger at the smaller of `context.compaction.threshold` times the window and the ceiling, and the working-set target scales down with it. The ceiling also stays at or below 98% of the lowest input-token boundary above which the model's input price rises, read from the model's price tiers, with built-in boundaries of 100K for `claude-haiku-5-5` and 272K for the GPT-6 family when a catalog row carries no tiers. Dispatched workers apply the same ceiling. `/context` shows it as `ceiling <N> tokens`, and a change applies at the next turn (#422, #423).
- A target whose serving window is unknown now compacts automatically when its input reaches the ceiling, where 0.6.3 turned threshold compaction off. `/context` reads `autocompact at ceiling (auto; serving window unknown)`, and request-fit accounting still needs a probed or configured window (#423).
- `anthropic-max` writes the main session's turn requests, and the prewarm that replays them, with the 1-hour cache TTL, so prewarm and turn send the same `cache_control`. The upgrade notes give its price and overrides (#422).
- A turn's scope (answer, proposal or change mode, delegation, skills, read-only and allowed tools) reaches the model as a `# Current task scope` block in that turn's `<system-reminder>`, kept verbatim in history. The session prompt compiles from the session's standing tool limits alone, such as operator flags or an ACP ceiling, so a scope change between turns no longer recompiles the system prompt. Admission still enforces the scope, and a dispatched worker gets the same lines as a task message (#423).
- The `# Memory` section compiled into a session's prompt stays until a completed compaction, a session switch or a recompile another input forces. A record approved or selected later reaches the model as a `# Memory update` block in the next turn's `<system-reminder>` and is not repeated while the history still carries it, and a record that only drops out of the ranking is not withdrawn. A record counts as delivered when its exact text is in the system prompt or inside host framing (#423).
- A config hot reload or a handbook edit no longer re-probes the session's git state into its prompt. The workspace facts captured for a session stay for the life of the process while the other session sources refresh (#423).
- Session-start facts no longer carry the local clock time, a relative age for the last recorded session or the new-conversation line. The last recorded session is dated by its timestamp and chosen against the session's own creation time, so a session resumed in a new process renders the same orientation (#423).
- The `tasks` and `decide` tool descriptions and the task-board reminder tell the model to chain known task updates and decisions with the next read or work step in one gateway `op=chain` call, and to trust the board a successful call returns instead of listing it again, so bookkeeping no longer takes a model round of its own. `done` still needs observed evidence, and a failed or partial update is reconciled before completion is claimed (#423).
- Background memory steps on a Codex route read the plan windows from the `codex.rate_limits` event of the session's own Codex responses, keyed by target and by a hash of the stored login's account. Quota views list those readings as `Codex (<target>)` beside the Codex CLI's (#423).
- A paid request parked at the `safety.limits.sessionCostUsd` ceiling is no longer aborted by the stall watchdog after `chat.retry.streamStallMs` as `no output from <target>` and retried into the same ceiling. A silent request that never reached the provider names the step it stalled in (request transform, authentication or budget admission) and says nothing was sent. The `[budget]` notice and the headless `budget_ceiling` error name the context tokens the parked request sends per call, a `budget_ceiling` refusal is never retried, and an aborted call that was never sent no longer puts an estimated prompt on the meter (#423).
- A main-session request that reached the provider and failed before the provider reported usage is recorded with null token and cost fields and `missingTokenCalls: 1` instead of zeros, so it no longer reads as a free call, and a response id now also marks a call as sent. A native worker's provider error keeps the usage its stream reported or marks it unobserved, and the headless `run --json` `agent_end` frame no longer reports `measured: true` for a segment containing such a call (#423).

### Compaction

- A skill loaded by a call that was not the first of its batch no longer clamps every later summary cut to the start of that skill turn. In a long single-turn task that left each automatic compaction at `no change` until the context window filled (#422).
- A skill load folded in from a dispatched worker no longer holds the main session's cut, and a slice that holds only bookkeeping counts as nothing to summarize, so no summarizer call is paid for it.
- An automatic compaction whose summarizer request is byte-identical, on the same route, to the last automatic request that ended without gain makes no call and settles `no change` with the reason `same history as the last summary without gain; no call made`. Forced runs and `CLIO_CODER_FORCE_COMPACT=1` always call the summarizer.
- A checkpoint held by the rearm band is silent: it shows no rail activity and records no operation.
- A settled `no change` compaction leads its rail message with the measured context size and names its reason, such as `141.9K tokens · nothing older than the protected skill turn to summarize`.
- A completed `Context compact` card without a summarized fact reads `· no summary`, because only eviction or masking ran and that output stays recallable.

### Memory

- A shell receipt vouches for the exact command it ran, and a successful pure `&&` chain run from the workspace root also vouches for each segment. A chain with `;`, `||`, pipes, substitution, another `cd` or a state-changing word such as `export` or `source` is not split, a call with a `cwd` other than the workspace root vouches for nothing, and a help or version call grounds no lesson.
- The memory gate holds an otherwise eligible lesson for the operator when an approved or operator-rejected record of the same repository already carries one of its `command:` evidence refs, so two wordings of one command no longer both pass the gate on their own.
- A memory reminder counts as delivered only when its exact text appears in a `<system-reminder>` block or `[middleware:<severity>]` note of an admitted request. An offer missing from three submitted requests is released, and one whose cited entry was rewritten or whose failure resolved is dropped before it is sent.
- Approved lessons in the `# Memory` section and in reminders name who stands behind them, `operator-approved` or `retained automatically`, and reminders carry their `Applies when` and `Avoid when` conditions.
- Lessons from the review of earlier sessions are saved under `<stateDir>/memory/history-candidates/` before the store is touched, and the review advances only once they are filed or saved, so a store failure no longer loses them.
- Completed-task retention that extracted lessons but bound none to a receipt or quoted source settles as `abstained` with reason `missing-source-evidence` instead of retrying.
- With `context.memory.observations.enabled`, a note citing an invented or unreadable source ref is dropped instead of its whole batch, reflections must account for every input and carry unrepresented constraints forward, and observer input drops thinking blocks and provider signatures. Compaction uses prepared notes only when the substituted request fits the summarizer window and is smaller than the ordinary one, and records `offer-used` with both input sizes in `<stateDir>/memory/observation-events.jsonl`, while the observation trace records `offer-declined` with its reason. Preparation waits until the context fills 0.4 of the main route's usable history, defers while that share is unknown, calls the observer only for a source group of at least 256 to 1,024 estimated tokens depending on the source budget, and yields between turns to a pending turn-boundary lesson step.
- Post-compaction restoration omits a bank fact the committed checkpoint already states in whole words.

### Providers and tools

- Behind a `litellm` or `openrouter` target, each model's streams are keyed as `<url>#model=<id>` and still counted under the gateway URL, so background memory no longer reads a foreground turn on another model as its own load and stops skipping steps as `endpoint_busy`. Dispatch admission and the settings endpoint rows keep their gateway totals.
- `code_nav` accepts `related=true` with `mode=symbol` or an exact-path `mode=outline` and returns one bundle of the definitions, the owning file, its direct imports, importers and test importers, 40 items by default across the bundle, with omitted counts and the call that lists each category in full. A symbol defined in several files returns the candidates instead of choosing one.

### Performance and runtime

- Dispatch admission no longer blocks the session while another process holds the shared admission lock: an uncontended request is admitted at once, a contended one waits with backoff, and each process renews all its capacity leases in one transaction. When a renewal fails or a lease has gone from the shared store, that process refuses new dispatches with a message naming the cause until a renewal succeeds or its runs settle, and a run holding a lost lease is stopped.
- The worker output lane is bounded on both ends. The orchestrator drops display-only frames first, never drops a receipt-bearing frame, and pauses the worker's stdout while evidence fills its bound. A run whose output trail cannot be complete fails instead of sealing as complete: stderr names the reason after `[worker] bulk output incomplete:` or `[worker] bulk evidence incomplete:`, and a clean exit code is reported as 1.
- The session ledger index grows in place and builds its snapshot only when a reader asks, instead of copying every earlier entry on each append. Paired probes over a 10,000-entry history measured 22 to 27% less append and read time and 45 to 48% less retained JavaScript heap.
- Optional relevance ranking no longer starts a call on the chat's own model or on an endpoint whose declared slots are all in use. A ranking started for a superseded task, session or branch is aborted and publishes nothing, and a cached ranking is reused only while the relevance binding's full configuration is unchanged.

### Installation and release

- `install.sh` installs only Clio Coder 0.6.0 or newer. A `--version` below that, or a rollback to an install below it, fails and leaves the active installation unchanged.
- The owner publishes the CI-qualified tarball to npm and forwards dist-tags from `pnpm run release`, because the release job's npm trusted-publisher exchange returns 404, and the release job checks that npm serves the qualified integrity before it writes the GitHub release, tag, `main` and website.
- The release workflow refuses to publish `dev` channel snapshots until npm trusted publishing from CI works, so an install following `dev` stays on its last snapshot.

### Fixes

- On `openai-codex`, a round that requires a tool now sends `tool_choice: "auto"` over the one narrowed tool, because the ChatGPT Codex backend rejects any forced choice. A coder worker's terminal result handoff on Codex failed with `Unsupported parameter: 'tool_choice' is not supported by rustponsesapi`, and the worker read reserve and middleware `require_tool` take the same fallback. A text-only round still sends `none` (#423).
- On Windows the `bash` tool resolves Git Bash from `PATH` or the standard Git for Windows locations and never the WSL launcher. With no usable bash the tool is not offered, `find` and `ls` stay attached, and dispatch admission drops `bash` so worker tool signatures still match (#421).
- At `yolo`, a `run_script` in Python or another non-shell interpreter is no longer read as shell lines, so a line such as `x > prev[i]` or a SQL string inside a Python literal no longer stalls or blocks an unattended run (#421).
- The GUI's refusal to take over another installation's background setup names `clio-coder gui background install --handover`, and the stale-build message says how to restart a background or foreground GUI server.

### Documentation

- The safety model page and the guides describe the two autonomy levels, containment, the safety judge, the yolo floor, workspace snapshots, unattended resolution, git hook drift and Clio's own git, with operator sections on choosing a level, `/rewind`, configuring `safety.judge` and running long jobs unattended. The README is reorganized around research workflows and onboarding, and the configuration guide lists `context.compaction.maxTokens`.

## 0.6.3 - 2026-10-17

Clio Coder 0.6.3 is the first stable release since 0.6.2 and includes everything published in 0.6.3-rc.1. Fleet workers can use MCP servers under explicit operator trust, an outside driver can follow, resume and bound a fleet or headless run, and tool ceilings set by a headless run, an ACP client or a prompt template are enforced. In the operator's own session, `yolo` drops routine approval asks while damage control stays on, and the scripts it lets run execute inside the OS sandbox. Claude subscription and Agent SDK targets list their models live, and a second terminal in the same folder always gets its own session. The [0.6.3-rc.1 entry](https://github.com/iowarp/clio-coder/blob/v0.6.3/CHANGELOG.md#063-rc1---2026-10-17) lists those changes in full.

Since 0.6.3-rc.1, the `/model` notice for a typed family name says which family it ranked, so its two counts no longer read as one set.

### Providers and sessions

- When `/model opus` or another family name matches several models, the notice names the family it ranked and how many of its models matched, or says the match was the newest by release date when every match is in that family.

## 0.6.3-rc.1 - 2026-10-17

Clio Coder 0.6.3-rc.1 is the release candidate for 0.6.3, published on the `beta` channel. Clio Coder 0.6.3 lets fleet workers use MCP servers under explicit operator trust, lets an outside driver follow, resume and bound a fleet or headless run, and enforces tool ceilings that a headless run, an ACP client or a prompt template sets. In the operator's own session, `yolo` drops routine approval asks while damage control stays on, and the scripts it lets run execute inside the OS sandbox. Claude subscription and Agent SDK targets list their models live. Memory now keeps commands a task proved to work and offers them when a later session touches the same files. Extension api 2 runtimes run in every host and in dispatched workers, and gpt-oss models keep their tool turns intact.

### Upgrade notes

- A project MCP server now binds the SHA-256 of every in-project file its launch names into its trust digest: an absolute command, each argument not shaped like a flag and each value a flag carries after `=` (such as `--require=./a.cjs`) that resolves to an existing file in the project. An imported module, a `python -m` module and a file reached through the environment are not bound. An existing trust for a server that names such a file reads as stale once after the upgrade, and the stale notice names the entry-script binding; run `clio-coder mcp trust <id>` again. Editing a bound file later makes the trust stale again. `mcp list` and `mcp trust` print `entry=<paths>`, or `entry=none` when the trust pins no file. An older build sharing the config directory drops the new `network` and `entryScriptHashes` trust fields when it rewrites the trust file and reads entry-bound digests as stale.
- With `CLIO_CODER_INTEROP_HOME` unset, Clio reads the operator's home for other agents' skills, prompts and inventory even when `CLIO_CODER_HOME` relocates Clio's own directories. A path names another home, and `CLIO_CODER_INTEROP_HOME=none` reads no foreign user roots, overrides an explicit agent home variable such as `CLAUDE_CONFIG_DIR` and turns off sibling quota credentials.
- A fleet node that runs workers carrying tool hooks needs a build that reads worker spec version 9. Specs without hooks still go out as version 8, so a node one release behind keeps working for them. A node that cannot read the version is reported as build skew, and the dispatch fails over to another node.
- Under any blocking tool hook, Clio refuses to dispatch to CLI runtimes and refuses ACP delegation, because neither can carry the hook.
- A native fleet worker's model response now ends after 600 seconds by default, and a round after a tools lockout ends after 120 seconds. Raise `safety.limits.workerResponseSeconds` for a slow local model that writes long answers.
- `/view` and the ACP artifact list no longer include the compiled system prompt. An ACP client that reads `system-prompt:current` gets `artifact_unknown`; the prompt manifest still shows the compiled fragments and their provenance.

### MCP

- Native workers can use MCP. A recipe names exact `mcp_<id>__<tool>` capabilities, admission refuses an untrusted or stale server by name, and the worker starts only the declaration its permit sealed, under the worker sandbox and at the task worktree root.
- `clio-coder mcp trust <id> --network` grants one project or plugin server network inside a worker sandbox, and a user declaration grants it with `network: true`. On Linux the granted server runs in the host network namespace, so it reaches the internet, services listening on localhost and abstract Unix sockets. Credential masking in the sandbox is a denylist of known paths, so any other secret readable in the home can leave through a granted server. A worker keeps the grant only when none of its write roots contains or lies inside the server's launch cwd, the directory of a bound entry file, or for a project server the project root, so in practice only read-only workers keep it. Admission and the dispatch result name each withheld grant with its reason. Worker shells and other servers keep the run's network policy. `mcp list` and `mcp test` show each server's grant and where it came from.
- `clio-coder mcp test <id> [--call <tool> [--args <json>]]` starts one declared server through the gateway's own client and records each call's result or error.
- An installed plugin's `mcp.json` servers are declared under explicit trust and stop when the plugin is disabled, removed or changed. A foreign package's `mcp.json` is skipped unless project imports are trusted.
- MCP tools are classified through one trust-first classifier. Annotations serve as advisory action-class defaults for untouched user declarations, operator overrides win, `mcp list` shows per-tool classes and `mcp list --refresh` refreshes them.
- Interrupting an in-flight MCP call sends `notifications/cancelled` and keeps a responsive server available. A trusted server that fails reconnects on the next gateway call, and a cancelled call is never replayed.
- Repeated read-only idempotent polls spend the normal call budget instead of tripping the identical-argument loop guard.
- Text `clio-coder mcp test` output names the network grant and its source, as `mcp list` does.

### Safety and limits

- In the operator's own session, `yolo` relaxes routine approval asks for work outside the workspace, edits, scratch cleanup and commands judged safe by their targets. Damage-control confirmations, protected paths and the irreversible-action net still apply, and dispatched workers keep their existing ceilings.
- Only user settings can set `safety.scratchRoots`, which adds scratch directories for `yolo` cleanup and script writes; project values are ignored. Config validation rejects relative paths, the filesystem root, the home directory and its ancestors, system trees outside conventional temp directories, and mount roots and parents under `/mnt`, `/media` and `/Volumes`. Runtime resolution also drops roots that cannot be resolved, resolve to those excluded paths, or contain the workspace.
- Under the operator's `yolo`, Clio scans supported shell script files it can read within the scan's bounds, follows nested scripts and judges their lines against the safety rules. A blocked line blocks the script.
- With `safety.sandbox` at `auto` or `required` and a backend available, those scripts run through bubblewrap on Linux; on macOS, Clio selects `/usr/bin/sandbox-exec` with a seatbelt profile after its availability probe succeeds.
- The script sandbox policy permits writes to the workspace, effective scratch roots including the host's `/tmp`, the repository's Git directories, the XDG cache directory and `~/.npm`. It marks Git hooks, config, `commondir` and `.git` pointer files, Clio's own directories, the workspace's `.clio-coder`, and `.git` and `.clio-coder` inside scratch and cache roots as read-only. Existing `~/.npm/_npx` and the XDG cache's `pre-commit`, `node/corepack` and `uv` directories are also read-only; `~/.local` is not a writable cache root. Known credential paths and runtime sockets are masked.
- Without a sandbox backend, `safety.sandbox: auto` leaves scripts unsandboxed under the static scan; `required` makes them ask for approval. With `off`, scripts use the static scan without a sandbox even when a backend is available.
- `clio-coder doctor --deep` reports the operator's effective `yolo` rules, whether scripts run sandboxed and where they can write.
- `clio-coder config inspect` shows effective `safety.limits` values.
- `clio-coder run --read-only` without `--agent` is an enforced ceiling on the main agent, and only MCP servers the operator classes as read start under it. A call the ceiling refuses does not fail the run.
- Every refusal says what refused it and puts its remedy on its own line, and an identical repeat in the same turn is refused without running.
- `--allow-tools` and `--delegate-tools` limit an interactive or ACP session's tools. Every turn runs under them, and `/run`, `/delegate`, `/council` and `/fleet` carry them to every worker.
- An ACP client can set a capability ceiling per session and per prompt. Clio advertises it, screens slash commands, shell lines and fleet runs against it, and carries it through fork, handoff and `session/load`.
- Prompt template `allowed-tools` now narrows the template's turn, and `delegated-tools` sets the ceiling its dispatched workers get. Neither widens the session's limits, and imported skills and commands keep their own narrower tool lists.
- Attended sessions ask once before the first test runner of each session, whoever wrote the code, including a dispatch or job host check. Headless runs keep their existing allow.
- `clio-coder run --max-cost-usd <n>` bounds the run's priced spend. The run stops with exit 4 and `budget_ceiling` when it reaches the cap, and warns about any unpriced route it cannot bound.
- Main-runner jobs accept an explicit `allow` capability list. It intersects inherited task constraints, holds on every occurrence regardless of autonomy, and shows in job creation and monitor output.
- Project extension and plugin trust pins package identities, so reinstalling identical content or disabling a package keeps consent, while a changed trust flag, capability envelope or plugin kind asks again. `config trust extensions` and `config trust plugins` list each package with its origin and trust, disabled ones included. An operator install approves only the records still carrying the content digest it wrote, so a record another writer replaced during the install stays unapproved.
- A per-target `--api-key` override satisfies an OAuth target again.
- Exact toolchain version probes such as `node --version`, `go version` and `python3 -V` run without an ask, so a fleet worker in deny mode is no longer ended by them.
- A tool surface refusal names what narrowed the surface (`--allow-tools`, a named template's `allowed-tools`, `--delegate-tools`, a job's `allow` list, or a recipe or dispatch scope) and gives the remedy on its own line. Inside a restricted surface every name outside it gets the same refusal, which lists the admitted capabilities, so a run cannot probe which other tools exist. Only an unrestricted run answers that a capability does not exist.
- The `--read-only` remedy tells the operator to rerun without the flag, and a run stopped by `--max-cost-usd` reports `budget_ceiling` without endpoint-failure wording.
- When a worker's tool list exceeds the parent task's tool ceiling, the dispatch refusal names the source and remedy, including the option to use a narrower `tool_profile` or recipe.
- A bounded tool result carries a retrieval hint only when output was actually omitted.
- Once the loop guard or the soft tool budget turns tools off, turn-end reminders no longer ask for another tool call.

### Fleet

- `clio-coder fleet events <root>` prints a fleet's hash-chained event journal, `--json` writes the stored NDJSON lines verbatim and `--follow` keeps reading until the fleet seals. Each settled step writes a verifiable manifest checkpoint.
- Fleets resume from the TUI, ACP and the desktop app as well as `fleet run --resume`. Every surface validates the prior root against the plan and shows the replayed steps in the preview.
- One cross-process lock per git checkout keeps two fleets from running in the same workspace. A refused CLI run exits 1, and a stale lock from another host is reclaimed once its holder stops refreshing it.
- Receipts count only provider calls and record how each ended, and a worker's receipt records the MCP tools its permit attested.
- Fleet verification counts cancelled check attempts.
- Fleet verification keeps checks completed before a sibling's cancellation.
- A native worker's model response is bounded: 600 seconds by default (`safety.limits.workerResponseSeconds`), and a round after a tools lockout or synthesis lock gets 120 seconds and at most 4096 output tokens, with thinking turned off where the route allows it. The deadline starts after a local model has loaded. A worker that reaches a bound fails with `worker_turn_timeout` or `worker_output_cap_exhausted` and is neither retried nor charged to the target's breaker.
- Ctrl-C, SIGTERM and SIGHUP on `clio-coder fleet run` seal the journal as aborted and release the checkout lock before the run exits with 130, 143 or 129. A second Ctrl-C exits at once after writing a forced seal.
- The approval preview shows the plan hash the journal records and labels the approval fingerprint separately. Preflight checks the standing delegation ceiling, the ledger tools of concurrent workers and shadow agents, so a plan that cannot run shows its refusal with no accept key and writes no journal. `playbook validate` refuses shadow agents too.
- Each step line prints once, on stdout, and `fleet events`, `fleet status`, `fleet view`, `trace` and the export commands exit quietly with status 141 when the reading end of their pipe closes.
- `/view` shows a worker's recorded output and changed paths, with path text sanitized, and says changed paths were not recorded when the host observed none.

### Extensions

- Extension api 2 hooks, runtime tools, observations and maintenance ticks run in `clio-coder run` and ACP sessions as well as the terminal. With no interview channel, an interview step is cancelled with reason `headless` at once instead of waiting.
- The session's tool hooks apply to dispatched workers' calls under `fleet run`, `run --agent` and in-session dispatch. A lost hook answer fails closed by the hook's stricter policy.
- A hook can name MCP tools by family with a trailing `*`, and hooks with tool-args access receive the link-resolved path each file tool lands on and the workers a dispatch will start.
- `clio-coder fleet run` checks every step's route in preflight and refuses a playbook before any step runs when one hooked step's runtime cannot carry a blocking hook.
- `clio-coder context wiki` and `clio-coder context init` run their workers under the command's own extension host. When that host fails to start and a blocking hook applies, they refuse before dispatching, and `context init` falls back to its heuristic bootstrap.
- Hook landings report a read-only recipe's workers as read-only with no write roots, and prompt templates that name extension tools load without a warning.
- A `before_tool` hook rewrite that only narrows a dispatch keeps the operator's approval. Widening grants, read scope, write roots, expected outputs or context, changing other approved input, or a rewrite Clio cannot prove to be a narrowing drops that approval.
- Hook receipts reach disk shortly after each call instead of waiting for the next call or for exit.

### Memory

- Memory keeps commands a completed task proved to work from its own receipts, whatever the lesson model answers, and offers them on the session's own actions: its first code change, a read, edit or run of a file the lesson names, and a failed run of the same program on the same file.
- A retention a process left unsettled is finished by the next process from that session's ledger.
- `/memory` opens on the lessons the session can reach and shows what each concerns, whether the main prompt carries it, its evidence and its track record.
- Opt-in `context.memory.observations.enabled` prepares source-linked notes that compaction can use in place of the history they cover.

### Providers and sessions

- `anthropic-max` lists models live through Anthropic's Models API with the subscription login.
- `claude-sdk` lists models through the Agent SDK's `supportedModels()` and reuses a fresh cached list without starting Claude Code.
- A typed model family name picks the newest dated match and says which model it chose.
- The TUI and `/model` show a one-line notice when the cached list has a newer model in the configured model's family, using provider dates for both models.
- The GUI reuses an untouched draft only in the window that created it.
- `/resume` and the session picker refuse a session that is live in another terminal and name its pid. A session whose process is gone stays resumable.
- A TUI started in a folder where another session is live prints one line saying so and says this terminal has its own session.
- A chat turn whose OAuth login cannot be refreshed reports "OAuth credential could not be refreshed. Run clio-coder auth login <provider> again." instead of a missing API key.
- gpt-oss models keep their reasoning on replayed tool turns and no longer send text, reasoning and tool calls in one turn.
- Out-of-turn rounds ask for an explicit thinking level.
- Live and resumed transcripts, copied views and Markdown and HTML exports attribute each assistant turn to its recorded provider and model, and exports show model changes where they happened.
- `/btw` and `/draft` answer while a turn is running, over a snapshot of the history, without touching the turn. A tool call that is still running is reported to the side model as still running, and a side answer that is only tool-call markup shows a note instead. `/handoff` still refuses during a turn.
- `/loop` and the `job` tool run a loop's first iteration when it is created, then every interval.
- `/loop cancel` without an id cancels the sole active loop; with several active loops it reports that a job id is required and directs the operator to `/loop list`.
- `/model <name>` resolves a bare model id only to targets that can run chat, prefers the active chat target, and names the competing targets when the name is ambiguous.
- Ctrl-Z suspends the interactive terminal on Linux and macOS, and `fg` resumes it with a full redraw. The binding is `clio-coder.suspend`; Windows shows a notice instead.
- Only the process that `/restart` started can claim the restarted session, so a second terminal opened in the same folder right after a restart starts its own session.
- A refused or failed edit row reads "edit failed", the `/model` apply menu shows its full label, and the exit summary docs match the styles and rows the renderer prints.
- Terminal gateway rows distinguish a failed call from a safety refusal and name the capability that was called.
- The settings center explains `safety.limits.workerResponseSeconds` in seconds.
- `clio-coder doctor` reports only running processes that belong to the home it checks.

### Documentation

- The bundled guide and architecture pages were checked against the source and corrected, and their sections are titled and opened in the words operators use, so Clio's own docs search finds the answering section more often. In a checkout the docs search skips the generated wiki, as the npm package already does.

## 0.6.2 - 2026-10-09

Clio Coder 0.6.2 is the first stable release since 0.6.1 and includes everything published in 0.6.2-rc.1 and 0.6.2-rc.2. It separates plugins from extensions: a plugin carries content, and an extension is Clio code that runs in its own sandboxed process and loads only after you approve the capabilities it declares. Fleet contracts are now playbooks, proactive memory runs on the chat route within that route's budget, `/loop` schedules turns and command polls, `/reload` and `/restart` apply changes in place, and the desktop app gains an integrated window title and Manage context. The [0.6.2-rc.1 and 0.6.2-rc.2 entries](https://github.com/iowarp/clio-coder/blob/v0.6.2/CHANGELOG.md#062-rc2---2026-10-06) list those changes in full.

Since 0.6.2-rc.2, Clio Coder moves to Pi 1.1.0, adds an opt-in semantic context index and worker recording, makes wiki generation reliable and accountable for its cost, and tightens dispatch safety, usage accounting, the desktop app and the terminal interface.

### Engine and semantic context

- Upgrade the Pi engine packages to 1.1.0 for native Haiku 5.5 catalog support and updated Anthropic provider compatibility.
- Add an opt-in EmbeddingGemma 2 Q8 service and persistent semantic context index for code, scientific inboxes, approved memory, evidence, and recorded dispatch output. The agent and CLI receive bounded, attributed search results; exact profile identities isolate vector spaces, and an explicit offline command reembeds old canonical records under a new profile. Approved API 2 extensions can call the host embedding service through a declared capability without receiving model credentials.
- Add explicit local or SSH worker recording as a bounded asciicast side channel with redacted evidence exports. Add a checksum-pinned asciinema installer and a previewed user-level fleet provisioning command.
- Keep background indexing disabled by default. PDF text, notebook outputs, images, mono 16 kHz WAV audio, and bounded timestamped GIF/video still frames are supported where the image route is qualified and FFmpeg is available. Raw video embedding and scanned PDF OCR remain unsupported. See the [semantic context beta guide](https://github.com/iowarp/clio-coder/blob/v0.6.2/docs/guide/semantic-context.md).

### Wiki generation

- Planning is bounded at every depth. Medium plans keep their ownership ceiling, oversized scopes split, detailed scopes subdivide with local ownership, and a planner revision is capped at 64 owners and rejected when it drops owned coverage. Flat directories get distinct, readable group names.
- Evidence checks parse pages with Marked through one shared reader, so every Markdown link form, fence, citation and layout statement is gated the same way. Links to planned sibling pages and encoded page names validate, and genuine non-citation names no longer fail a page.
- A page that fails validation gets one bounded repair run with the complete diagnostics before it falls back to normal writing. Unchanged pending drafts are revalidated before any new dispatch, and a draft from a writer stopped by its tool-call cap is judged by the evidence gate.
- Runs report usage, cost and budget telemetry, include earlier retry attempts in their totals, mark totals incomplete when a ledger is unreadable, and print unreported cache reads instead of a measured zero. Receipts keep tool and model audit facts, and generation exits nonzero when pages remain pending.

### Dispatch, safety and usage

- Attended sessions ask once before test runners execute code the session wrote, and a resumed or forked session counts as written.
- A writer that overlaps a live writer from another dispatch call is refused, compete and council keep candidates and judges independent, and compete, council and review are discoverable again.
- Workers verify their permit digest and tool ceiling, receipts record the permit ceiling, and the Claude SDK runtime enforces the admitted call ceiling and refuses escalation instead of downgrading it.
- Token and cost accounting is reconciled across the harness, fleet consumers, traces and cross-session totals. Partial and unknown totals are labelled, prompt pricing tiers are kept and Sonnet cache reads are priced correctly, and external CLI runs are priced from declared target rates.
- Telemetry preserves spans, admission and compaction outcomes, and capture loss through shutdown and replay.

### Desktop app

- Notifications reserve layout space, announce once, and keep keyboard focus after a dismissal.
- Live usage shows the model-call count, completed turns show cost provenance, parked sessions show their last recorded usage, and the approval queue shows each request's position.
- Markdown math typesets lazily as sanitized MathML, settings keep the selected workspace, and composers and suggestion lists keep their keyboard semantics.

### Terminal interface

- Each task names its status beside its glyph, the detailed settled-turn receipt shows the turn's cost, and the resume picker shows each session's recorded spend.
- Loop progress rides the composer rail, persistent loops are shown, and scheduled prompts are attributed.

### Packaging and security

- The release check gates package size per payload class, and published bundles no longer carry dangling `sourceMappingURL` comments.
- Dependencies override katex to 0.18.2 (GHSA-238p-pmpm-9mq7) and upgrade smol-toml to 1.9.0 (GHSA-r4xh-jqrq-34v2).

## 0.6.2-rc.2 - 2026-10-06

Clio Coder 0.6.2-rc.2 fixes the Materio lab flow and the release publisher, both found while shipping 0.6.2-rc.1. Everything else is as described for 0.6.2-rc.1 below.

### Fixes

- Materio confirm cards no longer fail on long drafts. A draft too long for the card is saved whole to `.research/drafts/<form>.md` and the card shows an excerpt, so `define-virtual-lab` and `define-research-tasks` can publish their documents. The corrections field starts at `none`, which accepts the draft, because Clio's interview refuses an empty answer. A workflow template longer than an option allows shows a shortened name with the full description beside it. The Materio extension is now 0.2.1.
- The release workflow finds the draft GitHub release it has just created, so a release no longer stops after uploading its assets.

## 0.6.2-rc.1 - 2026-10-06

Clio Coder 0.6.2-rc.1 is the release candidate for 0.6.2, published on the `beta` channel. Clio Coder 0.6.2 separates plugins from extensions. A plugin is an Agent Plugin that carries content; an extension is Clio code that runs in its own sandboxed process, declares everything it may do, and loads only after you approve those capabilities, with Materio and WTF-P as the first plugin and extension pairs. Fleet contracts are now playbooks, authored with `clio-coder playbook`, and the upgrade converts an existing home and each workspace once. Proactive memory runs on the chat route when it has no route of its own, within that route's cost, quota or speed budget, and reviews repository activity between turns. Library lifecycles leave receipts, extension and package activity is attributed in sessions and traces, `/loop` schedules turns and command polls, `/reload` and `/restart` apply changes in place, and the desktop app gains an integrated window title, Manage context and a denser layout.

### Plugins, extensions and the Library

- Plugins and extensions are separate Library packages. A plugin carries content, an extension carries Clio code that runs in its own process, and an extension names the one plugin it serves with `plugin:`. The terminal Library gains an Extensions tab, `clio-coder library` accepts `extension:<id>`, and package details say which extension serves a plugin and whether each is installed. Installing a plugin never installs its extension.
- Extension runtime API 2 (`runtime.api: 2` in `clio-coder-extension.yaml`) declares everything a package may do in its manifest: commands, hooks, tools, interface slots, workspaces, watched files, content access, file roots, programs and network. A runtime whose code registers other commands, events, hooks or tools than its manifest declares does not start.
- Before an extension is installed or updated, `clio-coder extensions install`, `clio-coder library install|update extension:<id>`, the Library review and a share import plan list what it would be allowed to do, and an update leads with what reaches further than the installed copy. The install records a digest of those capabilities, and an installed extension whose declared capabilities no longer match the record stays unloaded until you reinstall it.
- An extension runtime runs inside bubblewrap on Linux or Seatbelt on macOS when the backend is available. Its writes land only in its declared workspace roots and its own store, Clio's settings, state, trust records, installed packages and `.git` stay read-only, secrets are masked, and the network is cut unless the manifest declares it. Without a backend, including on Windows, only Node's permission flags apply, which are a seat belt rather than a boundary, and the Confinement line in `/extensions` says which applies.
- Extension hooks run at prompt submit, before and after each tool call, and at turn start and end. Each has a deadline from 50 to 2000 ms and a declared pass or block policy for a missed deadline or an error, and a hook that misses three deadlines in a row stays off until the next reload.
- A `before_tool` hook can refuse a call or, with `tool-args` access, rewrite its input. A rewritten call must match the tool's schema and goes through the same checks as the original call, protected paths and other extensions' gates included. A `prompt_submit` hook with `prompt` access can rewrite or block your prompt, and the capability review says which hooks can refuse and which can rewrite.
- Extension tools reach the model through the gateway as `extension_<id>__<name>`, checked against their declared input schema and the usual approvals. A tool can pause on an interview card, and your answers become its result.
- Extensions can show status lines, bands, cards, toasts, panels and docks. A workspace takes over the screen with a header, board, islands, rail and footer, leader-menu keys and a colour skin that must pass a contrast check and cannot restyle safety colours. `/workspace` shows the active workspace, `/workspace off` leaves it, and `/restart` returns to it.
- Extensions can run on a timer between 5 seconds and 1 hour, react to watched workspace files and to turn and tool events, and keep per-session state and a cross-session store that Clio holds, so a reload loses neither.
- An extension command can take over one of its served plugin's prompts (`replaces: prompt`) while that plugin is in effect, and the takeover is listed among the capabilities you approve.
- A package folder under `.clio-coder/dev/extensions/<id>/` in a workspace whose project extensions you approved, or one named with `/extensions dev <folder>`, is a dev extension for the terminal session. It loads only after you approve its capabilities for that session, each later save reloads at the next idle moment without asking while it stays within what you approved, a save that does not build keeps the previous copy running, and one session at a time develops a folder. `/extensions mute <id>` silences any extension for the session and `/extensions unmute <id>` restores it.
- `clio-coder extensions init <id> --template status|hook|panel|tool|workspace` scaffolds a package, `clio-coder extensions validate <path>` checks it and prints its capabilities with their digest, and `clio-coder extensions test <path>` runs its tests against a test host with a virtual clock. The `extension-authoring` Library skill and the `local-status` example extension teach the API.
- `/extensions` shows each package's served plugin, muted state, capability digest, confinement, why a listed runtime is not running, its last Library lifecycle event and its recent activity. `clio-coder extensions list` adds a plugin column.
- Library installs, updates, enables, disables, removals, registrations and imports, share imports included, write a lifecycle receipt with the content and capability digests, scope, source, operation and who acted: you, the model after your confirmation, or an upgrade. `library-receipts.json` in the state directory keeps the latest 512, and the Library detail shows a package's last lifecycle event.
- Extension tool calls, hook runs, skill loads and prompt expansions name the package that owns them, with its version and digest, in the session record and in `clio-coder trace`.
- Extension installs hash the source before staging, refuse a linked managed directory, a linked or hard-linked `state.json` and file names that collide by case, and keep files that differ from the install record as a recovery copy on update and remove. A project copy waiting on workspace trust reads untrusted instead of invalid.
- Share import writes context entries only under instruction file names, refuses links and colliding targets below its destination, and checks each path again before writing.
- Library and skill Git clones run with Git hooks and terminal prompts off and under a timeout, and helper processes a clone leaves behind are stopped.
- A plugin and an extension may share a name, as Materio's do: each keeps its own identity in the Library, and a lifecycle command given only the bare name asks you to choose `plugin:<name>` or `extension:<name>`. Installing, updating, enabling, disabling or removing an extension from the Library reloads extensions in the running session.
- Materio is now a plugin and a separate lab extension. The extension runs the lab bench as a workspace with its own commands, cost display and guardrails, and both packages require Clio Coder 0.6.2.
- Limits: API 2 hooks, tools, workspaces and dev extensions run only in the terminal. `clio-coder run`, ACP editors and the desktop app start no API 2 runtime, so an extension's blocking hook does not apply there.

### Agent core: memory, context, sessions and ACP

- With no memory route of its own, proactive memory runs on the active chat route and stays within that route's real budget: the session cost ceiling on metered API routes, the warning level of the provider's quota window on subscription routes, and a deadline derived from the endpoint's measured speed on local and unpriced routes, where it also yields to your own requests. `/memory` shows a skipped step's reason and when it lifts.
- Proactive memory reviews repository activity between turns in attended sessions. It reads completed work and earlier sessions of this checkout and its linked worktrees in short excerpts, and reaches older sessions the longer the session stays idle. Its requests yield to your own turns on a shared endpoint, and the footer, the desktop app and ACP telemetry show its state.
- A turn-end lesson pass records repository facts a future session would need. A repository lesson that quotes an exact successful command, or a passage the checkout still holds, is approved automatically once a later session shows it held, and is withdrawn when a later session contradicts it. Lessons with global, runtime or agent scope, and lessons without that evidence, wait for your approval.
- `/memory` lists pending and rejected records beside approved lessons and names the active memory route. `a` approves and `x` rejects the selected record.
- The read-only `memory_recall` capability searches the session's task memory and the approved durable memory that applies to the current repository and runtime.
- `/resume` restores a parked session's task memory, and durable memory records are shared between a repository's main checkout and its linked worktrees.
- `clio-coder context map` writes a standalone interactive HTML codebase map, by default `.clio-coder/artifacts/maps/<repo>.html`, with no model call. Up to eight areas expand to their files, declared symbols, import evidence and external imports, and `--json` prints a receipt with the size and SHA-256.
- Map source links pin a GitHub revision only when the working tree is clean and the indexed files match Git, and the map's own outputs no longer make a clean checkout read as dirty. The `map-codebase` library skill has Clio explain and refine the map.
- `/context init`, `refresh`, `reset`, `recall`, handoff recovery and compaction each end in one result card with the outcome, what was created, indexed, preserved or removed, estimated tokens before and after, and any warnings. The card stays in the session and shows again on resume, the CLI commands print the same summary, and `context init --json` includes it as `operation`.
- A running `/context init`, `refresh` or `reset` can be stopped. Indexing stops its worker, and the result card names the changes committed before the stop.
- A draft typed while Clio prepares a turn or compacts shows `HOLD` on the composer rail and is sent in order once that ends.
- `/loop <interval> <task>` runs a task as a fresh turn in the current conversation on a schedule. A bare loop runs five times, the first after one interval; `--count`, `--for` (a deadline up to seven days) and `--timeout` set other bounds, and the creation line shows every bound and which ones are defaults.
- `/loop <interval> --command <program> [args...]` polls a command directly with no shell and no model call. `--until 'json.status == "completed"'` ends the loop when the command's JSON output matches, which posts a notice by default; `--on-match main_turn --follow-up <text>` starts one turn that receives the result as untrusted data instead.
- A loop runs only while its conversation is idle and never replays missed runs. Unchanged poll results stay out of the transcript, failures back off up to five minutes, three infrastructure failures in a row pause the loop, and each run rechecks permissions, project trust and the command's executable.
- `/loop list`, `status`, `pause`, `resume`, `stop` and `cancel` control a session's loops; `stop` lets the current run finish and `cancel` aborts it. Switching session or branch, or `/new`, pauses a loop until `/loop resume`, quitting cancels it, and headless `clio-coder run` refuses loops. Clio can schedule the same loops itself, and `monitor`, ACP clients and the desktop app see them.
- On Linux and macOS, bare `clio-coder` asks once whether to open Clio in a per-project workspace beside terminal panes for files, workers and shells, powered by herdr. Quitting Clio returns you to your terminal, and `clio-coder panes workspace on|off|ask|status` changes or shows the remembered answer. The workspace is never offered inside tmux, Zellij, screen or herdr, with `--no-panes`, without a terminal, or on Windows.
- `/peer clio` opens a second Clio in a pane, and Clio can send that peer a prompt, wait for it to settle and read its output. The prompt arrives through a session-bound inbox and is never typed into the peer's terminal. It is refused while the peer waits on its operator, and the receiving transcript names the pane it came from.
- `/reload` reloads settings, Library resources and extension runtimes, or one of them with `settings`, `library` or `extensions`, and prints one report of what changed, which settings still need a restart, what applies next turn and what failed.
- `/restart` saves the session and restarts Clio Coder into the same session and workspace. It refuses while a turn, dispatch, reload, shell line or queued message is pending. `/reload` and `/restart` are terminal-only.
- A saved chat route that cannot be used is kept instead of being replaced for the session by another reachable target. A missing credential opens the session with the route unavailable and a line naming the fix. A route with no model, or a runtime that cannot drive chat, stops startup with exit 2 and points at `clio-coder configure`.
- The terminal and ACP share one resume path. A transcript that fails to replay leaves the next turn on the resumed session with empty context, never on the session you left.
- `clio-coder run --json` streams start with a `session` header carrying `schemaVersion: 1` and `mode`, and `clio-coder run --agent --json` names the agent, run id and version in that header and ends with one `{"type":"receipt",...}` line. Under `--json`, help and slash-command output go to stderr, so stdout stays JSON.
- `clio-coder run --agent coder --read-only` is admitted, and asking for an agent reserved for internal orchestration exits 2 without a model call.
- Editors switch the session's target through a `target` config option. `session/list` rows carry creation and end times, route, a first-message preview and the message count, and `_clio-coder/targets/list` adds the endpoint without credentials, default model, availability, health, tier and context window.
- ACP `_clio-coder/context/status` returns the active and latest context operation, `context.activity` events carry its progress, and `session/cancel` with `_meta["clio-coder/context"].operationId` stops one operation. A stopped context command reports as cancelled, not failed. `_clio-coder/jobs/list` lists the session's loops.
- Sessions on a Claude 5.5 model carry the vendor's published working notes for that model in the system prompt; other models, and targets that cannot call tools, get none.
- The agent names itself Clio Coder, uses Clio as the conversational short form, and uses the full name in receipts, reports, commit messages and handoffs. Prompts, built-in agents and interface text use no gendered pronouns.
- Read-only inspection commands with unquoted `*` or `?` globs, such as `cat src/*.ts`, run without an approval ask once every match passes the zero-access and workspace checks. `**`, brackets, braces, extglobs, variables and dot-leading globs still ask.
- `grep -r` over workspace paths runs without an ask when its walk cannot reach a zero-access file; `grep -R` still asks. A bash command that does need approval names the step that needed it, such as a glob, a redirection, too many steps or an unrecognized command, so a headless denial says what to change.
- `clio-coder tools install claude-sdk` installs the pinned Claude Agent SDK as a separate component in Clio's data directory, where upgrades and rollbacks keep it. `CLIO_CODER_CLAUDE_SDK_DIR` points Clio at an administrator-prepared prefix instead, and an attended session that needs the SDK asks once before installing it.
- A consent-gated conversational easter egg shows nothing until you accept its interview card, grants no tool action and stays off in headless runs. `/eggs` shows it or turns it off.
- Fixed: a headless run no longer fails on an unresolved block when the loop guard only withheld a repeat of a read that had already succeeded.
- Fixed: workers dispatched by a session can write the extension dev folders that session registered, while other sessions' workers stay blocked.

### Performance and runtime

- Long sessions no longer slow down as they grow. Clio keeps an index of the session ledger that is updated as entries are written, instead of re-reading and re-parsing the whole session file several times per turn. In a 300-turn local session on one Linux machine, the time each turn spent outside the model call fell from about 132 ms to 13 ms by the end, and shutting down after it from 437 ms to 157 ms.
- Stop ends the work it interrupts. A Stop during turn preparation, a retry countdown, compaction or a provider continuation starts no further model request and publishes nothing into the session afterwards, and a context overflow cancelled during recovery ends the turn as cancelled.
- A cancelled MCP tool call that already reached the server stops the server process Clio started and reports only after it is gone, closed MCP connections no longer leave a listener behind, and a discovery cancelled at its last page publishes no tools.
- Shutdown waits for the cleanup each resource needs: budgets derive from the real process grace periods, an expired budget aborts the work it was waiting for, worker descendants that outlive a normal exit are cleaned up, and a session drain can run more than once.
- `monitor` waits and collects wake as soon as a dispatched run changes state, instead of polling every 250 ms or 1 s, and Stop ends a wait at once.
- Worker start skips a safety policy compile it never used, about 50 ms per worker.

### Desktop app

- An installed Chrome or Edge app window can hide its title bar. Clio Coder then draws its own title area, and the system keeps its minimize, maximize and close buttons.
- Under WSL, Settings, General offers Install integrated app window when the browser allows it, which installs Clio Coder as an app in its managed browser profile. Once it is installed, the Start Menu shortcut opens the installed app, and reopening it keeps the title bar choice.
- `Ctrl/Cmd+/` opens Shortcuts & help with the cursor in one search box that covers shortcuts and help. Its topics are Shortcuts, Using Clio and Documentation, and shortcuts are grouped as Tasks & workspace, Conversation, Approvals & interviews, and Moving around.
- The app uses a smaller, denser type scale and a narrower conversation column.
- The app opens in the saved light or dark theme without first painting the other one, and the browser window colour follows the theme.
- In the Session column, App activity, Health, Usage, Artifacts and any section with nothing to show yet fold to a one-line summary and open on click. Health and Project trust move to the top when they need attention.
- Menus wrap long entries instead of cutting them off.
- The Context view adds Manage context, a form for the terminal's context actions: initialize or adopt project context, refresh the source index, compact history, recall an evicted result, recover a handoff, or reset generated context. Reset runs only after its confirmation box is ticked.
- The Context view shows workspace evidence and project-instruction coverage beside the context window breakdown.
- Context work shows a card above the composer with its stage, progress, elapsed time and a Stop button. A finished card says what was created, updated, indexed or removed, with any warnings, until you dismiss it.
- While context work runs, the composer keeps your draft and holds sending until the work finishes, and the task reads as working in the rail.
- Recurring `/loop` jobs appear at the live edge of the conversation, one row per loop with its schedule, runs started, next due time, last outcome and cost. Pause and Resume act at once; Stop and Cancel ask first.
- A `/loop` task typed in the composer may be wrapped in one pair of quotes.
- The conversation header shows Memory reviewing, Memory waiting or Memory unavailable while memory review works, waits for room on its model endpoint, or cannot run.
- A link to a saved task the app has not opened finds the project that holds it and offers Resume task. When no project has it, the page says so, counts projects that could not be read, and offers Look again.
- The composer's model picker can switch the connection as well as the model and thinking level, for this conversation only.
- On the Connections page, Probe checks only the selected connection and reports whether it is reachable, with its latency. A connection whose health was never checked reads Availability unknown.
- Library calls fleet workflows playbooks: the Playbooks tab, the Run a playbook panel and the `/fleet run` dialog, which read `.clio-coder/playbooks`, and the Playbook roots entry of the configuration map.
- A Library package copy blocked by project trust reads Requires trust.
- Extension rows in the Library show the terminal command for each lifecycle action instead of offering actions the desktop app cannot perform; extensions are reviewed and installed in the terminal.

### Installation, release and docs

- `install.ps1` adds the launcher directory to your user `PATH` and to the current PowerShell session by default, so `clio-coder` runs right after setup, including in a terminal opened before an earlier install. `-NoModifyPath` or `CLIO_CODER_MODIFY_PATH=0` leaves `PATH` alone, and the installer then prints the full launcher path to run.
- On Linux and macOS, `install.sh` prepares the herdr pane host behind the per-project workspace. A usable `herdr` on `PATH` is used as is; otherwise Clio Coder downloads and verifies its pinned copy. `--no-workspace` or `CLIO_CODER_INSTALL_WORKSPACE=0` skips it, and a failure never fails the install: Clio offers it again on first launch, or run `clio-coder panes install`.
- npm, pnpm and Bun installs no longer download the Claude Agent SDK (about 224 MB), because it is no longer an optional dependency of the package. The installers' `--include-claude-sdk` (`-IncludeClaudeSdk`) runs `clio-coder tools install claude-sdk` after installing, and a provisioning failure stops the install with the previous launcher still active.
- The Ollama client is bundled into the package instead of installed beside it. The desktop app's HTML sanitizer, including the copy Mermaid diagrams use, moves to DOMPurify 3.4.16 for GHSA-p98j-92pf-mc4p, and the package records its version and checksum with the third-party notices.
- Release qualification is one manually started run. It checks, builds and packs the package once, tests selected terminal, protocol, desktop-app and installed-package behavior against that archive, and boots the same archive on Node 24, with Windows and macOS boots on request. The minimum Node 22.19.0, the Windows subprocess contracts and the native Windows installer flows are not part of it.
- Publication waits for the owner's approval in GitHub, publishes the qualified bytes to npm with provenance, then creates the GitHub release with the tarball and the four installers, fast-forwards `main` and deploys the website built from the same commit. A partial failure resumes with the same archive instead of a rebuild.
- Clio Coder publishes on three channels: `latest` for stable releases, `beta` for release candidates such as this one, and `dev` for snapshots of the development branch. `install.sh --channel beta|dev`, `install.ps1 -Channel beta|dev`, `npm install -g @iowarp/clio-coder@beta` and `clio-coder upgrade --channel <name>` choose one, an install keeps following its channel, and a channel always resolves to the newest of itself and the stabler channels. `clio-coder upgrade --channel latest` returns a pre-release install to stable even when that is a lower version, and says when the newer version already ran migrations.
- The hosted installers pass `--channel` through and run the release candidate's own installer for `beta` and `dev`.
- The MCP SDK that Google's client brings in moves to 1.32.1 for GHSA-6qxp-vccf-f47h, and its `proxy-addr` to 2.0.8 for GHSA-jqcg-44mw-7w3h.
- Guides, architecture pages and the website name the product Clio Coder and refer to it without gendered pronouns, and the glossary records the origin of the name.

### Upgrade notes

- Running the hosted installer again without flags now moves an install pinned with `--version` to the latest release. Pass `--version <x.y.z>` to keep a pin.
- A plugin built for an older Clio, one that still declares `resources.fleets`, a `fleet` kind or a `fleet:` requirement, is refused with a diagnostic that names the fix: its author renames them to `playbooks`, `playbook` and `playbook:`. For WTF-P, run `wtf-p install clio`. `clio-coder upgrade`, the installers and the first start after a background update convert your home once: `fleets/` directories merge into `playbooks/` without overwriting, plugin install records and Library plugins take the new names, and any other package that still needs the fix is listed. Each workspace's `.clio-coder/` converts once on first open with one notice. Share archives from earlier releases still import.
- Library commands use the new names: `clio-coder library recipes` is now `clio-coder library components`, `--kind fleet` is `--kind playbook`, the terminal Library's Fleets tab is Playbooks, and `clio-coder share export --fleets` is `--playbooks`.
- A package can no longer be both a plugin and an extension. An extension root that holds `plugin.json` is invalid and a plugin root that holds an extension manifest fails validation, so publish two packages and link the extension to its plugin with `plugin:`.
- The upgrade replaces an installed Materio plugin with the current Library copy but never installs an extension. The lab bench is now `extension:materio`; `clio-coder library install extension:materio` shows what it may do before installing it.
- A model-run `clio-coder share import` (or `clio-coder import`), `extensions test` or `extensions validate` now asks for your approval like `library install`, so headless `clio-coder run` denies it. `extensions install` stays refused to the model.
- No core settings keys were added, renamed or retired. Two defaults changed, described in the next two notes.
- With no `context.memory.target` or `context.memory.model` set, proactive memory now uses the active chat route instead of staying rules-only. Attended sessions therefore make background model calls on the chat route after turns and while idle, including reviews of earlier sessions, within the budget described above. The "Rules only" choice is gone from `clio-coder configure` and `/settings`. Set `context.memory.enabled: false` to stop background memory, or set a dedicated memory target and model to move it off the chat route.
- `interface.panes.enabled` now defaults to `embedded`, which opens the pane workspace after your one-time yes. `auto` joins a pane host only when Clio starts inside one and never starts one. A settings file holding `off`, as the 0.6.1 template wrote, is respected: no invitation and no herdr download. Set `embedded` or run `clio-coder panes workspace on` to opt in. Changes take effect at the next start.
- After 0.6.2 records an approval or observation on a durable memory record, 0.6.1 can no longer read the memory store, so `clio-coder upgrade --rollback` leaves sessions without durable memory until you upgrade again. Durable records that 0.6.1 approved under a linked worktree's own path no longer apply; approve them again from the main checkout.
- The Claude Agent SDK is no longer an optional dependency of the npm package, and an SDK installed beside 0.6.1 does not carry over. Run `clio-coder tools install claude-sdk`, or accept the one-time prompt, before using a `claude-sdk` target. Shipped runtime dependencies are pinned to exact versions.
- `clio-coder run --agent --json` no longer prints a blank line and an indented receipt; the receipt arrives as one `{"type":"receipt","receipt":{...}}` line, so check `schemaVersion` in the header. `clio-coder run --agent` now exits 3 when the worker stopped on a refused permission (`permission_required`), where it exited 1 before.
- Picking a model with `/model` or over ACP also sets a thinking level that model supports and saves it at the scope you chose, so a saved pick of a non-reasoning model writes `chat.thinkingLevel: off`.
- What a fleet runs is now called a playbook. Authoring moves to `clio-coder playbook new|validate|graph|list|commands`, which writes to `.clio-coder/playbooks/` and your config directory's `playbooks/`; `clio-coder fleet run|status|view|verify|drain|resume|nodes`, `/fleet run <playbook>` and the `fleet.*` settings keep their names, and `fleet validate` and friends now exit 2. Old `fleets/` directories are converted by the upgrade as described above; Clio no longer reads them.
- `clio-coder context map` writes HTML instead of `<repo>.architecture.json`, and the `archify` skill is retired in favour of `map-codebase`. Catalog skills are renamed: `grill-me` is now `plan-interview`, `cut-it` is `sprint-plan`, `workflow-distiller` is `workflow-capture` and `skill-craft` is `skill-authoring`, and `herdr` is retired because the panes capability now sends, waits and reads directly. Copies installed under the old names keep loading but no longer update from the catalog.
- The desktop app's model picker no longer offers Apply to Every project or an unlisted model id. It changes only the current conversation; change saved defaults, including an unverified model id, in Settings or Connections.
- Under WSL, the integrated app window needs this release's Windows launcher scripts. An installer upgrade refreshes them the next time the app opens while idle; an npm or source-checkout install keeps the earlier scripts until you run `clio-coder gui background install` again.
- `install.ps1` and `install.cmd` now add the launcher directory to your user `PATH` by default, and `install.ps1` also adds it to the current PowerShell session. Pass `-NoModifyPath` or set `CLIO_CODER_MODIFY_PATH=0` to leave `PATH` alone. When the window cannot use the new `PATH` yet, the closing `Run:` line names the launcher by its full path.
- Running `install.sh` for 0.6.2 or newer on Linux or macOS downloads Clio Coder's pinned herdr when no usable copy is on `PATH`, and background updates from 0.6.2 onward do the same. Pass `--no-workspace` or set `CLIO_CODER_INSTALL_WORKSPACE=0` to skip it; a declined workspace or `interface.panes.enabled: off` also skips it.

## 0.6.1 - 2026-10-03

Clio Coder 0.6.1 brings a desktop app (alpha) with a setup wizard, a task rail and a Session column. A new installer brings its own Node.js to Linux, macOS and Windows. Approvals say what a command would do, and dispatched workers run under immutable permits, with OS sandboxing for native worker commands when a backend is available. Queued messages are held in Clio, where you can reorder, edit or send them now. Editors get live usage, plan and workspace telemetry over ACP. Experimental additions are SSH worker nodes, docks for workers, files and music, and steering triage. The Pi SDK moves to 1.0.0. This release supersedes 0.6.0, whose installer failed on native Windows and refused some upgrades.

### Installation and upgrade

- A native Windows install of 0.6.0 stopped at activation with `EPERM`. The installer helper now flushes its launcher record through a writable handle, and file edits on Windows no longer carry a durability warning on every call.
- Native Windows installers stage local tarballs before npm, including packages accessed through WSL UNC paths. Installer validation reports incomplete records and rejects malformed Node tarball names before writes. Concurrent desktop setup gives a retry instruction; configure keeps plaintext-key warnings inside its frame, and lifecycle commands consistently name managed installs as installer installs.
- The website installer bootstraps follow the latest GitHub release, and the release installer assets come from the same qualified tarball published to npm.
- A settings file holding a key that was retired without a replacement no longer refuses to load, which had blocked upgrades of 0.5.x homes with an interop setup. The key is ignored and `clio-coder doctor` names it as a warning.
- An upgrade refused over a setting the installed version cannot repair, such as `safety.autonomy: auto-edit` from 0.4.x, was a dead end, because the advised `clio-coder doctor --fix` ran the old version. The installer now prints the new version's own repair command.
- Installers direct a failed candidate check to `clio-coder doctor --fix` instead of reset, and explain how to keep a source-checkout launcher or replace it with a managed release.
- Linux installers reclaim unused refused candidates and versions older than seven days while retaining the active version, rollback version and versions used by live sessions. If process ownership cannot be checked, versions are retained. Replacing an npm-linked launcher names the npm prefix to uninstall from.
- `clio-coder doctor --fix` repairs file modes, removes retired settings keys, corrects YAML on/off booleans, and asks before replacing a stale model ID with the nearest provider catalog match.
- Every doctor warning or failure names a concrete next command, including the sign-in command for expired credentials.
- Doctor detects missing checkout build files and running sessions that need a restart after a rebuild, and `clio-coder doctor --fix` rebuilds an incomplete checkout.
- `clio-coder gui background install --handover`, the installer's `--gui`, and `clio-coder doctor --fix` can transfer a verified idle background service between installations while preserving its address and credentials.
- `clio-coder gui background restart --if-idle` restarts while conversations are resting and preserves active work. The app and doctor show when a session is still using a version replaced by upgrade or rollback.
- Under WSL, Windows shortcuts call the stable `clio-coder` launcher. Opening the app selects the activated service executable after upgrade or rollback, restarts only when idle, and reports browser launch failures.
- Background apps keep their web manifest available to installed browser apps. Hiding the manifest did not prevent duplicate browser installations. WSL shortcuts now open one managed desktop identity using a dedicated Chrome or Edge profile; repeated or simultaneous launches focus the existing window. Launch failures display the captured error; uninstall removes the owned Windows launch scripts, shortcuts and browser profile. Taskbar pinning remains a user action.
- Desktop app launches deliver the current address and token, and reconnecting with a fresh local launch link moves the browser to the correct port.
- Windows uninstall removes the private runtime and installed versions after Clio exits, and uninstall reports the shell configuration lines left for manual removal.

### Upgrade notes

- Settings from 0.5.9 load unchanged and no key is retired. New keys include `safety.sandbox`, `safety.sandboxNetwork`, `interface.exitSummary`, `integrations.music.*`, `chat.steering.triage.*` and `fleet.defaultNode`, and `fleet.permissions.mode` accepts `main`. `settings.yaml` is now written owner-only, and `clio-coder doctor` warns about a wider mode that `doctor --fix` tightens.
- Project extensions and plugins load only after the workspace is approved with `clio-coder config trust extensions` or `plugins`. An unapproved project copy stays listed but unloaded and no longer shadows your own copy. Your first project install approves its own surface; later installs, enables and removes ask again.
- A dispatched worker's own commands (`bash`, `run_script`, verification) run under an OS sandbox when `safety.sandbox` is `auto` (the default) and a backend exists, which is bubblewrap on Linux and Seatbelt on macOS. Writes land only in the worker's roots, `.git` and `.clio-coder` stay read-only, and network is off unless the run holds `web_fetch` or `safety.sandboxNetwork` is true. `required` refuses commands without a backend and `off` disables it. Main-agent commands are not sandboxed. A worker confined to narrow write roots loses `bash` and `verify` when no sandbox is active.
- External agents that run their own tool loop (the Claude Code, Codex, OpenCode, Pi and Antigravity runtimes, and ACP peers with `toolGovernance: agent-managed`) are refused write-capable work unless the target or entry sets `trustedUnmediated: true`. Read-only runs are unaffected.
- Under the default `fleet.permissions.mode: deny`, a worker's refused command returns to the model, and the third refusal ends the run as `permission_required` naming every refused command. The denial names the tool, the command (clipped, secrets redacted) and the rule. The Claude SDK runtime still ends at its first refusal. A worker change that removes existing test cases or deletes a test file is withheld from the merge (`merge_withheld`), and a current-tree run fails with `worker_removed_tests`, unless the task asked for the removal.
- `Ctrl+Q` no longer queues for the end of the turn and `clio-coder.message.followUp` is retired. A keybindings file that names it reports the replacement. Enter queues for the next slot, `Alt+K` opens the queue navigator, `Alt+S` sends now, and `Alt+A` toggles the music dock. `Alt+E` and `Alt+W` now hide and show docks, and a second tap within 400 ms closes them.
- A clean interactive exit prints a session summary. `interface.exitSummary` is `auto` by default and follows `interface.outputDetail`; `brief`, `standard`, `report` and `off` override it.
- `safety.limits.sessionCostUsd: 0` means no session ceiling in every path, including dispatch plans, fleet previews and `clio-coder configure`.
- The installer no longer fetches the Claude Agent SDK. Pass `--include-claude-sdk`, or accept the one-time prompt on first use, which installs it into Clio's own package root or prints the package-manager command.
- On sessions that attach `bash`, `find` and `ls` sit behind the gateway, and bash output keeps 16 KiB in model context, split between its head and tail.
- Prompt templates follow Pi 1.0 argument semantics (`$1`, `$@`, `${@:N}`, `${N:-default}`), and bare `$ARGUMENTS` inserts the text after the command unchanged.
- The packaged local model catalog now holds five profiles checked against their upstream Hugging Face model cards and templates: gpt-oss-20b, Qwen3.8-27B, Gemma 4 26B-A4B, Nemotron 3.5 Lightning 30B-A3B and Qwen3.5-4B. These are upstream capability and thinking-control records, not runtime benchmarks. Earlier profiles for finetunes are no longer packaged; keep any you rely on in your config directory's `model-profiles.yaml`, which merges over the packaged entries by id.

### Desktop app (alpha)

- The app is organized as a rail of tasks per project and one Session column holding the chat's model and health, context and spend, branches, sealed evidence, artifacts and workers. A first run goes through a setup wizard. A machine that has used Clio, with a provider key in the environment, a stored login or a local server on a default port, lands in chat with a notice naming the route.
- Any number of tasks stay open. A task idle for 5 minutes is parked and resumes when shown again, and at most 4 turns run at once, with later turns shown as "Waiting for a slot". Closed tasks stay in the rail as saved tasks.
- One app window: launching focuses the open window, in an installed Chrome or Edge app and through the Start Menu shortcut under WSL, and "Open in new window" or `Ctrl/Cmd+Shift+N` opens another on purpose. `clio-coder gui background install` keeps the app on port 4343, or 7373 while another program holds it.
- In the composer, `@` completes workspace files, `↑` recalls earlier messages, `/commands` complete from their grammar, and `@agent text` steers a running worker. A message that starts with `!` runs as a shell line between turns, and `!!` keeps its output out of Clio's context. Each queued message has Send now, move, Now or After, Edit and Remove.
- Worker blocks, the Agents view and Evidence show each run's receipt outcome, contract conformance, trust verdict and validation, and an Artifacts page lists a session's `/view` artifacts. Ignored untrusted project surfaces appear under Project trust in the Session column with the trust command to run. `Esc` twice in the composer stops the running turn.
- Tool output keeps the colours a command printed, tables keep their header and offer "Copy table", diffs mark the changed part of a line, and a wide Mermaid diagram offers "Full size". Images embedded in a reply as data are drawn; images at a web address are never loaded.
- Session notices move out of the conversation into the Session column: thinking guidance sits with the model, project-instruction coverage with context, and other notices under Session notes.
- Settings is rebuilt as a few pages, Library has its own page, and "Sign out" under Settings, Models removes the credential Clio stored for a connection. A settled turn closes with one line: Done, Failed or Stopped, then duration, tool calls and tokens.
- Limits: on native Linux the desktop launcher still opens a browser tab per launch, because focusing an existing window needs the installed Chrome or Edge app, and the limit of 4 running turns has no setting.

### Install, upgrade and first run

- `install.sh` installs a private Node.js 24 and the package under a versioned prefix with no root and no system Node. Downloads are checked against Node.js's published checksums; release-signature verification is attempted when `gpgv` or `gpg` is present, with a warning if it cannot be completed and a hard failure for a bad signature. Older x64 Linux gets a glibc 2.17 build, Alpine a musl build, and `--modify-path` is the only way it edits a shell startup file. `install.ps1` and `install.cmd` do the same on Windows, where support remains best effort and the native Windows installed-package flow is not CI-verified.
- `install.sh` offers the desktop app at the end (`--gui` or `--no-gui`). `clio-coder` checks the Node version before loading and honours `CLIO_CODER_NODE` for hosts whose default `node` is too old.
- `clio-coder upgrade --rollback` restores the previous version. A pinned install shows its pin, and `/upgrade` follows the recorded channel, leaves a pin alone and tells a source checkout to update through Git. Pre-release builds name their commit and say they are unreleased, and they hear about newer beta and latest releases.
- A new home starts directly at "Welcome to Clio Coder" and the first question. A home with no usable chat route tries configured targets, environment keys, Clio's stored logins and local servers on default ports, and saves a route only when none exists. `/config` runs configure inside the TUI and applies saved routing live. Peer agents enlist through current ACP recipes, including `@agentclientprotocol/claude-agent-acp` for Claude and `copilot --acp`.
- `clio-coder reset` and `uninstall` also remove the desktop app, and `uninstall` reports `.zshrc` and fish config lines that mention clio-coder. After a native upgrade, `clio-coder gui` and `gui background restart` accept the desktop app the previous version installed.
- `clio-coder doctor` leads with whether chat can run. `clio-coder library register|pin|drift` print text unless `--json`, and `clio-coder tools list|status` say when a pin bump superseded a vendored tool.

### Release qualification and platforms

- A manually dispatched release workflow gates the selected commit on CI and exact-package qualification, verifies the tarball checksum, publishes those bytes to npm with provenance, and creates the GitHub release and tag last. A failed qualification leaves the release tag unused.
- CI gates root contract and smoke tests, GUI checks and tests, maintenance checks, and installed-package tests on Linux with Node 22. The platform matrix builds and boots on macOS and Windows with Node 22, and Linux with Node 24 and the minimum Node 22.19.0; installed-package checks also run on those macOS and Linux legs. Windows runs selected subprocess contracts but explicitly skips the installed-package test. Node 24 also runs lifecycle, provider-transport and session-durability contracts.

### Approvals, trust and worker safety

- A permission approval renders inside the editor's own rails. The top rail names the decision and its kind, the card lists tool, target, effect, requester and worker authority, and `Alt+T` opens the full terms and `Alt+V` the full invocation. Bash approvals state what the command would do. A draft you were typing stays editable under the card.
- Every worker attempt runs under an immutable permit that fixes its asks, tools and Git allowance. `clio-coder run --delegate-tools` sets what dispatched workers may hold, separately from the main agent's `--allow-tools`.
- `fleet.permissions.mode: main` is a new opt-in. The main agent grants ordinary worker asks on native local workers at `yolo` and forwards them to you at any other autonomy level. Asks that need operator authority always reach you, and an ask no one can answer is denied.
- Workers in a task worktree commit on their task branch through a typed `git` capability (`status`, `diff`, `log`, `show`, `add`, `commit`) that refuses fields an operation does not take. Clio asks an attached operator before withholding a task worktree merge. A task worktree Clio created inherits package trust while its package state is unchanged. Model-run `clio-coder library import`, `push` and `remote` ask for confirmation like other library mutations, and `--dry-run` never asks.
- Information flow (advanced and opt-in) keeps named content with the models you chose. Source rules in `.clio-coder/safety.yaml` under `informationFlow` name paths or tools and their allowed recipients, and `clio-coder config trust safety` approves them. Refusals hold at `yolo`, restrictions travel through workers, resume and compaction, and a project with no rules behaves as before. The policy format may change.

### Terminal

- Partial project-instruction coverage appears once per workspace as an expiring footer notice, instead of a persistent welcome row.
- Messages sent during a run are held in Clio and handed over at the next steering slot. The queue navigator (`Alt+K`) reorders, edits, removes, switches an entry to end-of-turn and sends it now, and `Alt+S` interrupts the run with your draft. `/resume <id>` resumes a session directly, and a clean exit prints the resume line. CLI `--resume` and `--continue` stay refused (#191).
- The exit summary shows identity, model, tokens, cost provenance, wall time and resume instructions in brief form, and adds turns, files changed, tools, worker outcomes and compactions in standard and report form.
- An edit's diff shows once its arguments close, before the call runs. `/compact <instructions>` binds the summarizer and keeps the instructions verbatim. The wheel scrolls the transcript while an overlay is open and never moves list choices.
- Each substantive turn ranks installed skills, gateway capabilities and agents, and the reminder names up to five likely skills and three capabilities without changing the tool set between turns. `clio-coder fleet view <runId>` shows the requested model beside the provider-reported one, with cost provenance, and `--json` prints the snapshot with its authenticated receipt.

### Fleet and tools

- `clio-coder fleet nodes add|list|remove|test|discover|install` manages SSH worker nodes (experimental). `install <id> --yes` installs the exact client build you run, `discover` lists Tailscale peers, and a node needs a passing recorded `test --record` before dispatch. `fleet.defaultNode` sets a standing preference, and edits from a separate checkout return through isolated task branches. `clio-coder fleet cancel <runId>` cancels a run from any terminal.
- `read` lists zip and tar archives and reads one text member, extracts PDF text by page (needs poppler's `pdftotext` and `pdfinfo`), and renders Jupyter notebooks. The `data` tool reads SQLite databases read-only.
- The per-turn observation pool scales with the active context window. Automatic compaction pauses after three consecutive failures, while `/compact` and overflow recovery still run. A fleet loop's check step also runs the test files its workspace changed, and a failure feeds the repair loop.
- Headless runs and the coder agent map each task clause to evidence before finishing. Unattended runs and workers install only dependencies that were never installed and report failures confined to files they did not touch. When Clio needs one-off routing for a dispatch, she pins the dispatch's `target` and `model` fields instead of editing routing settings.
- Headless `clio-coder run --agent` prints a "Not verified:" block from the sealed result. Codex, OpenAI Responses and Azure Responses calls record the model the provider reports.

### Editors and ACP

- ACP pushes `usage_update` (at most one per model response), `plan` after board changes and `_meta["clio-coder/workspace"]`, so clients stop polling. It serves `/view` artifacts through `_clio-coder/artifacts/list` and `read`, sealed receipt facts on terminal fleet frames and replay, and ignored untrusted project surfaces in `_meta["clio-coder/trust"]`.
- `_clio-coder/session/shell` runs an operator shell line with the terminal's `!` and `!!` semantics, and `_clio-coder/session/queue_edit` removes, restores, moves, retypes and sends queued entries, with `_clio-coder/session/queue_changed` notifications for clients that opt in. Worker permission asks, `ask_user` and harness cards reach an attended ACP client, and bash asks carry the command's consequence line. `session/load` replay does not yet show shell lines.

### Experimental

- Docks need Herdr and are off by default. `Alt+W` opens a live workers dashboard (`clio-coder fleet view --watch`), `Alt+E` the Yazi files pane (`interface.panes.files.enabled`), and `Alt+A` the music pane. A hidden dock keeps running, and a second tap within 400 ms closes it. `/panes` and `/files` report and control docks.
- `/music` and the opt-in `music` tool drive cliamp 1.63.2 as focus radio. They need `integrations.music.enabled: true`, `integrations.music.agentControl` for the tool, and `clio-coder tools install cliamp` or a package-manager install.
- System One gains per-model capability profiles (`systemOne.engines.<name>.profile`), per-task routing under a site binding, a `steer` site and category hierarchies for recipes and catalogs. Its sites, keys and cuts may change between releases.
- `chat.steering.triage` (off by default) lets a side model read queued messages once the queue settles and relabel them. An unrelated task waits for the end of the turn, and a confident stop may interrupt the run. `fleet.speculativeDispatch` stays experimental.

### Fixed

- A turn that only writes Markdown, reStructuredText, AsciiDoc or Mermaid source finishes as prose-only instead of "change not verified". Stopping at an approval card says the turn stopped and the tool did not run.
- Redaction no longer treats code such as `token = getToken()` or a pure `$NAME` reference in an assignment as a credential, while literal secrets still redact, and durable trace payloads stay valid JSON after redaction.
- Python verification resolves `python` or `python3` once, refuses a uv project without `.venv`, and recognizes `PYTHONPATH=<relative paths>` test forms. A check that cannot start is reported as unavailable and not retried.
- Typed Git refuses fields an operation does not take, and the loop guard keys repeated Git calls on the arguments that run.
- A new desktop task opens when its model target is down instead of failing with "Clio ACP process is unavailable".

## 0.6.0 - 2026-10-03

Superseded by 0.6.1, which carries everything below and repairs the installer. Install 0.6.1.

Clio Coder 0.6.0 brings a desktop app (alpha) with a setup wizard, a task rail and a Session column. A new installer brings its own Node.js to Linux, macOS and Windows. Approvals say what a command would do, and dispatched workers run under immutable permits, with OS sandboxing for native worker commands when a backend is available. Queued messages are held in Clio, where you can reorder, edit or send them now. Editors get live usage, plan and workspace telemetry over ACP. Experimental additions are SSH worker nodes, docks for workers, files and music, and steering triage. The Pi SDK moves to 1.0.0.

### Upgrade notes

- Settings from 0.5.9 load unchanged and no key is retired. New keys include `safety.sandbox`, `safety.sandboxNetwork`, `interface.exitSummary`, `integrations.music.*`, `chat.steering.triage.*` and `fleet.defaultNode`, and `fleet.permissions.mode` accepts `main`. `settings.yaml` is now written owner-only, and `clio-coder doctor` warns about a wider mode that `doctor --fix` tightens.
- Project extensions and plugins load only after the workspace is approved with `clio-coder config trust extensions` or `plugins`. An unapproved project copy stays listed but unloaded and no longer shadows your own copy. Your first project install approves its own surface; later installs, enables and removes ask again.
- A dispatched worker's own commands (`bash`, `run_script`, verification) run under an OS sandbox when `safety.sandbox` is `auto` (the default) and a backend exists, which is bubblewrap on Linux and Seatbelt on macOS. Writes land only in the worker's roots, `.git` and `.clio-coder` stay read-only, and network is off unless the run holds `web_fetch` or `safety.sandboxNetwork` is true. `required` refuses commands without a backend and `off` disables it. Main-agent commands are not sandboxed. A worker confined to narrow write roots loses `bash` and `verify` when no sandbox is active.
- External agents that run their own tool loop (the Claude Code, Codex, OpenCode, Pi and Antigravity runtimes, and ACP peers with `toolGovernance: agent-managed`) are refused write-capable work unless the target or entry sets `trustedUnmediated: true`. Read-only runs are unaffected.
- Under the default `fleet.permissions.mode: deny`, a worker's refused command returns to the model, and the third refusal ends the run as `permission_required` naming every refused command. The denial names the tool, the command (clipped, secrets redacted) and the rule. The Claude SDK runtime still ends at its first refusal. A worker change that removes existing test cases or deletes a test file is withheld from the merge (`merge_withheld`), and a current-tree run fails with `worker_removed_tests`, unless the task asked for the removal.
- `Ctrl+Q` no longer queues for the end of the turn and `clio-coder.message.followUp` is retired. A keybindings file that names it reports the replacement. Enter queues for the next slot, `Alt+K` opens the queue navigator, `Alt+S` sends now, and `Alt+A` toggles the music dock. `Alt+E` and `Alt+W` now hide and show docks, and a second tap within 400 ms closes them.
- A clean interactive exit prints a session summary. `interface.exitSummary` is `auto` by default and follows `interface.outputDetail`; `brief`, `standard`, `report` and `off` override it.
- `safety.limits.sessionCostUsd: 0` means no session ceiling in every path, including dispatch plans, fleet previews and `clio-coder configure`.
- The installer no longer fetches the Claude Agent SDK. Pass `--include-claude-sdk`, or accept the one-time prompt on first use, which installs it into Clio's own package root or prints the package-manager command.
- On sessions that attach `bash`, `find` and `ls` sit behind the gateway, and bash output keeps 16 KiB in model context, split between its head and tail.
- Prompt templates follow Pi 1.0 argument semantics (`$1`, `$@`, `${@:N}`, `${N:-default}`), and bare `$ARGUMENTS` inserts the text after the command unchanged.
- The packaged local model catalog now holds five profiles checked against their upstream Hugging Face model cards and templates: gpt-oss-20b, Qwen3.8-27B, Gemma 4 26B-A4B, Nemotron 3.5 Lightning 30B-A3B and Qwen3.5-4B. These are upstream capability and thinking-control records, not runtime benchmarks. Earlier profiles for finetunes are no longer packaged; keep any you rely on in your config directory's `model-profiles.yaml`, which merges over the packaged entries by id.

### Desktop app (alpha)

- The app is organized as a rail of tasks per project and one Session column holding the chat's model and health, context and spend, branches, sealed evidence, artifacts and workers. A first run goes through a setup wizard. A machine that has used Clio, with a provider key in the environment, a stored login or a local server on a default port, lands in chat with a notice naming the route.
- Any number of tasks stay open. A task idle for 5 minutes is parked and resumes when shown again, and at most 4 turns run at once, with later turns shown as "Waiting for a slot". Closed tasks stay in the rail as saved tasks.
- One app window: launching focuses the open window, in an installed Chrome or Edge app and through the Start Menu shortcut under WSL, and "Open in new window" or `Ctrl/Cmd+Shift+N` opens another on purpose. `clio-coder gui background install` keeps the app on port 4343, or 7373 while another program holds it.
- In the composer, `@` completes workspace files, `↑` recalls earlier messages, `/commands` complete from their grammar, and `@agent text` steers a running worker. A message that starts with `!` runs as a shell line between turns, and `!!` keeps its output out of Clio's context. Each queued message has Send now, move, Now or After, Edit and Remove.
- Worker blocks, the Agents view and Evidence show each run's receipt outcome, contract conformance, trust verdict and validation, and an Artifacts page lists a session's `/view` artifacts. Ignored untrusted project surfaces appear under Project trust in the Session column with the trust command to run. `Esc` twice in the composer stops the running turn.
- Tool output keeps the colours a command printed, tables keep their header and offer "Copy table", diffs mark the changed part of a line, and a wide Mermaid diagram offers "Full size". Images embedded in a reply as data are drawn; images at a web address are never loaded.
- Session notices move out of the conversation into the Session column: thinking guidance sits with the model, project-instruction coverage with context, and other notices under Session notes.
- Settings is rebuilt as a few pages, Library has its own page, and "Sign out" under Settings, Models removes the credential Clio stored for a connection. A settled turn closes with one line: Done, Failed or Stopped, then duration, tool calls and tokens.
- Limits: on native Linux the desktop launcher still opens a browser tab per launch, because focusing an existing window needs the installed Chrome or Edge app, and the limit of 4 running turns has no setting.

### Install, upgrade and first run

- `install.sh` installs a private Node.js 24 and the package under a versioned prefix with no root and no system Node. Downloads are checked against Node.js's published checksums; release-signature verification is attempted when `gpgv` or `gpg` is present, with a warning if it cannot be completed and a hard failure for a bad signature. Older x64 Linux gets a glibc 2.17 build, Alpine a musl build, and `--modify-path` is the only way it edits a shell startup file. `install.ps1` and `install.cmd` do the same on Windows, where support remains best effort and the native Windows installed-package flow is not CI-verified.
- `install.sh` offers the desktop app at the end (`--gui` or `--no-gui`). `clio-coder` checks the Node version before loading and honours `CLIO_CODER_NODE` for hosts whose default `node` is too old.
- `clio-coder upgrade --rollback` restores the previous version. A pinned install shows its pin, and `/upgrade` follows the recorded channel, leaves a pin alone and tells a source checkout to update through Git. Pre-release builds name their commit and say they are unreleased, and they hear about newer beta and latest releases.
- A new home starts directly at "Welcome to Clio Coder" and the first question. A home with no usable chat route tries configured targets, environment keys, Clio's stored logins and local servers on default ports, and saves a route only when none exists. `/config` runs configure inside the TUI and applies saved routing live. Peer agents enlist through current ACP recipes, including `@agentclientprotocol/claude-agent-acp` for Claude and `copilot --acp`.
- `clio-coder reset` and `uninstall` also remove the desktop app, and `uninstall` reports `.zshrc` and fish config lines that mention clio-coder. After a native upgrade, `clio-coder gui` and `gui background restart` accept the desktop app the previous version installed.
- `clio-coder doctor` leads with whether chat can run. `clio-coder library register|pin|drift` print text unless `--json`, and `clio-coder tools list|status` say when a pin bump superseded a vendored tool.

### Release qualification and platforms

- A manually dispatched release workflow gates the selected commit on CI and exact-package qualification, verifies the tarball checksum, publishes those bytes to npm with provenance, and creates the GitHub release and tag last. A failed qualification leaves the release tag unused.
- CI gates root contract and smoke tests, GUI checks and tests, maintenance checks, and installed-package tests on Linux with Node 22. The platform matrix builds and boots on macOS and Windows with Node 22, and Linux with Node 24 and the minimum Node 22.19.0; installed-package checks also run on those macOS and Linux legs. Windows runs selected subprocess contracts but explicitly skips the installed-package test. Node 24 also runs lifecycle, provider-transport and session-durability contracts.

### Approvals, trust and worker safety

- A permission approval renders inside the editor's own rails. The top rail names the decision and its kind, the card lists tool, target, effect, requester and worker authority, and `Alt+T` opens the full terms and `Alt+V` the full invocation. Bash approvals state what the command would do. A draft you were typing stays editable under the card.
- Every worker attempt runs under an immutable permit that fixes its asks, tools and Git allowance. `clio-coder run --delegate-tools` sets what dispatched workers may hold, separately from the main agent's `--allow-tools`.
- `fleet.permissions.mode: main` is a new opt-in. The main agent grants ordinary worker asks on native local workers at `yolo` and forwards them to you at any other autonomy level. Asks that need operator authority always reach you, and an ask no one can answer is denied.
- Workers in a task worktree commit on their task branch through a typed `git` capability (`status`, `diff`, `log`, `show`, `add`, `commit`) that refuses fields an operation does not take. Clio asks an attached operator before withholding a task worktree merge. A task worktree Clio created inherits package trust while its package state is unchanged. Model-run `clio-coder library import`, `push` and `remote` ask for confirmation like other library mutations, and `--dry-run` never asks.
- Information flow (advanced and opt-in) keeps named content with the models you chose. Source rules in `.clio-coder/safety.yaml` under `informationFlow` name paths or tools and their allowed recipients, and `clio-coder config trust safety` approves them. Refusals hold at `yolo`, restrictions travel through workers, resume and compaction, and a project with no rules behaves as before. The policy format may change.

### Terminal

- Partial project-instruction coverage appears once per workspace as an expiring footer notice, instead of a persistent welcome row.
- Messages sent during a run are held in Clio and handed over at the next steering slot. The queue navigator (`Alt+K`) reorders, edits, removes, switches an entry to end-of-turn and sends it now, and `Alt+S` interrupts the run with your draft. `/resume <id>` resumes a session directly, and a clean exit prints the resume line. CLI `--resume` and `--continue` stay refused (#191).
- The exit summary shows identity, model, tokens, cost provenance, wall time and resume instructions in brief form, and adds turns, files changed, tools, worker outcomes and compactions in standard and report form.
- An edit's diff shows once its arguments close, before the call runs. `/compact <instructions>` binds the summarizer and keeps the instructions verbatim. The wheel scrolls the transcript while an overlay is open and never moves list choices.
- Each substantive turn ranks installed skills, gateway capabilities and agents, and the reminder names up to five likely skills and three capabilities without changing the tool set between turns. `clio-coder fleet view <runId>` shows the requested model beside the provider-reported one, with cost provenance, and `--json` prints the snapshot with its authenticated receipt.

### Fleet and tools

- `clio-coder fleet nodes add|list|remove|test|discover|install` manages SSH worker nodes (experimental). `install <id> --yes` installs the exact client build you run, `discover` lists Tailscale peers, and a node needs a passing recorded `test --record` before dispatch. `fleet.defaultNode` sets a standing preference, and edits from a separate checkout return through isolated task branches. `clio-coder fleet cancel <runId>` cancels a run from any terminal.
- `read` lists zip and tar archives and reads one text member, extracts PDF text by page (needs poppler's `pdftotext` and `pdfinfo`), and renders Jupyter notebooks. The `data` tool reads SQLite databases read-only.
- The per-turn observation pool scales with the active context window. Automatic compaction pauses after three consecutive failures, while `/compact` and overflow recovery still run. A fleet loop's check step also runs the test files its workspace changed, and a failure feeds the repair loop.
- Headless runs and the coder agent map each task clause to evidence before finishing. Unattended runs and workers install only dependencies that were never installed and report failures confined to files they did not touch. When Clio needs one-off routing for a dispatch, she pins the dispatch's `target` and `model` fields instead of editing routing settings.
- Headless `clio-coder run --agent` prints a "Not verified:" block from the sealed result. Codex, OpenAI Responses and Azure Responses calls record the model the provider reports.

### Editors and ACP

- ACP pushes `usage_update` (at most one per model response), `plan` after board changes and `_meta["clio-coder/workspace"]`, so clients stop polling. It serves `/view` artifacts through `_clio-coder/artifacts/list` and `read`, sealed receipt facts on terminal fleet frames and replay, and ignored untrusted project surfaces in `_meta["clio-coder/trust"]`.
- `_clio-coder/session/shell` runs an operator shell line with the terminal's `!` and `!!` semantics, and `_clio-coder/session/queue_edit` removes, restores, moves, retypes and sends queued entries, with `_clio-coder/session/queue_changed` notifications for clients that opt in. Worker permission asks, `ask_user` and harness cards reach an attended ACP client, and bash asks carry the command's consequence line. `session/load` replay does not yet show shell lines.

### Experimental

- Docks need Herdr and are off by default. `Alt+W` opens a live workers dashboard (`clio-coder fleet view --watch`), `Alt+E` the Yazi files pane (`interface.panes.files.enabled`), and `Alt+A` the music pane. A hidden dock keeps running, and a second tap within 400 ms closes it. `/panes` and `/files` report and control docks.
- `/music` and the opt-in `music` tool drive cliamp 1.63.2 as focus radio. They need `integrations.music.enabled: true`, `integrations.music.agentControl` for the tool, and `clio-coder tools install cliamp` or a package-manager install.
- System One gains per-model capability profiles (`systemOne.engines.<name>.profile`), per-task routing under a site binding, a `steer` site and category hierarchies for recipes and catalogs. Its sites, keys and cuts may change between releases.
- `chat.steering.triage` (off by default) lets a side model read queued messages once the queue settles and relabel them. An unrelated task waits for the end of the turn, and a confident stop may interrupt the run. `fleet.speculativeDispatch` stays experimental.

### Fixed

- A turn that only writes Markdown, reStructuredText, AsciiDoc or Mermaid source finishes as prose-only instead of "change not verified". Stopping at an approval card says the turn stopped and the tool did not run.
- Redaction no longer treats code such as `token = getToken()` or a pure `$NAME` reference in an assignment as a credential, while literal secrets still redact, and durable trace payloads stay valid JSON after redaction.
- Python verification resolves `python` or `python3` once, refuses a uv project without `.venv`, and recognizes `PYTHONPATH=<relative paths>` test forms. A check that cannot start is reported as unavailable and not retried.
- Typed Git refuses fields an operation does not take, and the loop guard keys repeated Git calls on the arguments that run.
- A new desktop task opens when its model target is down instead of failing with "Clio ACP process is unavailable".

## 0.5.9 - 2026-09-29

A `v0.5.8` tag was published on 2026-09-29 and withdrawn before the package reached npm. Its changes ship in 0.5.9.

- Experimental System One decisions: typed decision calls served by a hosted engine, a self-hosted `systemone` server or a configured chat model, bound through `systemOne.engines` and `systemOne.sites`. An unfitted build runs in shadow, and a non-empty `fleet.decisionProfiles` or `turnControl.interpretation` is retired in favor of them.
- Model knowledge comes from the serving server first, then the packaged `models/profiles.yaml`, with labeled estimates where no window is reported. The Pi SDK moves to 0.99.1, adding GPT-6.1 Sol through `openai-codex` and Sonnet 5.5 through `anthropic-max`.
- `clio-coder doctor` previews and `doctor --fix` repairs settings files that stopped loading on a retired value such as `safety.autonomy: auto-edit`. Session cost ceilings apply before paid requests, and `/upgrade` upgrades npm installs in session.

## 0.5.7 - 2026-09-27

- Main sessions attach `read`, `write`, `edit`, `gateway` and `dispatch`, and other capabilities are found through the gateway, where `gateway(op="chain")` composes bounded dependent steps. Repository tours go to the read-only Scout recipe.
- Repository quality policies in `.clio-coder/quality.yaml` select required checks by changed path, and receipts distinguish executed checks from denied ones. The structural index becomes the codemap in `.clio-coder/codemap.json`, and session format 6 cannot be reopened by format-5 readers.
- The browser app gains first-run model setup and redesigned conversation and inspection pages, and `/usage` gains an Activity heatmap. `clio-coder docs` and its documentation server are removed.

## 0.5.6 - 2026-09-25

- **Breaking:** `safety.autonomy` accepts only `default` and `yolo`, and a user `settings.yaml` holding `auto-edit`, `full-auto`, `suggest` or `read-only` refuses to load. Project settings can no longer set autonomy, and workers and peers always run at `default`.
- **Breaking:** ACP custom methods moved under `_clio-coder/`, error codes follow ACP v1, and the custom session list, delete and autonomy methods are gone in favor of `session/list`, `session/delete` and `session/set_mode`.
- **Breaking:** The read-time aliases for old `clio` names are removed, along with `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` and the unread keys `integrations.externalAgents.entries[].permissionTimeoutMs`, `integrations.externalAgents.entries[].labels` and `fleet.decisionProfiles.routing`.

## 0.5.5 - 2026-09-24

- Managed Codex, OpenCode and Pi CLI runtimes join Claude Code and Antigravity in dispatch. `/peer` opens any of them in an owned Herdr pane, and `/run --worktree` keeps a task branch.
- Image admission follows the resolved route's live capability, and an optional `fleet.profiles.vision` sidecar describes images for text-only routes.
- `verify` runs Python, Cargo, Go, CMake, Makefile and justfile checks, and fleet workers receive the project handbook rules that apply to them. Source builds work on case-insensitive filesystems (#397).

## 0.5.4 - 2026-09-23

- `clio-coder upgrade --restart` upgrades and resumes the last session, and a quiet update hint can be disabled with `CLIO_CODER_UPDATE_CHECK=0`. Dispatch runs and receipts carry their owning session, and `fleet` commands default to the current project (`--all` for machine-wide) (#392 to #396).
- A unified transcript grammar covers worker cards, compact folding and `/view`, and the instant shell answers the keyboard while the interface loads.
- Adds `/draft`, experimental `fleet.speculativeDispatch` and more System One decision sites. The `eval` command suite is removed.

## 0.5.3 - 2026-09-22

- Inception Mercury diffusion models run through the `inception` runtime (`INCEPTION_API_KEY`) and stream frame by frame in the terminal.
- A `typesafe-jev` runtime and the `decide()` primitive let System One decision sites bind through `fleet.decisionProfiles`.
- `gateway(op="find")` and `describe` answer from a persistent MCP tool metadata cache instead of launching servers.

## 0.5.2 - 2026-09-21

- `self_compact`, `/context recover` and strict input and reserved-output budgets across tool continuations, with session format 5.
- Skill discovery pages and detects drift, and the `clio-coder-dev` and `clio-coder-test` skills are redesigned.

## 0.5.1 - 2026-09-21

- `/usage` replaces `/cost` with Accounts, Session, Models and Workers views and subscription quota readers for Claude Code, `anthropic-max`, Codex CLI and Antigravity.

## 0.5.0 - 2026-09-20

- Public launch with the CLI, interactive TUI, headless `clio-coder run` with sealed receipts, and a bundled browser application.
- Safety admission for tools and shell commands, automatic compaction with working-set retention, session format v4, and `doctor --deep`.
- Fleet dispatch with automatic concurrency, a circuit breaker with failover, isolated task worktrees and optional Slurm dispatch, plus `clio-coder library` packages.

## 0.4.9 - 2026-09-17

- Hardened `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `run_script`, `verify`, `data` and MCP gateway tools with bounds, atomic writes and sandboxed shell execution.
- Web extraction, artifacts, terminal pane docking and subprocess cleanup on SIGINT and SIGTERM.

## 0.4.8 - 2026-09-12

- A Linux systemd background service and installable web app for the browser app, with one web build that retires the standalone trace viewer.
- An exact-package qualification script, and output limits, thinking settings and history retention applied at their declared boundaries.

## 0.4.7 - 2026-09-10

- Installable plugins, skills, agents, prompts and fleets unify into `library/` packages managed by `clio-coder library` and `/library`.
- Operator extension runtimes with namespaced slash commands, harness extensions for contained Node.js and Python tools, and a compact three-row welcome header.

## 0.4.6 - 2026-09-08

- Compact, Standard and Detailed output styles toggled with Alt+O, and a Quick Connect launcher option.
- Defaults to a single worker with prompt prewarm off and automatic TTY streaming.

## 0.4.5 - 2026-09-07

- `CLIO-CODER.override.md`, worker task timeouts, dynamic tool-result truncation, and `/context inspect` and `/context prune`.

## 0.4.4 - 2026-09-05

- MCP protocol v3 with bidirectional tool routing, `clio-coder trace`, and settings moved to `~/.config/clio-coder/settings.yaml`.

## 0.4.3 - 2026-09-05

- Remote marketplace skills, `clio-coder context map`, a read-only `world-knowledge` agent and `context.compaction.model` overrides.

## 0.4.2 - 2026-09-02

- A `/files` pane, `context.toolResultMaxBytes` (65,536 bytes by default), `chat.thinkingLevel` defaulting to `low`, and Pi SDK 0.84.4.
- Documentation restructured into `docs/guide/` and `docs/architecture/`.

## 0.4.1 - 2026-09-01

- Version-2 `settings.yaml` organized around `chat`, `fleet`, `targets`, `context` and `safety`, with machine-facing names consolidated under `clio-coder`.
- Panes, docks and Yazi integration marked experimental, and `clio-coder doctor` runs read-only unless `--fix` is given.

## 0.4.0 - 2026-08-31

- `clio-coder tools list|status|install|remove`, Herdr pane integration, a first-class LiteLLM runtime and run event journals.
- `@anthropic-ai/claude-agent-sdk` moves to `optionalDependencies`.

## 0.3.9 - 2026-08-30
Execution envelopes binding prompt fragment ids to results, a bounded SQLite trace mirror with `clio-coder trace prune` (#226), and `clio-coder config validate`.

## 0.3.8 - 2026-08-29
`clio-coder evidence` inspects, validates and exports evidence bundles with deterministic SHA-256 hashes.

## 0.3.7 - 2026-08-24
Typed dispatch intent with host-run verification (#155), `/btw` side questions (#41), opt-in desktop notifications (#204), and single-writer leases with task worktrees (#207).

## 0.3.6 - 2026-08-23
A `/tasks` board overlay, multi-stage prompt caching with prefix stabilization, and per-turn cost estimates from target pricing.

## 0.3.4 - 2026-08-22
Session format v4 with context eviction and recall records, `context.workingSet` settings, and policy-gated `verify(check=<id>)`.

## 0.3.3 - 2026-08-21
Transcript detail unified under `/output` with per-block folding, folded Bash bodies and stream-ordered thinking segments.

## 0.3.2 - 2026-08-20
Fullscreen mode with native Mermaid and LaTeX, HTML transcript export, Git commit attribution, Pi SDK 0.84.0 and hardened worker and ACP safety policy.

## 0.3.1 - 2026-08-16
Live worker transcript blocks, receipts and replay for `/run` and `/delegate`, interoperability discovery for external coding agents, and a redesigned TUI.

## 0.3.0 - 2026-08-14
First npm-published `clio-coder` command, with agent ledgers, durable capacity leases and receipt-backed dispatch plans.

## 0.2.9 - 2026-08-05
Deterministic fleet code steps with bounded check and repair loops, shipped SDLC fleets, a durable trace store and typed worker result contracts.

## 0.2.8 - 2026-07-07
A consolidated seven-plane tool surface, task tracking, codewiki v4 and multi-model local residency, with legacy tools such as `glob` and `dispatch_batch` removed.

## 0.2.7 - 2026-07-02
Reviewed marketplace skills, credential damage control, usage reports, headless receipts and secret redaction in evidence bundles.

## 0.2.6 - 2026-06-24
VRAM-aware local-model residency, layered settings, path-scoped rules, operator profiles, hooks and configuration inspection.

## 0.2.5 - 2026-06-23
The `alcf` runtime for Argonne ALCF Sophia and Metis targets with Globus OAuth.

## 0.2.4 - 2026-06-23
Fleet management with agent and profile bindings, fault-tolerant dispatch and a `/fleet` overlay.

## 0.2.3 - 2026-06-17
Declarative slash commands and hubs, enforced autonomy notices, codewiki indexing, live steering and richer receipts, with legacy slash commands retired.

## 0.2.2 - 2026-06-11
Context engine with compaction and bounded tool results, ACP support, a curated skills marketplace and local install and uninstall scripts.

## 0.2.1 - 2026-06-05
Live token-throughput telemetry, prompt-envelope hashes and `clio run --json` prompt diagnostics.

## 0.2.0 - 2026-06-03
First community alpha for source-checkout users, with JIT skills, stronger compaction, durable sessions and diagnostics.

## 0.1.9 - 2026-05-17
First-class fleet `dispatch`, frontend artifact validation, typed finish evidence and local-model capability improvements.

## 0.1.8 - 2026-05-11
Extensions, share archives, a redesigned welcome dashboard and a Claude Code SDK safety bridge.

## 0.1.7 - 2026-05-11
A shared safety-policy engine, strict project command policies and typed execution tools; default Bash denies ordinary execution unless allowed.

## 0.1.6 - 2026-05-04
`clio --print` and `clio -p` run one non-interactive turn.

## 0.1.5 - 2026-05-03
Public alpha for source-install developers and research-software teams, with `clio init`, `CLIO.md` parsing and codewiki indexing.

## 0.1.4 - 2026-04-30
Evolution tooling for inventories, evidence, evaluations, memory, middleware and protected artifacts.

## 0.1.3 - 2026-04-27
Live tool output, Bash echo, thinking expansion and a Git-branch footer slot, with `CLIO.md` as the canonical project file.

## 0.1.2 - 2026-04-25
Visible retries for transient provider and stream failures, and many interactive fixes.

## 0.1.1 - 2026-04-24
Deterministic loading of project context files from the working directory upward.

## 0.1.0-exp - 2026-04-24
Initial experimental public release with the interactive TUI, lifecycle CLI, target-first configuration, dispatch workers, receipts and safety modes. Windows support was best effort.
