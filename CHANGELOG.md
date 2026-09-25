# Changelog

All notable changes to Clio Coder are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.5.6 - 2026-09-25

### Autonomy

- **Breaking:** `safety.autonomy` accepts only `default` and `yolo`. The retired values `auto-edit`, `full-auto`, `suggest` and `read-only` are refused with no migration, and Clio will not start while your user `settings.yaml` holds one. Edit the file by hand: `auto-edit`, `suggest` and `read-only` become `default`, and `full-auto` becomes `yolo`. `clio-coder paths` shows where the file is. `--autonomy` accepts the same two names.
- **Breaking:** Project settings can no longer set autonomy. A `safety.autonomy` in `.clio-coder/settings.yaml` or `.clio-coder/settings.local.yaml` is ignored with a diagnostic, whether or not the file is trusted. Set it in your user `settings.yaml`, `/settings`, `clio-coder configure`, `--autonomy`, or an ACP client's session mode.
- `configure_clio` refuses to preview or apply `safety.autonomy` at either level, so only the operator changes autonomy.
- Autonomy now governs only the main agent. Workers and peers always run at `default` (see Dispatch and peers).
- The session prompt, the `/settings` help and the safety model guide describe the two levels as the code enforces them. `default` runs workspace edits and recognized commands, and asks before project build, lint, typecheck and CI scripts, other commands, outward actions, access outside the workspace and plan-scale dispatch. `yolo` runs all of those without asking, while hard blocks, damage-control confirmations and protected paths still apply.
- A headless `clio-coder run` now tells the model that no operator is attached and that approval-required calls are denied, instead of saying they pause for a confirmation that never comes.

### Dispatch and peers

- **Breaking:** Every dispatched worker and external peer runs at `default`, whatever the session level. A yolo session no longer passes yolo to its workers, and their asks resolve through `fleet.permissions.mode`.
- **Breaking:** `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` is removed and ignored, so a peer can no longer run in its own full-access mode through Clio. `toolGovernance: agent-managed` on a peer entry remains the one explicit opt-in to peer-owned tools, and admission refuses it for a read-only run.
- **Breaking:** `clio-coder run --agent --autonomy` is a usage error (exit 2). Use `--read-only` to restrict a dispatch.
- **Breaking:** The worker spec is now version 5, so a remote fleet node running an older build refuses dispatches until it is upgraded.
- Read-only is a dispatch restriction instead of an autonomy level. Recipes with `capabilityClass: read-only`, reviewer, judge and council roles, `/oracle`, the watchdog verifier and fleet `scope: readonly` set it. A read-only run may read inside the workspace and nothing else, and it cannot load a skill.
- Added `--read-only` to `/run`, `/delegate` and `clio-coder run --agent` to restrict one dispatch. Peers enforce it with their own read-only modes: Codex `--sandbox read-only`, Claude Code `plan` with read tools, Antigravity `plan --sandbox`, and Pi read tools. OpenCode refuses a read-only headless run before launch.

### ACP

- **Breaking:** Clio's custom methods and her event notification moved under the `_clio-coder/` prefix that ACP reserves for extensions, for example `_clio-coder/session/label` and `_clio-coder/event`. The `clio-coder/*` names are gone with no alias, so third-party clients must switch.
- **Breaking:** The custom session list, delete and autonomy methods are gone. Use `session/list`, `session/delete`, and `session/set_mode` or `session/set_config_option`.
- **Breaking:** Error codes follow the ACP v1 schema. `-32000` now means only authentication required; invalid params use `-32602`, a missing resource `-32002`, and an unclassified failure `-32603`. A client that treated `-32000` as a generic failure must read the specific codes.
- `initialize` answers protocol version 1 and advertises only what Clio serves. A client that advertises `auth.terminal` gets a terminal method that runs `clio-coder acp auth login` and opens Quick Connect in a separate process; other clients get none. `authenticate` and `logout` are served.
- Every request and notification accepts `_meta`, and `session/prompt` accepts `resource_link` blocks, which the model sees as a `Resource: <name> (<uri>)` line.
- Added `session/list` with a cwd filter and cursor paging, `session/delete`, and `session/resume`, which restores a closed session without resending its messages.
- `session/load` streams the complete active-branch history, without the former 64-turn and 4 MiB cut, so loading a long session sends much more to the client.
- `session/close` cancels an active prompt, waits for it to settle, and then closes, instead of refusing.
- Sessions offer the modes `default` and `yolo` through `session/set_mode` and `current_mode_update`, and config options for autonomy, model and thinking level through `session/set_config_option` and `config_option_update`. A change during a prompt is refused, and model and thinking changes apply to the session without saving a default.
- The server sends `available_commands_update` for the commands that work over ACP, `session_info_update` when the session label changes, and each tool's `name` when it starts. Per-turn usage, now with cost provenance, stays in `_meta["clio-coder/usage"]`; Clio sends no `usage_update` or `plan` update.
- When no workspace is bound yet, the first `session/new`, `session/load` or `session/resume` binds the server to the `cwd` it names, so a client no longer has to launch Clio in the project directory. `clio-coder acp --cwd <dir>` still binds at launch.
- A later session that names a different `cwd` is refused with `-32602` naming the bound workspace.
- Stdio MCP servers a client passes in `session/new`, `session/load` or `session/resume` run for that session only and are never written to settings. Every call goes through the gateway's safety policy and autonomy like any other MCP capability, and closing the session stops the servers.
- **Breaking:** As a client of ACP peers, Clio selects a named model only through the peer's `model` config option and `session/set_config_option`. A peer that offers models only through the unstable `models` field can no longer take a named model, and that delegation fails before the prompt.
- When an ACP peer offers a `thought_level` select config option, Clio sets a requested thinking level through `session/set_config_option` and refuses the delegation if the peer reports a different level. Peers without that option still use `model[effort]` variants.
- Clio never answers a peer's permission request with `allow_always`, which would turn one approval into a standing grant inside the peer. When a peer offers no `allow_once` for a call Clio approves, Clio rejects the call and the receipt's delegation tool log says why.
- Clio advertises no client capabilities to ACP peers, because she serves no file-system or terminal methods to them.

### Receipts and evidence

- **Breaking:** A receipt records one `autonomy` field, the level the run ran under; workers always record `default`. The `autonomyEnforcement` block and the autonomy trust axis are gone, so evidence and the GUI show five trust checks instead of six. Read `autonomy` where you read `autonomyEnforcement`. Receipts sealed by earlier builds still verify.
- **Breaking:** New gate decisions and receipts write `yolo-policy`, `yolo-applied`, `yolo-applied-winner` and `yolo-gate-policy` where earlier builds wrote the `full-auto-*` ids. Records sealed earlier still read and verify unchanged.
- **Breaking:** New receipts no longer carry fields nothing read: `attestation`, `identity.hpc` (the Slurm, PBS or LSF allocation), `reproducibility.git`, `fleetGate`, `ledgerContribution`, `pathScope`, `staticShellHash` and the decision and first-token phase marks. Sealing a receipt no longer spawns git. Older receipts still verify.
- New evidence bundles no longer write `trace.raw.jsonl`, `trace.cleaned.jsonl`, `audit-linked.jsonl` or `protected-artifacts.json`; their counts stay in the overview. Bundles from earlier builds still read.

### Fixes

- **Breaking:** A startup flag before a subcommand other than `run` or `acp` (for example `clio-coder -nc doctor`) is refused with exit 2 instead of silently ignored. `--with-panes` and `--no-panes` are refused before any subcommand.
- **Breaking:** `clio-coder fleet run` refuses unknown flags and no longer takes an option's value as the contract name.
- **Breaking:** `clio-coder share export --dry-run` lists the entries and writes nothing, and each share command refuses a flag it does not read, so `export --force`, `import --both` and `inspect --force` exit 2.
- `clio-coder upgrade --restart` relaunches plain `clio-coder` instead of the refused `--continue`, and every resume hint names `/resume`.
- `clio-coder run --agent` forwards the seven sampling flags (`--temperature`, `--top-p`, `--top-k`, `--min-p`, `--presence-penalty`, `--frequency-penalty`, `--repeat-penalty`) to the worker and refuses `--json-events`.
- `--with-panes` with `interface.panes.enabled: embedded` now looks for a herdr host, as `auto` does, instead of opening no panes.
- `clio-coder doctor --deep` evaluates each validator at the session's autonomy level, as tool admission does. A `$(...)` validator asks at `default` and runs at `yolo`, and a damage-control confirmation asks at both levels.
- A failed evidence build now shows as an error on the dispatch board and in the footer.
- The trace mirror records every worker's tool calls with their durations, including claude-sdk workers, which had no `tool_call` rows.
- Tool statistics, safety decisions and finish-contract entries a worker produces now survive backpressure on the worker stream.
- A worker that fails to spawn names the spawn error in its receipt.
- A run adopted after a restart keeps its council membership and cost provenance.
- A failed or aborted prewarm no longer reads as a free success in usage records.
- A replayed tool row without a recorded duration no longer shows a made-up one.
- The GUI receipt provenance panel shows the Clio Coder version again, and the GUI keeps a running tool's partial output when an update carries no content.

