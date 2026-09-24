# Commands and Modes

This guide covers the installed CLI, headless run behavior, interactive commands, keyboard controls, and operator workflows. The command registry and parser are authoritative: [CLI](../../src/cli/index.ts), [run arguments](../../src/cli/args.ts), [slash-command registry](../../src/interactive/slash-commands.ts), and [keybinding manager](../../src/interactive/keybinding-manager.ts). Exit codes and stdout guarantees are in [Exit codes and output](exit-codes-and-output.md).

## Demo guidance

Demo guidance is on by default before 1.0. After a turn, Clio may show one `[tip]` row that fits what the turn did: a question about Clio's own settings, a side question that `/btw` would keep out of the transcript, a correction that `/tree` could rewind, a long answer that another output style would fold. The harness picks the tip. The model never sees it, and no model call is made. At most four tips appear per session, spaced several turns apart, and a tip retires once you use its feature yourself or it has been shown twice.

Guidance keeps a small profile in the state directory (`harness-profile.json`): the tips shown, the Clio features you used, and the topics you asked Clio about. It stays on this machine and never enters a prompt.

Turn it off under Settings → Appearance → Demo guidance (`interface.demo`), or for one invocation with `--no-demo`. Off means no tips, no idle footer tips or rotating key hints, no demo prompt line, and no profile reads or writes. Guidance adds hints only; it does not grant tool authority. Headless runs, ACP sessions and workers do not receive it.

## CLI Commands

