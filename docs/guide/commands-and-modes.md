# Commands and Modes

This guide covers the installed CLI, headless run behavior, interactive commands, keyboard controls, and operator workflows. The command registry and parser are authoritative: the [CLI command table](../../src/cli/index.ts), [startup flags](../../src/cli/argv.ts), [run arguments](../../src/cli/args.ts), the [slash-command registry](../../src/interactive/slash-commands.ts), and the [keybinding manager](../../src/interactive/keybinding-manager.ts). Exit codes and stdout guarantees are in [Exit codes and output](exit-codes-and-output.md). The TUI's layout, theme and rendering contracts are in [TUI design](../architecture/tui-design.md).

## Demo presentation and guidance

Demo presentation and guidance are on by default before 1.0. The full welcome shows the stacked cyan-to-copper wordmark, workspace and fleet facts, and shortcut hints. It reserves two subscription rows from the first paint, keeping its height and Fleet placement steady while account data hydrates. Longer summaries show an ellipsis and `/usage` for the complete account details. With `--no-demo` or `interface.demo: false`, both the instant shell and hydrated TUI open with a compact identity header: the same editor and chosen regular/fullscreen layout, without artwork or welcome-only context, subscription, and recipe reads. Optional attention animation and smooth-streaming pacing are disabled; work status and approval text remain visible. Dumb/unknown terminals and screen-reader mode also use the compact welcome.

After a turn, Clio may show one fading footer line beginning `tip: ...` that fits what the turn did: a question about Clio's own settings, a side question that `/btw` would keep out of the transcript, a correction that `/tree` could rewind, a long answer that another output style would fold. The harness picks the tip. The model never sees it, and no model call is made. At most one tip appears per session, and a tip retires once you use its feature yourself or it has been shown twice.

Guidance keeps a small profile in the state directory (`harness-profile.json`): the tips shown, the Clio features you used, and the topics you asked Clio about. It stays on this machine and never enters a prompt.

Turn it off under Settings → Appearance → Demo presentation and guidance (`interface.demo`), or for one invocation with `--no-demo`. Off means no tips, no idle footer tips or rotating key hints, no demo prompt line, and no profile reads or writes. Guidance adds hints only; it does not grant tool authority. Headless runs, ACP sessions and workers do not receive it.

## CLI Commands