### Removed

- **Breaking:** The read-time aliases for the old `clio` names are gone, with no migration. A user `settings.yaml` with `lifecycle: clio-managed` or `toolGovernance: clio-policy` refuses to load; use `clio-coder-managed` and `clio-coder-policy`. A target with `runtime: lmstudio-native` or `ollama-native` resolves to an unknown runtime; use `lmstudio` or `ollama`, and re-enter credentials stored under the old id. A `clio.<action>` keybinding is ignored in favor of the default; use `clio-coder.<action>`. Installed `clio-dev` and `clio-test` skills load under their old names, and installing `clio-dev` finds nothing; the skills are now `clio-coder-dev` and `clio-coder-test`.
- **Breaking:** `doctor --fix` no longer rewrites legacy names in settings, skills, tool markers or the yazi profile, and `upgrade` registers two migrations instead of five. A yazi process left from a 0.4 session no longer delivers picks, and fleet preflight no longer accepts the pre-rename `clio-preflight/1` reply.
- **Breaking:** Three settings keys nothing read are retired: `integrations.externalAgents.entries[].permissionTimeoutMs`, `integrations.externalAgents.entries[].labels` and `fleet.decisionProfiles.routing`. A user settings file naming one refuses to load with a "retired without replacement" issue; earlier builds wrote `permissionTimeoutMs` on every peer accepted through interop consent, so remove it by hand. In a project layer the key is dropped with a diagnostic.
- **Breaking:** A user hook whose event cannot apply its effect is refused at load instead of recording an effect that was dropped. Every user hook on `on_compaction` is refused.
- **Breaking:** A plugin manifest that declares `resources.themes` is refused. No loader ever read it.
- **Breaking:** `clio-coder configure --remove` and `--rename` are gone. Use `clio-coder targets remove` and `clio-coder targets rename`.
- New `trace.sqlite` databases have no `envelopes` table or itemized cost columns, which nothing filled, and the GUI drops the always-empty envelopes panel. A `trace sql` query naming them fails on a new database, and a 0.5.5 build cannot prune a database this build created. Existing databases keep both.
- `clio-coder usage report` rows no longer record `sessionId`, `timing`, `promptCache` or cost provenance, which the report never read.
- The `safety.allowed` and `extensions.reloaded` bus channels, which had no subscriber, and the GUI's desktop approval notifications, which could never be turned on.

### Documentation

- The README is rebuilt around nine fixed sections with a product screenshot, and a `readme-shape` hygiene check keeps that structure.
- The safety model guide is rewritten to the two-level model and to what the code enforces, including the real damage-control hard blocks and confirmation rules.
- The environment variable reference lists the ambient variables Clio reads, and its hygiene check now also fails when a documented variable is no longer read. `clio-coder config trust safety|hooks|settings` is documented.
- The 0.5.5 sprint retrospective no longer ships in the package documentation.

## 0.5.5 - 2026-09-24

### External coding agents

- Added managed Codex, OpenCode, and Pi CLI runtimes to Clio dispatch. Claude Code and Antigravity CLI retain their existing managed runners; all five now use the shared subprocess connector registry. Configured headless targets use the normal run board, events, cancellation, and sealed receipts.
- `/interop` and `interop inspect` now show the modes available for each installed peer and the setup needed to use them. Added `/peer [--cwd <workspace>] <peer> [brief]` to open any of the five CLIs in an owned Herdr pane. A pane is an interactive handoff without a managed receipt.
- Claude Code retains its pinned ACP bridge; Codex retains its pinned bridge and OpenCode uses its native ACP mode. The outbound ACP client now resolves explicitly named environment references and records task worktree edits. ACP receipts state that peer-owned tools may write without sending a permission request. Antigravity CLI and Pi have no built-in ACP recipe.
- Added `/run --worktree` for a preserved task branch. Managed receipts record the branch and changed paths, or the Git-visible delta observed in the current checkout. OpenCode headless forwards only credential variables referenced by its local provider configuration and refuses authority levels its CLI cannot enforce.

### Image input and vision

- Image admission now uses the resolved route's live capability decision. An explicit deployment probe reporting no image input takes precedence over family defaults, while a target override remains authoritative. Later model hints preserve the probed result, and the optional vision sidecar probes its target before its first headless use.
- A text-only route refuses new image turns before saving the turn or contacting the provider, with the selected route and available vision choices in the interactive notice and `IMAGE_INPUT_UNSUPPORTED` in headless runs. Managed Codex, Pi, and OpenCode CLI peers remain text-only because their bridges do not carry image blocks, even with a vision override.
- When a text-only route follows an image-bearing session, Clio sends omission notes in place of historical image blocks and warns once; the saved session keeps the original images. The dashboard, model selector, and `/model` notices show the resolved image-input state.
- An optional `fleet.profiles.vision` target can inspect attached images before a text-only chat turn or answer a `vision` tool question about a recent attachment or image file. The main model receives a bounded, attributed text observation; image bytes stay with the sidecar. Image input documentation now lists supported formats and fixed resize and size bounds.

### Local models and routing

- LM Studio targets can set context, parallelism, flash attention, and speculative draft load options globally or per model. A LiteLLM route with one declared LM Studio deployment can use the same profile while requests continue through its alias; Clio does not forward the gateway key upstream. A resident instance with reported settings that differ from the profile is reloaded, which can interrupt another client's use of that instance.
- Clio records its LM Studio loads across processes and releases its earlier models before a profiled load on the same server. Live streams hold leases so another Clio process does not unload their model mid-request. Switching between models can now incur reload time.
- Qwopus routes send their Qwen-family sampler settings for thinking on and off instead of relying on server presets. Mini's quant-suffixed gateway routes are reflected in the catalog and tests, and model labels are wide enough to distinguish them in the TUI.
- An unknown dispatch node that matches a fleet profile now explains that node pins take `local` or a `fleet.nodes` id and points to profile selection.

### Project handbooks

- A project handbook written to the 200-line guideline now preloads in full. The session cap rose from 8000 to 24000 UTF-16 units, so the 220-line cap binds first, and `context init` now sees all of an existing handbook it is asked to preserve.
- Handbook discovery stops at the repository root, the nearest directory holding a `.git` directory or file. A `CLIO-CODER.md` in a folder above several repositories no longer instructs each of them. Handbooks nested inside a repository still layer.
- Fleet workers receive the handbook rules that apply to them instead of the first 1500 characters. Each H2 section compiles into rule units whose audience comes from the section title and whose scope comes from the paths it cites. A worker gets the hard invariants, the rules scoped to its dispatch paths and its role's rules within 6000 UTF-16 units, plus a line naming the sections it did not get. A `<!-- clio: audience=... paths=... -->` comment after a heading overrides both.
- A worker dispatched into a task worktree now receives the source checkout's handbook when the worktree has none, the usual case for a repository that keeps `CLIO-CODER.md` out of git.
- `clio-coder context init` now writes the rules an agent would get wrong after reading the code: hard invariants, conventions that differ from defaults, change recipes, and verification. The model receives an inventory of what the repository enforces, built without a model: the commands CI runs, the package scripts they reach, and each custom check with its coded failure messages and their remedies. It is asked for one rule per check an ordinary change can fail and for one rule on where a regression test must live so CI runs it. Clio writes the verification section itself from CI and the declared test runners.
- `context init` now uses the handbook the bootstrap worker submits through its result tool. Before, frontier models' output was dropped and the 11-line heuristic handbook was written. Citations are grounded against every visible repository path and file, so rules citing `CONTRIBUTING.md`, a CI job name or a glob are no longer deleted as invented. An overlong rule now ends at its last whole sentence instead of mid-word.
- When `context init` finds no route, its error now names the current `fleet.agentProfiles` and `fleet.default` keys.

### Verification and permissions