| Command | Purpose |
| --- | --- |
| `clio-coder` | Launch the interactive terminal UI. |
| `clio-coder run "<task>" [flags]` | Run one headless main-agent turn. Use `--json` for JSONL events. |
| `clio-coder run "<task>" --agent <id> [flags]` | Dispatch one explicit fleet agent non-interactively and write a receipt. |
| `clio-coder acp [--cwd PATH] [--permission-timeout MS]` | Serve Clio as an ACP v1 agent over stdio for ACP frontends. |
| `clio-coder --version` | Print the installed version. `clio-coder version` is the subcommand form. |
| `clio-coder --help [--all]` | Print the command list. `--all` appends every command under `clio-coder dev`. |
| `clio-coder --api-key <key>` | Override the active target API key for one invocation. |
| `clio-coder --no-context-files` / `clio-coder -nc` | Skip `CLIO-CODER.md` project-context injection for one invocation. |
| `clio-coder --with-panes` | Activate guest pane integration for this invocation when Clio is inside a reachable herdr session. |
| `clio-coder --no-panes` | Keep panes off even when settings turn them on. |
| `clio-coder --autonomy <level>` | Start this interactive session at `capable` or `yolo` without modifying `settings.yaml`. Legacy `read-only`, `suggest`, `auto-edit`, and `full-auto` values remain accepted. Passing `--autonomy` before a subcommand is refused with exit 2 (`clio-coder run --autonomy` remains the headless form). |
| `clio-coder --no-skills` | Disable skill discovery for one invocation and automatic skill/marketplace prompt guidance while still honoring explicit `--skill` paths. |
| `clio-coder --skill <path>` | Make one explicit skill file or directory available for one invocation (repeatable). Clio loads its instructions when the skill is activated through `context(scope="skills", name=...)`. |
| `clio-coder configure` | Run the configuration wizard. Ctrl+C reports `configuration cancelled`, writes no target, and exits 130; when first-run onboarding is cancelled, startup stops instead of opening the TUI with no usable target. |
| `clio-coder configure --interop` | Review other coding agents detected on this machine and connect one as a delegation peer. Without a TTY it prints the proposals and writes nothing. |
| `clio-coder configure --list` | List user-facing runtime ids. |
| `clio-coder configure --list --all` | List every registered runtime, including aliases. |
| `clio-coder config [inspect] [--json]` | Print the effective customization graph across settings, context files, rules, skills, prompts, agents, extensions, safety, memory, hooks, and operator profile. |
| `clio-coder targets [--json] [--probe [--reasoning] [--tools]] [--target <id>]` | List targets and metadata; `--reasoning` and `--tools` explicitly generate qualification requests. |
| `clio-coder targets add` | Add a target interactively or through configure flags. |
| `clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>] [--fleet-target <id>] [--fleet-model <id>]` | Select the named roles only when any role flag is present. `--background-model` selects memory; `--orchestrator-model` selects chat; `--fleet-model` or `--fleet-target` selects fleet. Other roles and thinking levels are preserved. Without role flags, chat and fleet use the target default (or shared `--model`), while memory is preserved. With role flags, `--model` is refused with exit 2 when no selected role falls back to it; pass `--orchestrator-model` to set chat. Confirmation names only roles whose settings changed. Model IDs must match a nonempty discovered or cached inventory exactly; unavailable discovery is reported explicitly. |
| `clio-coder targets fleet [--json]` | List the configured fleet profiles with their target, runtime, model, and thinking level. `targets workers` is an accepted alias. |
| `clio-coder targets profile list\|set\|remove\|rename\|bind\|unbind\|bindings` | Manage named fleet profiles and agent bindings. `clio-coder targets profile <name> <id>` is the short form of `profile set`, and `targets worker` is an accepted alias for `targets profile`. |
| `clio-coder targets convert <id> --runtime <runtimeId>` | Convert older local target definitions to a runtime-specific target. |
| `clio-coder targets remove <id>` | Remove a target. |
| `clio-coder targets rename <old> <new>` | Rename a target id. |
| `clio-coder models [search] [--target <id>] [--json] [--offline]` | List models. Live probing is the default; `--offline` skips it. |
| `clio-coder paths [--json]` | Print the resolved config, data, state, and cache directories. |
| `clio-coder auth list` | Show known auth entries. |
| `clio-coder auth status [target-or-runtime]` | Inspect auth state. |
| `clio-coder auth login [target-or-runtime] [--api-key <value>]` | Add credentials through the supported flow. |
| `clio-coder auth logout [target-or-runtime]` | Remove stored credentials. |
| `clio-coder doctor [--fix] [--json] [--deep [--tools-timeout <seconds>]]` | Diagnose state. Plain `doctor` is read-only and leaves even a partially initialized home byte-for-byte untouched. With `--fix`, create missing structure and templates, repair credential permissions, refresh install metadata, and record fleet preflight results. Settings remain strict; lifecycle migrations belong to `upgrade`, not `doctor --fix`. `--deep` adds a live tool-call probe per target and a dry run of the validation contract. See [Doctor](doctor.md). |
| `clio-coder mcp list\|trust\|untrust` | List configured MCP servers or manage explicit project trust with `trust <id> [--action-class read\|execute\|unknown]` and `untrust <id>`. |
| `clio-coder tools list [--json]` | List the pinned external tool registry and whether each program resolves from `PATH`, Clio's vendored data directory, or nowhere. |
| `clio-coder tools status <id> [--json] [--reset-profile]` | Inspect one registered tool. `--reset-profile` applies only to yazi's generated profile. |
| `clio-coder tools install <id> [--force] [--json]` | Download the platform asset, verify every declared checksum, and atomically vendor it. |
| `clio-coder tools remove <id>\|--all [--json]` | Remove Clio-vendored copies without touching a program found on `PATH`. |
| `clio-coder panes install` | Alias for `clio-coder tools install herdr`. |
| `clio-coder panes theme` | Print Clio's theme tokens as a herdr `[theme.custom]` block to paste into herdr's `config.toml`; Clio never edits that file itself. See [Panes and the Files Pane](panes-and-files.md). |
| `clio-coder tasks [list\|add\|hand\|done\|drop]` | List, add, hand, finish, or drop project operator tasks. |
| `clio-coder verifiers discover\|inspect\|author\|validate\|edit\|dry-run` | Discover, inspect, author, validate, edit, or dry-run project checks. |
| `clio-coder reset [--state\|--data\|--cache\|--auth\|--config\|--all] [--dry-run] [--force] [--json]` | Reset selected Clio Coder state. `--state` is the default level. |
| `clio-coder uninstall [--dry-run] [--remove-binary] [--keep-config] [--keep-data] [--force] [--json]` | Remove Clio Coder state and print uninstall guidance. |
| `clio-coder upgrade [--dry-run] [--channel=<latest\|beta\|dev>] [--skip-migrations] [--restart] [--json]` | Update an identified npm global installation in its original prefix and apply migrations with that installation's new binary. Other managers receive update instructions. `--post-install` runs local migrations and repairs only. `--restart` resumes the project's last session after success; it requires a terminal and cannot combine with `--json` or `--post-install`. |
| `clio-coder agents [--json] [--all]` | List discovered agent specs. |
| `clio-coder fleet list\|run\|status\|drain\|resume` | List fleet contracts, run one, show dispatch state, or control admission. `drain` denies new execution starts for up to one hour and preserves running work; `resume` reopens admission immediately. `run <name>` takes `[--var k=v ...]` and `[--json]`; `status` takes `[--json] [--all]` and defaults to this project; `drain` and `resume` each take `[--json]`. |
| `clio-coder fleet inspect\|decisions --json [--all]` | Read bounded run, council, and gate decision summaries for this project. `--all` reads machine-wide state. |
| `clio-coder fleet view <runId\|fleetRootId> [--follow] [--all]` | Read the append-only run journal after verifying receipt trust. A fleet root prints its durable step index. IDs from other projects require `--all`. Without `--follow`, the width-bounded snapshot is plain text with no ANSI control bytes. `--follow` requires an interactive terminal and one run id; `fleet view --help` prints this subcommand's own usage, including `--watch`. |
| `clio-coder fleet view --watch <selection-file>` | Follow the run id currently named by the selection file and retarget when it changes. This is the operator-pulled watch surface used by the pane integration. |
| `clio-coder dev components [list] [--json]` | List behavior-affecting harness components. |
| `clio-coder dev components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio-coder dev components diff --from <a> --to <b> [--json]` | Compare component snapshots. |
| `clio-coder evidence build\|inspect\|list` | Build and inspect deterministic evidence artifacts. |
| `clio-coder memory list\|propose\|promote\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. |
| `clio-coder trace runs [--db PATH] [--limit N] [--json]` | List runs recorded in the durable trace mirror beside the ledger. |
| `clio-coder trace inspect --json` | Emit the fixed, bounded recent accounting projection used by the graphical application. It accepts no path, identifier, or limit and omits request text, error prose, event payloads, process commands, PIDs, and hosts. |
| `clio-coder trace phases <runId> [--db PATH]` | Show one run's recorded phases. |
| `clio-coder trace tail <runId> [--follow] [--db PATH]` | Tail one run's recorded events; `--follow` streams as they land. |
| `clio-coder trace procs <runId> [--db PATH]` | Show the processes one run spawned. |
| `clio-coder trace code-steps <rootId> [--json]` | Show the deterministic code-step records one fleet root wrote (argv, cwd, env names, exit code, duration, output digest, artifact paths). They are files beside the ledger, not rows in the mirror, so `--db` does not apply. |
| `clio-coder trace prune [--max-age-days N] [--max-bytes N] [--db PATH] [--json]` | Apply the trace-retention policy while protecting queued and running runs; JSON reports the resolved policy, rows, runs and bytes removed, protected runs, and whether vacuum ran. |
| `clio-coder trace sql <SELECT query> [--db PATH]` | Run one read-only query against the mirror. Only a single `SELECT` or read-only `WITH` statement is accepted; anything else exits 2. |
| `clio-coder dev evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio-coder extensions list\|discover\|install\|enable\|disable\|remove` | Manage installed extension packages and resource roots. `clio-coder ext` is an accepted alias. |
| `clio-coder library list\|search\|register\|inspect\|validate\|install\|update\|enable\|disable\|drift\|pin\|remove` | Manage packages of kind plugin, skill, agent, prompt or fleet at user/project scope; `install/update --dry-run` preview. `library skills` lists runtime skills; `library inventory --json` is the fixed GUI read. |
| `clio-coder gui [--open]`, `clio-coder dev gui` | Start the graphical application, an opt-in alpha for power users listed under `clio-coder --help --all`; the terminal UI stays the primary interface and nothing starts the application unless you run it. `--open` opens the browser. See the [GUI reference](commands-and-modes.md). |
| `clio-coder docs [topic] [--no-open] [--foreground]`, `clio-coder docs --stop` | Open the documentation in your browser, rendered directly from the canonical Markdown. Use the installed background app when there is one. Otherwise start a loopback server in the background, reuse it on the next call, and stop it with `--stop` or after 15 minutes without an open page. `--no-open` prints the launch link. `--foreground` serves privately in this terminal until Ctrl+C. |
| `clio-coder usage report [--repo <path>] [--days <n>] [--json]` | Cross-session usage facts from session/run ledgers and retained out-of-turn calls, including known failed-compaction spending and missing coverage. The window defaults to 30 days and the JSON schema is marked experimental. |
| `clio-coder dev share export --out <path> [--project\|--user\|--both] [--context] [--prompts] [--skills] [--settings] [--extensions]` | Export project context, prompts, skills, settings fragments, and extension bundles. |
| `clio-coder dev share import <path> [--dry-run] [--force] [--project\|--user] [--json]` | Import a share archive with conflict reporting. |
| `clio-coder dev share inspect <path> [--json]` | Inspect a share archive without importing it. |
| `clio-coder export --out <path> ...` / `clio-coder import <path> ...` | Top-level aliases for `dev share export` and `dev share import`. Each `dev` command also resolves without the `dev` prefix. |
| `clio-coder context` | Show project context status, preload class, codewiki freshness, and the codewiki digest when present. |
| `clio-coder context init [--preview] [--heuristic] [--yes] [--json] [--adopt] [--global] [--propose\|--apply\|--rewrite] [--target <id> [--model <id>] [--thinking <level>]]` | Explore the repo and bootstrap or update project context: `CLIO-CODER.md`, `.clio-coder/codewiki.json`, and `.clio-coder/state.json`. |
| `clio-coder context refresh [--wiki]` | Rebuild the codewiki and state without touching `CLIO-CODER.md`; with `--wiki`, update an existing Markdown wiki. |
| `clio-coder context wiki [--update\|--retry-pending] [--status] [--depth auto\|simple\|medium\|detailed] [--target <id>] [--model <id>] [--thinking off\|low\|medium\|high]` | Generate, update, or inspect the agent-authored Markdown wiki under `.clio-coder/wiki/`. |
| `clio-coder context reset [--all] [--yes]` | Clear accumulated project context artifacts; `--all` also removes `CLIO-CODER.md`. `--yes` (or `-y`) answers every confirmation and is required when stdin is not a terminal. |
| `clio-coder context index [--json]` | Build the structural codewiki index without model calls; writes `.clio-coder/codewiki.json` and `.clio-coder/state.json` and prints coverage plus a structural hash. |
| `clio-coder context map [--out <path>] [--json]` | Write an archify architecture seed from the structural index without model calls. |
| `clio-coder context replay (--sessions <path>... \| --synthetic <ids>) [--policies <ids>] [--budgets <tokens>] [--threshold <ratio>] [--target <ratio>] [--protect-last-turns <n>] [--min-evictable-tokens <n>] [--seed <n>] [--no-filter] [--json <out>] [--md <out>]` | Replay working-set policies over Clio session ledgers or the seeded procedural corpora and report retention, precision, token savings, recall cost, cold-prefix cost, saturation, and summary headroom. |
| `clio-coder context working-set --session <id\|path>` | Inspect one session's durable working-set fold and path-index summary without modifying the ledger. |

## Headless Run Flags

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | Enter `<dir>` before the run resolves anything against the working directory, the way `acp --cwd` does. Applies to the main agent and to `--agent`. See [Headless Working Directory](#headless-working-directory). |
| `--target <id>` | One-run main-agent or dispatch target override. |
| `--model <wireId>` | One-run model override. |
| `--thinking <level>` | One-run thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--autonomy <level>` | One-run autonomy override: `capable` (`auto-edit`) or `yolo` (`full-auto`); legacy values remain accepted. It does not change saved settings. |
| `--temperature <n>` / `--top-p <n>` / `--top-k <n>` / `--min-p <n>` | One-run sampler overrides when the selected runtime supports them. |
| `--presence-penalty <n>` / `--frequency-penalty <n>` / `--repeat-penalty <n>` | One-run penalty overrides when the selected runtime supports them. |
| `--max-context-tokens <n>` | One-run context-window override for supported local runtimes. |
| `--json` | Stream JSONL events for main-agent runs; dispatch streams events and receipt JSON. |
| `--json-events <mode>` | Main-agent JSON stream mode: `full` or `terminal`; implies `--json`. |
| `--session <id>` | Append this turn to an existing session identified by `<id>`. |
| `--continue` | Append this turn to the most recent session for the current working directory. |
| `--fail-on-noop` | Exit 1 when the main-agent run was a no-op, and seal its receipt as `failed` with `outcomeDetail: "noop"`. Main agent only; with `--agent` it is a usage error. See [Headless No-op Runs](#headless-no-op-runs). |
| `--timeout <seconds>` | Wall-clock limit for the whole main-agent run, boot included. On expiry the run starts the coordinated shutdown a SIGTERM starts, seals its receipt with outcome `timed_out`, and exits 124. A positive number of seconds; anything else is a usage error. Main agent only; with `--agent` it is a usage error. |
| `--agent <recipe-id>` | Dispatch a fleet agent instead of the main agent. Unknown ids fail fast. |
| `--skill <path>` | Make one explicit skill file or skill directory available for this run. Repeatable; the model loads its instructions with `context(scope="skills", name=...)`. |
| `--no-skills` | Disable skill discovery for this run and automatic skill/marketplace prompt guidance while still honoring explicit `--skill` paths. |
| `--turn-mode <mode>` | Main-agent workflow guidance (`answer`, `proposal`, `change`). Guides prompt and turn continuation (`answer` and `proposal` disable autonomous continuation turns; `proposal` renders `tasks` `plan`/`add` as blocked proposals). Not an authorization grant: mutating tools (`write`, `edit`) are not denied by `mode` alone; enforcement requires `--allow-tools` or `--autonomy read-only`. See [Turn Constraints](#turn-constraints). |
| `--no-delegate` | Forbid worker delegation (`dispatch`) for this run; the agent must work directly. |
| `--allow-tools <names\|none>` | Comma-separated allowlist of capability names permitted for this turn, or `none` to disable all tools. Enforces mechanical restriction at admission and runtime. |
| `--agent-profile <name>` | Use a named fleet profile for dispatch. |
| `--agent-runtime <id>` | Pick the first fleet profile whose target uses this runtime. |
| `--tool-profile <name>` | Restrict dispatched-agent tools: `minimal-local`, `science-local`, or `full-agent`. |
| `--require <capability>` | Require a target capability for dispatch. Repeatable. |
| `--steer-channel <path>` | Read live steering lines from a FIFO or an appended regular file to steer the active run. |
| `--with-panes` | Activate guest pane integration for this invocation when Clio is already inside a reachable herdr session. It overrides `interface.panes.enabled`. |
| `--no-panes` | Disable pane integration for this invocation. It overrides `interface.panes.enabled`. |

`--with-panes` is an explicit first-class launch mode, not permission to start a
pane server. Clio confirms `HERDR_ENV=1`, connects to an existing socket, and
pings it before registering pane tools. The fleet watch pane runs
`fleet view --watch` against a selection file. Clio writes only the selected run
id, while the viewer reads journals itself, so dispatch remains independent of
the pane host and a second terminal can use the same journal surface directly.
`interface.panes.enabled: embedded` does not start a host: it is an accepted but
unimplemented rung that resolves to no panes, prints a refusal during boot, and
is labelled `NOT IMPLEMENTED` in Settings. Use `auto` or `--with-panes` only
when Clio is already inside a reachable herdr session.

### Headless Working Directory

`clio-coder run --cwd <dir> "<task>"` behaves the same as `cd <dir> && clio-coder run "<task>"`. The process enters `<dir>` before it reads layered project settings, context files, skills, `@file` references, or the session ledger, and every tool path resolves against it. Relative paths in other arguments, such as `--skill`, `--steer-channel`, and `@file`, resolve against `<dir>` as well. The path is canonicalized first, so the run ledger records the physical directory as the run's `cwd`.

Image `@file` references in a headless prompt or stdin require the routed model's image-input capability. Clio refuses the turn before sending the image when the route is text-only. The run exits nonzero and prints `IMAGE_INPUT_UNSUPPORTED` with the target and model. A turn refused before admission has no run receipt. This behavior is shipped and tested.

- A missing path, a file, or a directory the process cannot enter fails with exit code 2 and a message naming the resolved path. No model is called.
- `--cwd` with no value is a usage error with exit code 2.
- An orchestrator that runs Clio inside a git worktree can pass the worktree path here instead of changing its own working directory before the spawn.
- `CLIO_CODER_HOME`, `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, and `CLIO_CODER_CACHE_DIR` are read as given and are not resolved before the process enters `<dir>`. A relative value therefore points under `<dir>`, not under the directory the driver spawned from. A driver that sets any of them together with `--cwd` must pass absolute paths.

### Headless No-op Runs

Every headless main-agent receipt carries a `safety` summary and a `noop` flag, whatever the flags. `safety.decisions` counts how admission decided each call (`allowed`, `blocked`, `permissionRequested`) and `safety.blockedAttempts` lists every call whose outcome was blocked, with its tool, action class, rule, and reason. These are the names and shapes a dispatched worker's receipt already uses. A call that parked for approval and was denied, because a headless run has no operator to approve it, counts under `permissionRequested` every time, including a repeat whose reason the loop guard replaced with its own guidance.

`safety.blockedAttempts` keeps the first 50 blocked calls, and clips each reason to 500 characters. When more calls than that were blocked, `safety.blockedAttemptsTruncated` counts the ones left out; the field is absent otherwise. The per-tool `blocked` counts in `toolStats` stay exact either way.

`noop` is true when either condition holds:

- at least one block remains unresolved and no mutating call succeeded, or
- the run called tools and none of them succeeded.

A mutating call is one the tool registry admitted with action class `write`, the class autonomy `auto-edit` runs without asking: `write`, `edit`, and an outward `web_fetch`. A terminating result does not count. The `artifact` tool's plan, review, or report is the turn's answer written to a file, so a run whose every edit was blocked and that then wrote a report about it is still a no-op. A successful `bash` call does not count, because its `execute` class says that a command ran, not that it wrote. A run that called no tool and answered in prose is not a no-op.

A later successful substantive read or command can recover a block of the same
action class. Bookkeeping, discovery, and terminal reports do not count as that
recovery. A successful dispatch is not counted as the main agent's write; inspect
worker receipts when assessing delegated changes.

An unresolved block with no successful write exits 1 and seals `failed` with
`outcomeDetail: "noop"`, even without `--fail-on-noop`. A successful `limitation`
call likewise records failure with detail `limitation`. The flag additionally
fails runs whose attempted tools all failed without a block. Existing errors,
interruptions, and timeouts retain their outcomes. The model's final prose is
still available; a normal provider stop alone does not prove task completion.

### Headless Session Continuity

A headless turn (`clio-coder run`) starts a fresh session unless `--session <id>` or `--continue` specifies a session to append to.
- `--session <id>` appends the turn to the session with id `<id>`.
- `--continue` appends the turn to the most recent session recorded for the current working directory.
- A resumed session continues on the target, model, and thinking level it last recorded, not on the default another session saved to `settings.yaml`. `--target`, `--model`, and `--thinking` override it, and the session records the override. Resuming never writes `settings.yaml`; a recorded target that is no longer configured keeps the current route and prints a notice.
- `--session` and `--continue` are mutually exclusive. Specifying both causes the invocation to fail with exit code 2 before execution.
- Session continuity options apply strictly to main-agent execution. They are non-applicable to `--agent` fleet dispatches because dispatched agents execute in isolated worker processes with independent transcripts; specifying session flags alongside `--agent` exits with code 2.
- A named session that cannot be resumed (such as an unknown session ID or unreadable history) fails the run with exit code 2 before any model call is initiated.
- An explicit `--target <id>` resolves targets from layered project settings (`.clio-coder/settings.yaml`, `.clio-coder/settings.local.yaml`) as well as user settings before applying target-not-found validation.
- The session ID is discoverable via the `session` event when running under `--json` mode and on stderr via the `clio-coder run: session <id>` line in text mode. Standard output remains reserved for the assistant answer alone.

### JSON Event Streaming and Wire Projection Promise

When `--json` or `--json-events <mode>` (`full` | `terminal`) is passed, `clio-coder run` streams structured JSONL events.
- **Wire Projection Promise:** Each piece of turn content crosses the wire exactly once.
- Intermediate `message_update` events are dropped to prevent quadratic snapshot duplication over stdout.
- `text_delta` and `thinking_delta` events stream incremental text deltas rather than accumulating message snapshots.
- `agent_end` events carry segment summary metrics (`messageCount` and a `usage` object containing `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `costUsd`, `apiCalls`, and `measured`) instead of duplicating the full message transcript.
- `turn_end` preserves the final assistant message while dropping `toolResults` array objects, each of which already crossed the wire in an preceding `tool_execution_end` event.

Example:

```bash
clio-coder run \
  "Find the test command and summarize the project structure." \
  --target local-lmstudio \
  --model qwen3.8-27b
```

### Turn Constraints

Headless runs can explicitly constrain one submitted turn and its continuations using host-enforced bounds ([turn-constraints.ts](../../src/core/turn-constraints.ts)). Turn constraints are never guessed from natural language or derived from model-generated arguments; they can only narrow existing safety, skill, and recipe policies.

- **Workflow mode (`--turn-mode <mode>`):** Selects workflow guidance (`answer` | `proposal` | `change`). Mode guides system prompt rendering and turn continuation discipline (`turnAllowsContinuation` disables autonomous continuation turns for both `answer` and `proposal`). Under `proposal`, tasks board `plan` and `add` actions automatically record `initialStatus: "blocked"` with a note awaiting operator authorization. **Important:** `mode` is prompt and workflow guidance, not an authorization boundary. `turnAllowsTool` ignores mode entirely; mutating tools such as `write` or `edit` are *not* denied by `--turn-mode proposal` alone. To mechanically enforce read-only execution or restrict modifications, pass an explicit capability allowlist (`--allow-tools read,grep,find,ls`) or set `--autonomy read-only` / `suggest`.
- **Worker delegation (`--no-delegate`):** Sets `delegation: "forbidden"`. `turnAllowsTool` mechanically denies the `dispatch` tool, and prompt compilation instructs the model to work directly without spawning workers.
- **Capability allowlist (`--allow-tools <names|none>`):** Restricts executable tools to an explicit comma-separated list of capability names, or disables all tools when passed `none`. Mechanically enforced by `turnAllowsTool` and tool execution admission. Naming a secondary capability (such as `data` or `clio_docs`) automatically admits its gateway transport wrapper, while naming `gateway` alone never admits every capability behind it.
- **Skill discovery suppression (`--no-skills`):** Suppresses automatic skill discovery from catalog roots and marketplace guidance while still honoring explicitly specified skill paths (such as `--skill <path>`). Programmatic turn constraints can also set `skills: "disabled"`, which mechanically rejects `context(scope="skills")` calls at the tool boundary.

In prompt generation, turn constraints render as the final `# Current task scope` section of the system prompt ([compiler.ts](../../src/domains/prompts/compiler.ts)). Because they appear after identity, role, context, and memory, adjusting turn constraints between turns preserves the preceding `stablePrefix` for models with prefix caching.

## Interactive Slash Commands

Slash commands are available inside the TUI. Type `/` at the start of the prompt to open the grouped command palette autocomplete.

The registry table below lists the available interactive slash commands. On a bare `/`, commands are presented in groups (`Run`, `Inspect`, `Configure`, `Sessions`) with compact argument hints. Each operation has one canonical spelling; autocomplete, help, and parsing all read the same registry. The "Usage" column details expected arguments, with brackets `[]` indicating optional arguments and angle brackets `<>` indicating required arguments.

| Command | Usage | Purpose |
| --- | --- | --- |
| `/quit` | `/quit` | Exit Clio Coder |
| `/help` | `/help [query]` | Open the interactive help center showing commands and keys |
| `/skill` | `/skill <name> [task]` or `/skill off` | Invoke a skill or clear its active tool surface; `/skills` opens the browser. |
| `/background` | `/background` | Detach the newest eligible attached dispatch through its existing owner; no eligible dispatch gives an explanatory no-op. |
| `/interrupt` | `/interrupt <text>` | Settle the active run and send text through the interrupt owner; refusals keep its existing next-slot behavior. Missing text is correctable. |
| `/editor` | `/editor [text]` | Edit explicit text or an empty buffer externally; return to the composer for deliberate submission. Failure preserves the command for correction. |
| `/notifications` | `/notifications dismiss [all]` | Dismiss the oldest notice once, or explicitly dismiss all; this does not mute future notices. |
| `/library` | `/library [inspect \| install \| remove <ref>] [import <path-or-url>] [reload]` | Open the full-screen Library with Skills, Agents, Prompts, Fleets and Plugins tabs. A named reference opens the browser on that row; `install`, `remove` and `import` show a reviewed plan first and write nothing until it is accepted. `reload` refreshes installed recipe resources. Alt+L opens the same browser. |
| `/skills` | `/skills` | Open the Library on Skills. |
| `/prompts` | `/prompts` | Open the Library on Prompts. |
| `/mcp` | `/mcp [list] \| /mcp trust <id> [class] \| /mcp untrust <id>` | List MCP servers or manage explicit trust for project MCP servers with optional action class |
| `/extensions` | `/extensions [reload]` | Inspect harness extensions or reload their commands, hooks and operator UI |
| `/interop` | `/interop` | Inspect another local coding agent and review adoption of supported resources. |
| `/share` | `/share [runId]` | Share a worker result with the main agent |
| `/archive` | `/archive export <path> \| /archive import [--dry-run] [--force] <path>` | Export or import a full Clio archive |
| `/run` | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] [--share] <agent> <task>` | Run a fleet agent |
| `/delegate` | `/delegate [--share] <agent-id> <task>` | Run an ACP delegation agent |
| `/btw` | `/btw <question>` | Ask a side question that never enters the session transcript |
| `/draft` | `/draft [N] <request>` | Draft N answers in parallel (2-4, default 3) and let a decision model pick the strongest |
| `/oracle` | `/oracle <question>` | Ask a read-only advisor to challenge a question against this session's settled decisions |
| `/council` | `/council [--roster <name>] [--rounds <n>] [--synthesis <judge\|vote\|none>] <task>` | Ask a roster of read-only members the same task, with an optional vote or judge synthesis |
| `/agents` | `/agents` | Open the Library on Agents. |
| `/usage` | `/usage` | Show subscription quota, credits, and session token and cost totals |
| `/doctor` | `/doctor [deep]` | Show a diagnostic report with errors and warnings first and full wrapped check details; `deep` adds live tool probes on the session's targets and a validation-contract dry run at the session's autonomy. See [Doctor](doctor.md). |
| `/context` | `/context compact [instructions] \| /context recall <ref> \| /context init [--preview] [--heuristic] [--adopt] [--global] [--propose\|--apply\|--rewrite] \| /context refresh \| /context reset` | Context hub: window overlay plus compact, recall, init, refresh, and reset |
| `/fleet` | `/fleet [run [--var <key=value>] <name>]` | Open Fleet Runs, or run a fleet contract with an approval preview. Configure fleets with `/settings fleet`. |
| `/decisions` | `/decisions` | Show settled interview decisions and operator revisions |
| `/tasks` | `/tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] <text> \| /tasks hand <id> \| /tasks done <id> \| /tasks drop <id>` | Show the session board or manage project operator tasks |
| `/memory` | `/memory [seed]` | Inspect, promote, or seed task memory |
| `/view` | `/view [filter] \| /view verify <runId>` | Browse session artifacts and verify receipts |
| `/panes` | `/panes show <run-or-agent> \| /panes open <preset-or-argv> \| /panes zoom [target] \| /panes close [target]` | Inspect the pane layer, watch a live run in a pane, or open a utility pane (`files`, `logs`, `shell`, `files --once`, or a command); a second open focuses the pane already there |
| `/files` | `/files [open\|close\|pick]` | Toggle the files pane docked below the session; picks land in the composer as `@` mentions. See [Panes and the Files Pane](panes-and-files.md) |
| `/thinking` | `/thinking [level]` | Set the chat thinking level; bare `/thinking` opens a picker of the levels this route supports |
| `/model` | `/model [pattern]` | Open model selector or set a model |
| `/settings` | `/settings [chat\|fleet\|targets\|context\|safety\|interface\|integrations] [group]` | Open interactive settings, optionally at a durable area and UI group |
| `/resume` | `/resume` | Resume a past session on the route it last ran on |
| `/new` | `/new` | Start a fresh session |
| `/handoff` | `/handoff <goal>` | Hand this session's working state to a fresh session for a stated goal |
| `/tree` | `/tree` | Open session tree navigator. Press `p` to filter by current cwd and `s` to cycle tree order or most recent first. |
| `/fork` | `/fork` | Fork from an assistant turn |
| `/export` | `/export [path]` | Export a self-contained HTML transcript by default; a `.md` path writes Markdown |

The `/model` selector marks image-capable rows with `V` and spells out `image input yes` or `image input no` in the selected row's details. A completed `/model <pattern>` switch includes the same image-input state in its notice. The expanded dashboard's session capabilities always say `images yes` or `images no` for the active route. These states use the resolved deployment capability and are shipped and tested.

### Subscription quota and session usage

`/usage` replaces `/cost`. There is no alias: `/cost` is no longer a command.
The overlay keeps the token and cost accounting `/cost` carried and adds what
the connected subscription accounts report. It is a live view of this session
and of your accounts right now; `clio-coder usage report` remains the separate
command for folding token and cost facts across past sessions.

| View | What it shows |
| --- | --- |
| Accounts | Subscription and credit meters, every reported model group, remaining capacity, reset countdowns and local reset times with an explicit time zone, and stale or expired readings |
| Session | Recorded token and cost totals, cache traffic, reasoning, and the background-call categories (side questions, handoffs, pre-warms, memory steps) |
| Models | Each model's share of recorded processed tokens, including cache traffic, plus its detailed token and cost breakdown |
| Workers | Active and recent runs, recorded tokens and cost, context usage, and the shared account limit when the local credential owner is known |

Press 1–4, Tab/Shift+Tab, or ←/→ to change views; ↑/↓ or PgUp/PgDn to scroll;
Home/End or Ctrl+Home/Ctrl+End to jump to either end; and Esc to close. Each
view keeps its own scroll position while the overlay stays open.

#### Used, left, and what a percentage describes

One direction per label, on every surface. A filled meter cell always means
consumed capacity, and the detailed meters in Accounts and Status label that
number `used` and print the complement beside it as `remaining`. Compact badges
carry the other direction and say so: `weekly 9% used` in a detailed meter is
the same reading as `weekly 91% left` in a footer badge.

Subscription percentages describe an account-wide provider window shared across
your sessions and devices. Session tokens and costs describe only what this
process recorded, and the two cannot be converted into each other. Context
occupancy is a third quantity again: it measures one request against a model's
window, not an account against its plan.

#### Where quota appears outside the overlay

The welcome header, the compact footer, the expanded dashboard, worker cards,
and fleet islands read the same cached readings the overlay does.

- The **welcome launchpad** carries a `Subscriptions` field beside the wordmark,
  wrapped so every connected account and the free local-inference row stay visible.
- The **compact footer** shows the selected model's weekly headroom on line 1,
  beside the model identity, and only when the account and model group are
  identifiable. Line 2 always keeps the working directory and Git branch or dirty
  state; notices, tips, and urgent prompts borrow the rotating hint area beside
  them. Quota never takes line 2, and the footer never promotes an unrelated
  account's busier window in place of the selected model's.
- The expanded dashboard's **Status** page puts the session total above the
  account meters, **Activity** shows shared account headroom on worker cards, and
  **Context** states that request occupancy and account limits are different
  quantities.

#### What Clio does not claim

Worker badges are shared account headroom, not a measured per-worker share.
Clio does not infer a worker's subscription consumption from its token counts or
from account deltas, and a badge appears only for a supported local credential
owner and the matching model group. Antigravity's Gemini group stays distinct
from its Claude and GPT group. Remote workers and generic transports stay
unlinked rather than being attributed to an account that may not be theirs.
Clio's own `openai-codex` sign-in is separate storage from the Codex CLI's
`auth.json`, so a Codex CLI reading is never attributed to an `openai-codex`
worker.

Local inference is listed at `$0.00` with no subscription window consumed. No
saved-quota figure is claimed, because per-target token attribution does not
exist yet.

#### Reads, caching, and failures

Quota reads are read-only. They read stored credentials and never refresh a
token, write a credential, or start a sign-in. An expired credential is reported
as expired with the provider's own sign-in guidance rather than repaired.

A reading is cached for about five minutes and refreshed lazily when a surface
that shows it is rendered, never on a background timer. A failed refresh keeps
the last good reading and marks it `STALE` rather than blanking the account. A
provider that reports no window for a period reports nothing for it: Codex sends
a weekly window and no 5h window, and Clio prints the rows a provider actually
sent instead of a fixed shape. Where a provider sends its own severity word,
that word wins over Clio's thresholds.

Two credentials on one Anthropic subscription (an `anthropic-max` sign-in and a
Claude Code sign-in) report identical windows, so they are folded into one
account and the apparent budget is not doubled. Accounts that merely happen to
show equal percentages are never merged.

### Notes on individual commands

| Workflow | Behavior |
| --- | --- |
| `/model` and `/thinking` | Choose a route for this session or save it as a default. Cancel leaves the active route unchanged. See [routing defaults](configuration-and-targets.md#live-routing-vs-saved-defaults). |
| `/btw` and `/draft` | Run side questions or candidate answers without tools or transcript changes. Calls still count in `/usage`. Use a model-bound draft judge for a scored pick. |
| `/council` | Runs a configured roster of two to five read-only members. Approval is shown before work starts; share the synthesis or an individual member explicitly with `/share <runId>`. |
| `/run` and `/delegate` | Start a fleet worker or ACP peer. Its answer is separate from main-agent context until shared with `--share` or `/share`. |
| `/handoff <goal>` | Review a bounded handoff document, then accept it to create a fresh session. The goal must describe a concrete continuation. |
| `/context` | Bare command opens the context ledger. Subcommands compact or recall session content and manage project context; see [Project context](#project-context). |
| `/tasks` | Inspect session tasks and the durable project task inbox. Acceptance checks travel with handed tasks; receipts show whether they passed. |
| Unknown slash command | Rejected before model submission. Use `\/text` to send text that begins with a slash. The command list is [above](#interactive-slash-commands). |

The command spellings and arguments are the [slash-command registry](../../src/interactive/slash-commands.ts); this table calls out only session workflows that need explanation.


## Keybindings

Clio has eleven direct application defaults. `/help` shows the effective keys,
fixed leader entries, scopes and user overrides. `Ctrl+G` opens a visible action
menu with no timeout: use a suffix or Up/Down and Enter. Unknown suffixes leave
the menu open and preserve the draft; Ctrl+G or Esc closes it. Ctrl+C immediately
cancels the underlying owner. The menu does not search as you type.

| Direct default | Action | Fixed leader suffix |
| --- | --- | --- |
| `Alt+L` | Toggle top-level Library | `l` |
| `Alt+M` | Toggle model picker | `m` |
| `Alt+O` | Cycle Compact, Standard, Detailed output | `o` |
| `Alt+U` | Cycle dashboard: Activity → Context → Status → closed | `u` |
| `Alt+W` | Toggle Workers | `w` |
| `Alt+E` | Toggle files from Clio focus | `e` |
| `Shift+Tab` | Cycle supported thinking effort for this session only | `t` |
| `Ctrl+Q` | Queue draft after the whole active run; ordinary send while idle | `f` |
| `Alt+Q` | Restore both queue kinds before the current draft, once | `q` |
| `Ctrl+D` | Delete forward with text; exit only empty and idle with no queued messages | — |
| `Ctrl+G` | Open or close the contextual action menu | — |

Additional menu entries: `i` interrupts with the draft, `s` backgrounds the newest
eligible attached dispatch, `g` edits the expanded draft externally, `x` dismisses
one notification, `z` undoes the focused editable field, `r` toggles transcript
search, `p`/`n` page the transcript and Home/End jump to its bounds. Previous/next
prompt entries are available through arrows and Enter. `/tasks`, `/decisions`
and `/tree` retain their boards; scoped model cycling retains configurable action
IDs and has no default direct key.

| Editing or contextual key | Behavior |
| --- | --- |
| `Enter` | Accept completion first, otherwise send idle input or queue at the next steering slot |
| `Ctrl+J`, `Shift+Enter` | Composer newline; distinct Shift+Enter delivery is optional |
| `Alt+B`/`Alt+F`, Ctrl+Left/Right, Alt+Left/Right | Word movement |
| `Alt+D`/Alt+Delete | Delete the next word |
| Ctrl+W, Alt+Backspace, Ctrl+Backspace | Delete the previous word; Ctrl+Backspace covers Windows Terminal's BS encoding |
| Home/End, Ctrl+A/E | Composer line bounds, including fullscreen |
| Ctrl+P/N | Prompt history, restoring the unfinished draft on return |
| Ctrl+underscore | Undo; menu `z` is the fallback when the physical chord is unavailable |
| Ctrl+R | Fullscreen transcript search; regular mode explains terminal Find |
| Search Enter / Up | Next / previous match; Home/End edit the query |
| Search Esc / Ctrl+C / Ctrl+R | Close search without cancelling unrelated work |
| PageUp/PageDown, Ctrl+Up/Down | Fullscreen transcript paging / previous-next prompt; overlays own their local navigation |
| Esc | Cancel completion or one local field/detail first; plain composer cancels bash then the active run |
| Ctrl+C | Cancel the current search/modal/child; otherwise cancel work, clear draft, or use idle-empty double Ctrl+C to quit |

Reviews, model-scope choices, permissions and interviews own their input. They
expose no global send, navigation, background or quit actions. Top-level Library,
model, tree and Workers scopes can expose their owner toggle; editable fields
expose semantic undo. Nested Library reviews must finish or cancel before the
browser toggle becomes available. Permission deletion never resolves a user
submit binding. Enter allows only when its defined empty-draft condition holds;
legacy LF/Ctrl+J is indistinguishable from Enter in these single-line scopes.

Bracketed paste is literal and never submits, executes a slash or shell command,
or confirms a modal. Submission needs a later deliberate key. External editing
receives expanded paste text and preserves the draft on failure; returned text
and recovered queues retain literal bang provenance. Input arriving during an
asynchronous send expansion remains in the composer. Explicit release events
are ignored before application or viewport actions. Repeats may edit, navigate
or scroll; they cannot repeat send, toggle, cycle, confirmation, cancel or exit.
Legacy streams cannot distinguish every held-key repeat.

**Overrides and migration.** Keep overrides in `interface.keybindings`; legacy
top-level `keybindings` remains a compatibility input. An explicit `[]` disables
both direct access and the action's default leader entry. A default-unbound
action may still have a leader entry. Rebinding a direct key does not change its
fixed suffix; `leader: []` disables the menu. Unknown IDs and effective conflicts
diagnose, and edits reload routing, components and hints together, cancelling a
pending menu. No preferences are rewritten. Defaults move follow-up from
Alt+Enter to Ctrl+Q and recovery from Alt+Up to Alt+Q; Alt+B/D return to editing.
Infrequent boards use their slash commands, and interrupt/background/external
editor/dismiss use the menu or command bridges. Explicit old choices remain.

**Terminal delivery.** On stock macOS Terminal.app, Option may compose text;
the Ctrl+G menu works without changing that setting. A temporary profile with
Use Option as Meta enabled permits direct Alt keys. Windows Terminal/WSL2 can
retain native Alt+Enter, Alt+arrow, clipboard, Find and zoom controls. Ctrl+J
is the portable newline. Node raw mode normally disables flow control and
signal generation; an SSH/mux or terminal UI can still intercept keys, so menu
`f` is available if Ctrl+Q does not arrive. Native clipboard and terminal window
controls remain upstream. Clio does not own keys while Yazi, an external editor
or the host mux holds focus. Physical Windows/macOS acceptance is separate from
Linux PTY and protocol tests; no terminal profile is installed automatically.

### What Ctrl+C does

`Ctrl+C` is not a single action. It resolves against the current input boundary,
first match wins (`resolveApplicationCtrlCAction`, [application-controller.ts](../../src/interactive/application-controller.ts)):

| State | What Ctrl+C does |
| --- | --- |
| An overlay owns input (transcript search, Library, Settings, model picker, a permission card) | Closes that overlay. It does not cancel a running turn and does not exit. Any armed shutdown is disarmed. |
| Streaming or running a tool | Cancels the in-flight run. The turn seals its partial output in ledger order and the session stays open. |
| Idle with text in the composer | Clears the draft. The press is consumed as an editor action, so it cannot become the hidden first half of an exit. |
| Idle with messages queued | Protects the queue and says how to recover it with the bound dequeue key (`Alt+Q` by default). |
| Idle, empty composer, nothing queued | Arms shutdown. A second `Ctrl+C` within 500 ms (`APPLICATION_DOUBLE_TAP_MS`) exits. |

Closing a permission card without approving it is a decision, not a dismissal:
the parked call is cancelled with `User cancelled this tool call from the
permission confirmation prompt`, and a parked *worker* permission resolves as
`deny`. The session itself keeps running.

### Typing before Clio has finished starting

Interactive startup mounts the editor before it loads its services, so the
composer accepts input from the first frame. Type and press Enter during
startup and the submission is held in a visible pending list, in order. When
hydration completes it adopts that same editor rather than rebuilding it, and
the held submissions drain once, in the order you sent them, through the
ordinary slash/bash/chat pipeline. A draft you have not submitted stays in the
composer with its cursor.

If startup fails or you interrupt it before hydration finishes, the terminal is
restored and any pending submissions and draft text are printed to stderr rather
than discarded. `CLIO_CODER_INSTANT_SHELL=0` opts out and waits for a fully
hydrated first frame. The seam is [terminal-lease.ts](../../src/interactive/terminal-lease.ts).

## Live Steering

While a run is active, the key that submits a message chooses when it lands.
There are three modes, chosen per message; the default is next slot.

| Mode | Key | Delivery |
| --- | --- | --- |
| Next slot | `Enter` | Between tool batches, mid-run, through `agent.steer`. The agent keeps going and reads the message before its next model call. |
| End of turn | `Ctrl+Q` | When the whole run settles and Clio would hand control back, through `agent.followUp`. A turn is the whole run, not one model round. |
| Interrupt | `Ctrl+G`, `i` or `/interrupt <text>` | Cancels the in-flight work the way `Esc` does (generation aborts; a running bash child gets SIGTERM, then SIGKILL), waits for the cancelled run to seal its tool results in ledger order, then submits the message as a fresh prompt. Anything already queued returns to the editor. |

### The same three modes against a background worker

The table above describes the main agent. Against a dispatched worker the three
modes are not symmetric:

- **Steer** reaches a worker. `@<agent> <text>` sends the message across the
  worker channel; the worker acknowledges it and keeps running.
- **Follow-up** does not. A worker has no follow-up queue, so a new goal for it
  is a new dispatch.
- **Interrupt** is refused while an attached dispatch is running, for the reason
  given below. Cancel the worker itself with `Esc`, which stops the run and
  still leaves a receipt.

Interrupt is refused in two states and the message is queued for the next slot
instead, with a notice saying why: while an attached dispatch is running (the
abort would kill the worker's run with no receipt; steer it with `@<agent>` or
cancel it with `Esc`) and while a permission ask is parked (it is already
waiting on you). A steer that arrives as the run ends is resubmitted as a fresh
prompt. Headless `--steer-channel` lines are always next-slot steers.

Explicitly addressed worker steering stays addressed to that worker. A stale,
completed, ambiguous or unavailable target produces a notice and preserves the
draft; it does not become a new main-agent prompt. The late-steer resubmission
above applies to an unaddressed steer for the main agent.

For running dispatches, the editor also accepts:

```text
@<agentId-or-runId-prefix> <steering text>
```

Clio resolves the token to an exact agent id first, then to a run-id prefix,
and forwards the text to an HTTP or SDK worker's steering channel. File-looking
tokens such as `@package.json` are rejected so ordinary repository references
do not accidentally become steering requests.

The `Alt+W` Fleet Runs board makes this control path discoverable: use
Up/Down or `j`/`k` to select a run, `s` to close the board and prefill its
exact `@<runId> ` steering prefix, and `x` to cancel a live worker or queued
retry. At narrow widths, the footer prioritizes available steer/cancel actions over navigation and detail hints; Enter still expands the selected card. Completed runs offer no steer/cancel actions. A steer first reports `queued`; only the worker's
`clio_coder_steer_received` acknowledgement reports `received`. Single-shot
subprocess runtimes and ACP delegation do not expose a live steering channel
and are labeled accordingly.

## Operating Posture and Autonomy

The settings UI offers **capable** (`auto-edit`) for supervised edits and **yolo** (`full-auto`) for work that should proceed without autonomy prompts. Safety rules remain active at both levels. Existing `read-only` and `suggest` values still load for older sessions and scripts. `--turn-mode proposal` is workflow guidance, not a read-only permission boundary; use `--allow-tools` or the legacy `--autonomy read-only` when execution must be restricted. An interactive capable or yolo session can preview a Clio settings change with `configure_clio`; only the host's Apply choice commits it, and at capable it cannot raise autonomy. See the [settings reference](configuration-reference.md#let-clio-propose-settings-changes), [safety model](../architecture/safety-model.md), and [Bash policy](tool-usage.md#bash-run-a-shell-command).

## Dispatch and Built-In Agents

Use `clio-coder agents` to inspect the installed agent catalog and `clio-coder run --agent <id> "<task>"` for a non-interactive dispatch. In the TUI, `/run` starts a fleet worker and `/delegate` starts a configured ACP peer. Fleet profiles determine target, model, and limits; worker execution and receipts are covered by [Fleet dispatch](fleet-dispatch.md). Agent ids and recipe contracts are maintained in [Built-in agents](built-in-agents.md).

## Environment Variables

Clio-specific and ambient variables are listed in the [environment variable reference](environment-variables.md).

## Project Context

`CLIO-CODER.md` is the project guidance file. Context operations are exposed through `clio-coder context` and `/context`; the maintained architecture and lifecycle details live in [Context continuity](context-continuity.md) and the [context engine](../architecture/context-engine.md).

### Codewiki index

`clio-coder context index` builds the structural codewiki without model calls. `context map` derives an architecture map from that index. Pinned source citations require a clean repository and matching indexed bytes; dirty or unknown source state falls back to uncited seeds.

### Working-set replay

`clio-coder context replay --sessions <path>...` replays saved ledgers; `--synthetic <ids>` adds deterministic procedural traces. `--json` writes a stable report, and `--md <file>` writes Markdown. `clio-coder context working-set --session <id|path>` inspects eviction, recall, and path observations for one session. These are read-only; replay-specific policy overrides never write settings. See [working-set design](../architecture/context-working-set.md).

### Markdown wiki commands

`clio-coder context wiki` creates the optional model-authored wiki through the wiki-writer agent. `--status` is read-only; `--update` refreshes stale pages; `--retry-pending` retries pending pages. `clio-coder context refresh` rebuilds only the structural index; `context refresh --wiki` also updates an existing wiki and does not create the first one.

### code_nav modes

The read-only `code_nav` tool queries the local index. Its modes and argument schema are in [Tool usage](tool-usage.md#codenav-navigate-the-codewiki-index).


## Output styles

**Alt+O** cycles **Compact → Standard → Detailed → Compact**. Standard is the default, so the first press reveals Detailed. The current style appears in the footer. Cycling applies immediately to the current session, including streaming output and history. Save a preferred startup style through **/settings interface → Output style → Apply and save globally**, or `clio-coder configure --section panes`.

| Content | Compact | Standard | Detailed |
| --- | --- | --- | --- |
| Answers and user messages | Complete | Complete | Complete |
| Supplied reasoning | Marker | 3 rows | 12 rows |
| Reads and searches | Consecutive successful observations grouped | Action and outcome | 8 result rows |
| File changes | Paths and change facts | 8 diff rows | 20 diff rows |
| Agent shell commands | Command and outcome | Command and outcome | 12 output rows |
| Your `!` / `!!` shell commands | 3 output rows | 6 output rows | 12 output rows |
| Workers | Identity, execution and validation outcome | 3 summary rows | 8 summary rows and bounded tool activity |
| Failures and refusals | Actionable reason, up to 4 rows | Actionable reason, up to 4 rows | Up to 12 rows |
| Turn receipt | None | Completion and available duration | Usage and model-call facts |

Preview budgets count terminal rows **after wrapping**, including the `/view` overflow hint, and shrink on short terminals. Reasoning previews retain the newest text when streaming stops. Detailed remains bounded: a successful `cat` or file read cannot fill the transcript with the entire file.

Use **/view transcript** to select full available reasoning, tool arguments/results, local shell output, or worker details. Search the list, press Enter to inspect, and Escape to return. Offloaded tool and dispatch output remains available in the other `/view` categories; missing or truncated captured content is identified. Inspection applies secret redaction, and `!!` output remains excluded from model context.

Output style changes presentation only. **Shift+Tab** still changes the model's thinking effort. It does not reveal unavailable reasoning; Clio shows only reasoning supplied by the provider. The previous Alt+R, Alt+P, and expand-all rendering shortcuts are retired. `/output` now explains how to reach Alt+O and Settings. Existing `minimal`, `default`, and `verbose` preferences map to `compact`, `standard`, and `detailed` without rewriting other preferences.

The footer owns live activity. Transcript actions have static running or outcome markers and update in place. Background workers add a count without replacing the main agent's current phase; a completed worker cannot clear a sibling's active state. Approval and user-input waits do not spin. Failed and cancelled turns retain their actual outcome, and an elapsed wait is described as silence rather than proof that a process is stuck. A worker's successful execution remains separate from its validation result.

## Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio-coder: command not found` | Run `pnpm run install:local`, then `hash -r`; confirm `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}` is on `PATH`. |
| No model target is available | Run `clio-coder configure`, then `clio-coder targets --probe`. |
| Local model does not respond | Confirm the runtime is running and the target URL is correct. |
| Cloud model auth fails | Check `clio-coder auth status <target>` and verify the relevant API key or login flow. |
| Source changes do not appear | Re-run `pnpm run build`; linked CLI points at `dist/`. |
| Session replay looks incomplete | Confirm durable session entries exist for the relevant tool, bash, or display activity. |
| Doctor reports stale state metadata | Run `clio-coder doctor --fix`; upgrades also refresh install metadata after reinstalling. |
| You need a clean start | Use `clio-coder reset --state`, `--data`, `--cache`, `--auth`, `--config`, or `--all`. |