| Command | Purpose |
| --- | --- |
| `clio-coder` | Launch the interactive terminal UI. |
| `clio-coder run "<task>" [flags]` | Run one headless main-agent turn. Use `--json` for JSONL events. |
| `clio-coder run "<task>" --agent <id> [flags]` | Dispatch one explicit fleet agent non-interactively and write a receipt. |
| `clio-coder acp [--cwd PATH] [--permission-timeout MS]` | Serve Clio as an ACP v1 agent over stdio for ACP frontends. `--permission-timeout` overrides `integrations.externalAgents.defaults.permissionTimeoutMs`, the server's default bound on a mediated permission request. |
| `clio-coder acp [--cwd PATH] auth login` | Open interactive Quick Connect when an ACP client offers terminal authentication. `clio-coder --acp` is an alias for `clio-coder acp`. |
| `clio-coder --version` / `-v` | Print the installed version. `clio-coder version` is the subcommand form. |
| `clio-coder --help [--all]` / `-h` | Print the command list. `--all` appends every command under `clio-coder dev`. |
| `clio-coder --demo` / `clio-coder --no-demo` | Start the interactive session with the full welcome and guidance, or with the compact startup. Refused with exit 2 before a subcommand. |
| `clio-coder --api-key <key>` | Override the active target API key for one invocation. |
| `clio-coder --no-context-files` / `clio-coder -nc` | Skip `CLIO-CODER.md` project-context injection for one invocation. |
| `clio-coder --with-panes` | Activate guest pane integration for this invocation when Clio is inside a reachable herdr session. |
| `clio-coder --no-panes` | Keep panes off even when settings turn them on. |
| `clio-coder --autonomy <level>` | Start this interactive session at `default` or `yolo` without modifying `settings.yaml`. Passing `--autonomy` before a subcommand is refused with exit 2 (`clio-coder run --autonomy` remains the headless form). |
| `clio-coder --no-skills` | Disable skill discovery for one invocation and automatic skill/marketplace prompt guidance while still honoring explicit `--skill` paths. |
| `clio-coder --skill <path>` | Make one explicit skill file or directory available for one invocation (repeatable). Clio loads its instructions when the skill is activated through `context(scope="skills", name=...)`. |
| `clio-coder --resume`, `--continue`, `-r`, `-c` | Refused with exit 2 as `unknown global option: <flag>. Sessions are resumed from inside the app: start clio-coder, then type /resume to pick one.` Resume from the interactive session with `/resume`. See [Resuming sessions](#resuming-sessions). |
| `clio-coder configure` | Run the configuration wizard. Ctrl+C reports `configuration cancelled` once, writes no target, and exits 130 without an additional error line; when first-run onboarding is cancelled, startup stops instead of opening the TUI with no usable target. |
| `clio-coder configure [--quick\|--settings\|--section <name>\|--json\|--edit]` | `--quick` connects an endpoint with recommended defaults, `--settings` opens the complete settings menu, `--section <name>` opens one of `targets`, `chat`, `fleet`, `context`, `safety`, `interface`, `integrations` or `advanced` (without a terminal it prints that section's values), `--json` prints the effective settings, and `--edit` edits user settings in `VISUAL`/`EDITOR` with validation and review before saving (it needs a terminal and exits 2 without one). |
| `clio-coder configure --id <targetId> --runtime <runtimeId> [flags]` | Register a target without prompts. Flags: `--url <host>`, `--model <wireModelId>`, `--orchestrator-model <id>`, `--background-model <id>`, `--fleet-model <id>` (exclusive with `--agent-profile`), `--agent-profile <name>`, `--agent-profile-model <id>`, `--bind-agent <agentId>`, `--api-key-env <VAR>`, `--api-key <literal>`, `--force`, `--gateway`, `--lifecycle <user-managed\|clio-coder-managed>`, `--set-orchestrator`, `--set-background`, `--set-fleet-default`, `--context-window <N>`, `--max-tokens <N>`, `--reasoning <true\|false>`. `clio-coder targets add` forwards its arguments here. |
| `clio-coder configure --interop` | Review other coding agents detected on this machine and connect one as a delegation peer. Without a TTY it prints the proposals and writes nothing. |
| `clio-coder configure --list` | List user-facing runtime ids. |
| `clio-coder configure --list --all` | List every registered runtime, including aliases. |
| `clio-coder config [inspect] [--json]` | Print the effective customization graph across settings, context files, rules, skills, prompts, agents, extensions, safety, memory, hooks, and operator profile. |
| `clio-coder config trust safety\|hooks\|settings\|extensions\|plugins [--json\|--hash <sha256>\|--revoke]` | Review, approve, or revoke one privilege-bearing project surface for this workspace. See [Project trust](#project-trust). |
| `clio-coder targets [--json] [--probe [--reasoning] [--tools [--tools-timeout <seconds>]]] [--target <id>]` | List targets and metadata; `--reasoning` and `--tools` explicitly generate qualification requests, and `--tools-timeout` bounds each tool probe. |
| `clio-coder targets add` | Add a target interactively or through configure flags. |
| `clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>] [--fleet-target <id>] [--fleet-model <id>]` | Select the named roles only when any role flag is present. `--background-model` selects memory; `--orchestrator-model` selects chat; `--fleet-model` or `--fleet-target` selects fleet. Other roles and thinking levels are preserved. Without role flags, chat and fleet use the target default (or shared `--model`), while memory is preserved. With role flags, `--model` is refused with exit 2 when no selected role falls back to it; pass `--orchestrator-model` to set chat. Confirmation names only roles whose settings changed. Model IDs must match a nonempty discovered or cached inventory exactly; unavailable discovery is reported explicitly. |
| `clio-coder targets fleet [--json]` | List the configured fleet profiles with their target, runtime, model, and thinking level. `targets workers` is an accepted alias. |
| `clio-coder targets profile list\|set\|remove\|rename\|bind\|unbind\|bindings` | Manage named fleet profiles and agent bindings. `list [--json]` and `bindings [--json]` read; `set <name> <id>` takes `--model` and `--thinking`; `remove <name>` takes `--force`; `rename <old> <new>` renames; `bind <agentId> <profileName>` and `unbind <agentId>` attach and detach an agent. `clio-coder targets profile <name> <id>` is the short form of `profile set`, and `targets worker` is an accepted alias for `targets profile`. |
| `clio-coder targets convert <id> --runtime <runtimeId>` | Convert older local target definitions to a runtime-specific target. |
| `clio-coder targets remove <id>` | Remove a target. |
| `clio-coder targets rename <old> <new>` | Rename a target id. |
| `clio-coder models [search] [--target <id>] [--json] [--offline]` | List models. Live probing is the default; `--offline` skips it. |
| `clio-coder paths [--json]` | Print the resolved config, data, state, and cache directories. |
| `clio-coder auth list` | Show known auth entries. |
| `clio-coder auth status [target-or-runtime]` | Inspect auth state. |
| `clio-coder auth login [target-or-runtime] [--api-key <value>]` | Add credentials through the supported flow. |
| `clio-coder auth logout [target-or-runtime]` | Remove stored credentials. |
| `clio-coder doctor [--fix] [--json] [--verbose] [--deep [--tools-timeout <seconds>]]` | Diagnose state. Plain `doctor` is read-only and leaves even a partially initialized home byte-for-byte untouched. With `--fix`, create missing structure and templates, repair credential permissions, refresh install metadata, rewrite retired enum values and YAML 1.1 booleans in settings, and record fleet preflight results. Settings remain strict; lifecycle migrations belong to `upgrade`, not `doctor --fix`. `--deep` adds a live tool-call probe per target and a dry run of the validation contract. See [Doctor](doctor.md). |
| `clio-coder mcp list\|trust\|untrust` | List configured MCP servers (`list [--json]`) or manage explicit project trust with `trust <id> [--action-class read\|execute\|unknown] [--json]` and `untrust <id> [--json]`. Exit 0 on success, 1 on operational failure, 2 on invalid usage; `list` exits 1 when config or trust diagnostics are present. |
| `clio-coder tools list [--json]` | List the pinned external tool registry (`herdr`, `yazi`, `croc`, `cliamp`) and whether each program resolves from `PATH`, Clio's vendored data directory, or nowhere. After a pin moves, an older vendored copy reads ``vendored <versions> is superseded by the <pin> pin (update with `clio-coder tools install <id>`)`` instead of `not found`. |
| `clio-coder tools status <id> [--json] [--reset-profile]` | Inspect one registered tool; its `resolves to` line uses the same wording as `tools list`. `--reset-profile` applies only to yazi's generated profile. |
| `clio-coder tools install <id> [--force] [--json]` | Download the platform asset, verify every declared checksum, and atomically vendor it. The `ok:` result line also names the versions it pruned, followed by one `license` line per upstream license file; `--json` lists the pruned versions in `pruned`. |
| `clio-coder tools remove <id>\|--all [--json]` | Remove Clio-vendored copies without touching a program found on `PATH`. |
| `clio-coder panes install [--force] [--json]` | Alias for `clio-coder tools install herdr`. |
| `clio-coder panes theme` | Print Clio's theme tokens as a herdr `[theme.custom]` block to paste into herdr's `config.toml`; Clio never edits that file. See [Panes and the Files Pane](panes-and-files.md). |
| `clio-coder systemone status\|export --out <file> [--since <YYYY-MM-DD>] [--site <site>]` | Show whether System One recording is on, what the local dataset holds and where each site is bound, or export the dataset as JSON lines. See [System One](system-one.md). |
| `clio-coder tasks [list\|add\|hand\|done\|drop]` | List, add, hand, finish, or drop project operator tasks. `add` takes `--expect <path>` and `--verify <checkId>[:timeoutMs]`; `hand`, `done` and `drop` take a `uN` id. |
| `clio-coder verifiers discover\|inspect\|author\|validate\|add\|edit\|rename\|remove\|baseline\|dry-run` | Discover, inspect, author, validate, add, edit, rename, remove, baseline, or dry-run project checks. |
| `clio-coder reset [--state\|--data\|--cache\|--auth\|--config\|--all] [--dry-run] [--force] [--json]` | Reset selected Clio Coder state. `--state` is the default level. Under `--state` or `--all`, an owned background app is stopped first and reported as `Removed Background service`. |
| `clio-coder uninstall [--dry-run] [--remove-binary] [--keep-config] [--keep-data] [--force] [--json]` | Remove Clio Coder state and print uninstall guidance. Shell startup files that mention Clio, including `$ZDOTDIR/.zshrc` and fish `config.fish`, are reported and never edited. |
| `clio-coder upgrade [--dry-run] [--channel=<latest\|beta\|dev>] [--skip-migrations] [--refresh-runtime] [--post-install] [--rollback] [--restart] [--json]` | Update an identified npm global installation in its original prefix and apply migrations with that installation's new binary. An `install.sh` installation gets the new version in a new prefix beside the old one and its launcher is switched; `--refresh-runtime` also moves it to the newest Node LTS the installer picks. Other managers and source checkouts receive update instructions. `--channel` also accepts a separate value (`--channel beta`). `--post-install` runs local migrations and repairs only. A pinned installer install prints `Pinned version: <X>` and the installer command that follows the channel again, and is not upgraded. `--rollback` restores the previous working version of a native installation, disables background updates and moves a version pin to the restored version; with no previous version it fails up front, and `--dry-run` names both versions. It cannot combine with `--post-install`, `--refresh-runtime` or `--restart`. `--restart` relaunches the installed CLI in the project after success, where `/resume` picks up the last session; it requires a terminal and cannot combine with `--json` or `--post-install`. |
| `clio-coder agents [--json] [--all]` | List discovered agent specs. |
| `clio-coder fleet list\|new\|validate\|graph\|commands\|run\|status\|drain\|resume` | List fleet contracts, copy a built-in one with `new <name> --from <build-review\|build-test\|sdlc>`, validate or graph one without side effects (`validate <name> [--json]`, `graph <name> [--json]`), draft a command registry with `commands init`, run one, show dispatch state, or control admission. `drain` denies new execution starts for up to one hour and preserves running work; `resume` reopens admission immediately. `run <name>` takes `[--var k=v ...]`, `[--resume <runId>]` and `[--json]` and refuses any other flag with exit 2; `status` takes `[--json] [--all]` and defaults to this project; `drain` and `resume` each take `[--json]`. |
| `clio-coder fleet verify <runId> --json` | Re-authenticate one run's sealed receipt now, instead of reading the trust status a snapshot captured earlier. `--json` is required; any other argument shape exits 2, and an unknown run id exits 1. |
| `clio-coder fleet cancel <runId> [--json] [--reason <text>]` | Ask the process that owns the run to abort it and wait up to 15 seconds for the run to seal `canceled`; exit 1 while the request is still pending. When the owning process is gone, terminate the orphaned worker's process group and settle the ledger row directly. |
| `clio-coder fleet nodes add\|discover\|install\|list\|remove\|test` | Manage SSH worker nodes. `add <id> --host <SSH alias or address> [--user <name>] [--port <number>] [--identity-file <path>] [--entry <worker command>] [--version-command <command>] [--labels <a,b>] [--max-workers <number>] [--test] [--record]`; `discover [--json]` lists Tailscale peers; `install <id> [--yes]` previews a user-level install of this exact client and `--yes` executes it; `list [--json]` shows recorded readiness; `remove <id>` removes a node without deleting remote files; `test <id> [--record] [--json]` probes without remote writes and `--record` updates local eligibility. A node needs a passing recorded check before dispatch. See [Fleet dispatch](fleet-dispatch.md). |
| `clio-coder fleet inspect\|decisions --json [--all]` | Read bounded run, council, and gate decision summaries for this project. `--all` reads machine-wide state. |
| `clio-coder fleet view <runId\|fleetRootId> [--follow] [--json] [--all]` | Read the append-only run journal after verifying receipt trust. A fleet root prints its durable step index. IDs from other projects require `--all`. Without `--follow`, the width-bounded snapshot is plain text with no ANSI control bytes. Once the receipt authenticates, the snapshot adds the requested model next to the provider-reported model per call (`not observed` when uncaptured), the cost with its provenance, and the `settled` label. `--json` prints the snapshot with the authenticated receipt and takes a run id only. `--follow` tails only on an interactive terminal and for one run id; otherwise it prints the snapshot (a fleet root prints its index) and says so on stderr. Exit 2 for an unknown or ambiguous id and for invalid flags. `fleet view --help` prints this subcommand's own usage, including `--watch`. See [Fleet dispatch](fleet-dispatch.md). |
| `clio-coder fleet view --watch <selection-file> [--dock-taps <file>] [--all]` | Run the workers dashboard: a board of this session's workers and a live takeover of one, driven by the selection file. This is the process the workers dock (`Alt+W`) runs in a `--with-panes` session. `--dock-taps` names the file where the dashboard reports `q` and `Alt+W` to Clio; without it `q` quits. Without a TTY it prints the selected run's snapshot and exits. |
| `clio-coder dev components [list] [--json]` | List behavior-affecting harness components. |
| `clio-coder dev components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio-coder dev components diff --from <a> --to <b> [--json]` | Compare component snapshots. |
| `clio-coder evidence build\|inspect\|list\|inventory` | Build (`build --run <runId>` or `--session <sessionId>`) and inspect deterministic evidence artifacts. `inventory --json` is the fixed GUI read. |
| `clio-coder memory list\|propose\|promote\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. `propose --from-evidence <evidenceId>`, `promote --from-handoff <path> --scope <scope>` (with `--entry <id>` to pick entries), `approve <memoryId>`, `reject <memoryId>` and `prune --stale`. Scopes are `repo` (`--repository <canonical-absolute-path>`), `global` (`--acknowledge-global`), `runtime` (`--runtime <source-runtime-id>`) and `agent` (`--agent <source-agent-id>`). Promotion always needs an explicit scope and creates unapproved records for review. |
| `clio-coder interop inspect [--json]` | Show the host inventory of detected coding agents and how far each one is wired. Changes no host or project files and starts no agent session. |
| `clio-coder interop adopt <host> [--kind skill\|agent\|prompt\|plugin] [--project\|--user] [--yes] [--dry-run]` | Review and adopt safe resources from a detected host. Wiring a host as a delegation peer is `clio-coder configure --interop`. |
| `clio-coder trace runs [--db PATH] [--limit N] [--json]` | List runs recorded in the durable trace mirror beside the ledger. |
| `clio-coder trace inspect --json` | Emit the fixed, bounded recent accounting projection used by the graphical application. It accepts no path, identifier, or limit and omits request text, error prose, event payloads, process commands, PIDs, and hosts. |
| `clio-coder trace phases <runId> [--db PATH]` | Show one run's recorded phases. |
| `clio-coder trace tail <runId> [--follow] [--db PATH]` | Tail one run's recorded events; `--follow` streams as they land. |
| `clio-coder trace procs <runId> [--db PATH]` | Show the processes one run spawned. |
| `clio-coder trace code-steps <rootId> [--json]` | Show the deterministic code-step records one fleet root wrote (argv, cwd, env names, exit code, duration, output digest, artifact paths). They are files beside the ledger, not rows in the mirror, so `--db` does not apply. |
| `clio-coder trace prune [--max-age-days N] [--max-bytes N] [--db PATH] [--json]` | Apply the trace-retention policy while protecting queued and running runs; JSON reports the resolved policy, rows, runs and bytes removed, protected runs, and whether vacuum ran. |
| `clio-coder trace sql <SELECT query> [--db PATH]` | Run one read-only query against the mirror. Only a single `SELECT` or read-only `WITH` statement is accepted; anything else exits 2. |
| `clio-coder dev evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio-coder extensions list\|discover\|run\|install\|enable\|disable\|remove` | Manage installed extension packages and resource roots, or run an extension command with `run <id> <command> -- [arguments]`. `list`, `install`, `enable`, `disable` and `remove` take `--user` or `--project`. `clio-coder ext` is an accepted alias. A project copy loads only after `clio-coder config trust extensions` approves the project's extension state, and the first `install --project` into a workspace with no project extension state approves it. `list` shows an unapproved project copy as `untrusted`. See [Harness extensions](harness-extensions.md). |
| `clio-coder library list\|search\|recipes\|register\|inspect\|validate\|install\|import\|update\|enable\|disable\|drift\|pin\|remove\|reload` | Manage packages of kind plugin, skill, agent, prompt or fleet at user/project scope (`--user`, `--project`); `list` and `search` take `--kind <kind>`, `recipes [query]` takes `--kind skill\|agent\|prompt\|fleet`, `--source core\|package\|user\|project\|compat` and `--all`. `install`, `import`, `update`, `enable`, `disable` and `remove` accept `--dry-run` to preview; `install` also takes `--force` and `--with-requirements`; `update` takes `--force`. `import <path\|github-tree-url>` takes `--format claude\|codex` and `--yes`. `register`, `pin` and `drift` print text lines unless `--json` is given, and a committed install, update, enable, disable or remove ends with `A running session picks this up after /library reload.` `library skills [--all]` lists runtime skills; `library inventory --json` is the fixed GUI read. `library sync`, `library push` and `library remote confirm <url>` manage a remote library. A project copy loads only after `clio-coder config trust plugins` approves the project's plugin state; the first project `install` into a workspace with no plugin state approves it, and `import` never does. Run by the model through a shell, `install`, `import`, `update`, `remove`, `enable`, `disable`, `pin`, `register`, `sync`, `push` and `remote` ask for one-shot confirmation, and `--dry-run` never asks. See [Resource library](resource-library.md). |
| `clio-coder gui [--path </app/path>] [--open\|--no-open] [--foreground]`, `clio-coder dev gui` | Start the graphical application, an opt-in alpha for power users listed under `clio-coder --help --all`; the terminal UI stays the primary interface and nothing starts the application unless you run it. Also `gui background install [--open] [--port <1-65535>]`, `gui background status\|start\|open\|restart [--if-idle]\|stop\|uninstall` and `gui launcher install\|status\|uninstall`. See [Graphical application](#graphical-application) and the [GUI guide](gui.md). |
| `clio-coder usage report [--repo <path>] [--days <n>] [--json]` | Cross-session usage facts from session/run ledgers and retained out-of-turn calls, including known failed-compaction spending, System One calls and missing coverage. The window defaults to 30 days and the JSON schema is marked experimental. |
| `clio-coder dev share export --out <path> [--project\|--user\|--both] [--context] [--prompts] [--skills] [--agents] [--fleets] [--settings] [--extensions] [--all] [--dry-run] [--json]` | Export project context, prompts, skills, agents, fleets, settings fragments, and extension bundles. `--dry-run` lists what the archive would hold and writes nothing. |
| `clio-coder dev share import <path> [--dry-run] [--force] [--project\|--user] [--json]` | Import a share archive with conflict reporting. |
| `clio-coder dev share inspect <path> [--json]` | Inspect a share archive without importing it. Each share command refuses, with exit 2, a flag it does not use. |
| `clio-coder export --out <path> ...` / `clio-coder import <path> ...` | Top-level aliases for `dev share export` and `dev share import`. Each `dev` command also resolves without the `dev` prefix. |
| `clio-coder context` | Show project context status, preload class, codemap freshness, and the codemap digest when present. |
| `clio-coder context init [--preview] [--heuristic] [--yes] [--json] [--adopt] [--global\|--include-global] [--propose\|--apply\|--rewrite] [--depth quick\|standard\|deep] [--target <id> [--model <id>] [--thinking <level>]]` | Explore the repo and bootstrap or update project context: `CLIO-CODER.md`, `.clio-coder/codemap.json`, and `.clio-coder/state.json`. `--depth` bounds the model's exploration: `quick` allows 8 tool calls and 2 minutes, `standard` (the default) 16 and 4, `deep` 32 and 8. The time limit doubles at `medium` and `high` thinking and triples at `xhigh` and `max`, and its last quarter is reserved for the model to submit its draft. Any other value exits 2. |
| `clio-coder context refresh [--wiki]` | Rebuild the codemap and state without touching `CLIO-CODER.md`; with `--wiki`, update an existing Markdown wiki. |
| `clio-coder context wiki [--update\|--retry-pending] [--replan] [--status] [--depth auto\|simple\|medium\|detailed] [--target <id>] [--model <id>] [--thinking off\|low\|medium\|high]` | Generate, update, or inspect the agent-authored Markdown wiki under `.clio-coder/wiki/`. |
| `clio-coder context reset [--all] [--yes]` | Clear accumulated project context artifacts; `--all` also removes `CLIO-CODER.md`. `--yes` (or `-y`) answers every confirmation and is required when stdin is not a terminal. |
| `clio-coder context index [--json]` | Build the structural codemap index without model calls; writes `.clio-coder/codemap.json` and `.clio-coder/state.json` and prints coverage plus a structural hash. |
| `clio-coder context map [--out <path>] [--json]` | Write an archify architecture seed from the structural index without model calls. |
| `clio-coder context replay (--sessions <path>... \| --synthetic <ids>) [--policies <ids>] [--profile <id>] [--budgets <tokens>] [--threshold <ratio>] [--target <ratio>] [--protect-last-turns <n>] [--protect-last-steps <n>] [--min-evictable-tokens <n>] [--rearm-fraction <ratio>] [--overflow-fraction <ratio>] [--seed <n>] [--no-filter] [--json <out>] [--md <out>]` | Replay working-set policies over Clio session ledgers or the seeded procedural corpora and report retention, precision, token savings, recall cost, cold-prefix cost, saturation, and summary headroom. Non-default profiles include paired default-profile comparisons. |
| `clio-coder context working-set --session <id\|path>` | Inspect one session's durable working-set fold and path-index summary without modifying the ledger. |
| `clio-coder worker` | Internal. The native worker stream server: a WorkerSpec on stdin, NDJSON on stdout. SSH placement launches it on a remote installation. It is not an operator command. |

An unknown subcommand prints the command list to stderr and exits 2. The retired spellings `context-init`, `context-index` and `context-clear` are unknown subcommands; use `context init`, `context index` and `context reset`.

Without `--cwd`, ACP binds the first session's absolute workspace path before it loads project settings or tools. `--cwd PATH` binds the workspace when Clio starts.

ACP frontends can list, load, resume, and delete sessions through the stable session methods. Clio offers `default` and `yolo` as ACP modes. A frontend can change autonomy with `session/set_mode` or the `autonomy` configuration option (category `mode`). The `model` and `thinkingLevel` options (category `thought_level`) change only the hosted session; saved defaults stay as they were. Mode and option changes are refused with `prompt_active` while a prompt is running.

The startup flags `--api-key`, `--no-context-files` (`-nc`), `--no-skills` and `--skill` apply to the interactive session, `clio-coder run` and `clio-coder acp`. `--with-panes` and `--no-panes` apply to the interactive session alone. A startup flag given before any other subcommand is refused with exit 2 and a message naming the flag and the subcommand, because that command would ignore it.

### Pane launch flags

`clio-coder run` does not read the startup flags `--with-panes` and `--no-panes`.
Given before `run`, they are refused with exit 2.

`--with-panes` is an explicit first-class launch mode, not permission to start a
pane server. Clio confirms `HERDR_ENV=1`, connects to an existing socket, and
pings it before registering pane tools. The workers dock runs
`fleet view --watch` against a selection file. Clio writes the requested run id and
the session scope into that file, while the dashboard reads the ledger, journals and
receipts itself, so dispatch remains independent of the pane host and a second
terminal can use the same journal surface directly.
`interface.panes.enabled` defaults to `off`. The value `embedded` is accepted in
`settings.yaml` but does not start a host: it resolves to no panes with the reason
`embedded pane hosting is not implemented`, and Settings offers only `off` and
`auto`. `--with-panes` overrides any setting with `auto`, and `--no-panes`
overrides any setting with `off`. Use `auto` or `--with-panes` only when Clio is
already inside a reachable herdr session. The pane contracts are in
[Panes and the Files Pane](panes-and-files.md).

### Graphical application

`clio-coder gui` opens the local browser application. It reuses this installation's owned background application when one is installed and otherwise starts a private foreground server that stops with Ctrl+C. A browser opens by itself only from an interactive terminal on a desktop; `--open` always opens one and `--no-open` never does. `--foreground` selects a private server explicitly, as do `--port`, `--idle-exit <milliseconds>`, `--token` and `--log-file`. `--path </app/path>` opens a particular page; under WSL, when `gui` reuses the background application and its window is already open, `gui` brings that window to the front and `--path` shows the page in it, while a bare `gui` leaves the window on the page it shows. `--reuse-background` fails instead of starting a private server when the background application cannot be used.

| Subcommand | Effect |
| --- | --- |
| `gui background install [--open] [--port <1-65535>]` | Install the optional login service on Linux with a systemd user session. The stable address is `127.0.0.1:4343`, or `127.0.0.1:7373` while another program holds it; `--port` replaces 4343 as the first choice. |
| `gui background status\|start\|open\|stop\|uninstall` | Inspect, start, open or stop the service, or remove it together with its login, desktop and Windows entries. |
| `gui background restart [--if-idle]` | Load a newly installed version; `--if-idle` leaves the service alone while work or a conversation is open. |
| `gui launcher install\|status\|uninstall` | Manage a desktop entry. |

macOS and native Windows run the private server only, and Windows prints the link instead of opening it. The graphical application needs a build that includes it: without `dist/gui/server.js` the command exits 2. The application's pages, guided setup, settings and attended-session behavior are in the [GUI guide](gui.md).

### Project trust

Five project surfaces carry operator authority, so Clio ignores each one in a
workspace until you approve its exact bytes:

| Surface | Files |
| --- | --- |
| `safety` | The nearest `.clio-coder/safety.yaml`, searching up from the workspace root. |
| `hooks` | `.clio-coder/hooks.yaml` and `.clio-coder/hooks.local.yaml`. |
| `settings` | `.clio-coder/settings.yaml` and `.clio-coder/settings.local.yaml`. |
| `extensions` | `.clio-coder/extensions/state.json`, the install state of the project's harness extensions. |
| `plugins` | `.clio-coder/plugins/state.json`, the install state of the project's library packages. |

A surface that was never approved, or whose files changed after approval, is
ignored, and Clio reports it with the command that reviews it.
`clio-coder config inspect` lists an ignored project settings layer beside the
settings it failed to change.

| Command | Effect |
| --- | --- |
| `clio-coder config trust <surface>` | Print the captured snapshot as JSON (`workspaceRoot`, `surface`, `files` with `path`, `text` and `hash`, `contentHash`, `verdict`). When at least one file is readable, the lines `Review the captured files above. Approve exactly these bytes with:` and `clio-coder config trust <surface> --hash <digest>` follow. Read-only. |
| `clio-coder config trust <surface> --json` | The same JSON with no approval line, for scripts. Read-only. |
| `clio-coder config trust <surface> --hash <sha256>` | Approve exactly the reviewed bytes and print `Project <surface> approved for <workspace> at <digest>.` with a reload hint. It exits 1 with `project <surface> changed since review; inspect it again before approving` when the bytes differ from the digest, and with `no readable project <surface> files to approve` when none of the files is readable. |
| `clio-coder config trust <surface> --revoke` | Remove the approval for this workspace and print `Project <surface> trust revoked.` with a reload hint. It exits 0 when no approval existed. |

Approval is per surface and per canonical workspace. Trusting one surface never
trusts another, and trusting a parent directory never trusts a child workspace.
Settings and safety take effect at the next restart. A revoked hook stops
before its next execution, and a newly approved hook registers when extensions
reload. Approved `extensions` apply on `/extensions reload` and approved
`plugins` on `/library reload`. A missing or unknown surface name prints
`usage: clio-coder config trust safety|hooks|settings|extensions|plugins [--json | --hash SHA256 | --revoke]`,
and any other argument form, including a `--hash` value that is not 64 lowercase
hexadecimal characters, prints `trust expects --json, --revoke, or --hash followed by the full reviewed SHA-256 digest`.
Both exit 2.

The `extensions` and `plugins` surfaces pin the install state of the project's
packages. Until one is approved, the project's packages of that kind do not
load, and a user-scope package with the same ID keeps loading. Any later
install, update, enable, disable or remove changes the state file and needs a
new approval, with two exceptions that approve without `config trust`. The first
project install into a workspace with no state file for that surface approves
the state it creates, through `extensions install <path> --project` for
extensions and through `library install` from the CLI, the Library overlay or
the GUI for plugins. A task worktree that Clio created inherits its origin's
`extensions` and `plugins` approval while its state file is byte-identical to
the origin's approved one. Archive imports, `library import` and `interop adopt`
never approve. The details are in the [safety model](../architecture/safety-model.md),
[harness extensions](harness-extensions.md) and [library packages](resource-library.md).

Approval records live under the Clio state directory, in
`workspace-trust/`, and are written only by this command, by Clio's own
project settings saves and by the first-install approval above.

## Headless Run Flags

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | Enter `<dir>` before the run resolves anything against the working directory, the way `acp --cwd` does. Applies to the main agent and to `--agent`. See [Headless Working Directory](#headless-working-directory). |
| `--target <id>` | One-run main-agent or dispatch target override. |
| `--model <wireId>` | One-run model override. |
| `--thinking <level>` | One-run thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--autonomy <level>` | Main-agent one-run autonomy override: `default` or `yolo`. It does not change saved settings. Combining it with `--agent` is a usage error; use `--read-only` to restrict a dispatch. |
| `--read-only` | Restrict a `--agent` dispatch to read-only tools. Without `--agent`, it is a usage error, as are `--agent-profile`, `--agent-runtime`, `--tool-profile` and `--require` (`fleet dispatch flags require --agent <recipe-id>`). |
| `--temperature <n>` / `--top-p <n>` / `--top-k <n>` / `--min-p <n>` | One-run sampler overrides when the selected runtime supports them. `--temperature` takes a number of 0 or more, `--top-p` and `--min-p` take 0 to 1, and `--top-k` takes a number of 0 or more, rounded down. They reach the main agent and an `--agent` worker alike. |
| `--presence-penalty <n>` / `--frequency-penalty <n>` / `--repeat-penalty <n>` | One-run penalty overrides when the selected runtime supports them. They reach the main agent and an `--agent` worker alike. |
| `--max-context-tokens <n>` | One-run context-window override for supported local runtimes. |
| `--json` | Stream JSONL events for main-agent runs; dispatch streams events and receipt JSON. |
| `--json-events <mode>` | Main-agent JSON stream mode: `full` or `terminal`; implies `--json`. With `--agent` it is a usage error; use `--json`. |
| `--session <id>` | Append this turn to an existing session identified by `<id>`. |
| `--continue` | Append this turn to the most recent session for the current working directory. |
| `--fail-on-noop` | Exit 1 when the main-agent run was a no-op, and seal its receipt as `failed` with `outcomeDetail: "noop"`. Main agent only; with `--agent` it is a usage error. See [Headless No-op Runs](#headless-no-op-runs). |
| `--timeout <seconds>` | Wall-clock limit for the whole main-agent run, boot included. On expiry the run starts the coordinated shutdown a SIGTERM starts, seals its receipt with outcome `timed_out`, and exits 124. A positive number of seconds no greater than 2,147,483 (the timer ceiling in `src/core/timers.ts`); anything else is a usage error. Main agent only; with `--agent` it is a usage error. |
| `--agent <recipe-id>` | Dispatch a user-facing fleet agent instead of the main agent. Unknown ids and shadow agents (`oracle`, `provenance`, `researcher`, `scout`, `world-knowledge`) fail fast; for their read-only work use `--agent coder --read-only`. |
| `--skill <path>` | Make one explicit skill file or skill directory available for this run. Repeatable; the model loads its instructions with `context(scope="skills", name=...)`. |
| `--no-skills` | Disable skill discovery for this run and automatic skill/marketplace prompt guidance while still honoring explicit `--skill` paths. |
| `--turn-mode <mode>` | Main-agent workflow guidance (`answer`, `proposal`, `change`). Guides prompt and turn continuation (`answer` and `proposal` disable autonomous continuation turns; `proposal` renders `tasks` `plan`/`add` as blocked proposals). Not an authorization grant: mutating tools (`write`, `edit`) are not denied by `mode` alone; use `--allow-tools` to restrict execution. See [Turn Constraints](#turn-constraints). |
| `--no-delegate` | Forbid worker delegation (`dispatch`) for this run; the agent must work directly. |
| `--delegate-tools <names\|none>` | Comma-separated capability names the workers this run dispatches may hold, independent of `--allow-tools`; `none` gives them no tools. Main agent only; with `--agent` it is a usage error. |
| `--allow-tools <names\|none>` | Comma-separated allowlist of capability names permitted for this turn, or `none` to disable all tools. Enforces mechanical restriction at admission and runtime. |
| `--agent-profile <name>` | Use a named fleet profile for dispatch. |
| `--agent-runtime <id>` | Pick the first fleet profile whose target uses this runtime. |
| `--tool-profile <name>` | Restrict dispatched-agent tools: `minimal-local`, `science-local`, or `full-agent`. |
| `--require <capability>` | Require a target capability for dispatch. Repeatable. |
| `--steer-channel <path>` | Read live steering lines from a FIFO or an appended regular file to steer the active run. |

### Headless Prompt Assembly

The task is every non-flag argument joined with spaces. An argument that starts with `@` and has a path after it is a file reference, read relative to the working directory: text files are prepended to the task and image files travel as images. Piped stdin is read only when no task argument was given and is prepended the same way. An empty assembled task exits 2 with `clio-coder run: empty task`. A missing `@file` path or an unreadable file exits 2 before any model call.

A task that begins with `/` is checked before boot. A name that is neither a skill invocation nor a prompt template is refused with exit 2: interactive slash commands are `interactive commands are not supported by clio-coder run; use interactive chat or the corresponding CLI command`, and an unknown name is `/<name> is not a command. Type /help for the list.` A display-only prompt template is answered on stdout without booting a provider or calling a model. `\/text` sends text that begins with a slash.

### Headless Working Directory

`clio-coder run --cwd <dir> "<task>"` behaves the same as `cd <dir> && clio-coder run "<task>"`. The process enters `<dir>` before it reads layered project settings, context files, skills, `@file` references, or the session ledger, and every tool path resolves against it. Relative paths in other arguments, such as `--skill`, `--steer-channel`, and `@file`, resolve against `<dir>` as well. The path is canonicalized first, so the run ledger records the physical directory as the run's `cwd`.

Image `@file` references in a headless prompt or stdin require the routed model's image-input capability. Clio refuses the turn before sending the image when the route is text-only. The run exits nonzero and prints `IMAGE_INPUT_UNSUPPORTED` with the target and model. A turn refused before admission has no run receipt. When the fleet profile named `vision` (`fleet.profiles.vision`) is configured, that sidecar describes the image and the turn proceeds on the text route.

Inline image references accept PNG, JPEG, GIF, or WebP bytes detected by file signature. Clio attempts to resize them to at most 2,000 by 2,000 pixels and below 4.5 MiB of base64 before submission; an image that cannot fit is omitted with a note. There is currently no settings key to disable images or change this inline cap.

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

A mutating call is one the tool registry admitted with action class `write`, which `default` runs without asking inside write roots: `write`, `edit`, and an outward `web_fetch` (a method other than GET or HEAD, or any `body`) after its separate outward approval. A bodiless GET or HEAD `web_fetch` is read class: it runs without asking and does not count. A terminating result does not count. The `artifact` tool's plan, review, or report is the turn's answer written to a file, so a run whose every edit was blocked and that then wrote a report about it is still a no-op. A successful `bash` call does not count, because its `execute` class says that a command ran, not that it wrote. A run that called no tool and answered in prose is not a no-op.

A later successful substantive read or command can recover a block of the same
action class. Bookkeeping, discovery, and terminal reports do not count as that
recovery. A successful dispatch counts as a write only when its task worktree
was merged into this workspace; other dispatch work does not, so inspect worker
receipts when assessing delegated changes.

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
- A text-mode run prints the `No CLIO-CODER.md detected` bootstrap hint and the imported-context refresh hint to stderr only when stderr is a terminal. A `--json` run or a piped one prints neither, and neither prints the interactive project-instructions line.
- The session ID is discoverable via the `session` event when running under `--json` mode and on stderr via the `clio-coder run: session <id>` line in text mode. Standard output remains reserved for the assistant answer alone.

### JSON Event Streaming and Wire Projection Promise

When `--json` or `--json-events <mode>` (`full` | `terminal`) is passed, `clio-coder run` streams structured JSONL events.
- **Wire Projection Promise:** Content streams as increments without repeated growing snapshots; the final answer is also included on `turn_end` for scripts.
- Intermediate `message_update` events are dropped to prevent quadratic snapshot duplication over stdout.
- `text_delta` and `thinking_delta` events stream incremental text deltas rather than accumulating message snapshots.
- A `dispatch_scope_notice` event, `{type, code, level, message}`, reports a dispatch scope entry that did something its request did not say, such as a write root of `.` that sets no boundary, or narrow write roots that cost the worker its `bash` and `verify` because no OS sandbox enforces them. Text mode writes the same message to stderr. It is absent from `--json-events terminal`.
- `agent_end` events carry segment summary metrics (`messageCount` and a `usage` object containing `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `costUsd`, `apiCalls`, and `measured`) instead of duplicating the full message transcript.
- In `full` mode, `turn_end.message.content` preserves the final assistant text blocks, with `streamed: true` and `textLength`; thinking remains length-only. It drops `toolResults` array objects, each of which already crossed the wire in a preceding `tool_execution_end` event. In `terminal` mode, `turn_end` is synthesized and carries timing, `exitCode`, the final answer in `text`, and any `error`.
- `tool_execution_start`, `tool_execution_update` and `tool_execution_end` name the capability that ran. A `gateway` op=call carries the capability as `toolName`, the capability's own arguments as `args`, and `via: "gateway"`, so a consumer of direct calls reads it unchanged. A `gateway` chain keeps its own frames, and its `tool_execution_end` is followed by a `tool_execution_start` and `tool_execution_end` pair per settled step, each with `toolCallId` `<parent>:<step id>`, `parentToolCallId`, the step's capability, arguments, result and `isError`, and `via: "gateway"`. A step whose `$from` binding failed never ran: its start frame carries the step's requested arguments with references unresolved, and its end frame adds `bindingError`. Assistant `toolCall` blocks and `toolResult` messages keep the wire name `gateway`.

Example:

```bash
clio-coder run \
  "Find the test command and summarize the project structure." \
  --target local-lmstudio \
  --model qwen3.8-27b
```

### Turn Constraints

Headless runs can explicitly constrain one submitted turn and its continuations using host-enforced bounds ([turn-constraints.ts](../../src/core/turn-constraints.ts)). Turn constraints are never guessed from natural language or derived from model-generated arguments; they can only narrow existing safety, skill, and recipe policies.

- **Workflow mode (`--turn-mode <mode>`):** Selects workflow guidance (`answer` | `proposal` | `change`). Mode guides system prompt rendering and turn continuation discipline (`turnAllowsContinuation` disables autonomous continuation turns for both `answer` and `proposal`). Under `proposal`, tasks board `plan` and `add` actions automatically record `initialStatus: "blocked"` with a note awaiting operator authorization. **Important:** `mode` is prompt and workflow guidance, not an authorization boundary. `turnAllowsTool` ignores mode entirely; mutating tools such as `write` or `edit` are *not* denied by `--turn-mode proposal` alone. To mechanically restrict execution, pass an explicit capability allowlist (`--allow-tools read,grep,find,ls`).
- **Worker delegation (`--no-delegate`):** Sets `delegation: "forbidden"`. `turnAllowsTool` mechanically denies the `dispatch` tool, and prompt compilation instructs the model to work directly without spawning workers.
- **Capability allowlist (`--allow-tools <names|none>`):** Restricts executable tools to an explicit comma-separated list of capability names, or disables all tools when passed `none`. Mechanically enforced by `turnAllowsTool` and tool execution admission. Naming a secondary capability (such as `data` or `clio_docs`) automatically admits its gateway transport wrapper, while naming `gateway` alone never admits every capability behind it.
- **Skill discovery suppression (`--no-skills`):** Suppresses automatic skill discovery from catalog roots and marketplace guidance while still honoring explicitly specified skill paths (such as `--skill <path>`). Programmatic turn constraints can also set `skills: "disabled"`, which mechanically rejects `context(scope="skills")` calls at the tool boundary.

In prompt generation, turn constraints render as the final `# Current task scope` section of the system prompt ([compiler.ts](../../src/domains/prompts/compiler.ts)). Because they appear after identity, role, context, and memory, adjusting turn constraints between turns preserves the preceding `stablePrefix` for models with prefix caching.

## Interactive Slash Commands

Slash commands are available inside the TUI. Type `/` at the start of the prompt to open the grouped command palette autocomplete.

The registry table below lists every interactive slash command. On a bare `/`, commands are presented in groups (`Work`, `Inspect`, `Configure`, `Session`) with compact argument hints. Each operation has one canonical spelling; autocomplete, help, and parsing all read the same registry. The "Usage" column details expected arguments, with brackets `[]` indicating optional arguments and angle brackets `<>` indicating required arguments. `/compact` is a second name for `/context compact`. A command-shaped token that the registry does not claim (one word of letters, digits, hyphens or colons) is refused instead of reaching the model, and `/resources` and `/plugins` point to `/library` and `/extensions`. `/output` is not a command: it reports `/help`, `/settings interface` and `/view` as the places to look.

| Command | Usage | Purpose |
| --- | --- | --- |
| `/quit` | `/quit` | Exit Clio Coder |
| `/help` | `/help [query]` | Open the interactive help center showing commands and keys |
| `/skill` | `/skill <name> [task]` or `/skill off` | Invoke a skill or clear its active tool surface; `/skills` opens the browser. |
| `/background` | `/background` | Detach the newest eligible attached dispatch through its existing owner; no eligible dispatch gives an explanatory no-op. |
| `/interrupt` | `/interrupt <text>` | Settle the active run and send text through the interrupt owner; refusals keep its existing next-slot behavior. Missing text is correctable. |
| `/editor` | `/editor [text]` | Edit explicit text or an empty buffer externally; return to the composer for deliberate submission. Failure preserves the command for correction. |
| `/notifications` | `/notifications dismiss [all]` | Dismiss the oldest notice once, or explicitly dismiss all; this does not mute future notices. |
| `/library` | `/library [inspect \| install \| update \| enable \| disable \| remove <ref> [--user \| --project]] \| import <path-or-url> [--user \| --project] \| reload` | Open the full-screen Library with Skills, Agents, Prompts, Fleets and Plugins tabs. A named reference opens the browser on that row; `install`, `update`, `enable`, `disable`, `remove` and `import` show a reviewed plan first and write nothing until it is accepted. An accepted project-scope `install` into a workspace with no plugin state also approves the project's plugin state; `import` never does. `reload` refreshes installed recipe resources and reports `library: reloaded installed recipes (generation <N>)`. Alt+L opens the same browser. |
| `/skills` | `/skills` | Open the Library on Skills. |
| `/prompts` | `/prompts` | Open the Library on Prompts. |
| `/mcp` | `/mcp [list] \| /mcp trust <id> [class] \| /mcp untrust <id>` | List MCP servers or manage explicit trust for project MCP servers with optional action class |
| `/extensions` | `/extensions [reload]` | Inspect harness extensions (an unapproved project copy shows as `untrusted`) or reload their commands, hooks, operator UI and the workspace approval of project extensions |
| `/interop` | `/interop` | Inspect local coding agents, their ACP/headless/pane modes, and supported resource adoption. |
| `/share` | `/share [runId]` | Share a worker result with the main agent |
| `/archive` | `/archive export <path> \| /archive import [--dry-run] [--force] <path>` | Export or import a full Clio archive |
| `/run` | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] [--worktree] [--read-only] [--share] <agent> <task>` | Run a worker or configured headless peer; `--worktree` preserves an isolated task branch and `--read-only` denies writes. |
| `/delegate` | `/delegate [--read-only] [--share] <agent-id> <task>` | Run a configured ACP peer with a managed receipt; `--read-only` denies write permission requests. |
| `/peer` | `/peer [--cwd <workspace>] <claude-code\|codex\|opencode\|antigravity\|pi> [brief]` | Open an installed coding agent in an owned Herdr pane; no managed receipt. Needs the pane layer, see [Panes and the Files Pane](panes-and-files.md). |
| `/btw` | `/btw <question>` | Ask a side question that never enters the session transcript |
| `/draft` | `/draft [N] <request>` | Draft N answers in parallel (2-4, default 3). With the System One `drafts` site bound, a decision engine says which to read first. `Enter` on a finished draft puts it in the composer, unsent |
| `/oracle` | `/oracle <question>` | Ask a read-only advisor to challenge a question against this session's settled decisions |
| `/council` | `/council [--roster <name>] [--rounds <n>] [--synthesis <judge\|vote\|none>] <task>` | Ask a roster of read-only members the same task, with an optional vote or judge synthesis; `--rounds` takes an integer from 1 to 3 |
| `/agents` | `/agents` | Open the Library on Agents. |
| `/usage` | `/usage` | Show workspace activity, subscription quota, credits, and session token and cost totals |
| `/doctor` | `/doctor [deep]` | Show a diagnostic report with errors and warnings first and full wrapped check details; `deep` adds live tool probes on the session's targets and a validation-contract dry run at the session's autonomy. See [Doctor](doctor.md). |
| `/upgrade` | `/upgrade` | Recheck the release, review an eligible npm-global or installer replacement, and ask before changing the package. An installer install follows the channel it recorded, and a pinned install is left alone with the command that unpins it. User data is preserved; after success Clio asks you to exit and restart. A source checkout is told to update through git; other installation kinds receive manager-specific instructions. |
| `/context` | `/context [compact [instructions] \| recall <ref> \| recover <handoffId> <reduce\|deliver> \| init [--preview] [--heuristic] [--adopt] [--global\|--include-global] [--propose\|--apply\|--rewrite] [--depth quick\|standard\|deep] \| refresh \| reset [--yes] [--all]]` | Context hub: bare `/context` opens the context window overlay; subcommands compact, recall, recover a paused handoff, init, refresh, and reset. `reset` asks in a chooser; `--yes` and `--all` give the confirmation as flags for hosts without one |
| `/compact` | `/compact [instructions]` | Alias for `/context compact [instructions]`. Instructions bind the summarizer and are kept verbatim as an operator note, see [Context continuity](context-continuity.md) |
| `/fleet` | `/fleet [run [--var <key=value>] <name>]` | Open Fleet Runs, or run a fleet contract with an approval preview. Configure fleets with `/settings fleet`. |
| `/decisions` | `/decisions` | Show settled interview decisions and operator revisions |
| `/tasks` | `/tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] <text> \| /tasks hand <id> \| /tasks done <id> \| /tasks drop <id>` | Show the session board or manage project operator tasks |
| `/memory` | `/memory [seed]` | Inspect, promote, or seed task memory |
| `/view` | `/view [filter] \| /view verify <runId>` | Browse session artifacts (transcript, accountability, evidence, receipts, dispatch runs, task ledger, workspace, tool output, protected artifacts, compactions, prompt manifests, audit rows and the live system prompt) and verify a receipt. The providers live in `src/domains/session/view-artifacts.ts`; ACP clients read the same artifacts, see [ACP](../architecture/acp.md) |
| `/panes` | `/panes [show <run-or-agent> \| open <preset-or-argv> \| zoom [target] \| close [target]]` | Bare `/panes` prints the pane layer status, including each running dock and whether it is hidden. `show` takes the workers dock over for a live run, opening or showing it without moving the keyboard, `open` opens a utility pane (`files`, `logs`, `shell`, `files --once`, or a command; a second open focuses the pane already there), `zoom` toggles zoom (default: the watch pane) and `close` closes one Clio-owned pane or, with no target, all of them. See [Panes and the Files Pane](panes-and-files.md) |
| `/files` | `/files [open\|hide\|close\|pick]` | Show or hide the files pane docked below the session, with the keyboard moving into it on a show. `open` opens, shows or focuses it, `hide` parks it with Yazi still running, `close` ends Yazi, and `pick` borrows it for one selection. Picks land in the composer as `@` mentions. See [Panes and the Files Pane](panes-and-files.md) |
| `/music` | `/music [on\|off\|pause\|next\|status\|station <name or url>]` | Bare `/music` does what `Alt+A` does: it opens the focus-radio pane and plays, shows a hidden pane, or hides a visible one. `on` plays, `pause` silences and keeps the pane, and `off` stops and closes it. The pane drives cliamp in a Herdr dock. It needs the pane layer and `integrations.music.enabled`, which is off by default. See [Music](music.md) |
| `/thinking` | `/thinking [level]` | Set the chat thinking level; bare `/thinking` opens a picker of the levels this route supports |
| `/model` | `/model [pattern]` | Open model selector or set a model |
| `/config` | `/config` | Run the configure flow inside the TUI and apply the routing it saves to this session. Takes no arguments. See [Running setup with /config](#running-setup-with-config) |
| `/settings` | `/settings [area]` | Open the settings center, optionally at an area: `recent`, `targets`, `models`, `chat`, `agents`, `fleet`, `context`, `workspace`, `safety`, `interface`, `integrations`, `advanced`, or an alias such as `connections`, `appearance` or `panes`. `/settings chat model-picker` and `/settings models model-picker` open Models & Inference at its scope row; any other second word is accepted and ignored. An unknown area is a usage error |
| `/resume` | `/resume [id\|prefix]` | Resume a past session on the route it last ran on. With an exact id or a unique id prefix it resumes directly; otherwise it opens the picker. The picker hides sessions with no model turn and gives each session a separate metadata row with status, age, turn count, folder and route; replay restores recorded turn durations. See [Resuming sessions](#resuming-sessions) |
| `/new` | `/new` | Start a fresh session. While a run is active it cancels the run first and returns queued follow-ups to the editor |
| `/handoff` | `/handoff <goal>` | Hand this session's working state to a fresh session for a stated goal |
| `/tree` | `/tree` | Open session tree navigator. Press `p` to filter by current cwd, `s` to cycle tree order or most recent first, `e` to label the selected entry, and `Shift+T` to toggle timestamps. |
| `/fork` | `/fork` | Fork from an assistant turn |
| `/export` | `/export [path]` | Export a self-contained HTML transcript by default; a `.md` path writes Markdown |

The `/model` selector marks image-capable rows with `V` and spells out `image input yes` or `image input no` in the selected row's details. A completed `/model <pattern>` switch includes the same image-input state in its notice. The expanded dashboard's session capabilities always say `images yes` or `images no` for the active route. These states use the resolved deployment capability.

When a session with earlier images moves to a text-only model, the next turn shows a warning. Clio replaces each historical image block with an explicit omission note in that model's request. The saved session keeps the original blocks, so switching back to a vision-capable model can use them again.

### Subscription quota and session usage

`/usage` shows this session's token and cost accounting beside what the
connected subscription accounts report. There is no `/cost` command. It is a
live view of this session and of your accounts right now; `clio-coder usage
report` is the separate command for folding token and cost facts across past
sessions.

| View | What it shows |
| --- | --- |
| Activity | A heatmap of this workspace's recent session activity, git changes, session cost and tokens with elapsed time, and the first reported subscription window |
| Accounts | Subscription and credit meters, every reported model group, remaining capacity, reset countdowns and local reset times with an explicit time zone, and stale or expired readings |
| Session | Recorded token and cost totals, cache traffic, reasoning, and the background-call categories (side questions, handoffs, pre-warms, memory steps) |
| Models | Each model's share of recorded processed tokens, including cache traffic, plus its detailed token and cost breakdown |
| Workers | Active and recent runs, recorded tokens and cost, context usage, and the shared account limit when the local credential owner is known |

Press 1–5, Tab/Shift+Tab, or ←/→ to change views; ↑/↓ or PgUp/PgDn to scroll;
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

- The **welcome launchpad** carries an `AI usage · used` section beside the wordmark with an `Accounts` field, or `No usage data` when no account reported. It reserves two rows from the first paint; a longer summary ends in `… /usage`.
- The **compact footer** has two lines. Line 1 carries the working directory, the Git branch with a dirty marker, the context counter and tokens per second. Line 2 carries one notice, tip, hint or urgent prompt on the left and, on the right, the active worker count, active skills and the selected model's weekly headroom. The weekly figure appears only when the account and model group are identifiable, and the footer never promotes an unrelated account's busier window in place of the selected model's.
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
| `/model` and `/thinking` | Choose a route for this session or save it as a default. Cancel leaves the active route unchanged. See [routing defaults](configuration-and-targets.md). |
| `/btw` and `/draft` | Run side questions or candidate answers without tools or transcript changes. Calls still count in `/usage`. Candidates differ by sampling temperature, or by prompt angle for models that refuse a sampler, with one retry without `temperature` on an `Unsupported parameter: temperature` rejection. Bind `systemOne.sites.drafts` for a judged pick. In `/draft`, `Enter` on a finished draft closes the overlay and appends its text to the composer below anything already typed, never sending it, and `Esc` closes without taking anything. |
| `/council` | Runs a roster declared under `fleet.rosters` of two to five read-only members: the roster named `default`, or the one `--roster` names. With no `--roster` and no `default` roster, the notice points at `fleet.rosters` in `settings.yaml`. Approval is shown before work starts; share the synthesis or an individual member explicitly with `/share <runId>`. |
| `/run` and `/delegate` | Start a worker or ACP peer with a managed receipt. Its answer is separate from main-agent context until shared with `--share` or `/share`. |
| `/handoff <goal>` | Review a bounded handoff document, then accept it to create a fresh session. The goal must describe a concrete continuation. |
| `/context` | Bare command opens the context ledger. Subcommands compact or recall session content and manage project context; see [Project context](#project-context). |
| `/tasks` | Inspect session tasks and the durable project task inbox. ↑/↓ select a row, Tab and Shift+Tab jump between sections, and a board taller than the dock scrolls to keep the selection in view, pages with PgUp/PgDn, and shows its position. `a` adds an operator task; `h`, `d` and `x` hand, finish or drop the selected one. Acceptance checks travel with handed tasks; receipts show whether they passed. |
| Unknown slash command | Rejected before model submission. Use `\/text` to send text that begins with a slash. The command list is [above](#interactive-slash-commands). |

The command spellings and arguments are the [slash-command registry](../../src/interactive/slash-commands.ts); this table calls out only session workflows that need explanation.

### Resuming sessions

`/resume` opens the session picker. `/resume <id|prefix>` skips it: an exact session id wins, and otherwise a prefix that names exactly one session resumes that session directly. When the text matches no session, or several, Clio warns (`no session matches <text>` or `<text> matches <n> sessions`) and opens the picker with the text as its filter. The command runs only while no overlay is open.

The direct path and the picker share one switch. Any in-flight chat settles first, the transcript is replayed along the session's active branch (a `/tree` pin wins over the newest turn), the footer and `/usage` totals are rebuilt from that branch, and the session continues on the route it last recorded. When the recorded working directory is missing or unusable, a working-directory fallback dialog offers to continue in the current directory or to cancel, which restores the previous session (or reopens the picker when there was none).

The command line has no resume flag. `clio-coder --resume`, `--continue`, `-r` and `-c` before any subcommand fail with exit 2 and an error that names `/resume` (#191), and `clio-coder run --resume` is an unknown run option. Start `clio-coder`, then type `/resume`. A headless turn appends to an earlier session with `clio-coder run --session <id>` or `--continue` (see [Headless Session Continuity](#headless-session-continuity)), and `clio-coder upgrade --restart` relaunches the CLI so `/resume` can pick up the last session. A clean exit prints the exact `/resume <id>` line (see [Exit summary](#exit-summary)).

### Running setup with /config

`/config` runs the same flow as `clio-coder configure` without leaving the session. Clio hands the terminal to the configure flow through an asynchronous terminal suspension, restores the TUI when it ends, and reports one notice: `Setup saved. Active route: <target>/<model>.` or `No changes saved.` Only the routing delta that setup saved (the chat route, the memory route, the fleet default and the model-picker cycle set) supersedes this session's route, and it applies live without a restart. A flow cancelled with Ctrl+C (exit 130) raises no error; any other failure reports `Setup failed: Configure could not complete.`

`/config` refuses to start while a turn is running (`A turn is running. Press Esc first, then run /config.`) and needs an interactive terminal. It takes no arguments. `/settings` stays the settings center: it edits individual values in place and never leaves the TUI. Both reach target setup, and `/settings targets` runs the add and edit wizard in the composer dock.


## Keybindings

Clio has twelve direct application defaults and the `Ctrl+G` leader. `/help` shows the effective keys,
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
| `Alt+W` | Workers dock in a `--with-panes` session (first tap opens or shows it and moves the keyboard in, a tap on a visible dock parks it, a second tap within 400 ms closes it); the Fleet Runs board without a pane host | `w` |
| `Alt+E` | Show or hide the files pane (first tap), close it (second tap within 400 ms); bound inside Yazi too | `e` |
| `Alt+A` | Show or hide the music pane (first tap), close it (second tap within 400 ms); bound inside cliamp too | `a` |
| `Shift+Tab` | Cycle supported thinking effort for this session only | `t` |
| `Alt+S` | Send now: interrupt the run with the draft, or flush the queue when the draft is empty; ordinary send while idle | `i` |
| `Alt+K` | Open the queue navigator over the queued messages | `n` |
| `Alt+Q` | Restore both queue kinds before the current draft, once | `q` |
| `Ctrl+D` | Delete forward with text; exit only empty and idle with no queued messages | — |
| `Ctrl+G` | Open or close the contextual action menu | — |

`Alt+E` and `Alt+A` drive Herdr docks that hide instead of close; [Panes and the Files Pane](panes-and-files.md#showing-hiding-and-closing-docks) specifies the shared tap model. `Alt+W` is the workers dock key in a pane-host session and is covered in [Fleet Dispatch](fleet-dispatch.md).

Additional menu entries: `y` toggles default and yolo autonomy for this session, `i` interrupts with the draft, `s` backgrounds the newest
eligible attached dispatch, `g` edits the expanded draft externally, `x` dismisses
one notification, `z` undoes the focused editable field, `r` toggles transcript
search, `p` pages the transcript up and Home/End jump to its bounds (the page-down entry also lists `n`, but the queue navigator claims that suffix first, so pick page down with Up/Down and Enter). Previous/next
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

**Mouse wheel with an overlay open.** In fullscreen, a wheel event while any overlay is open scrolls the transcript (one line per notch, five with Alt held) and never moves a list choice. Choices move on keys only (`src/engine/application-input-tui.ts`). An interview (an `ask_user` round) also turns off mouse tracking and alternate-scroll mode 1007 while it is visible, so the terminal selects and copies text natively and does not turn the wheel into arrow keys that would move the interview's choice. Mode 1007 and mouse tracking return when the interview closes or is hidden (`src/engine/instrumented-tui.ts`).

Bracketed paste is literal and never submits, executes a slash or shell command,
or confirms a modal. Submission needs a later deliberate key. External editing
receives expanded paste text and preserves the draft on failure; returned text
and recovered queues retain literal bang provenance. Input arriving during an
asynchronous send expansion remains in the composer. Explicit release events
are ignored before application or viewport actions. Repeats may edit, navigate
or scroll; they cannot repeat send, toggle, cycle, confirmation, cancel or exit.
Legacy streams cannot distinguish every held-key repeat.

**Overrides.** Keep overrides in `interface.keybindings`; a top-level `keybindings`
map is a retired settings-v1 path that `clio-coder upgrade` moves. An explicit `[]` disables both direct access
and the action's default leader entry. A default-unbound action may still have a
leader entry. Rebinding a direct key does not change its fixed suffix, and
`leader: []` disables the menu. Unknown action IDs and effective conflicts produce
a diagnostic; shipped fullscreen viewport keys that intentionally shadow unchanged
editor defaults carry no conflict tag, while user rebindings can still conflict.
Edits reload routing, components and hints together and cancel a pending menu, and
no preferences are rewritten. Send now has the direct key Alt+S, the queue
navigator Alt+K, and queue recovery Alt+Q; Alt+B and Alt+D edit. The action
`clio-coder.message.followUp` (Ctrl+Q) does not exist: a keybindings file that names
it gets a diagnostic that points to the navigator's `t` toggle, which sets the
end-of-turn slot. Infrequent boards use their slash commands, and background,
external editor and dismiss use the menu or command bridges.

**Terminal delivery.** On stock macOS Terminal.app, Option may compose text;
the Ctrl+G menu works without changing that setting. A temporary profile with
Use Option as Meta enabled permits direct Alt keys. Windows Terminal/WSL2 can
retain native Alt+Enter, Alt+arrow, clipboard, Find and zoom controls. Ctrl+J
is the portable newline. Node raw mode normally disables flow control and
signal generation; an SSH/mux or terminal UI can still intercept keys, so menu
`i` is available if Alt+S does not arrive. Native clipboard and terminal window
controls remain upstream. Clio does not own keys while Yazi, an external editor
or the host mux holds focus. Physical Windows/macOS acceptance is separate from
Linux PTY and protocol tests; no terminal profile is installed automatically.

### What Ctrl+C does

`Ctrl+C` is not a single action. It resolves against the current input boundary,
first match wins (`resolveApplicationCtrlCAction`, [application-controller.ts](../../src/interactive/application-controller.ts)):

| State | What Ctrl+C does |
| --- | --- |
| An overlay owns input (transcript search, Library, Settings, model picker) | Closes that overlay. It does not cancel a running turn and does not exit. Any armed shutdown is disarmed. |
| A permission card | Denies the parked call, as `Esc` does. It does not cancel the running turn and does not exit. |
| Streaming or running a tool | Cancels the in-flight run. The turn seals its partial output in ledger order and the session stays open. |
| Idle with text in the composer | Clears the draft. The press is consumed as an editor action, so it cannot become the hidden first half of an exit. |
| Idle with messages queued | Protects the queue and says how to recover it with the bound dequeue key (`Alt+Q` by default). |
| Idle, empty composer, nothing queued | Arms shutdown. A second `Ctrl+C` within 1,200 ms (`APPLICATION_DOUBLE_TAP_MS`) exits. |

In a permission card, `Esc` denies the one parked call and `Alt+X` stops the turn, because denying one call does not stop the model from asking again. Letters typed while a card is open go to the composer, never to the card. Denying a permission card is a decision, not a dismissal:
the parked call is cancelled with `User denied this call at the permission
prompt. It will not run; no approval is pending.` (`User denied this call and
stopped the turn. The turn is over.` after `Alt+X`), and a parked *worker*
permission resolves as `deny`. The session itself keeps running.

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

## Exit summary

A clean interactive exit prints a session summary on stdout after the TUI has stopped and the terminal is restored. `interface.exitSummary` picks the style: `full` (the default), `brief` or `off`. Change it under Settings → Appearance → Transcript → Session summary on exit or with `clio-coder configure --section interface`. The setting reloads hot, so the next exit uses the saved value.

**When it prints.** The summary runs on the application's own shutdown path: `/quit`, `Ctrl+D` on an empty idle composer, and the idle double `Ctrl+C`. It is skipped in these cases:

- A teardown step failed. The failure is reported and no summary follows.
- A signal such as SIGTERM ended the process. Signals go straight to the termination coordinator.
- The visit had no model activity: no assistant message finished, no tool call started, no worker was dispatched, and the session did not already hold a model turn. Nothing prints, even with `off`.
- The run was headless (`clio-coder run`) or an ACP session. Only the interactive session keeps the snapshot.

**What "this visit" means.** The collector in `src/interactive/exit-summary-collector.ts` folds events as they arrive, so exit does no ledger reads, file work or provider calls. It starts when the interactive session starts and resets on `/new`. Turns count across sessions you resumed or parked during the visit. Usage and cost come from the observability session ledger. Wall time is measured from the start of the visit.

**What it contains.** `src/interactive/exit-summary.ts` formats the snapshot and is pure.

| Style | Rows |
| --- | --- |
| `off` | One line: `To resume: clio-coder, then /resume <session id>`. |
| `brief` | `Session` (the session name, else its id), one `Model` row per `target / model` used, `Total tokens`, `Total cost` and the resume line. |
| `full` | Everything in `brief`, plus `Wall time`, `Model active`, `Turns`; per model `Requested` (ids the request named when they differ), `Tokens` and `Cost`, or `Usage: not reported; cost unknown`; `Tool calls` (per tool, main agent and workers together, sorted by name); `Files changed (observed)` with the first 8 paths and `N more`; `Workers dispatched` with the first 8 as `agent · outcome · runId` and `N more`; and `Compactions`. |

Tokens are printed as input, output, cache read, cache write and reasoning counts. `Model active` is the summed model-call time; when some API calls carried no timing it reads `<time> observed; some calls unmeasured`. Changed files are the paths that successful mutating tool calls and worker receipts reported, relative to the working directory when inside it. A command's side effects that no receipt names are not listed, which is why the row says observed.

Cost reads `$0.00 (free)` when every call was known free, `<amount> (known)` when every price came from a declared rate, a bare amount when it includes estimates, `<amount> (unknown pricing in total)` or `unknown` when some calls had no price, and `unknown (not measured)` when nothing was measured. On a terminal the block is a themed frame headed `Clio Coder · Session summary` with `this visit` on its right edge. On a pipe it is plain lines starting `Clio Coder · Session summary · this visit`, with no color, frame or wrapping.

## Live Steering

While a run is active, a message you submit waits in Clio's own steering
queue, shown in the Steering Queue panel above the composer, until the engine
reaches a slot. Every queued message bound for that slot is handed over
together, in the order you typed them, and lands before one model call as
separate user messages. There are three modes, chosen per message; the default
is next slot.

| Mode | Key | Delivery |
| --- | --- | --- |
| Next slot | `Enter` | Between tool batches, mid-run. The agent keeps going and reads every queued message before its next model call. A message typed during the run's final model call is handed over at the end of that call, so the run carries on with it instead of ending. |
| End of turn | `t` on the entry in the queue navigator, or ACP mode `end-of-turn` | When the whole run settles and Clio would hand control back. A turn is the whole run, not one model round. |
| Send now | `Alt+S`, `Ctrl+G` `i` or `/interrupt <text>` | Cancels the in-flight work the way `Esc` does (generation aborts; a running bash child gets SIGTERM, then SIGKILL), waits for the cancelled run to seal its tool results in ledger order, then submits the draft as a fresh prompt. Anything already queued stays queued and lands at the new run's first slot. With an empty draft, Alt+S flushes the queue: the first entry is the prompt and the rest land with its first model call. While a tool call is running, Alt+S asks whether to stop it or to send after it finishes; waiting queues the message ahead of everything else. |

### The queue navigator

`Alt+K` opens the queued messages as a list. `Up`/`Down` select, `Shift+Up`/
`Shift+Down` move an entry, `e` takes it back to the editor, `x` removes it,
`t` flips it between the next slot and the end of the turn, `Enter` sends the
selected entry now and keeps the rest queued, and the restore key (`Alt+Q`)
puts everything back in the editor. The panel shows each entry's slot word,
how long it has waited, and advisory marks: `!` when a reading found it urgent,
`·t` when steering triage relabeled it. Steering triage is experimental and
off by default (`chat.steering.triage`): when on, a side model reads the queue
once it has settled, moves an unrelated task to the end of the turn unless you
set its slot yourself, and may interrupt the run on a confident stop.

### The same three modes against a background worker

The table above describes the main agent. Against a dispatched worker the three
modes are not symmetric:

- **Steer** reaches a worker. `@<agent> <text>` sends the message across the
  worker channel; the worker acknowledges it and keeps running.
- **End of turn** does not. A worker has no follow-up queue, so a new goal for
  it is a new dispatch.
- **Send now** is refused while an attached dispatch is running, for the reason
  given below. Cancel the worker itself with `Esc`, which stops the run and
  still leaves a receipt.

Send now is refused in two states and the message is queued at the head of the
queue for the next slot instead, with a notice saying why: while an attached
dispatch is running (the abort would kill the worker's run with no receipt;
steer it with `@<agent>` or cancel it with `Esc`) and while a permission ask is
parked (it is already waiting on you). A message that arrives only after the
run's final turn has settled is resubmitted as a fresh prompt, each queued
entry as its own message. Headless `--steer-channel` lines are always next-slot
steers.

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

The Fleet Runs board (`/fleet`, `←` on an empty composer, or `Alt+W` without a pane host) makes this control path discoverable: use
Up/Down or `j`/`k` to select a run, `s` to close the board and prefill its
exact `@<runId> ` steering prefix, and `x` to cancel a live worker or queued
retry. At narrow widths, the footer prioritizes available steer/cancel actions over navigation and detail hints; Enter still expands the selected card. Completed runs offer no steer/cancel actions. A steer first reports `queued`; only the worker's
`clio_coder_steer_received` acknowledgement reports `received`. Single-shot
subprocess runtimes and ACP delegation do not expose a live steering channel
and are labeled accordingly.

## Operating Posture and Autonomy

The settings UI offers **default** for supervised workspace edits and **yolo** for work that should proceed without ordinary confirmation prompts. Hard blocks and damage-control asks remain active at both levels. `--turn-mode proposal` is workflow guidance, not a read-only permission boundary; use `--allow-tools` when execution must be restricted. An interactive session can preview a Clio settings change with `configure_clio`; `default` requests the host's Apply choice and cannot raise autonomy, while `yolo` applies the exact preview directly, except that edits to `fleet.default`, `fleet.profiles` and `fleet.agentProfiles` ask the operator at every autonomy level. See the [settings reference](configuration-reference.md), [safety model](../architecture/safety-model.md), [Bash policy](tool-usage.md), and [information flow](information-flow.md) for source labels and approved destinations.

## Dispatch and Built-In Agents

Use `clio-coder agents` to inspect the installed agent catalog and `clio-coder run --agent <id> "<task>"` for a non-interactive dispatch. In the TUI, `/run` starts a fleet worker or a configured headless coding peer, `/delegate` starts a configured ACP peer, and `/peer` opens an interactive handoff pane. Fleet profiles determine target, model, and limits; worker execution and receipts are covered by [Fleet dispatch](fleet-dispatch.md). Agent ids and recipe contracts are maintained in [Built-in agents](built-in-agents.md). See [Coding Agent Interoperability](interop.md) for peer setup and workspace choices.

## Environment Variables

Clio-specific and ambient variables are listed in the [environment variable reference](environment-variables.md).

## Project Context

`CLIO-CODER.md` is the project guidance file. Context operations are exposed through `clio-coder context` and `/context`; the maintained architecture and lifecycle details live in [Context continuity](context-continuity.md) and the [context engine](../architecture/context-engine.md).

### Codemap index

`clio-coder context index` builds the structural codemap and bounded orientation without model calls. `context map` derives an architecture map from that index. Pinned source citations require a clean repository and matching indexed bytes; dirty or unknown source state falls back to uncited seeds.

### Working-set replay

`clio-coder context replay --sessions <path>...` replays saved ledgers; `--synthetic <ids>` adds deterministic procedural traces. `--json` writes a stable report, and `--md <file>` writes Markdown. `clio-coder context working-set --session <id|path>` inspects eviction, recall, and path observations for one session. These are read-only; replay-specific policy overrides never write settings. See [working-set design](../architecture/context-working-set.md).

### Markdown wiki commands

`clio-coder context wiki` creates the optional model-authored wiki through the wiki-writer agent. `--status` is read-only; `--update` refreshes stale pages; `--retry-pending` retries pending pages. `clio-coder context refresh` rebuilds only the structural index; `context refresh --wiki` also updates an existing wiki and does not create the first one.

### code_nav modes

The read-only `code_nav` tool queries the local index. Its modes and argument schema are in [Tool usage](tool-usage.md).


## Output styles

**Alt+O** cycles **Compact → Standard → Detailed → Compact**. Standard is the default, so the first press reveals Detailed. The current style appears in the footer. Cycling applies immediately to the current session, including streaming output and history. Save a preferred startup style through **/settings chat → Replies → Output style → Apply and save globally**, or `clio-coder configure --section interface`.

| Content | Compact | Standard | Detailed |
| --- | --- | --- | --- |
| Answers and user messages | Complete | Complete | Complete |
| Supplied reasoning | Marker | 3 rows | 12 rows |
| Reads and searches | Consecutive successful observations grouped | Action and outcome | 8 result rows |
| File changes | Paths and change facts | 8 diff rows | 20 diff rows |
| Agent shell commands | Command and outcome | 3 output rows | 12 output rows |
| Your `!` / `!!` shell commands | 3 output rows | 6 output rows | 12 output rows |
| Workers | Identity, execution and validation outcome | 3 summary rows | 8 summary rows and bounded tool activity |
| Failures and refusals | Actionable reason, up to 4 rows | Actionable reason, up to 4 rows | Up to 12 rows |
| Turn receipt | None | Completion and available duration | Usage and model-call facts |

Preview budgets count terminal rows **after wrapping**, including the `/view` overflow hint, and shrink on short terminals. Reasoning previews retain the newest text when streaming stops. Detailed remains bounded: a successful `cat` or file read cannot fill the transcript with the entire file.

Use **/view transcript** to select full available reasoning, tool arguments/results, local shell output, or worker details. Search the list, press Enter to inspect, and Escape to return. Offloaded tool and dispatch output remains available in the other `/view` categories; missing or truncated captured content is identified. Inspection applies secret redaction, and `!!` output remains excluded from model context.

Output style changes presentation only. **Shift+Tab** changes the model's thinking effort and does not reveal unavailable reasoning; Clio shows only reasoning supplied by the provider. There are no separate reasoning-expand or tool-expand shortcuts, and `/output` is not a command (it answers with how to reach Alt+O and Settings). A saved `minimal`, `default` or `verbose` value reads as `compact`, `standard` or `detailed` without rewriting the file. How each segment of the reply renders is in [TUI design](../architecture/tui-design.md).

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

Task-board guidance and ordinary continuation preserve proposal-only scope. Deferred implementation should be blocked or dropped while awaiting an explicit operator go-ahead. A skill-install decision is separate from implementation authorization, and yolo authority does not expand the task. Task guidance is included in the model prompt; tool admission independently applies the configured policy.

## Library packages

Use `/library`, `/skills`, `/agents`, and `/prompts` to browse resources. `/skill <name>` activates a loaded skill; `/interop` reviews external coding-agent peers; `/extensions` manages harness extensions. See [Resource library](resource-library.md), [Interop](interop.md), and [Extensions and sharing](extensions-and-sharing.md).

With an empty composer, press `?` for the docked key card, `←` for Fleet Runs, or `↓` for Tasks. The next key closes the key card without taking another action. With a draft, `?` inserts text and the arrows move the cursor.

`/usage` opens the docked Activity tab with workspace session history and current consumption. Its five tabs are Activity (`1`), Accounts (`2`), Session (`3`), Models (`4`) and Workers (`5`). Use Tab to switch tabs and PgUp/PgDn, Home or End to read a long tab.

Live Fleet runs reserve a section just above the composer. This summary never covers transcript text and disappears when no run is live. Open Fleet Runs with the configured shortcut or `←` on an empty composer to inspect additional runs.

Open `/settings targets` to add or edit targets inside the TUI. Choose **Add target**, or select a target and choose **Edit URL, runtime and default model**. The shared configure wizard stays in the composer dock. Use arrows to select, type to edit or filter a model list, Enter to continue, Esc to go back, and Ctrl+C to cancel setup. Target settings remain a draft until **Save target**, which writes global settings; credentials are stored when browser sign-in succeeds. Editing a target preserves explicit chat, fleet and memory model defaults.

At the default Clio directories, authenticated sibling CLIs remain connected accounts even without a Clio target. When any resolved Clio directory differs from its platform/XDG default, sibling quota adapters are excluded unless their own home is explicitly set: `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude Code, or `ANTIGRAVITY_HOME` for agy. Those directories contain `auth.json`, `.credentials.json`, and `antigravity-oauth-token`, respectively. Excluded adapters read no credentials, make no requests, and display no cached account rows. Clio-owned Anthropic Max credentials remain available in relocated homes.

The Local AI `$0.00` quota row is shown only when settings contain a target whose registered runtime tier is `local-native`. A cloud-only configuration has no local-cost row.