- `verify` now runs a repository's own checks outside Node. It derives Python runners (pytest or unittest, through `uv run` when `uv.lock` exists), Cargo, Go and CMake test presets, Makefile and justfile verification targets, and repository scripts that CI runs directly, such as `scripts/gate.sh`. A check it cannot resolve runs nothing, and the error names what was searched and points at `bash`. A resolved `verify` call is admitted exactly as `bash` admits the same command.
- At full-auto (`--autonomy yolo`), `npm run build|lint|typecheck|ci`, a test runner behind a pipe or redirect, and an `&&` chain holding a repository script now run without asking. They still ask at suggest and auto-edit. Headless runs, which deny every ask, had been refused their repository's own gate.
- Exact `git diff --check` commands run at capable. Typed `verify` scans the resolved command, model-supplied arguments, and execution directory before admission; shell substitution and protected paths retain their safety rails.

### Harness reliability

- Task views distinguish a completion claim from verified checks and name the next host validation action. Sealed delegated edits and batch collect progress now advance the loop guard without admitting unchanged retries.
- Native read-only scouts enter final synthesis after 36 observed tool calls. Dispatch summaries expose sealed batch call counts and cost with provenance for opaque external runs.
- Evidence pages through visible session bundles and explains trust axes and event attribution. Memory reminders suppress stale paths and resolved failures; skill load warnings show drift hashes and receipt provenance.

### Build

- Building from source now works on case-insensitive filesystems such as the macOS default. Four GUI logic modules were renamed so no module stem differs from its component's only by case, and a hygiene check rejects case-only path collisions (#397).
- Biome's exclusions are anchored at the repository root, so a checkout inside `.clio-coder/worktrees` or `.claude/worktrees` can lint its own files while the parent checkout skips nested worktrees.

## 0.5.4 - 2026-09-23

### Installation and upgrades

- Added a quiet, dismissible update hint that waits for an idle terminal. Checks start after the first full frame, cache registry results for a day, and detect when the running installation has been replaced. `CLIO_CODER_UPDATE_CHECK=0` disables the monitor.
- Added `clio-coder upgrade --restart` to upgrade an npm installation, complete migrations, and resume the project's last session after success.
- Preserve an npm installation's actual prefix and invoke the exact installed binary for post-install checks. Other package managers receive matching instructions; older dist-tags do not downgrade newer installations.
- Source installation now applies migrations before repair. Bootstrap installation reports incomplete post-install checks as a failure with the correct retry command.
- Reset and uninstall stop owned documentation servers before removing state. State reset also removes owned background services and preserves state if ownership or shutdown cannot be verified.

### Session and project isolation