For issue reports, include `clio-coder --version`, `node --version`, `clio-coder doctor`,
`clio-coder targets`, the command you ran, the target/model, expected behavior, and
actual behavior. Redact secrets and private repository content.

> [!NOTE]
> `clio-coder dev <command>` groups the instruments that answer a question about the
> harness rather than about your own work. Bare `clio-coder dev` or `clio-coder dev --help` prints
> developer instrument help and exits with code 0. Nothing under it is deprecated: every
> name still resolves without the prefix, so scripts and agents driving Clio over
> bash keep working unchanged. The prefix exists so `clio-coder --help` stays the set of
> commands a person needs to read; `clio-coder --help --all` prints both lists. Across all
> CLI subcommands (`targets use/remove/rename/profile/convert`, `context refresh`,
> `fleet list/run/status/drain/resume`, `auth login`), passing `--help` prints
> usage instructions and exits with code 0.

## Operator-task handoff and continuation

`clio-coder tasks hand <uN>` prints the inbox record as JSON on stdout and an actionable pickup prompt on stderr. Submit that prompt to the intended session. Before task work, the model must pick the intended `uN`, confirm its durable session and board linkage, and use the returned `tN`. Handing a task does not itself pick it. Completion should be checked against the linked board and inbox with the actual IDs; manual CLI completion is an operator action, not evidence of model completion.

Acceptance rows labeled Required declare expected checks and timeout limits; they are not pending executions or passing results. Inspect verification receipts for outcomes. Under high rigor, the finish gate requires the applicable passing checks or explicit limitations.

Task-board guidance and ordinary continuation preserve proposal-only scope. Deferred implementation should be blocked or dropped while awaiting an explicit operator go-ahead. A skill-install decision is separate from implementation authorization, and full-auto capability does not expand the task. These are model instructions, not a guarantee of model adherence.

## Library packages

Use `/library`, `/skills`, `/agents`, and `/prompts` to browse resources. `/skill <name>` activates a loaded skill; `/interop` reviews external coding-agent peers; `/extensions` manages harness extensions. See [Resource library](resource-library.md), [Interop](interop.md), and [Extensions and sharing](extensions-and-sharing.md).