- Dispatch runs, receipts, and batches now carry their owning Clio session. A sibling session in the same project can inspect a run, while collect, steer, nudge, and gate recovery act only on runs owned by the current session (#392).
- Resuming a session restores its own model and thinking level without changing global settings. Model changes in the picker and keyboard cycle stay in the current session until explicitly saved (#393).
- `/model` and `/settings` can save edits for the current project in `.clio-coder/settings.local.yaml`. Existing project settings must be trusted; an explicit save approves only the exact bytes Clio wrote (#394).
- `fleet status`, `inspect`, `decisions`, and `view` now show the current project by default. `--all` enables machine-wide inspection, including run and fleet root IDs from other projects (#395).
- The footer's first-pass success and accountability figures now count only runs owned by the current session (#396).

### Demo guidance and self-knowledge

- Demo guidance shows at most one `[tip]` row after a turn, chosen by the harness from what the turn did, such as a question about Clio's settings, a `btw` side question, or a correction that `/tree` could rewind. The model never sees tips and no model call is made. Tips are spaced out, capped at four per session, and retire once you use the feature. A local `harness-profile.json` tracks what you already know. Turning off Demo guidance in `/settings` (`interface.demo`) or passing `--no-demo` stops tips, footer key hints, and the profile.
- Clio reads her shipped docs and source without an approval prompt, always knows where her live settings are, and can preview a settings change with `configure_clio` at capable autonomy. At capable she cannot propose raising autonomy.

### Startup and input readiness

- The instant shell answers the keyboard while the full interface loads. Boot yields between its phases, so keystrokes echo, Enter queues a submission that runs once in order after loading, and Ctrl+C, SIGTERM and resize work before the full interface appears. `CLIO_CODER_INSTANT_SHELL=0` restores the old single-step boot.
- Operator extensions start just after the first full frame instead of before it, about 60 to 80 ms sooner to a usable screen with many plugins installed.
- Installed plugins are verified at most once per operation. Plain-text submits no longer verify them at all, slash completion and the `/help` and `/extensions` views read the plugin state committed at load, and `context`, library inventory and a session's first turn verify each plugin once. Running a template or an extension command still verifies it first.

### Transcript presentation

- **Two-cell gutter grammar**: Unified gutter across all output styles (`✓ Done`, `✗ Failed`, `⊘ Cancelled`, `▸` observation, `⚙` worker, `§` skills, `ℹ`/`⚠`/`✗`/`↻` notices) with hanging indents for wrapped rows.
- **Worker cards**: Display live action and spend across all styles (`⚙ running <cmd> · <time> · <tokens> · <calls>`), stack under dispatch calls (`◆ delegated to <role> ✓`), group council rounds under `◇ council · round N`, and show failover retry attempts.
- **Skill actions & status**: Dedicated `§` rows for skill activations, refusals with explicit error reasons (`manual-only`, `not-ready`, etc.), and armed surfaces in the footer until `/skill off`.
- **Receipts**: Consolidated Detailed turn receipts into a single fact per field (`✓ Done · 14s · 3 calls · in 100.1k · out 381 · reasoning 98 · cold: <reason>`), persisting consistently across `/resume` and `/export`.
- **Compact folding**: Group consecutive file reads, searches, and listings into class folds (`▸ explored 3 files, 2 searches ✓`), with cleaner folding across reasoning model spans.
- **Cleaned action rows**: Removed duplicate command echoes, repetitive error codes, and unnecessary workspace `cd` prefixes; state scalar arguments directly on the action row.
- **Inspectable `/view`**: Responsive layout switching above/below 84 columns, human-readable tool titles instead of raw IDs, redacted titles and search text, and post-paint layout optimization.
- **Direct transcript inspection**: Bare `/view` selects the first displayed transcript detail, and clearing its filter retains the selected item. The preview shows the selected row's full available content with terminal controls neutralized; worker inspection and `/export` retain raw answers and validation facts.
- **Worker outcomes**: Detailed trails distinguish successful, failed, and blocked calls in live and resumed sessions, compress repeated calls, and name earlier calls omitted by the four-action trail. Detailed receipts show speculative worker holds adopted or left unused after the session journal records them.
- **Terminal responsiveness**: Accurate footer rendering across terminal resizes, auto-scroll to live edge after prompts or commands, and proper diff row wrapping.
- **Narrow-screen polish**: Keep a quantized model suffix whole in the footer, reserve Fleet orange for a running glyph, exit fullscreen without printing its docked frame, name workspace-local `/export` files relatively, and omit a repeated run id from monitor previews.

### Transcript speed

- **Eliminated full transcript re-scans**: Replaced flex stack with delegating lease host to prevent call stack overflow on long sessions; step over unchanged rows in rewritten ranges.
- **Zero-copy rendering**: Eliminated transcript-sized array allocations per streamed frame; retain row buffers across frames and leverage zero-copy container rendering in pi-tui.
- **Immediate first-token display**: Render full first deltas on the leading edge of quiet windows instead of pacing individual graphemes.
- **Pre-warmed renderers**: Warm Markdown, LaTeX, and syntax renderers post-initialization to eliminate first-answer latency spikes.
- **Synchronized animation clocks**: Combined footer spinner and composer rail pulse on a unified 120ms animation clock; idle-render alternative output styles for instant Alt+O switching.
- **Cached replay blocks**: Cache notices, command output, and finished `!` commands in transcript render cache.

Fresh built-binary PTY measurements against `5a8289ce` used five interleaved runs per side at 120×40, Node 24.20.0 on WSL2, with compile cache disabled. The long fixture held 40,000 settled source lines across four turns under a 1,000,000-token mock context, avoiding benchmark-triggered compaction on both sides. Times are milliseconds; pairs are p50/p99 except first token and startup, which are medians. Earlier step-2 measurements used a different long fixture and are not directly comparable.

| Measure | Short before | Short after | 40k lines before | 40k lines after |
| --- | ---: | ---: | ---: | ---: |
| Idle key to stdout | 1.09 / 3.12 | 1.11 / 3.07 | 4.70 / 12.00 | 2.63 / 3.14 |
| Streaming key to stdout | 0.70 / 6.36 | 0.69 / 1.42 | 5.27 / 14.22 | 2.17 / 2.89 |
| First token to stdout | 33.11 | 8.57 | 34.02 | 6.96 |
| Stream frame | 0.52 / 2.45 | 0.53 / 1.21 | 5.23 / 14.55 | 2.04 / 9.94 |
| Stdout bytes per token | 149.58 | 140.12 | 143.70 | 138.21 |
| Stage 0 / Stage 1 startup | 112.6 / 745.6 | 113.3 / 743.5 | 118.6 / 778.8 | 122.6 / 767.5 |

Every run committed all 400 streamed deltas with zero full redraws. In three interleaved short runs with an empty composer, stdout bytes per token fell from 141.37 to 130.94.

### Streaming Markdown

- **Block-by-block streaming**: Render completed top-level Markdown blocks as the next block begins; style open code fences, lists, and quotes while growing.
- **Layout caching**: Retain transcript rendering across the last three layouts for instantaneous style toggling.
- **Clean spacing**: Automatically drop blank opening rows in replies.

### Diffusion frames

- **Interactive diffusion streaming**: Stream Inception Mercury answers frame-by-frame in TUI, rewriting live frames instead of concatenating delta SSE chunks.
- **Scoped interactive rendering**: Restrict diffusion frame replacement to interactive surfaces; headless `run`, ACP, JSONL, and workers retain standard delta streaming.
- **Tool-call stability**: Preserve single preamble frame segments during tool-call argument deltas and accurately track time-to-first-token.
- **Progress semantics**: The footer enters Writing on the first frame. No numeric denoising gauge is shown because the API reports progress as 0 until its final frame reports 1.

### Drafts judged by a decision model

- **`/draft [N] <request>`**: Added command to generate N parallel candidate drafts and select the best response using a decision model.
- **`drafts` decision site**: Added dedicated decision site for evaluating and ranking candidate draft answers.

### System One decision sites

- **Decision sites**: Added `turnScope`, `dispatchForecast`, `capabilities`, `consult`, and `drafts` decision sites; retired legacy `routing` site.
- **Unified `askSite` interface**: Added single resolution entry point with certainty floors, structured criteria scaling, and provider-agnostic distributions across Jev and Laya models.
- **Speculative dispatch**: Added experimental pre-turn worker prewarming behind `fleet.speculativeDispatch`.
- **Dispatch accounting**: Persist speculative hold, adoption, and discard counts for live Detailed receipts and `/resume`. Admit requests to check whether tests pass to verifier, and classify inspection of test files as read work for scout.
- **Batched pre-turn briefs**: Combined pre-turn memory and skill relevance queries into a single batched request with a 1.5s timeout.
- **Calibration tooling**: Added `scripts/decision-probe.ts` with `--cases` to score and calibrate site prompts and certainty thresholds against labeled fixtures.
- **Local execution**: Documented running Laya locally through `typesafe-jev` on CPU and ROCm/Radeon iGPU.

### Pi 0.87.1

- Upgraded to Pi 0.87.1.
- Limited worker terminal handoffs to three requests upon repair exhaustion.

### Fixes

- Registered `inception` and `typesafe-jev` in the runtime boot manifest.
- Demoted dated release handoffs in documentation search.
- Corrected skill listing ordering when decision models abstain.
- Refused `targets use --model` selections targeting unconfigured roles.
- Normalized worker error classification and grounded citations to grep matches.
- Bound pre-turn memory and skill query latency.
- Mark a call target only when its source description is actually truncated at 120 characters; ACP, audit, and TUI use the same mark. Charge the context estimate only for custom handoff seeds replayed to the model, rather than display-only session records. Strip inert `<tool_call>` markup from a pending worker answer tail while preserving the settled raw answer for inspection.
- `verifiers validate` fails when discovery would block the catalog, and names the colliding check id and both of its sources. Ported from ikourkouta-svg's fix (#382).
- Model lists come from the provider when it answers. A cached list or catalog shown as a fallback says why in `configure`, `targets use`, `models` and the model picker. Gemini lists the models its API key can generate with (#390, #386).
- ALCF targets ask for a gateway URL, with the Sophia endpoint as the example, instead of offering `http://127.0.0.1:8080` (#388).
- On macOS, the safety classifier and the startup workspace check treat `/private/etc`, `/private/var` and `/private/tmp` as the system paths they are, and the root test suites pass there (#391).

### Tool contract coverage

- Enforced executable contract test references for all built-in tools.
- Added contract tests for `steer`, `monitor`, `ledger`, `panes`, `ask_user`, `code_nav`, and `data`.
- Promoted 7 deterministic tests to `tests/contracts/` (`evidence`, `decide`, `limitation`, `tasks`, `verify`, `web_read`, `web_fetch`).
- Synchronized built-in tool inventory count to 31.

### Removed

- Removed evaluation engine (`src/domains/eval`) and all `clio-coder eval` subcommands (`validate`, `run`, `report`, `compare`, `gate`, `baseline`, `inventory`, `skill`).
- Removed `evals/` test suites, baselines, and behavioral benchmarks.
- Removed `clio-coder evidence build --eval` and eval evidence sources.
- Removed GUI Evals view, `/api/evals` endpoints, and evaluation scenario files (`evals.md`) from library skills.

## 0.5.3 - 2026-09-22

### Diffusion model support

- **Inception runtime**: Added `inception` cloud runtime for Inception Mercury diffusion models (`mercury-2.5`, `mercury-2`, `mercury-edit-2`), authenticated via `INCEPTION_API_KEY`.
- **Chat and FIM endpoints**: Wired chat completions at `/v1/chat/completions` and fill-in-the-middle at `/v1/fim/completions` via `infill()`.
- **Reasoning configuration**: Disabled reasoning with `reasoning_effort: instant` to prevent hidden token exhaustion.
- **Provider compatibility**: Added `compat` and `samplingParams` passthrough for catalog-backed models; dynamically probe context and output limits from `/models`.

### System One decision models

- **TypeSafe runtime**: Added `typesafe-jev` cloud runtime (`jev-latest`, `jev-preview`), authenticated via `TYPESAFE_API_KEY`, for closed-distribution micro-decisions (`chat: false`).
- **`decide()` primitive**: Added `decide()` verb covering `noul` (truth probability), `choice` (categorical distribution), and `score` (position on a criteria ladder).
- **Confidence handling**: Separated confidence from probability; derived `noul` certainty based on deviation from coin-flip; abstentions return `null` below confidence floor.
- **Harness binding**: Bound decision sites via `fleet.decisionProfiles` (`routing`, `skills`, `memory`, `toolRisk`) with fallback to heuristics when unbound.
- **Decision integration**: Ranked skill discovery by relevance; scored command blast radius advisively in approval prompts; batched synchronous memory scoring during turn boundaries.

### Harness eval baselines

- **Committed baselines**: Recorded per-task baselines via `eval baseline record|check` and inline checks in `eval run`, pinning deterministic harness properties while excluding environmental noise.
- **Tool bench suites**: Added `bash` tool bench suite (230 scenarios) with per-scenario autonomy (`auto-edit` vs `full-auto`). Added 5 offline machinery suites covering admission, prompts, and context budgets.
- **Suite renaming**: Renamed `tracked-metrics-baseline.yaml` to `tracked-metrics-suite.yaml`.

### Cached MCP discovery

- **Cached metadata queries**: Answered `gateway(op="find")` and `describe` from persistent tool metadata cache (`metadata-cache.ts`) instead of launching MCP server processes on discovery.
- **Catalog persistence**: Persisted bounded tool catalogs per declared server, tracking provenance and missing catalogs; added `server` and `refresh` parameters to `find`.
- **Live execution**: Kept live server connection and real-time schema validation for `call`.

## 0.5.2 - 2026-09-21

### Context continuity and memory

- **Self-compaction**: Added `self_compact({note_to_self})` for assistant-authored notes, whole-batch exclusivity, and summary/eviction checkpoints.
- **Context recovery**: Added `/context recover <handoffId> <reduce|deliver>` for explicit branch-bound recovery; session format v5 persists continuity records across forks and replays.
- **Budget enforcement**: Strictly enforced input and reserved output budgets across tool continuations; inspectable via `context(scope="budget")` and `/context`.
- **Memory stability**: Froze approved durable-memory selection for prepared turns using content hashes; restored private task memory only after successful reductions.

### Skills and harness correctness

- **Skill discovery**: Added bounded query and paging for skill discovery with drift detection.
- **Test stability**: Corrected handoff guidance fixtures, removed checkout-name test dependencies, and stabilized retained-memory measurements.

### Library

- **Remote catalog packaging**: Added `wtfp@0.7.3` as pinned remote catalog package with manifest and tree-digest validation.

### Self-development skills

- **Developer skills**: Redesigned `clio-coder-dev` and `clio-coder-test` around source ownership, isolated builds, and focused validation; auto-discovered inside checkout.

## 0.5.1 - 2026-09-21

### subscription quota and unified usage

- **Subscription quota normalization**: Added proactive quota readers for Claude Code, `anthropic-max`, Codex CLI, and Antigravity, normalizing reported windows into consumed percentage models cached for ~5 minutes.
- **`/usage` overlay**: Replaced `/cost` with `/usage` featuring Accounts, Session, Models, and Workers views (switched via keys 1–4, Tab, and arrows); retained `clio-coder usage report` for cross-session reporting.
- **Unified telemetry**: Displayed cached subscription headroom across welcome launchpad, dashboard, worker cards, and fleet islands with explicit `used` vs `left` direction labels.
- **Compact footer**: Standardized two-line footer layout: Line 1 for active work, model identity, headroom, thinking, and context; Line 2 for cwd, git branch/status, and rotating hints.
- **Worker quota**: Displayed worker quota as shared account headroom for local credentials and matching model groups.

## 0.5.0 - 2026-09-20

### public launch and documentation

- **Public launch**: Initial public release with full CLI, interactive TUI, documentation server, and browser application.
- **Documentation**: Shipped comprehensive guides under `docs/` and accessible in-session via `clio_docs`.
- **Safe data stores**: All state, cache, logs, and configuration strictly scoped to user and project data directories; added `clio-coder uninstall` with verification.

### engine, prompts, and long sessions

- **Context management**: Automatic multi-tier compaction, eviction, and working-set retention for long interactive sessions.
- **Prompt compilation**: Modular prompt templates with scoped layering, cache-key hashing, and token budgeting.
- **Session persistence**: Append-only session format (v4) with replay, branching, and export support.

### command admission and context controls

- **Command admission**: Pre-execution security and safety admission pipeline for tools and shell commands.
- **Context controls**: Added `/context` inspection, manual compaction triggers, and live budget tracking.

### graphical application

- **Browser GUI**: Bundled local web interface (`apps/clio-coder-gui`) with session explorer, settings manager, and documentation reader.
- **Lifecycle & auth**: Origin-verified local server with secure token-based authentication and process lifecycle management.

### library

- **Package management**: Packaged and validated skills, prompts, fleets, and plugins under `library/`.
- **Installation scopes**: Supported project-local and global package registration and installation via `clio-coder library`.

### configuration and terminal

- **Settings reorganization**: Structured settings around Connections, Chat, Fleet, Context & Memory, and Safety.
- **Terminal UI**: State-aware composer rails, live local-machine telemetry (CPU, RAM, RSS, network), and diagnostics routing.
- **Interactive doctor**: Added in-session `/doctor` diagnostic reports with error and warning prioritization.

### agent behavior

- **Shadow helpers**: Inline agent-to-agent delegation cards with compact footer status and lifecycle accounting.
- **Loop lockout**: Detected repetitive identical tool calls and infinite loops with bounded recovery prompts.
- **Result handoffs**: Native shadow helpers submit results via structured terminal handoff contracts.

### run

- **Headless mode**: `clio-coder run` with `--timeout <seconds>`, `--cwd <dir>`, and structured JSON output for non-interactive scripting.
- **Sealed receipts**: Headless execution receipts record safety decisions, blocked attempts, and outcome summaries.

### safety

- **Symlink resolution**: Rigorous recursive symlink traversal and `..` canonicalization in safety admission.
- **Bash admission**: Real-time evaluation of bash write targets, variable expansions, and chained directory navigation.
- **Autonomy levels**: Unconfirmed test command execution at `auto-edit` (`npm test`, `pytest`); strict out-of-tree read/write gating.

### grep

- **Binary & encoding resilience**: Clean handling and reporting for non-UTF8 lines in grep results.

### eval

- **Tool bench suites**: Added evaluation harnesses for `grep`, `find`, and core tool behavior.
- **Failure classification**: Structured scoring of run tasks with granular failure classifications.

### providers

- **Local & gateway providers**: Hardened streaming and residency tracking for Ollama, llama.cpp, LM Studio, and LiteLLM.
- **Live probing**: Added `targets --probe` with `--tools` and `--reasoning` flags for real-time capability verification.
- **Slot & memory management**: Dynamic slot discovery, context window extraction, and automatic model release on exit.

### fleet

- **Dynamic concurrency**: `fleet.concurrency` defaults to `auto`, sizing worker limits from available CPUs and cgroups.
- **Circuit breaker & failover**: Half-open circuit breaker on target routes with automatic failover to alternative providers.
- **Isolated task worktrees**: Git worktree isolation for concurrent workers with lease recovery after process crashes.
- **Slurm integration**: Optional cluster dispatch via clio-kit Slurm MCP server.

### doctor

- **Environment diagnostics**: Added comprehensive system checks for compilers, MPI, Slurm, and runtime dependencies.
- **Deep probing**: Added `doctor --deep` for live model inference and tool-calling validation.

## 0.4.9 - 2026-09-17

### read
- Bounded file reads with offset-based paging and large-file truncation warnings.

### write and edit
- Atomic file writes with automatic parent directory creation and lint-aware inline replacement.

### bash
- Sandboxed shell execution with execution timeout, output capture, and safety admission checks.

### grep, find, and ls
- Native search commands with `.gitignore` awareness, regex filtering, and bounded result counts.

### run_script
- Direct execution for project scripts in isolated temporary environments.

### verify
- Executable verification contracts linking test commands and file validation assertions.

### gateway and MCP
- Model Context Protocol (MCP) server lifecycle management, stdio transport, and dynamic tool catalog discovery.

### model compatibility
- Standardized sampling parameters and prompt formatting across OpenAI, Anthropic, and local inference targets.

### context, web, and artifacts
- Web page extraction, artifact lifecycle management, and scoped context window tracking.

### data
- Structured data query and inspection utilities for workspace analysis.

### terminal workbench
- Interactive pane docking, split-window browsing, and live status inspection.

### maintenance reliability
- Hardened subprocess lifecycle handling, signals cleanup on SIGINT/SIGTERM, and memory leak prevention.

## 0.4.8 - 2026-09-12

### Added
- Explicit background service setup for Linux with a systemd user session and installable PWA with stable local origin.
- Exact-package qualification script (`scripts/release-candidate.mjs qualify`).
- Shared runtime trace reader integration in web application.

### Changed
- Separated fast routine CI, exact-package qualification, and explicit full development investigations.
- Generated web documentation directly from canonical Markdown with unified search and navigation.
- Unified web surface build with CLI, sharing server chunks and assets.
- Retired standalone trace viewer in favor of unified web app.

### Fixed
- Applied effective output limits, thinking settings, tool read limits, and history retention at declared boundaries.
- Loaded provider runtime packages from canonical settings and bound cached probe state to target identity.
- Preserved SDK pricing tiers and per-call costs through native worker accounting.
- Applied user-hook path protections before tool execution.
- Stopped owned web background services and desktop entries during uninstall.

## 0.4.7 - 2026-09-10

### Added
- Operator extension runtimes with declared namespaced slash commands and bounded session/turn observation.
- Added `context(scope="library")` projection for shared recipe inventory inspection.
- Unified installable plugins, skills, agents, prompts, and fleets into canonical `library/` packages with manifest validation.
- Auto-discovery of user/project resources from major coding agents.
- Prompt template frontmatter `display-only: true` support and composer slash autocompletion.
- Shipped `materio` materials research plugin with literature search and advisory review.
- Harness extensions for contained Node.js and Python command tools with JSON contracts.

### Changed
- Replaced welcome panel with compact three-row header showing configured route and status.
- Contextual keyboard map (Ctrl+G menu, Ctrl+Q follow-up, Alt+Q recovery).
- Package management centralized in `clio-coder library` and `/library`; deprecated separate plugin/skill commands.
- Responsive `ask_user` interview UI positioned above composer with preserved answer history.
- Standalone harness extension manifest schema (`id`, `name`, `version`, `description`, `capabilities`).

### Fixed
- Extended hosted Ubuntu release gate timeout to 15 minutes.
- Preserved trusted project output-token settings in native workers.
- Protected installed plugin and harness extension directories as operator-owned resources.
- Gated `/skill off` prior to skill expansion on interactive chat admission.

### Removed
- Removed extension-owned prompt, skill, agent, and fleet directories outside `library/`.
- Removed legacy `2026-09-01-extension-install-digests` lifecycle migration.

## 0.4.6 - 2026-09-08

### Added
- Quick Connect launcher option with immediate setup alongside Settings and Diagnostics.

### Changed
- Three distinct output styles: Compact, Standard (default), and Detailed, toggled via Alt+O.
- Bounded terminal wrapping for reasoning spans, shell output, diffs, and worker previews.
- Footer exclusively owns live activity state, concurrent tool status, and background counts.
- Defaulted to single worker, disabled prompt prewarm, and automatic TTY streaming.

### Fixed
- Preserved JSON measurement fields in numerical verification without prototype pollution.
- Fixed `configure` readline scoping and menu arrow-key selection exits.
- Canonicalized autonomy levels across settings menu and schema validation.
- Added `configure --edit` and All Settings menu for in-place settings file editing.
- Prevented configuration inspection and dry runs from unintentionally initializing user state.

## 0.4.5 - 2026-09-07

### Added
- Directory-scoped `CLIO-CODER.override.md` configuration override support.
- Worker task timeout controls and bounded cancellation timeouts.
- Dynamic tool result truncation with configurable byte ceilings.
- Model knowledge base entries for Claude 3.5 Sonnet and GPT-4o.
- Memory and compaction diagnostics via `/context inspect` and `/context prune`.

### Changed
- Compacted default main and worker system prompts.
- Unified receipt status reporting across headless CLI and interactive TUI.
- Strict parameter schema validation for built-in tool calls.
- Simplified keyboard navigation and modal dismissal shortcuts.

### Fixed
- Fixed command argument escaping and variable expansion in safety admission.
- Handled recursive symlink loops and cross-device directory moves gracefully.
- Prevented unhandled stream abort exceptions during provider failover.
- Sanitized ANSI escape sequence filtering across wrapped terminal views.
- Restored accurate task board status tracking across resumed sessions.

## 0.4.4 - 2026-09-05

### Added
- Model Context Protocol (MCP) protocol v3 support with bidirectional tool routing.
- Command-line trace inspection utilities via `clio-coder trace`.
- Target probe timeout flags (`--probe-timeout`) and failure diagnostics.
- Custom MCP server environment variable inheritance and working directory configuration.
- Bounded scratch space offload for oversized tool execution outputs.

### Changed
- Migrated settings path to `~/.config/clio-coder/settings.yaml`.
- Unified session storage format with backward compatibility for v3 sessions.
- Enhanced parallel worker dispatch scheduling and concurrency limits.

### Fixed
- Resolved MCP stdio transport hanging on abrupt SIGINT/SIGTERM termination.
- Fixed worker lease acquisition timeouts under high concurrency.
- Corrected terminal resize reflow bugs causing duplicate prompt renders.
- Fixed token count misattributions during multi-turn compaction cycles.

### Removed
- Removed deprecated legacy command-line flags and alias parameters.

## 0.4.3 - 2026-09-05

### Added
- Remote marketplace skills (`skills/remote.yaml`) fetching external repository packages.
- `archify` architecture planning skill pinned to `tt-a1i/archify` v2.16.0.
- `clio-coder context map [--out <path>] [--json]` generating architecture seeds from codewiki indices.
- Read-only `world-knowledge` shadow agent for open-world research and web synthesis.
- Reusable `branch-closeout` Git workflow skill (`skills/git/branch-closeout/`).

### Changed
- Unified skill pin validation into single lint pass.
- Enabled `context.compaction.model` and `context.compaction.systemPrompt` configuration overrides.
- Isolated Antigravity external delegation within bounded subprocess boundary.
- Hardened complete Git skill suite (`file-ticket`, `fix-issue`, `ship`, `worktree-create`).

### Fixed
- Cold target metadata discovery for LiteLLM before worker admission.
- Compaction usage accounting in out-of-turn ledger for failed/empty compactions.
- Preserved thinking controls through LiteLLM parameter filtering.
- Reset transient task memory on explicit session and branch switches.

## 0.4.2 - 2026-09-02

### Added
- **Accountability in ACP**: Observability extension publishes `accountability.evidenceReady` events with run evidence bundles.
- **Trace step inspection**: Added `clio-coder trace code-steps <rootId> [--json]` for reading deterministic code-step records.
- **Real-home smoke test**: Added `npm run smoke:real-home` testing binaries against real operator configuration.
- **Files pane**: Added `/files` pane docked below the session with dedicated keyboard navigation.
- **Immutable extension snapshots**: Extensions projected into generation-numbered immutable snapshots per session.
- **Configuration reference**: Added complete switch and knob inventory in `docs/configuration-reference.md`.
- **Audience documentation structure**: Restructured documentation into `docs/guide/`, `docs/architecture/`, and `docs/process/`.

### Changed
- **Tool result ceiling**: Added configurable `context.toolResultMaxBytes` (default 65,536 bytes).
- **Dynamic output limits**: Chat completions default to model advertised maximums rather than fixed 32k ceilings.
- **Pi SDK 0.84.4**: Updated Pi engine libraries (`pi-ai`, `pi-agent-core`, `pi-tui`) from 0.84.0 to 0.84.4.
- **Default thinking**: Set `chat.thinkingLevel` default to `low`; mapped thinking off to `reasoning_effort: "none"`.
- **Loop detection**: Retained last 48 attempts in loop detector rather than time-based windows.
- **System prompt diet**: Compacted main and worker system prompts, eliminating redundant routing and retrieval prose.
- **Dispatch schema**: Serialized `intent` and `budget` schemas once under `$defs`.

### Fixed
- Fixed skill `clio:` frontmatter deprecation warnings.
- Restored `model.clioCoder` runtime metadata reading after naming migration.
- Fixed thinking off reaching LM Studio as `reasoning_effort: "none"`.
- Fixed boot refusal when `safety.limits.readBytesPerCall` exceeded 50 KiB.
- Fixed `runs.json` dispatch run ledger path and added `source` column to trace `runs` table.
- Fixed headless `run --autonomy <level>` flag application.
- Restored parallel tool batch result order during session replay.
- Handled `intent.verification: [{ check: "none" }]` without failing dispatches.

### Removed
- Removed unused environment variables `CLIO_CODER_RESUME_SESSION_ID` and `CLIO_CODER_BOOTSTRAP_GENERATE_CHILD`.
- Removed `CLIO_CODER_SYNTHESIS_LOCK`.

## 0.4.1 - 2026-09-01

### Changed
- Version-2 `settings.yaml` organized around `chat`, `fleet`, `targets`, `context`, and `safety`.
- Panes, docks, and Yazi file integration marked experimental and opt-in.
- Slash command registry organized into Work, Inspect, Configure, and Session categories.

### Added
- Grammar-aware slash autocomplete in interactive composer.
- Workspace-aware `@` file picker in editor with metadata and line counts.
- Bounded public/private execution boundary for `!command` operators.
- Marketplace self-promotion matching requests to uninstalled catalog skills.

### Fixed
- Fixed version-2 settings diagnostics and missing-journal error messaging.
- Cached marketplace offer middleware inventory per session.
- Model picker Enter key confirms and applies selection cleanly.
- `clio-coder doctor` runs read-only by default (requires `--fix` to mutate).
- TUI text properly wraps to terminal width without truncating remedies.

### Test-suite diet
- Automated test suite streamlined from 557 files (184k lines) to 35 files (19k lines).

### CI modernization
- Consolidated CI into single Node 22 job executing package qualification.

### Eval consolidation
- Unified evaluation engine under `src/domains/eval/`.

### Clio Coder naming migration
- Consolidated machine-facing identifiers and paths under the unified `clio-coder` namespace.

## 0.4.0 - 2026-08-31

### Added
- **ACP setup discovery**: ACP clients discover terminal setup flow via `clio-login`.
- **Vendored tools registry**: Added `clio-coder tools list|status|install|remove <id>` for pinned external binaries.
- **Herdr pane integration**: Integrated `/panes show|open|focus|close` when running inside Herdr.
- **Pane file picker**: Added terminal file picker pane returning selected paths to composer.
- **Run event journal**: Dispatched runs record append-only NDJSON journals at `<stateDir>/runs/<runId>/events.ndjson`.
- **LiteLLM runtime**: First-class LiteLLM provider runtime supporting managed gateways.
- **Fleet board & agent attribution**: Live fleet board in ACP attributing frames and tool calls to originating agents.
- **Slot discovery persistence**: Discovered parallel slot counts persisted across process lifetimes.
- **Workbench read surfaces**: Added four read surfaces over durable harness state in Workbench.

### Changed
- Moved `@anthropic-ai/claude-agent-sdk` to `optionalDependencies`.
- Graduated pane layer to first-class integration with fallback when unsupported.
- Enforced boundary rules preventing unauthorized external network reach.

### Fixed
- Output budgeting for thinking models in proactive memory.
- Saturated endpoint dispatch queueing under stable run identities.
- Error reporting for debugger, verifier, and research result-contract repairs.
- Clean TUI exit for fleet watch panes and restored input focus.
- Corrected unpriced model work display from `$0.0000` to unmetered indicator.
- Sanitized slash command validation in `clio-coder run`.

## 0.3.9 - 2026-08-30

### Added
- Additive execution envelope binding prompt fragment IDs, versions, and composition hashes to results.
- Bounded SQLite trace mirror with retention policies and `clio-coder trace prune` (#226).
- Always-on input pipeline crash logging written on `SIGTERM` (#224).
- Behavioral evaluation comparison reporting correctness, safety, and efficiency metrics.
- Typed dispatch validation projections (`routeValidationProjection`).
- Added `clio-coder config validate` command.

### Fixed
- Prevented dispatch retries from dropping original execution constraints.
- Restored terminal raw mode reliably across interrupted prompts and error exits.
- Corrected context window calculation for local models with custom context offsets.
- Fixed prompt cache invalidation races during rapid sequential tool executions.
- Compacted trace storage automatically upon reaching size thresholds.
- Accurately recorded token usage for aborted or timed-out tool calls.

## 0.3.8 - 2026-08-29

### Added
- Added `clio-coder evidence` command suite for inspecting, validating, and exporting evidence bundles.
- Deterministic SHA-256 evidence bundle hashing for reproducible verification records.

### Changed
- Unified evidence schema (v3) with strict provenance metadata and validation timestamps.
- Normalized timestamp formats across session, trace, and run ledgers to ISO 8601 UTC.

### Fixed
- Resolved race conditions in concurrent dispatches modifying shared ledger entries.
- Fixed subagent cancellation cascading to ensure child processes terminate cleanly.
- Eliminated memory retention in long-running TUI sessions caused by uncleared terminal buffers.
- Corrected prompt cache key generation to prevent spurious cache misses across turns.

## 0.3.7 - 2026-08-24

### Added
- **Typed dispatch intent and verification** (#155): Added `intent` (`read_roots`, `write_roots`, `relevant_paths`, `expected_outputs`, `verification: [{check, timeout_ms?}]`) with host-run verification via code-step runner and receipt sealing (integrity v16).
- **Side questions (`/btw <question>`)** (#41): Evaluates read-only questions against compiled history without modifying session JSONL, ledger, or worker briefs.
- **Desktop notifications** (#204): Opt-in notifications via `terminal.notify: true` using OSC 777 / OSC 9 on turn completion, batch settlement, or parked approvals.
- **Single-writer leases & task worktrees** (#207): `writers: 1` concurrency constraint with process-level checkout writer leases and `worktree: true` task isolation (`clio/task/<runId>`) with automatic verification and merge policies (receipt integrity v17).

### Changed
- Resolved verification checks from package scripts and `.clio-coder/verifiers.yaml` at admission.
- Enforced POSIX-normalized repository-relative paths across all dispatch intents.

## 0.3.6 - 2026-08-23

### Added
- Interactive task board overlay (`/tasks`) for tracking active, queued, and completed subagent tasks.
- Multi-stage prompt caching with prefix stabilization to maximize local and cloud KV-cache reuse.
- Live token cost and usage estimation per turn based on configured target pricing models.

### Changed
- Modernized TUI layout with adaptive pane splitting on wide terminals.
- Streamlined permission approval prompts with granular risk explanations.

### Fixed
- Fixed session recovery failures when resuming across differing terminal geometries.
- Hardened subprocess signal propagation to prevent orphaned worker processes.
- Fixed provider SSE parsing edge cases during stream reconnection.

## 0.3.4 - 2026-08-22

### Added
- Session format v4 adding `contextEviction` and `contextRecall` records.
- Working set settings under `context.workingSet` (`enabled`, `policy: structural-v1`, `targetOccupancy`).
- Compaction reporting `working_set` stage on `ContextPruned`, exposing `on_compaction` middleware hooks.
- Deterministic code-point ordering for evidence rows and verifier catalogs.

### Changed
- Unified trust fact derivation across receipts, evidence bundles, and monitor outputs.
- Calibrated tool-result summaries with disjoint head and tail slicing and offload paths.

### Removed
- Removed Claude Code transcript loader for `context replay`.
- Removed legacy evidence trust status promotion rules.

### Security
- Gated project-catalog `verify(check=<id>)` behind policy engine validation.

### Fixed
- Prevented auto-compaction from destroying valid tool observation bodies.
- Fixed verifier catalog writer reporting incorrect status prior to file commits.

## 0.3.3 - 2026-08-21

### Changed
- Unified transcript detail under `/output minimal|default|verbose` with per-block folding controls.
- Folded Bash execution bodies by default while retaining concise command, outcome, timing, and size headers.
- Rendered reasoning as stream-ordered thinking segments.

### Fixed
- Preserved reasoning order and token provenance across live, interrupted, and replayed turns.
- Preserved complete replay bodies for HTML export and aggregated multi-call receipts.
- Contained failure excerpts and mutation diffs within narrow terminal frames (down to 40 columns).
- Replaced internal tool-call signatures with human-readable action summaries.

## 0.3.2 - 2026-08-20

### Added
- Evidence-aware Git commit attribution (configurable via Advanced settings).
- Fullscreen terminal mode, native Mermaid and LaTeX rendering, and smooth-streaming controls.
- HTML transcript export with retained Markdown export option.
- Directory-scoped `CLIO-CODER.override.md` instructions and project-rule propagation to workers.
- Compile-cache support for interactive, run, ACP, and worker boot paths.
- Updated Pi SDK libraries to 0.84.0 with declaration-surface checks.

### Changed
- Consolidated slash command spelling and argument handling; retired aliases fail closed.
- Replaced LM Studio SDK with HTTP adapter (`lmstudio` canonical, `lmstudio-native` alias).
- Strengthened ACP v1 contracts for sessions, workspaces, permissions, and error reporting.

### Fixed
- Preserved prompt submission order during instant-shell boot and restored fullscreen rendering.
- Prevented concurrent dispatch processes from overwriting run-ledger entries (#118).
- Fixed LM Studio duplicate model loading (#113) and llama.cpp residency errors (#127, #134).
- Restored documented headless JSON/event output and CLI exit code behavior (#122, #123).

### Security
- Hardened worker and session safety policies, OAuth cancellation, and ACP permission mediation.
- Added publish-time version-coherence verification (#124).

## 0.3.1 - 2026-08-16

### Added
- Live worker transcript blocks, receipts, sharing, and durable replay for `/run` and `/delegate`.
- Interoperability discovery and opt-in configuration for compatible external coding agents.
- Agent-ledger surface for coordinated worker findings and transactional Settings Center.
- Stream-stall retries and authoritative timezone-aware timing.

### Changed
- Redesigned TUI around adaptive launch, composer, transcript, and narrow-terminal layouts.
- Unified user-facing runtime identifiers to `clio-coder`.

### Fixed
- Restored prompt-template invocation in TUI and implemented ACP `--cwd` and `--permission-timeout`.
- Prevented unsafe llama.cpp model parameter overrides.
- Fixed cancelled-turn replay accounting and credentials corruption safeguards.

### Security
- Scoped escalation decisions without widening separate requests.
- Added outward-exposure confirmation prompts and protected foreign-agent file paths.

## 0.3.0 - 2026-08-14

### Added
- Initial npm-published `clio-coder` command and package namespace.
- Agent ledgers, intentional compete stances, durable capacity leases, and deterministic execution plans.
- Soak and invariant evaluation suites with receipt-derived accounting.

### Changed
- Streamlined `clio-coder --help` to focus on primary human commands (`--help --all` for full list).
- Unknown slash commands fail closed with helpful correction hints.

### Fixed
- Preserved active session branches across compaction and replay cycles.
- Prevented automatic retries following state-mutating tool executions.
- Fixed JSON transcript duplication and evaluation threshold enforcement.

### Security
- Replaced shell interpolation with argument-safe process execution when opening URLs.
- Enforced immutable, receipt-backed dispatch plans and worker write-boundary restrictions.

## 0.2.9 - 2026-08-05

### Added
- Deterministic fleet code steps, bounded check/repair loops, shipped SDLC fleets, and a durable trace store with read-only trace commands and viewer.
- Per-step write-boundary verification, typed worker result contracts, strict worker attestation, and process-safe capacity/routing leases.
- One compiled worker harness with explicit tool/budget profiles, model-facing dispatch/collect provenance, and transactional editing attempts.

### Changed
- Added first-class singular dispatch while retaining batch dispatch, and unified synchronous and detached run monitoring.
- Updated Pi engine dependencies to 0.80.6 and advanced receipt, route, plan, and policy formats to their strict current versions.
- Broadened model-authored repository exploration while retaining bounded Scout guidance and Fleet Runs visibility.

### Fixed
- Made successful native and ACP delegation require receipt-sealed final output, and made protected-artifact recovery durable across restart and worktrees.
- Improved compaction, context provenance, routing, external-agent cancellation, and generated-wiki grounding.

### Security
- Enforced immutable approved dispatch plans, strict external-agent policy checks, bounded worker protocol frames, and fail-closed handling of older or partial durable formats.

## 0.2.8 - 2026-07-07

### Added
- A consolidated seven-plane tool surface, task tracking, richer dispatch monitoring/steering, codewiki v4, exports, and improved interactive command hubs.
- Multi-model local residency management and native shadow-agent fleet routing.

### Changed
- Improved local-model prompting, TUI pressure handling, accounting, worker IPC, deadlines, model catalog metadata, and documentation.

### Fixed
- Corrected approval, symlink, loop-guard, worker-profile, reasoning, session-branch, and timeout edge cases.

### Removed
- Legacy tools including `glob`, `workspace_context`, `docs_search`, `run_task`, `validate_frontend`, `write_plan`, `write_review`, `create_skill`, and `dispatch_batch`; use the consolidated tool surface.

## 0.2.7 - 2026-07-02

### Added
- Reviewed marketplace skills, executable skill evaluations, enforced skill tool surfaces, and registry integrity pins.
- Credential damage control, usage reports, headless receipts, dispatch evidence bundles, and high-rigor validation support.

### Changed
- Reduced package size and refreshed release and documentation workflows.

### Fixed
- Improved dispatch, lifecycle, skill, and loop-guard reliability.

### Security
- Added zero-access credential storage and secret redaction in evidence bundles.

## 0.2.6 - 2026-06-24

### Added
- VRAM-aware local-model residency, layered settings, path-scoped rules, operator profiles, hooks, configuration inspection, docs search/viewing, and SciCode benchmark support.

### Fixed
- Prevented dispatched Ollama work from leaving models resident and overflowing VRAM.

## 0.2.5 - 2026-06-23

### Added
- The `alcf` runtime for Argonne ALCF Sophia/Metis targets, including Globus OAuth, discovery, metadata, and gateway documentation.

### Fixed
- Enforced strict OpenAI-compatible reasoning payloads for ALCF targets.

## 0.2.4 - 2026-06-23

### Added
- Fleet management with agent/profile bindings, fault-tolerant dispatch, and a `/fleet` overlay.

### Changed
- Refreshed Pi, Claude, Anthropic, Biome, TypeBox, Undici, UUID, and TSX dependencies.

### Fixed
- Isolated dispatch tests and made receipt digests deterministic across hosts.

## 0.2.3 - 2026-06-17

### Added
- Declarative slash commands and full-screen hubs; enforced autonomy and safety notices; additional subscription/delegation runtimes; codewiki indexing, middleware, live steering, and richer receipts.

### Changed
- Reworked on-disk roots, settings ownership, lifecycle commands, model-target vocabulary, and observability.

### Removed
- Retired legacy slash commands; their workflows moved to `/skill`, `/targets`, `/help`, `/view`, and related hubs.

## 0.2.2 - 2026-06-11

### Added
- Context engine, compaction, bounded tool results, prompt-cache telemetry, ACP support, a curated skills marketplace, and local install/uninstall scripts.
- A richer `CLIO.md` project rulebook and source-tree awareness.

### Changed
- Replaced built-in CLI-subprocess runtimes with direct HTTP/native/Pi targets and ACP delegation.

### Fixed
- Improved prompt-prefix stability, ledger appends, permission overlays, and release verification.

## 0.2.1 - 2026-06-05

### Added
- Live token-throughput telemetry, prompt-envelope hashes, and `clio run --json` prompt diagnostics.

### Changed
- Reduced context pressure through narrower tool exposure and bounded output; improved the footer for smaller terminals.

### Fixed
- Corrected headless run arguments, unknown-agent handling, dashboard layout, and prompt-diagnostic visibility.

## 0.2.0 - 2026-06-03

### Added
- First community alpha for source-checkout users, with JIT skills, stronger compaction, project-instruction adoption, runtime resolution, diagnostics, durable sessions, and expanded documentation.

### Fixed
- Hardened path policy, headless runs, prompt-cache boundaries, overlays, session replay, and TUI startup.

## 0.1.9 - 2026-05-17

### Added
- First-class fleet `dispatch`, frontend artifact validation, typed finish evidence, and local-model capability improvements.

### Fixed
- Corrected reasoning replay, Harmony parsing, Codex file-tool aliases, lifecycle metadata repair, and model-capability duplication.

## 0.1.8 - 2026-05-11

### Added
- Extensions, share archives, associated CLI/TUI workflows, a redesigned welcome dashboard, configure validation, and a Claude Code SDK safety bridge.

### Fixed
- Corrected Gemini CLI token accounting and expanded extension, sharing, configuration, and supervised-SDK coverage.

## 0.1.7 - 2026-05-11

### Added
- A shared safety-policy engine, strict project command policies, typed execution tools, and receipt safety summaries.

### Changed
- Default Bash now denies ordinary execution unless allowed by curated commands or project policy.

### Fixed
- Hardened dispatch scope, external-runtime permissions, audit rows, and worker safety parity.

## 0.1.6 - 2026-05-04

### Added
- `clio --print` / `clio -p` for one non-interactive turn, with stdin/argv composition and stdout safeguards.

### Changed
- Reserved future JSON/RPC modes behind explicit errors.

## 0.1.5 - 2026-05-03

### Added
- Public alpha for source-install developers and research-software teams: interactive TUI, target-first configuration, coding agents, sessions, project context, receipts, audits, evidence, evaluations, memory, and safety modes.
- `clio init`, CLIO.md parsing, codewiki indexing, improved cost/model UI, and documented alpha operating limits.

## 0.1.4 - 2026-04-30

### Added
- Evolution tooling for inventories, change manifests, evidence, evaluations, memory, middleware, protected artifacts, finish checks, workspace orientation, specialist recipes, and scientific validation.

### Changed
- Unified llama.cpp handling and improved TUI, compaction, context accounting, and protected-artifact behavior.

## 0.1.3 - 2026-04-27

### Added
- Live tool output, Bash echo, thinking expansion, and a Git-branch footer slot.

### Changed
- Made `CLIO.md` the canonical project instruction file and improved LM Studio/Ollama detection.

### Fixed
- Corrected Debian/Ubuntu slash autocomplete, doctor/targets JSON envelopes, and partial tool-output rendering.

## 0.1.2 - 2026-04-25

### Added
- Visible retries for transient provider and stream failures.

### Changed
- Improved interactive tool, Bash, dashboard, hotkey, resume, prompt, receipt, compaction, audit, and abort behavior.

### Fixed
- Corrected retry duplication, cancellation races, oversized Bash output, active-run session operations, provider hot-swaps, and local OpenAI-compatible reasoning/tool schemas.

## 0.1.1 - 2026-04-24

### Added
- Deterministic loading of project context files from the working directory upward.

### Fixed
- Corrected rich session replay, subprocess dispatch, out-of-tree SDK rehydration, receipt verification, dispatch heartbeats, and boundary-check documentation.

## 0.1.0-exp - 2026-04-24

### Added
- Initial experimental public release with interactive TUI, lifecycle CLI, target-first configuration, runtime support, built-in agents, dispatch workers, receipts, audit logs, safety modes, and XDG-aware state.

### Security
- Windows support was best effort; remote fan-out and MCP surfaces were scaffolded but not admitted by dispatch.
