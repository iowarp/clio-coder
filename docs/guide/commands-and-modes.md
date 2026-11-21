# Commands and Modes

This guide covers the installed CLI, headless run behavior, interactive commands, keyboard controls, and operator workflows. The command registry and parser are authoritative: the [CLI command table](../../src/cli/index.ts), [startup flags](../../src/cli/argv.ts), [run arguments](../../src/cli/args.ts), the [slash-command registry](../../src/session-control/slash-commands.ts), and the [keybinding manager](../../src/interactive/keybinding-manager.ts). Exit codes and stdout guarantees are in [Exit codes and output](exit-codes-and-output.md). The TUI's layout, theme and rendering contracts are in [TUI design](../architecture/tui-design.md).

## Demo presentation and guidance

Demo presentation and guidance are on by default before 1.0 and follow output detail. Minimal opens with an identity header. Default shows a compact launchpad with the route, autonomy, project awareness and next action; Detailed adds artwork, project facts and shortcut hints. Detailed reserves two subscription rows from the first paint; longer account summaries end in an ellipsis and `/usage`. With `--no-demo` or `interface.demo: false`, both the instant shell and hydrated TUI use the identity header and skip welcome-only reads and learning tips. Immediate controls, work status and approval text remain visible. Stream pacing and motion preferences are independent. Dumb/unknown terminals and screen-reader mode also use the identity header.

After a turn, CLIO Coder may show one fading footer line beginning `tip: ...` that fits what the turn did: a question about CLIO Coder's own settings, a side question that `/btw` would keep out of the transcript, a correction that `/tree` could rewind, a long answer that another output style would fold, a question about spend (`/usage`), a broken install or login (`/doctor`), installing a skill, agent or plugin (the Library key, or `/library`), a turn where you approved two stops yourself (the autonomy key for YOLO), a long investigation that changed nothing (`/run coder --read-only`), or a long turn a worker could have carried (`/run coder`). The harness picks the tip. The model never sees it, and no model call is made. A newcomer, who has seen fewer than six lessons, gets up to two tips a session; after that, one. A tip retires once you use its feature yourself or it has been shown twice. The first tip ever says how to turn tips off.

While the composer is idle, the footer teaches one key at a time, the first unlearned lesson that fits its width (such as `?` for the key card). The hint holds until you press its key, and then the next one takes its place. A slash command that has a key (such as `/model`) earns one tip naming that key (`Alt+M`) until you press it; see [Keybindings](#keybindings). Before the first prompt, a launchpad without its own hint column shows one welcome tip (ask CLIO Coder how it works, `?`, the action menu, `/help`). Each idle footer tip retires after three sessions. `/help` → Topics → learning clio & tips summarizes all of this.

Guidance keeps a small profile in the state directory (`harness-profile.json`): the tips shown, the features and keys you used, and the topics you asked about. It stays on this machine and never enters a prompt.

Turn it off under Settings → Chat and display → Demo presentation and guidance (`interface.demo`), or for one invocation with `--no-demo`. Off means no tips, no idle footer tips or learning key hints, no demo prompt line, and no profile reads or writes. Guidance adds hints only; it does not grant tool authority. Headless runs, ACP sessions and workers do not receive it.

## CLI Commands

The table uses three distinct surfaces, which the registry in
[index.ts](../../src/cli/index.ts) also enforces:

| Surface | Meaning |
| --- | --- |
| Public | Operator-facing commands named by normal `clio-coder --help`. |
| Developer | `clio-coder dev <name>` is the only form of the developer instruments (`components`, `evolve`, `flywheel`). CLIO Coder keeps no alias spellings: a bare dev name, `ext`, `export`, `import`, `targets workers` and `targets worker` are unknown commands. |
| Internal / retired | `worker` is an internal stdin/NDJSON host used by placement, and `setup --next` is an installer handoff. They are intentionally absent from normal help and are not operator workflows. `context-init`, `context-index` and `context-clear` are unknown subcommands. |

| Command | Purpose |
| --- | --- |
| `clio-coder` | Launch the interactive terminal UI. |
| `clio-coder run "<task>" [flags]`, `clio-coder run [flags] -` | Run one headless main-agent turn. `--output-format json` prints one result document and `--output-format stream-json` prints JSONL events that end with it. Everything after `--` is task text, even text that starts with `-`. Stdin is read only with `-`. See [Headless Run Flags](#headless-run-flags). |
| `clio-coder run "<task>" --agent <id> [flags]` | Dispatch one explicit fleet agent non-interactively. The finished run settles and seals in its telemetry run scope. |
| `clio-coder acp [--cwd PATH] [--permission-timeout MS] [--autonomy LEVEL] [--allow-tools NAMES] [--deny-tools NAMES] [--delegate-tools NAMES] [--read-only]` | Serve CLIO Coder as an ACP v1 agent over stdio for ACP frontends. `--permission-timeout` overrides `integrations.externalAgents.defaults.permissionTimeoutMs`, the server's default bound on a mediated permission request, and a client's negotiated `timeoutMs` never overrides it. `--autonomy default` caps every hosted session at `default`, so a client's choice of `yolo` is refused; the flag lowers the configured level and never raises it. `--read-only` applies the mediated ACP read-only ceiling; see [Read-only runs](../architecture/safety-model.md#read-only-runs) for the external-process boundary. |
| `clio-coder acp [--cwd PATH] auth login` | Open interactive Quick Connect when an ACP client offers terminal authentication. |
| `clio-coder --version` / `-v` | Print the installed version. Only before a subcommand and before `--`. After a subcommand the token belongs to that command, so `clio-coder paths -v` is refused as an unknown flag and `clio-coder run -- -v` treats it as prompt text. `clio-coder -- -v` starts an interactive session. `clio-coder version` is the subcommand form. A running CLIO Coder names the same build in its process title, `clio-coder <version>@<commit>` (for example `clio-coder 0.8.0-dev@67b3247`, `-dirty` when built from a modified tree, no `@` part when the bundle records no commit), which `ps -o args=` and `/proc/<pid>/cmdline` show, so a session's build can be checked from outside it. The title cannot be longer than the command line the process started with, so a very short launch command shows it cut; the installed `clio-coder` command and an absolute `dist/cli/index.js` path leave room for it. Workers keep their own `clio-coder-worker` title. |
| `clio-coder --help [--all]` / `-h` | Print the grouped command page. `--all` appends every command path, the `clio-coder dev` commands included. |
| `clio-coder help [<command> [<subcommand>...]]`, `clio-coder help --json [<command>...]`, `clio-coder help run --topics` | Print one command's help. `--json` prints the command manifest as one JSON document (`version: 1`): every command leaf with its flags, value choices, stdin use, effects and exit codes. `help run --topics` prints the long-form notes for `run`. |
| `clio-coder schema <name>` | Print the shipped JSON Schema (draft 2020-12) of one machine-readable document: `run-result`, `run-events`, `task`, `help` or `fleet-result`. An unknown name exits 1. |
| `clio-coder --demo` / `clio-coder --no-demo` | Start the interactive session with the full welcome and guidance, or with the compact startup. Refused with exit 2 before a subcommand. |
| `clio-coder --api-key <key>` | Override the API key of the target the invocation runs on, for that invocation. The key binds after the route is resolved, so it follows `--target` and the route a resumed session restores instead of the saved chat target. With no resolvable target the invocation exits 2. |
| `clio-coder --no-context-files` / `clio-coder -nc` | Skip `CLIO-CODER.md` project-context injection for one invocation. |
| `clio-coder --with-panes` | Activate guest pane integration for this invocation when CLIO Coder is inside a reachable herdr session. |
| `clio-coder --autonomy <level>` | Start this interactive session at `default` or `yolo` without modifying `settings.yaml`. A `yolo` start holds at `default` until the one-time acceptance card is accepted, and starts at `default` with a notice as root outside a container. Passing `--autonomy` before a subcommand is refused with exit 2 (`clio-coder run --autonomy` remains the headless form). |
| `clio-coder --allow-tools <names\|none>` / `--deny-tools <names>` / `--delegate-tools <names\|none>` | Limit the interactive session's own capabilities or its workers' capabilities with a comma-separated list. `--deny-tools` removes the named tools whatever else admits them, including from an `--allow-tools` list. For `run` and `acp`, put these flags after the subcommand. The limits hold on every turn and propagate to workers. |
| `clio-coder --max-context-tokens <N>` | Cap this interactive session's context budget at a positive integer of tokens, as `clio-coder run --max-context-tokens` does for one run. The cap lowers the effective window when the route's window is unknown or larger, and never enlarges the server window. Passing it before a subcommand is refused with exit 2; for a headless run, put it after `run`. |
| `clio-coder --session-file <path>` | Keep a live JSON record of the interactive session's lane at `<path>`, and replace it with an exit record when the session ends. The live record is rewritten at every turn boundary and on every move into or out of a wait: `version` (1), `sessionId`, `sessionName`, `state` (`working`, `idle`, `awaiting-approval` while a permission card is open, `awaiting-answer` while an `ask_user` question is open), `since` (ISO time of the last transition), `turns`, `lastTurn` (`endedAt`, `stopReason`, `toolCalls`, `failedToolCalls`, or null), `waitingOn` (awaiting states only: `tool` and `text`, the first 200 characters of the command or question with secrets redacted), `pendingInput` (`queued`, the messages the operator submitted that have not reached the model yet, and `queuedTurns`, the prompt templates among them waiting to start their own turn when the run ends; rewritten whenever the queue changes), `build` (`id` and `commit` of the running build, each null when unknown) and `cwd`. The exit record to `<path>` (resolved against the launch directory): `version` (1), `sessionId` and `sessionName` (null without a model turn), `outcome` (`quit`, `interrupted` for a double `Ctrl+C` or a terminating signal, `crashed` for any other exit), `exitCode`, `usage` (`tokens` and `cost`, each the read model's `display` and `fact`, or null), `model` (the last `{target, model}` used, or null), `models`, `turns`, `cwd`, `endedAt` and `state` (`ended`). The exit record is written once. Every write goes to a temporary file in the same directory that is renamed into place, with mode 0600; missing parent directories are created. It also works inside CLIO Coder's own pane host, and `/restart` leaves the record to the restarted session. Refused with exit 2 before a subcommand. |
| `clio-coder --no-skills` | Disable skill discovery for one invocation and automatic skill/marketplace prompt guidance while still honoring explicit `--skill` paths. |
| `clio-coder --skill <path>` | Make one explicit skill file or directory available for one invocation (repeatable). CLIO Coder loads its instructions when the skill is activated through `context(scope="skills", name=...)`. |
| `clio-coder --resume [<id\|prefix>]`, `-r`, `--continue`, `-c` | Open the interactive session on an earlier session. `--resume <id\|prefix>` (or `--resume=<id>`) resolves like `/resume <id\|prefix>` and exits 2 before the TUI starts when nothing or several sessions match; a bare `--resume` opens the session picker; `--continue` opens the most recent session for this project that reached a model turn, or a fresh session with a notice when there is none. `--resume` with `--continue`, or either before a subcommand, is refused with exit 2. See [Resuming sessions](#resuming-sessions). |
| `clio-coder configure` | Run the configuration wizard. Ctrl+C reports `configuration cancelled` once, writes no target, and exits 130 without an additional error line; when first-run onboarding is cancelled, startup stops instead of opening the TUI with no usable target. |
| `clio-coder configure [--quick\|--settings\|--section <name>\|--json\|--edit]` | `--quick` connects an endpoint with recommended defaults, `--settings` opens the complete settings menu, `--section <name>` opens one of `targets`, `chat`, `fleet`, `context`, `safety`, `interface`, `integrations` or `advanced` (without a terminal it prints that section's values), `--json` prints the effective settings, and `--edit` edits user settings in `VISUAL`/`EDITOR` with validation and review before saving (it needs a terminal and exits 2 without one). |
| `clio-coder configure --id <targetId> --runtime <runtimeId> [flags]` | Register a target without prompts. Flags: `--url <host>`, `--model <wireModelId>`, `--orchestrator-model <id>`, `--background-model <id>`, `--fleet-model <id>` (exclusive with `--agent-profile`), `--agent-profile <name>`, `--agent-profile-model <id>`, `--bind-agent <agentId>`, `--api-key-env <VAR>`, `--api-key <literal>`, `--force`, `--gateway`, `--lifecycle <user-managed\|clio-coder-managed>`, `--set-orchestrator`, `--set-background`, `--set-fleet-default`, `--context-window <N>`, `--max-tokens <N>`, `--reasoning <true\|false>`, `--verify` (send one short test request first and save only if the model answers). Guided `clio-coder configure` takes `--no-verify` to save without its test request. |
| `clio-coder configure --interop` | Review other coding agents detected on this machine and connect one as a delegation peer. Without a TTY it prints the proposals and writes nothing. |
| `clio-coder configure --list` | List user-facing runtime ids. |
| `clio-coder configure --list --all` | List every registered runtime, including aliases. |
| `clio-coder config [inspect] [--json]` | Print the effective customization graph across settings, context files, rules, skills, prompts, agents, extensions, safety, memory, hooks, and operator profile. |
| `clio-coder config get <path> [--scope effective\|user\|project] [--json]`, `clio-coder config set <path> <value> [--scope user\|project] [--json]`, `clio-coder config unset <path> [--scope user\|project] [--json]` | Read, save or remove one setting by its dotted path, such as `interface.exitSummary`. `get` prints the layered value and the layer it came from. `set` parses the value by the setting's type and writes user settings by default; `--scope project` writes `.clio-coder/settings.local.yaml` and needs trusted project settings. Routing paths (`chat.target`, `chat.model`, `fleet.*`, `targets`) are refused and point to `clio-coder targets use`. An unknown path or invalid value exits 2 and writes nothing; a path the named scope does not set exits 1. |
| `clio-coder config trust safety\|hooks\|settings\|extensions\|plugins [--json\|--hash <sha256>\|--revoke]` | Review, approve, or revoke one privilege-bearing project surface for this workspace. See [Project trust](#project-trust). |
| `clio-coder targets [--json] [--probe [--reasoning] [--tools [--tools-timeout <seconds>]]] [--target <id>]` | List targets and metadata; `--reasoning` and `--tools` explicitly generate qualification requests, and `--tools-timeout` bounds each tool probe. |
| `clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>] [--fleet-target <id>] [--fleet-model <id>]` | Select the named roles only when any role flag is present. `--background-model` selects memory; `--orchestrator-model` selects chat; `--fleet-model` or `--fleet-target` selects fleet. Other roles and thinking levels are preserved. Without role flags, chat and fleet use the target default (or shared `--model`), while memory is preserved. With role flags, `--model` is refused with exit 2 when no selected role falls back to it; pass `--orchestrator-model` to set chat. Confirmation names only roles whose settings changed. Model IDs must match a nonempty discovered or cached inventory exactly; unavailable discovery is reported explicitly. |
| `clio-coder targets profile list [--json]` | Show the fleet default (`fleet.default`, set by `targets use <id> --fleet-model <model>`) and the configured fleet profiles, each with its target, runtime, model, thinking level, and settings source. `--json` prints `{ "default": ..., "profiles": [...] }`, with `default` null when unset. |
| `clio-coder targets profile set\|remove\|rename\|bind\|unbind\|bindings` | Manage named fleet profiles and agent bindings. `bindings [--json]` reads; `set <name> <id>` takes `--model` and `--thinking`; `remove <name>` takes `--force`; `rename <old> <new>` renames; `bind <agentId> <profileName>` and `unbind <agentId>` attach and detach an agent. `clio-coder targets profile <name> <id>` is the short form of `profile set`. |
| `clio-coder targets convert <id> --runtime <runtimeId>` | Convert older local target definitions to a runtime-specific target. |
| `clio-coder targets remove <id>` | Remove a target, with the key only it used. |
| `clio-coder targets rename <old> <new>` | Rename a target id. |
| `clio-coder models [search] [--target <id>] [--json] [--offline]` | List models, with the thinking levels each route offers in a `thinking` column (`thinkingLevels` under `--json`). Live probing is the default; `--offline` skips it. |
| `clio-coder paths [--json]` | Print the resolved config, data, state and cache roots, the installer root and whether this binary runs from it, the launcher, and where a new project `.clio-coder/` entry goes from this directory. |
| `clio-coder auth list` | Show known auth entries. |
| `clio-coder auth status [target-or-runtime]` | Inspect auth state. |
| `clio-coder auth login [target-or-runtime] [--api-key <value>]` | Add credentials through the supported flow. |
| `clio-coder auth logout [target-or-runtime]` | Remove stored credentials. |
| `clio-coder doctor [--fix] [--json] [--verbose] [--deep [--tools-timeout <seconds>]]` | Diagnose state. Plain `doctor` changes no file outside CLIO Coder's home and creates nothing on a home that was never set up; like any run it may refresh CLIO Coder's own caches. With `--fix`, create missing structure and templates, repair credential permissions, refresh install metadata, rewrite retired enum values and YAML 1.1 booleans in settings, and record fleet preflight results. Settings remain strict; lifecycle migrations belong to `upgrade`, not `doctor --fix`. `--deep` adds a live tool-call probe per target and a dry run of the validation contract. See [Doctor](doctor.md). |
| `clio-coder mcp list\|test\|trust\|untrust` | List configured servers with `list [--refresh] [--json]`; test one with `test <id> [--call <tool> [--args <json>]]... [--json]`; approve a project or plugin server with `trust <id> [--action-class read\|execute\|destructive\|unknown] [--network] [--json]`; or revoke with `untrust <id> [--json]`. Exit 0 on success, 1 on operational failure, 2 on invalid usage. `list` exits 1 for config or trust diagnostics other than warnings. See [MCP configuration and trust](configuration-reference.md#local-stdio-mcp-configuration-and-trust). |
| `clio-coder tools list [--json]` | List the pinned external tool registry (`asciinema`, `herdr`, `yazi`, `croc`, `cliamp`) and whether each program resolves from `PATH`, CLIO Coder's vendored data directory, or nowhere. After a pin moves, an older vendored copy reads ``vendored <versions> is superseded by the <pin> pin (update with `clio-coder tools install <id>`)`` instead of `not found`. |
| `clio-coder tools status <id> [--json]` | Inspect one registered tool; its `resolves to` line uses the same wording as `tools list`. |
| `clio-coder tools reset-profile <id> [--json]` | Regenerate a tool's CLIO Coder profile the next time it opens. It applies to yazi's generated profile. |
| `clio-coder tools install <id> [--force] [--json]` | Download the platform asset, verify every declared checksum, and atomically vendor it. The `ok:` result line also names the versions it pruned, followed by one `license` line per upstream license file; `--json` lists the pruned versions in `pruned`. |
| `clio-coder tools install claude-sdk [--json]` | Provision the separate pinned Claude Agent SDK component under CLIO Coder's data root. This special component install accepts no `--force` or extra arguments. See [SDK installation](installation-and-lifecycle.md#lean-install-the-claude-agent-sdk). |
| `clio-coder tools remove <id>\|--all [--json]` | Remove CLIO Coder-vendored copies without touching a program found on `PATH`. |
| `clio-coder panes install [--force] [--json]` | Alias for `clio-coder tools install herdr`. |
| `clio-coder panes theme` | Print CLIO Coder's theme tokens as a herdr `[theme.custom]` block to paste into herdr's `config.toml`; it never edits that file. See [Panes and the Files Pane](panes-and-files.md). |
| `clio-coder systemone status\|use <route>[,<route>...]\|off\|check <engine> --live` | Show whether System One is on and why not, name its routes at user or project scope, turn it off, or verify which build answers. A named route answers the `consult` tool, the judge screen and steering triage, so on a hosted route web and MCP result text leaves the machine at judge time. Experimental. See [System One](system-one.md). |
| `clio-coder tasks [list\|add\|hand\|done\|drop]` | List, add, hand, finish, or drop project operator tasks. `add` takes `--expect <path>` and `--verify <checkId>[:timeoutMs]`; `hand`, `done` and `drop` take a `uN` id. |
| `clio-coder verifiers discover\|inspect\|author\|validate\|add\|edit\|rename\|remove\|baseline\|dry-run` | Discover, inspect, author, validate, add, edit, rename, remove, baseline, or dry-run project checks. |
| `clio-coder reset --state\|--data\|--cache\|--auth\|--settings\|--all [--dry-run] [--yes] [--json]` | Reset the named CLIO Coder state; with no level it exits 2. `--yes` (`-y`) skips the confirmation and is required without a terminal. Under `--state` or `--all`, an owned background app is stopped first and reported as `Removed Background service`. |
| `clio-coder uninstall [--dry-run] [--keep-binary] [--keep-package] [--keep-config] [--keep-data] [--inactive] [--yes] [--json]` | Remove CLIO Coder state, stop its private pane hosts, and close with what was removed and what was kept. The exact `PATH` block `install.sh --modify-path` added is removed with the launcher, and kept while other programs share its directory; other shell startup lines that mention CLIO Coder, including in `$ZDOTDIR/.zshrc` and fish `config.fish`, are reported and never edited. An npm global package is removed unless `--keep-package` or `--keep-binary` is given. `--inactive` removes only installer roots this binary no longer runs from, and refuses while a process or a graphical service file still starts from one. |
| `clio-coder upgrade [--dry-run] [--channel=<latest\|beta\|dev>] [--skip-migrations] [--refresh-runtime] [--post-install] [--rollback] [--restart] [--json]` | Update an identified npm global installation in its original prefix and apply migrations with that installation's new binary. An `install.sh` installation gets the new version in a new prefix beside the old one and its launcher is switched; `--refresh-runtime` also moves it to the newest Node LTS the installer picks. On a user-writable npm prefix, `upgrade` refuses to replace the package while other sessions or an update lease hold the install, lists them as `pid@host` and exits 75. Other managers and source checkouts receive update instructions. `--channel` also accepts a separate value (`--channel beta`). `--post-install` runs local migrations and repairs, moves a background app another installation owns to this one, and names an installer root a move to another method left behind. A pinned installer install prints `Pinned version: <X>` and the installer command that follows the channel again, and is not upgraded. `--rollback` restores the previous working version of a native installation, disables background updates and moves a version pin to the restored version; with no previous version it fails up front, and `--dry-run` names both versions. An npm, pnpm or Bun install gets its manager's command for the version it ran before. It cannot combine with `--post-install`, `--refresh-runtime` or `--restart`. `--restart` relaunches the installed CLI in the project after success, where `/resume` picks up the last session; it requires a terminal and cannot combine with `--json` or `--post-install`. |
| `clio-coder agents [list] [--json] [--all]` | List discovered agent specs. |
| `clio-coder agents validate [--json]` | Check this repository's harness: project and user agent recipes, project and user skills, and the fleet bindings in `.clio-coder/settings.local.yaml`. Prints every problem as one `file: field: message` line and exits 1 when there is any. |
| `clio-coder fleet run\|status\|list\|view\|verify\|wait\|cancel\|admission\|nodes` | The fleet is the coordinator and its workers. `run <playbook>` runs a playbook and takes `[--var k=v ...]`, `[--resume <runId>]`, `[--output-format text\|json\|stream-json]`, `[--cwd <dir>]`, `[--timeout <duration>]` (exit 124), `[--max-cost-usd <usd>]` (exit 4) and `[--detach]`. `--output-format json` prints one `fleet_end` result document, and `stream-json` prints `fleet_started`, `step_dispatched`, `step_settled` and `fleet_end` lines. `--detach` returns once the fleet root is recorded and prints one `fleet_accepted` line under `json`. `status` takes `[--json] [--all]` and defaults to this project; `list [--all-projects] [--limit N] [--json]` lists this project's fleet roots, newest first, with each one's state (`sealed`, `ended`, `running`, `orphaned`) and sealed outcome; `view <runId\|fleetRootId>` reads one run or lists a fleet run's steps; `verify <runId>` re-verifies a run's sealed scope; `wait <fleetRootId> [--timeout <duration>] [--json]` waits for a fleet root to seal, prints its result and exits with the root's exit code, 1 when its owner died unsealed, or 75 when `--timeout` expires; `admission [status\|drain\|open] [--json]` shows the dispatch admission gate, denies new execution starts for up to one hour while preserving running work (`drain`), or reopens it (`open`); `nodes` manages SSH worker nodes. |
| `clio-coder playbook list\|new\|validate\|graph\|commands` | List the builtin, plugin, user and project playbooks the fleet runs, copy a built-in one with `new <name> --from <build-review\|build-test\|sdlc>`, validate or graph one without side effects (`validate <name> [--json]`, `graph <name> [--json]`), or draft a command registry with `commands init`. A playbook is a Markdown file in a `playbooks/` directory. `clio-coder upgrade` converts a pre-0.6.2 `fleets/` directory once. See [Fleet dispatch](fleet-dispatch.md#playbook-authoring). |
| `clio-coder fleet events <fleetRootId> [--follow] [--json] [--all]` | Print a fleet root's hash-chained event journal (`fleet_started`, `step_dispatched`, `step_settled`, `fleet_sealed`). `--follow` reads until the seal, `--json` writes the stored lines verbatim, `--all` reads another project's root, and the root id may be a unique prefix. Exit 0 for a sealed intact journal, 1 for an integrity break or read error, 2 for usage, 3 for an intact journal that is not sealed yet, and 4 when a followed fleet can no longer seal its journal. |
| `clio-coder fleet verify <runId> [--json] [--exit-code]` | Re-verify one run's sealed telemetry scope now, instead of reading the trust status a snapshot captured earlier, and print its trust state as a text verdict or, with `--json`, as the snapshot. The snapshot's `reason` names what failed (`manifest-mismatch`, `segment-mismatch`, `object-mismatch`, `chain-mismatch`, `seal-mismatch`, `unsealed` or `run-unreadable`). `--exit-code` exits 0 verified, 1 failed or unavailable, and 75 pending. An unknown run id exits 1. |
| `clio-coder fleet cancel <runId\|fleetRootId> [--json] [--reason <text>]` | Ask the process that owns the run to abort it and wait up to 15 seconds for the run to seal `canceled`; exit 75 while the request is still pending. When the owning process is gone, terminate the orphaned worker's process group and settle the ledger row directly. Given a fleet root, no further step starts and its running steps are canceled; a root that already sealed exits 0 with its recorded outcome. |
| `clio-coder fleet land [<run>] [--squash] [--message <text>] [--keep] [--yes] [--plan <id>] [--json]` | List task branches finished runs kept, preview landing one (commits, changes, destination, conflicts), and with `--yes` land it on the branch it was dispatched from through a fast-forward that never overwrites a local change, then remove its branch, worktree and claim unless `--keep`. See [Fleet dispatch](fleet-dispatch.md#landing-a-kept-branch-later). |
| `clio-coder fleet nodes setup\|add\|discover\|install\|list\|remove\|test` | Manage SSH worker nodes. `setup <id> [--host <host> and add flags] [--yes]` or `setup --all [--yes]` adds the node when `--host` is given, installs this exact build when the node lacks it (preview without `--yes`) and records the preflight; `add <id> --host <SSH alias or address> [--user <name>] [--port <number>] [--identity-file <path>] [--entry <worker command>] [--version-command <command>] [--labels <a,b>] [--max-workers <number>] [--test] [--record]`; `discover [--json]` lists Tailscale peers and marks registered ones; `install <id> [--yes]` previews a user-level install of this exact client and `--yes` executes it; `list [--json]` shows recorded readiness; `remove <id>` removes a node without deleting remote files; `test <id> [--record] [--json]` probes without remote writes and `--record` updates local eligibility. A node needs a passing recorded check before dispatch. See [Fleet dispatch](fleet-dispatch.md). |
| `clio-coder fleet decisions --json [--all]` | Read bounded gate decision summaries for this project. `--all` reads machine-wide state. |
| `clio-coder fleet view <runId\|fleetRootId> [--follow] [--json] [--all]` | Read one run's ledger entry, display feed and sealed run record. A fleet root prints its durable step index. IDs from other projects require `--all`. Without `--follow`, the width-bounded snapshot is plain text with no ANSI control bytes. Once the run's seal verifies, the snapshot adds the requested model next to the provider-reported model per call (`not observed` when uncaptured), the cost with its pricing provenance, and the label the route settled with. An unsealed run says its settled facts are not yet vouched for. `--json` prints the snapshot with the sealed run record and takes a run id only. `--follow` tails only on an interactive terminal and for one run id; otherwise it prints the snapshot (a fleet root prints its index) and says so on stderr. Exit 2 for an unknown or ambiguous id and for invalid flags. `fleet view --help` prints this subcommand's own usage, including `--watch`. See [Fleet dispatch](fleet-dispatch.md). |
| `clio-coder fleet view --watch <selection-file> [--dock-taps <file>] [--all]` | Run the workers dashboard: a board of this session's workers and a live takeover of one, driven by the selection file. This is the process the workers dock (`Alt+W`) runs in a `--with-panes` session. `--dock-taps` names the file where the dashboard reports `q` and `Alt+W` to CLIO Coder; without it `q` quits. Without a TTY it prints the selected run's snapshot and exits. |
| `clio-coder dev components [list] [--json]` | List behavior-affecting harness components. |
| `clio-coder dev components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio-coder dev components diff --from <a> --to <b> [--json]` | Compare component snapshots. |
| `clio-coder evidence inspect <runId> [--json]\|list` | List the run scopes on this host with their assessment state, or inspect one run's assessment, trust status, findings and gate verdicts by run id. Every run is assessed when it settles, so there is nothing to build; `evidence build` is refused with that reason. A run's sealed scope directory is its evidence. See [Evidence](../architecture/telemetry.md#evidence). |
| `clio-coder memory list\|propose\|promote\|approve\|reject\|prune\|consolidate` | Manage scoped, evidence-linked memory records. `propose --from-evidence <evidenceId>`, `propose --from-claim <claim-id-prefix>` (an unapproved `repo` record resting on one claim), `promote --from-handoff <path> --scope <scope>` (with `--entry <id>` to pick entries), `approve <memoryId>`, `reject <memoryId>`, `prune --stale` and `consolidate [--json]`, which tidies this checkout's records by rule with no model call and never changes an operator decision. `list --json` prints `{ records }` with each record's review fields, for the GUI's review list, and `list --approved-by operator\|guardian` keeps the approved records one approver let into the prompt. Scopes are `repo` (`--repository <canonical-absolute-path>`), `global` (`--acknowledge-global`), `runtime` (`--runtime <source-runtime-id>`) and `agent` (`--agent <source-agent-id>`). Promotion always needs an explicit scope and creates unapproved records for review. |
| `clio-coder claims [list] [--check <id>] [--json]`, `clio-coder claims show <id-prefix> [--json]`, `clio-coder claims export [--check <id>] [--out <file>]`, `clio-coder claims import <file> [--json]`, `clio-coder claims compact [--prune-superseded-before <iso-date>] [--dry-run] [--json]` | List the project's claims, oldest first, with its disputes and imported claims in their own sections, or show one claim or hypothesis with its full conditions. `--check` takes a check id or one `<id>/<run>` of a sweep. Each judged `reproduce` or `numeric-compare` check, from a main-thread `verify` call or a worker run's host verification, appends one claim: whether the judged results agreed within the declared tolerance, with the commit, command, inputs, seed, platform and per-metric verdicts it ran under. A check that was refused or could not run records nothing. Only the main session writes claims: a dispatched worker's own `verify` call records none, and a worker run's checks reach the log only through host verification, which runs when the run declares a gate. `clio-coder run --agent` declares none, so it records no claim. A checkout whose `.git` pointer names a worktree its repository does not record records nothing. A claim never states that a result is scientifically right. The log is append-only, lives in the state directory and is keyed by the repository root, the same key memory uses; a linked worktree shares its main checkout's log. Each new claim is compared with earlier claims of the same check by recorded conditions only. The opposite verdict with the same pinned conditions (commit, command, reference digest, inputs and tolerance, plus seed, environment and platform for `reproduce`) adds a `contradicts` edge to the latest earlier claim there. When a failure overturns a pass, every earlier pass under those conditions reads `retired` and the failure reads `contested`; any other contradiction leaves both `contested`. A claim whose pinned conditions changed, such as a new commit or new input digests, adds `supersedes` edges to earlier claims from the same worktree, and those read `superseded`. A claim recorded at a commit other than HEAD is listed as stale. A `numeric-compare` check's working tree is not pinned, so an agreement on a clean tree that turns into disagreement with uncommitted changes at the same commit is a contradiction; each edge and regression names what matched and how the working trees differed. A claim with no recorded commit is never contradicted. When a disagreement overturns an agreement, each memory record citing that agreeing claim gets a regression and leaves the prompt until approved again, and the claim lists the records changed or says none were. An agent-ledger review that did not pass is kept as a dispute: both sides as written, inferred, with no merged verdict. `export` prints, or writes mode 0600 with `--out`, a bundle of this project's unflagged claims; `import` adds another project's claims as `inferred`, labelled with their origin, and they never contradict, supersede or ground a claim here or back a memory record. `compact` rewrites the log without spent check-starts and repeated lines, quarantines damaged lines, and with `--prune-superseded-before` drops old superseded claims nothing cites; `--dry-run` only counts. A main session whose task names a check with an open contradiction or superseded claims, or whose `verify`, `read`, `edit` or `write` call touches it, gets those claims once as a reminder in the message tail, and a dispute whose path it touches the same way; see `observer.claims-delivery` in [Middleware and components](../architecture/middleware-and-components.md) and [Claims ledger](../architecture/evidence-and-memory.md#claims-ledger). |
| `clio-coder arena run --contender <target>/<model> ... [--timeout <s>] [--suite <name>] [--check <verifier-id>] [--max-cost-usd <n>] [--read-only] [--autonomy default\|yolo] [--json] <prompt>`, `clio-coder arena show <match-id> [--reveal] [--json]`, `clio-coder arena vote <match-id> A\|B\|C\|D\|tie\|both-bad [--note <text>] [--replace] [--json]`, `clio-coder arena list [--suite <name>] [--json]`, `clio-coder arena standings [--suite <name>] [--json]` | Run one prompt on 2 to 4 contenders side by side and vote on the result blind. Inside Git each contender runs `clio-coder run` in its own worktree from `HEAD`, the worktrees are removed after the diffs are saved, and the main checkout is never touched; outside Git, or with `--read-only`, contenders only read. `--autonomy yolo` runs every contender as contained yolo and records it on the match; unconfined yolo is refused. A contender's shell commands run in the main-session sandbox: they write its worktree and Git metadata, the run's `$TMPDIR`, /tmp, the sandbox cache under CLIO Coder's cache directory (`sandbox-cache`) and the `safety.scratchRoots`, and nothing else. `XDG_CACHE_HOME`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH` point at the sandbox cache, and your own `~/.cache` and `~/.npm` stay read-only because tools later run code from them outside the sandbox; a refused write tells the contender to point that tool's cache variable under the sandbox cache. `--check <id>` must name a check the project can resolve (its `.clio-coder/verifiers.yaml`, `<sweep>/<run>` for one run of a sweep, or a derivable id) and is refused before any contender starts otherwise; the project's catalog and the uncommitted files the check names (paths on its command, its reference, baseline or pinned inputs; not ignored files or links) are copied into each worktree, replacing any copy a contender wrote, and a file the check reads without naming it must be committed. Before a vote, `show` lists labels A to D in a seeded random order with each contender's answer, diff, turns, tool calls, writes and blocks, and hides the target, model, duration, tokens and cost; `--reveal` before a vote is refused. A vote is recorded once; `--replace` writes a new one and the journal keeps both. `standings` counts wins, losses, ties and all-bad votes per target/model and shows an Elo rating once a contender has 5 votes. CLIO Coder records the human's vote and never judges a match. The GUI Arena page runs the same commands. See [Research and Arena](research-and-arena.md#arena-blind-side-by-side-comparison). |
| `clio-coder campaign run --fixture <dir> --roster <roster.yaml> --answers <answers.yaml> --prompt <text> --out <dir> [--timeout <seconds>] [--probe <extension>:<command>] [--autonomy default\|yolo] [--json]` | Run one seeded project across a roster of models, one headless `run --answers` per entry, and report per entry how the run ended, the extension gates it reached, refusals, loop-guard blocks, tokens and wall time. See [Model campaigns](research-and-arena.md#model-campaigns). |
| `clio-coder research start --check <id> --metric <key> --direction min\|max --max-iterations <N> [--min-improvement <frac>] [--trials <N>] [--scope <glob>]... [--gate <id>]... [--goal <text>] [--max-wall-minutes <M>] [--max-cost-usd <X>] [--allow-unpriced] [--allow-noisy] [--target <id>] [--model <id>] [--autonomy default\|yolo] [--keep] [--json]` | Hill climb one numeric key of a verifier check's JSON payload within a budget. An A/A check first measures the base against itself and refuses a noisy campaign unless `--allow-noisy`. Each iteration runs `clio-coder run` at `--autonomy` (`default`, or contained `yolo`, whose refused calls the journal keeps as open decisions; unconfined yolo is refused) with dispatch off in a fresh worktree at the current best commit, then archives a no-op, a repeated tree, a change to a protected path (the verifier catalog, every file the checks name, the executable included, every symlink resolving a named path passes through, chained links included, and the targets those links reach; a deletion, rename or replacement of a protected path or of a directory or link on the way to it, or a changed symlink that reaches one, also counts) or a change outside `--scope` (its globs match dot segments such as `.github/`) without measuring. Otherwise it measures interleaved base and candidate pairs and keeps the change only when the median moves by at least `--min-improvement` (default 0.05), a seeded 2,000-resample bootstrap 95% interval excludes zero, and every `--gate` check passes (`--check` and `--gate` take `<sweep>/<run>` for one run of a sweep check, and a bare sweep `--gate` gates on every run, each of which must be committed); a judged objective (`numeric-compare`) is also a gate, so its reference comparison must pass. `--max-wall-minutes` is one campaign-wide deadline: it cuts off the agent run, the measurements and the gates in flight, and nothing graded after it is ratcheted. A kept change moves the branch `clio/research/<id>` by compare-and-swap; the checked-out branch is never touched. Spend is summed from each run's cost and never counts an unknown cost as zero: with `--max-cost-usd` and without `--allow-unpriced`, an unpriced run stops the campaign as `budget-unenforceable`. Ctrl-C, SIGTERM and SIGHUP stop cleanly (exit 130, 143, 129). Judged gates record claims and each measured iteration records its hypothesis, see `clio-coder claims`; the ledger marks every research hypothesis, from any campaign, tested (other project hypotheses bound to a gate keep the gate's claim as evidence), and the journal records whether the grade supported it (improved), refuted it (regressed) or left it inconclusive. |
| `clio-coder research resume <id> [--json]` | Continue a stopped campaign, or one whose process died, from its journal with the same spec and budget: the iterations, spend and wall time already used carry over, the A/A check is not repeated, and an unfinished iteration is archived as `interrupted`. Refused (exit 1) while another process runs the campaign, after a noisy A/A check, when the budget is spent, or when something else moved `clio/research/<id>`. Exit codes as `research start`. See [Research and Arena](research-and-arena.md#resume-a-stopped-campaign). |
| `clio-coder research status [<id>] [--json]`, `clio-coder research report <id> [--json]`, `clio-coder research list [--json]` | Read campaigns under `.clio-coder/research/`. `status` prints the objective, the branch and best commit, the budget and spend, the A/A grade and one line per iteration (the latest campaign when no id is named). `report` also regrades the A/A check and every measured iteration from the raw samples with the recorded seeds and exits 1 when any grade disagrees with the journal. See [Research and Arena](research-and-arena.md#research-a-verified-hill-climb). The GUI's [Research page](gui.md#research-page) runs these and `research start`. |
| `clio-coder interop inspect [--json]` | Show the host inventory of detected coding agents and how far each one is wired. Changes no host or project files and starts no agent session. |
| `clio-coder interop adopt <host> [--kind skill\|agent\|prompt\|plugin] [--project\|--user] [--yes] [--dry-run]` | Review and adopt safe resources from a detected host. Wiring a host as a delegation peer is `clio-coder configure --interop`. |
| `clio-coder fleet code-steps <rootId> [--json]` | List the deterministic code steps one fleet root ran (argv, cwd, env names, exit code, duration, output digest, artifact paths), read from the `code_step.settled` records in the root's run journal. |
| `clio-coder telemetry inspect\|calls\|cost\|cache\|timeline\|why-stopped\|explain` | Read the telemetry read model. `inspect <session>` or `inspect --run <run-id>`; `calls <session>` filters by `--run`, `--role`, `--disposition`, `--turn`, `--from`, `--to` and `--limit`; `cost <session>` or `cost --run <run-id>` groups `--by role\|model\|turn`, and `cost [--repo <path>] --days <n>` folds the window `usage report` reads; `cache`, `timeline [--from <iso> --to <iso>]` and `why-stopped` take a session; `explain <ref>` explains one value. `<session>` is a session id or directory, given as an argument or as `--session <session>` (the form `telemetry tokens` takes); passing both is a usage error (exit 2), and `explain` does not take `--session`. `inspect` prints the scope's seal verdict on its `seal` line (`verified`, `unsealed` or `failed` with the first mismatch). Each takes `--json` for the read-model DTO the TUI, ACP and GUI serve, and `--imported <install-id>` to read scopes `telemetry import` placed instead of your own. See [Read model](../architecture/telemetry.md#read-model). |
| `clio-coder telemetry quota [--provider <id>] [--json]`, `clio-coder telemetry health [--json]`, `clio-coder telemetry runs <session> [--json]` | Print the telemetry snapshots ACP's telemetry methods return, read from the state directory. `quota` reads only the readings this host journaled and polls no provider, `health` reports this process's read model, and `runs` lists the worker runs a session referenced. |
| `clio-coder telemetry surfaces [--session <id>] [--json]` | List every side surface (memory, compaction, the safety judge, triage, prewarm and the rest) with its calls by disposition, output tokens and service time, then every middleware rule and host surface that fired with how its firings settled. A surface whose calls never reached a model prints `unexercised`. With `--session` it folds that session's journals; without, every session and run journal in the state directory. It reads structure only, never content. |
| `clio-coder telemetry tokens --session <id> [--by-source] [--json]` | List each turn of a session with its input tokens, cached and fresh, and its output tokens, read from the session ledger and journal; the id may also be the first positional argument. `--by-source` splits each turn's input, and the session's, across system prompt, skills, tool schemas, template body, extension effects (reminders and tool-result annotations), tool results per tool, and history. Providers report one input total per call, so totals are measured while the split is estimated: each call's total is apportioned over its request's segments by estimated size, and its cache read is assigned to the leading segments in request order. The header says so. Calls a side agent made (compaction, memory and the like) are charged to the turn they ran in and sit inside its totals; `--by-source` gives each role one unsplit row. The calls count is every invoked call and names the unmeasured ones, whose tokens no sum includes, and the side-agent calls by role; a turn with no measured call prints its tokens as unknown. A measured call that sent no cache-read count has no cached/fresh split: its tokens count in the input total only, and the calls count names it as without split. Fresh is uncached input plus cache write; on copilot-sdk calls fresh is cache write, and the output says so. Each `--by-source` turn heading also names its cold-cache reasons. `--json` prints the report verbatim. Exits 1 when the session is unknown, 2 on a usage error. |
| `clio-coder telemetry consent [--workspace <dir>] [--revoke\|--list]` | Record, revoke or list research content consent for a workspace (default: the current directory). Capture also needs `telemetry.mode: research` and `telemetry.research.content: true`. Consent lives in the state directory, never in the workspace. |
| `clio-coder telemetry prune [--apply] [--days N] [--max-gib N] [--research-days N] [--research-max-gib N]` | List, oldest first, the telemetry retention would remove: journals and objects past 90 days or over 1 GiB, and research content past 30 days or over 4 GiB. Live or locked scopes and anything a kept scope references stay. Nothing is deleted without `--apply`, which prints every file it removed. See [Retention](../architecture/telemetry.md#retention). |
| `clio-coder telemetry verify <session\|scope-dir\|archive> [--imported <install-id>] [--json]`, `clio-coder telemetry verify --run <run-id> [--imported <install-id>] [--json]` | Verify a sealed session, run or process scope with nothing but its own files: segment and object sizes and sha256, the journal hash chain, and the seal record. Prints `verified`, `unsealed` or `failed` with the first mismatch. Given a share archive, verifies its manifest and every bundle in it. Exit 0 verified, 1 failed or unsealed, 2 on a usage error or an unreadable path. See [Verify](../architecture/telemetry.md#verify). |
| `clio-coder telemetry doctor [--json]` | Show the effective capture mode for the current directory against what settings request, the consent that covers it, the newest session journal's health (records, skipped and damaged lines, gaps, duplicates), and the seal state of every scope. Exit 1 when a seal fails, the consent store is unreadable or the newest journal has damaged lines; 2 on a usage error. |
| `clio-coder telemetry insights [--project [<dir>]] [--json]` | Classify each recorded session into a research task category or non-research software work, give it an autonomy level from 1 to 5, and print per project the category mix, the autonomy distribution and the share of sessions with a verified outcome. A heuristic over content-free telemetry; it reads no message content and nothing leaves the machine. `--project` limits it to the current directory's project, or `<dir>`. See [Research insights](#research-insights). |
| `clio-coder telemetry share [--session <id>]... [--run <id>]... [--process <id>]... [--repo <path>] [--since <iso>] [--until <iso>] [--live] [--profile content-free\|report\|structural\|research] [--out <file>] [--dry-run] [--send --consent debug\|dataset [--yes]]` | Pack sealed scopes into one tar.gz for the maintainer; without `--send` nothing is uploaded, and `--send` shares it encrypted to the maintainers ([Share with the maintainers](troubleshooting.md#share-with-the-maintainers)). A session brings the runs it references; a live scope or one that fails verification is skipped and named, unless `--live` shares a named live scope as a snapshot of what is on disk without sealing it. `--process` reaches a process scope (boot, health, domain loads, exit). The `report` profile is `structural` with target ids anonymized too, for an archive linked from a public issue; `--send` takes the other three profiles. Every profile redacts secrets again, each scope is resealed with `share.sealed`, and the manifest names the profile, this installation's random install id and the CLIO Coder version. The default profile is `content-free`. It previews counts before writing; `--dry-run` stops there. `--out` defaults to a timestamped file in the current directory and is never overwritten. In a terminal with no scope flags it asks; outside one it needs a scope flag. Exit 0 written or previewed, 1 nothing to share or a failure, 2 on usage. See [Share and import](../architecture/telemetry.md#share-and-import). |
| `clio-coder telemetry share list`, `clio-coder telemetry share forget <shareId>`, `clio-coder telemetry share sweep [--json]` | List the shares this machine sent, delete one's gist, or delete every expired share through `gh`. `list` contacts nothing. |
| `clio-coder telemetry import <archive>` | Verify every bundle in a share archive as `telemetry verify` does, then place its scopes under `telemetry/imported/<install-id>/` in the state directory, keeping any scope already there. Imported scopes never enter your own totals. Exit 0 placed or already present, 1 on a failed verify or a differing scope, 2 on usage. |
| `clio-coder dev evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio-coder dev flywheel [--json] [--kind <kind>[,<kind>]] [--top N]`, `clio-coder dev flywheel --pull <shareId\|all> [--key <pem>] [--store <dir>]`, `clio-coder dev flywheel --sweep\|--forget <reportId> [--store <dir>]` | Print a Usage headline for CLIO Coder (npm downloads, install-script requests, GitHub views and clones over 7 days, stars, forks, open reports, shares on file, the latest release and its share of downloads, stale data sources, the latest weekly digest issue) and the maintainers' ranked backlog from CLIO Coder's files in iowarp/clio-metrics, the CLIO brand metrics hub (`data/projects/coder/`, falling back to the brand-wide files filtered to CLIO Coder), through `gh` (private to the maintainers). `--kind` keeps rows of those kinds and `--top N` (or `--limit N`, default 20) the first N; a `why` column prints under its row, and `file-me` rows, issues the metrics suggest filing, print last with their title ready to paste. `--json` prints `{usage, backlog}`. `--pull` is for maintainers: it reads the pointers in up to 1000 `has-bundle` issues and 1000 discussions, decrypts the shares public pointers name with the intake key, imports telemetry shares and keeps verified report bundles in the private intake store (`~/.local/share/clio-intake/store`, bundle bytes ignored by git); `--pull` and `--sweep` honour reporters' deletion requests and delete debug-only bundles 90 days after their issue closed or at 180 days, and `--forget <reportId>` deletes one on request. |
| `clio-coder extensions init\|validate\|test\|view\|list\|discover\|run\|install\|enable\|disable\|remove` | Author and check an extension (`init <id> [--template status\|hook\|panel\|tool\|workspace]`, `validate <path> [--json]`, `test <path>`), manage installed extension packages, or run an extension command with `run <id> <command> -- [arguments]`. `install` prints what the package may do (its capability envelope) before it writes. A model shell call that runs `extensions test` or `extensions validate` asks the operator first, because both run package code. `list`, `install`, `enable`, `disable` and `remove` take `--user` or `--project`. A project copy loads only after `clio-coder config trust extensions` approves the project's extension state, and an operator `install --project` into new or already trusted state can approve the identities it writes. `list` shows an unapproved project copy as `untrusted`. See [Extensions](harness-extensions.md). |
| `clio-coder library list\|search\|components\|register\|inspect\|validate\|install\|import\|update\|enable\|disable\|drift\|pin\|remove\|reload` | Manage packages of kind plugin, extension, skill, agent, prompt or playbook at user/project scope (`--user`, `--project`); `list` and `search` take `--kind <kind>`, `components [query]` takes `--kind skill\|agent\|prompt\|playbook`, `--source core\|package\|user\|project\|compat` and `--all`. `install`, `import`, `update`, `enable`, `disable` and `remove` accept `--dry-run` to preview; `install` also takes `--force` and `--with-requirements`; `update` takes `--force`. `import <path\|github-tree-url>` takes `--format claude\|codex` and `--yes`. `register`, `pin` and `drift` print text lines unless `--json` is given, and a committed install, update, enable, disable or remove ends with `A running session picks this up after /reload library.` `library skills [--all]` lists runtime skills; `library inventory --json` is the fixed GUI read. `library sync`, `library push` and `library remote confirm <url>` manage a remote library. A project copy loads only after `clio-coder config trust plugins` approves the project's plugin state; an operator project `install` into new or already trusted state can approve the identities it writes, and `import` never does. Run by the model through a shell, `install`, `import`, `update`, `remove`, `enable`, `disable`, `pin`, `register`, `sync`, `push` and `remote` ask for one-shot confirmation, and `--dry-run` never asks. See [Resource library](resource-library.md). |
| `clio-coder gui [--path </app/path>] [--open\|--no-open] [--foreground]` | Start the graphical application, an opt-in alpha for power users listed under `clio-coder --help --all`; the terminal UI stays the primary interface and nothing starts the application unless you run it. Also `gui background install [--open] [--port <1-65535>]`, `gui background status\|start\|open\|restart [--if-idle]\|stop\|uninstall` and `gui launcher install\|status\|uninstall`. See [Graphical application](#graphical-application) and the [GUI guide](gui.md). |
| `clio-coder session list [--json] [--stale]` | List the open sessions that keep a heartbeat under the state directory, on this node or any node that shares it: id, host, pid, surface, start time, heartbeat age, state (`live`, `stale <age>`, `terminating`) and working directory. `--stale` shows only sessions whose heartbeat is older than 3 minutes; `--json` adds `ageMs`, `skewMs` and the clock offset against the state directory. |
| `clio-coder session history\|show\|export\|artifacts\|rename\|fork\|rm\|compact` | Manage persisted sessions from the shell. `<session>` is an id, a unique id prefix or a session name in this directory, and `--all-projects` widens the read verbs only. `history [--all-projects] [--limit N] [--json]` lists them; `show <session> [--transcript] [--json]` prints one; `export <session> [--format md\|html\|jsonl] [--out <path>]` writes a transcript; `artifacts <session> [read <id>]` lists or reads its artifacts; `rename <session> <name>` names it; `fork <session> [--at <turnId>] [--name <name>]` branches a new session; `rm <session> [--yes]` asks first and never removes a session open elsewhere or one with forks; `compact <session> [--instructions <text>] [--json]` summarizes older history and refuses a session open elsewhere with `session_live`. Each verb takes `--json`. |
| `clio-coder session terminate <id> [--force] [--reason <text>] [--json]` | Ask an open session to end. Without `--force` the request is a file the owner reads on its next beat (every 15 seconds), and a same-host owner also gets SIGTERM; no signal crosses hosts. `--force` releases a session whose owner cannot answer: a pid provably gone on this host, or a foreign heartbeat stale for over 3 minutes with trustworthy clocks. It frees that owner's capacity, state, fleet and checkout leases, fences the old owner so a woken process writes nothing, and names `clio-coder run --resume <id>` to resume it. A live same-host pid refuses `--force` with exit 2. |
| `clio-coder report [bug\|feature\|question] [--title <t>] [--body-file <f> \| -] [--session <id> \| --last] [--bundle none\|mechanics --consent debug\|dataset [--share] ...] [--dry-run] [--yes] [--json] [--on-duplicate comment\|new\|stop] [--reply-check]`, `clio-coder report status\|show\|send\|forget\|sweep\|selftest\|security` | Preview, then send a bug report, feature request or question to CLIO Coder's maintainers on GitHub. Nothing is sent before you choose send in a terminal or pass `--yes`. When the search finds an open report of the same problem, or a fixed one this would regress, a terminal asks; with `--yes`, `--on-duplicate` decides and defaults to `stop`. `--yes` never sends a draft the review would refuse or an agent's draft, and a diagnostic bundle stays on this machine unless `--share` sends it encrypted to the maintainers, with the report or later with `report send <id> --share` for a saved draft. `report status` and `report show` read local state; `report status --refresh` asks GitHub where each open report stands, and `report sweep [--json]` deletes every expired report gist and bundle. See [Report a problem to the maintainers](troubleshooting.md#report-a-problem-to-the-maintainers). |
| `clio-coder usage report [--repo <path>] [--days <n>] [--json]` | Read-only report over the window from the telemetry read model: tool decisions, approvals, settled runs, tokens and spend, for one repository or all of them. The window defaults to 30 days; `--json` emits the read model's report DTO. |
| `clio-coder share export --out <path> [--project\|--user\|--both] [--context] [--prompts] [--skills] [--agents] [--playbooks] [--settings] [--extensions] [--all] [--dry-run] [--json]` | Export project context, prompts, skills, agents, playbooks, settings fragments, and extension packages. `--dry-run` lists what the archive would hold and writes nothing. |
| `clio-coder share import <path> [--dry-run] [--force] [--project\|--user] [--json]` | Import a share archive with conflict reporting. |
| `clio-coder share inspect <path> [--json]` | Inspect a share archive without importing it. Each share command refuses, with exit 2, a flag it does not use. |
| `clio-coder context` | Show project context status, preload class, codemap freshness, the codemap digest when present, and handbook freshness: `never verified`, or the commit `context init --verify` last checked, how many commits HEAD has moved since, and how many rules it flagged stale or contradicted. It reads that record from the repository root, whatever directory it runs in. |
| `clio-coder context init [--preview] [--heuristic] [--json] [--adopt] [--global\|--include-global] [--propose\|--apply\|--rewrite] [--depth quick\|standard\|deep] [--target <id> [--model <id>] [--thinking <level>]]` | Explore the repo and bootstrap or update project context: `CLIO-CODER.md`, `.clio-coder/codemap.json`, and `.clio-coder/state.json`. `--depth` bounds the model's exploration: `quick` allows 8 tool calls and 2 minutes, `standard` (the default) 16 and 4, `deep` 32 and 8. The time limit doubles at `medium` and `high` thinking and triples at `xhigh` and `max`, and its last quarter is reserved for the model to submit its draft. Any other value exits 2. When sibling handbooks were read, the summary counts their rules by verdict, lists each dropped, contradicted or merged rule with its source file, line and reason (20 lines, then how many more the ledger holds), and names the handbooks it read, which CLIO Coder never modifies; `--json` and a proposal's sidecar carry the same report as `absorb`. A proposal's summary names the command that writes it. |
| `clio-coder context init --verify [--apply] [--json]` | Re-check every rule of the effective handbook against the current tree without a model call, from the repository root whatever directory it runs in. Citations must resolve in the tree itself (a codemap entry for a deleted file does not count, a codemap symbol counts only while its file still names it, and no instruction file such as `AGENTS.md` or `CLAUDE.md` is evidence); a citation that a negated add, create, install, import or similar verb takes as its object, as in "Never add `lodash`", is not checked, but one after without, before, from or when is ("Never import from `legacy-utils`"), and a rule whose only citations are forbidden ones is unverifiable; tree-fact claims must match the tree, and checker ids must exist. Each rule is listed as verified, stale, contradicted or unverifiable with its file and line; a rule over 600 characters, or an introduction with no list under it, is unverifiable. The verdicts and commit are recorded in `.clio-coder/state/handbook-ledger.json`, and a later `context init` keeps that record, except that writing the handbook drops the verdicts for that file, as `--accept` does. Exits 1 when any rule is stale or contradicted. `--apply` writes a proposal for each handbook file without the flagged rules (an introduction goes with its list, and a removal never reaches into a fence or table), rewrites a rule whose only fault is a renumbered checker id, prints the diff and the `--accept` command; the handbook itself is not changed. |
| `clio-coder context init --accept [<proposal path or id>] [--json]` | Write a reviewed `.clio-coder/proposals/` draft (the newest when no path or id is given) byte for byte to the handbook it was drafted for: `CLIO-CODER.md` for a `context init` draft, the verified file for a `--verify --apply` draft. Refuses, exit 1, when that handbook changed since the draft was written (its hash no longer equals the sidecar's `sourceHash`) or the draft was edited, or when the handbook cannot be read; draft it again then. The hash covers the file's bytes. Accepting a `context init` draft records its generation as the handbook's last bootstrap, and accepting any draft drops the last `--verify` verdicts for the file it replaced until `--verify` runs again. |
| `clio-coder context refresh [--wiki]` | Rebuild the codemap and state without touching `CLIO-CODER.md`; with `--wiki`, update an existing Markdown wiki. |
| `clio-coder context wiki [--update\|--retry-pending] [--replan] [--status] [--depth auto\|simple\|medium\|detailed] [--target <id>] [--model <id>] [--thinking off\|low\|medium\|high]` | Generate, update, or inspect the agent-authored Markdown wiki under `.clio-coder/wiki/`. |
| `clio-coder context reset [--all] [--yes]` | Clear accumulated project context artifacts; `--all` also removes `CLIO-CODER.md`. `--yes` (or `-y`) answers every confirmation and is required when stdin is not a terminal. |
| `clio-coder context index [--json]` | Build the structural codemap index without model calls; writes `.clio-coder/codemap.json` and `.clio-coder/state.json` and prints coverage plus a structural hash. |
| `clio-coder context map [--out <path>] [--json]` | Create a native interactive HTML codebase map without model calls. |
| `clio-coder context replay (--sessions <path>... \| --synthetic <ids>) [--policies <ids>] [--profile <id>] [--budgets <tokens>] [--threshold <ratio>] [--target <ratio>] [--protect-last-turns <n>] [--protect-last-steps <n>] [--min-evictable-tokens <n>] [--rearm-fraction <ratio>] [--overflow-fraction <ratio>] [--seed <n>] [--no-filter] [--json <out>] [--md <out>]` | Replay working-set policies over CLIO Coder session ledgers or the seeded procedural corpora and report retention, precision, token savings, recall cost, cold-prefix cost, saturation, and summary headroom. Non-default profiles include paired default-profile comparisons. |
| `clio-coder context working-set --session <id\|path>` | Inspect one session's durable working-set fold and path-index summary without modifying the ledger. |
| `clio-coder context working-set --verify <id\|path>` | Render the session at each dispatched attempt's cursor and compare it with the receipt journaled at send. Each attempt reports verified, not-verifiable with a reason, external, or mismatch, and fold decisions are reconciled with the ledger's fold records. Exits 1 on any mismatch. |
| `clio-coder store tags\|ls\|stat\|history\|verify\|put\|get\|rm\|rm-tag ...` | Read and manage the project store visible from the current directory: this project's tags and blobs, shared by the main checkout and its task worktrees. See [Store](store.md). |
| `clio-coder semantic configure\|inbox\|refresh\|reembed\|search\|status\|qualify` | Opt-in semantic indexing (beta). No command enables scans on startup; `refresh` indexes registered sources only when you run it. See [Semantic context beta](semantic-context.md). |
| `clio-coder worker` | Internal. The native worker stream server: a WorkerSpec on stdin, NDJSON on stdout. SSH placement launches it on a remote installation. It is not an operator command. |

An unknown subcommand prints `unknown subcommand: <name>` and the command page to stderr and exits 2. `clio-coder -p`, `--print`, `--prompt` and bare task text are refused with a pointer to `clio-coder run "<task>"`. `context-init`, `context-index` and `context-clear` were removed; use `context init`, `context index` and `context reset`. `fleet inspect` was removed; use `fleet status --json [--all]` or `telemetry inspect --run <runId> --json`. `evidence build` was removed; use `evidence inspect <runId>`.

Without `--cwd`, ACP binds the first session's absolute workspace path before it loads project settings or tools. `--cwd PATH` binds the workspace when CLIO Coder starts.

ACP frontends can list, load, resume, and delete sessions through the stable session methods. CLIO Coder offers `default` and `yolo` as ACP modes. A frontend can change autonomy with `session/set_mode` or the `autonomy` configuration option (category `mode`). The `model` and `thinkingLevel` options (category `thought_level`) change only the hosted session; saved defaults stay as they were. Mode and option changes are refused with `prompt_active` while a prompt is running. Choosing `yolo` counts as the operator's yolo acceptance and runs contained unless the operator's own settings chose and accepted unconfined yolo; it is refused with `yolo_refused` when CLIO Coder runs as root outside a container.

Across `run`, the lifecycle commands and most other commands, a usage error prints one `clio-coder <command>: ...` line with a help pointer, and one failure document under `--json`.

The startup flags `--api-key`, `--no-context-files` (`-nc`), `--no-skills` and `--skill` apply to the interactive session, `clio-coder run` and `clio-coder acp`. `--with-panes` applies to the interactive session alone. A startup flag given before any other subcommand is refused with exit 2 and a message naming the flag and the subcommand, because that command would ignore it.

### Pane launch flags

`clio-coder run` does not read the startup flag `--with-panes`. Given before
`run`, it is refused with exit 2. The retired `--no-panes` is an unknown option
and exits 2 everywhere.

`--with-panes` is an explicit first-class launch mode, not permission to start a
pane server. CLIO Coder confirms `HERDR_ENV=1`, connects to an existing socket, and
pings it before registering pane tools. The workers dock runs
`fleet view --watch` against a selection file. CLIO Coder writes the requested run id and
the session scope into that file, while the dashboard reads the ledger, run journals and
run feeds itself, so dispatch remains independent of the pane host and a second
terminal can use the same journal surface directly.
Bare `clio-coder` in an interactive terminal opens its own private
pane host on the pinned herdr, and continues in the plain terminal when
it cannot. A home that never had panes is not given them at launch: a pane feature
such as `/panes`, `/files` or Alt+E says they are not installed and names
`clio-coder panes install`, which adds them; launch itself does not repeat it. A
second `clio-coder` in a folder whose pane host another open terminal still
shows gets its own pane host and its own session, up to four per folder; a
fifth runs without panes (see
[A second terminal in the same folder](panes-and-files.md#a-second-terminal-in-the-same-folder-gets-its-own-panes)). Started from a
pane of the operator's own herdr, it opens its host nested there with the
prefix `ctrl+shift+b`. Use `--with-panes` only to join, as a guest, a herdr
session CLIO Coder is already inside. The pane contracts are in
[Panes and the Files Pane](panes-and-files.md).

### Graphical application

`clio-coder gui` opens the local browser application. It reuses this installation's owned background application when one is installed and otherwise starts a private foreground server that stops with Ctrl+C. A browser opens by itself only from an interactive terminal on a desktop; `--open` always opens one and `--no-open` never does. `--foreground` selects a private server explicitly, as do `--port`, `--idle-exit <milliseconds>`, `--token-stdin` and `--log-file`. `--path </app/path>` opens a particular page; under WSL, when `gui` reuses the background application and its window is already open, `gui` brings that window to the front and `--path` shows the page in it, while a bare `gui` leaves the window on the page it shows. `--reuse-background` fails instead of starting a private server when the background application cannot be used.

| Subcommand | Effect |
| --- | --- |
| `gui background install [--handover] [--open] [--port <1-65535>]` | Install the optional login service: a systemd user unit on Linux, a launchd agent on macOS, a Task Scheduler logon task on Windows. `--handover` takes over a verified idle service that another installation owns and keeps its address and credentials. The stable address is `127.0.0.1:4343`, or `127.0.0.1:7373` while another program holds it; `--port` replaces 4343 as the first choice. |
| `gui background status\|start\|open\|stop\|uninstall` | Inspect, start, open or stop the service, or remove it together with its login, desktop and Windows entries. |
| `gui background restart [--if-idle]` | Load a newly installed version; `--if-idle` leaves the service alone while work or a conversation is open. |
| `gui launcher install\|status\|uninstall` | Manage a desktop entry. |

Background install uses a systemd user unit on Linux, a launchd agent on macOS and a logon task on native Windows. On native Windows `gui` prints the link instead of opening it unless `--open` is given. The graphical application needs a build that includes it: without `dist/gui/server.js` the command exits 2. The application's pages, guided setup, settings and attended-session behavior are in the [GUI guide](gui.md).

### Project trust

Five project surfaces carry operator authority. CLIO Coder ignores an unapproved
surface in a workspace. Settings, safety and hooks require approval of their
exact bytes; extensions and plugins use package identities as described below.
A sixth, `handbook`, pins a repository's handbook bytes for work that reaches
it from a session started in another repository; until it is approved there,
that work carries only the rules the repository's tree verifies. Run
`clio-coder config trust handbook` in that repository. The startup card does
not list it.

When the terminal app opens a workspace whose surfaces are untrusted or have
changed since approval, one card lists them before the session starts:
settings by top-level area and each connection's address, safety by rule
counts, hooks by event and command, and extensions and plugins by name. A
surface that changed is marked `changed since you trusted it`. **Review** (the
default) prints each file in full, and for hooks the repository scripts the
hooks file names, whose bytes the approval pins, then returns to the card; **Trust all** records
the same approvals the `--hash` form below records and applies them to this
launch; **Open without it** (also Esc) starts without them, and the header
reads `Project configuration not active · /trust` instead of a notice per file.
`q` or Ctrl+C quits without opening a session and exits 1. In the session,
`/trust` opens the same card: Enter on a surface shows its summary and files in
full, **Trust all and restart** records the approvals and restarts into the
session as `/restart` does (when the restart is refused, the header reads
`Project configuration trusted · restart Clio to apply it`), and **Not now** or
Esc trusts nothing. `/reload` raises the card by itself only when a surface is
new or has changed since the session started or since the card was last closed
without trusting. After **Trust all**, and whenever a session starts with the
project's configuration trusted (as after `/trust`'s restart), CLIO Coder names what
each project connection still needs from you: a missing key or sign-in with its
command, or, for a connection at an address the project chose, that it receives
none of your keys until you define it in your user settings. Headless runs,
ACP and the GUI keep the per-file notices.

| Surface | Files |
| --- | --- |
| `safety` | The nearest `.clio-coder/safety.yaml`, searching up from the workspace root. |
| `hooks` | `.clio-coder/hooks.yaml` and `.clio-coder/hooks.local.yaml`. |
| `settings` | `.clio-coder/settings.yaml` and `.clio-coder/settings.local.yaml`. |
| `extensions` | `.clio-coder/extensions/state.json`, the install state of the project's extensions. |
| `plugins` | `.clio-coder/plugins/state.json`, the install state of the project's library packages. |

A surface that was never approved, or whose files changed after approval, is
ignored, and CLIO Coder reports it with the command that reviews it.
`clio-coder config inspect` lists an ignored project settings layer beside the
settings it failed to change. Each settings row names a dotted path. A map key that is not plain letters, digits, underscores and hyphens, such as a target id containing a dot, appears in JSON brackets (`targets["gpu.lab"]`), so a dotted key is never read as nested keys.

| Command | Effect |
| --- | --- |
| `clio-coder config trust <surface>` | For settings, safety and hooks, print the captured snapshot as JSON (`workspaceRoot`, `surface`, `files` with `path`, `text` and `hash`, `contentHash`, `verdict`). When files are readable, `Review the captured files above. Approve exactly these bytes with:` and the approval command follow. For extensions and plugins, list each installed package's enabled state, source, origin, trust, content digest and envelope digest; plugins also show kind. Disabled packages are included in the review. Read-only. |
| `clio-coder config trust <surface> --json` | Print the snapshot with no approval line. Extension and plugin snapshots also include `packages`. Read-only. |
| `clio-coder config trust <surface> --hash <sha256>` | Approve exactly the reviewed bytes and print `Project <surface> approved for <workspace> at <digest>.` with a reload hint. It exits 1 with `project <surface> changed since review; inspect it again before approving` when the bytes differ from the digest, and with `no readable project <surface> files to approve` when none of the files is readable. |
| `clio-coder config trust <surface> --revoke` | Remove the approval for this workspace and print `Project <surface> trust revoked.` with a reload hint. It exits 0 when no approval existed. |

Approval is per surface and per canonical workspace. Trusting one surface never
trusts another, and trusting a parent directory never trusts a child workspace.
Settings and safety take effect at the next restart. A revoked hook stops
before its next execution, and a newly approved hook registers when extensions
reload. Approved `extensions` apply on `/reload extensions` and approved
`plugins` on `/reload library`. A missing or unknown surface name prints
`usage: clio-coder config trust safety|hooks|settings|extensions|plugins|handbook [--json | --hash SHA256 | --revoke]`,
and any other argument form, including a `--hash` value that is not 64 lowercase
hexadecimal characters, prints `trust expects --json, --revoke, or --hash followed by the full reviewed SHA-256 digest`.
Both exit 2.

The `extensions` and `plugins` surfaces approve package identities, including
content, origin, trust flag, capability envelope and plugin kind. Reinstalling
identical content, disabling or removing a package preserves that consent.
Enabling a previously unapproved identity or changing an identity needs approval.
Until a surface is approved, its project packages do not load and a user-scope
package with the same ID keeps loading. An operator install into a workspace
with no install state, or with trusted state, can approve the records it wrote
while they still carry the installed content digest. A record another writer
replaced stays unapproved. A task worktree that CLIO Coder created inherits its origin's
approval when its enabled package identities are covered, or its state file is
byte-identical to the approved origin. Archive imports, `library import` and
`interop adopt` never approve. The details are in the [safety model](../architecture/safety-model.md),
[extensions](harness-extensions.md) and [library packages](resource-library.md).

Approval records live under the CLIO Coder config directory, in
`workspace-trust/`, and are written only by this command, by CLIO Coder's own
project settings saves and by the operator-install approval above.

### Research insights

`clio-coder telemetry insights` gives each session one category: data analysis, writing and communication, data gathering, reading and knowledge acquisition, theoretical analysis, design and development, ideation and hypothesis generation, other, or non-research software work. The rules live in `src/domains/telemetry/insights.ts` and are deterministic, so the same journals always give the same output. They read only content-free records: which tools ran (a gateway call counts the capabilities it invoked), the kind of file each write or edit touched by its extension, the declared kind of each verify check, the skills loaded, worker runs and their agents, approvals, operator message counts and the autonomy mode. The verified-outcome share uses the same count as the `Session verified` row of the exit summary, read through a projection of the session ledger that keeps check verdicts, payload digests, run ids and task statuses and copies no text.

A session counts as research when it used `data`, `run_script` or a science MCP server (data, literature, catalog or HPC servers, recognized by server name), ran a passing `reproduce` or `numeric-compare` check, wrote prose (`.md`, `.tex`, `.bib`, `.rst`), a notebook or a data file, read the web, loaded a research skill, or delegated to a research worker. Among research sessions each category scores its own signals and the highest wins. A session with tool calls and none of those signals is non-research software work, and one with no tool call is `other`.

Autonomy is 1 for a session with no tool call. Otherwise fewer than 3 tool calls per operator message gives 2, fewer than 10 gives 3, and more gives 4. Delegating to a worker or running at autonomy `yolo` adds 1. When more than a tenth of the tool calls waited on an operator's own approval, it drops by 1, never below 2.

Known confusions, as found on recorded sessions:

- Sessions recorded before tool calls carried the file kind, check kind, skill and gateway capability show only their tool mix and are marked `facets not recorded`. Their `data`, `web_fetch` and MCP calls read as an opaque gateway call, so sessions that inspected HDF5 or Parquet data, or searched the literature through a skill, read as `other` or as software work.
- An older session whose only signal is `verify` reads as data analysis only when a `reproduce` or `numeric-compare` pass was counted; a failing check or a `command` check leaves it `other`.
- HPC work driven through `bash` with no science tool, skill or data file reads as non-research software work.
- Headless runs carry one operator message each, so their autonomy follows the tool count alone. A headless approval is denied by policy, not decided by the operator, so it never lowers the level, and a denied call is not a tool call.
- `clio-coder run --agent` dispatches a standalone run with no session, so it does not appear.
- No recorded session reached theoretical analysis or ideation and hypothesis generation. The first is assigned only through a skill whose name names proofs, derivations or theory; the second through `decide` or `consult` calls or an ideation skill.

## Headless Run Flags

`clio-coder run --help` prints this contract, and `clio-coder help run --topics` prints its long-form notes. `run --json` and `run --json-events` were removed; use `--output-format json` or `--output-format stream-json`.

| Flag | Meaning |
| --- | --- |
| `-` | Read stdin. `run -` takes the task from stdin, and `run "<task>" -` appends stdin after the task as a `<stdin>` block. A pipe without `-` is ignored. See [Headless Prompt Assembly](#headless-prompt-assembly). |
| `--task-file <path\|->` / `--trust-task-file` | Read the run from a version 1 JSON task envelope (`schemaVersion: 1`), from a file or from stdin with `-`. Its keys mirror the run flags: `task`, `attachments`, `verify`, `route`, `session`, `permissions`, `limits`, `output`, `cwd`, `mode`, `agent` and the rest that `clio-coder schema task` lists. A key set both in the file and on the command line exits 2 naming the key. An envelope that carries `verify`, `permissions.autonomy: "yolo"` or `cwd` widens what the host does and exits 2 (`task_authority`) unless `--trust-task-file` is passed. |
| `--cwd <dir>` | Enter `<dir>` before the run resolves anything against the working directory, the way `acp --cwd` does. Applies to the main agent and to `--agent`. See [Headless Working Directory](#headless-working-directory). |
| `--target <id>` | One-run main-agent or dispatch target override. |
| `--model <wireId>` | One-run model override. |
| `--thinking <level>` | One-run thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--autonomy <level>` | Main-agent one-run autonomy override: `default` or `yolo`. It does not change saved settings. A headless run takes `yolo` only from this flag: a `settings.yaml` that sets `yolo` runs at `default` and says so on stderr. `--autonomy yolo` as root outside a container exits 2. Combining it with `--agent` is a usage error; use `--read-only` to restrict a dispatch. |
| `--systemone <engine\|off>` | System One for this main-agent run: `jev`, `memory`, `main`, an engine, a target, or `off`. See [System One](system-one.md). |
| `--read-only` | Apply CLIO Coder's mediated read-only ceiling. The main agent's writes, edits and asks are refused, its shell commands run only in the read-only sandbox, its delegations run read-only on runtimes that can enforce it, and only MCP tools the operator classes as read are admitted. A third-party read-class server or other external process is still trusted for its classification; see the explicit boundary in [Read-only runs](../architecture/safety-model.md#read-only-runs). A refused call returns to the model and does not itself fail the run. With `--agent`, restrict the dispatch to read-only tools. `--record`, `--worktree`, `--agent-profile`, `--agent-runtime`, `--tool-profile` and `--require` need `--agent` (`fleet dispatch flags require --agent <recipe-id>`). |
| `--temperature <n>` / `--top-p <n>` / `--top-k <n>` / `--min-p <n>` | One-run sampler overrides when the selected runtime supports them. `--temperature` takes a number of 0 or more, `--top-p` and `--min-p` take 0 to 1, and `--top-k` takes a number of 0 or more, rounded down. They reach the main agent and an `--agent` worker alike. |
| `--presence-penalty <n>` / `--frequency-penalty <n>` / `--repeat-penalty <n>` | One-run penalty overrides when the selected runtime supports them. They reach the main agent and an `--agent` worker alike. |
| `--max-context-tokens <n>` | Cap this run's context budget at a positive integer of tokens without enlarging the server window. The cap lowers the effective window when the route's window is unknown or larger. |
| `--output-format text\|json\|stream-json` | Select the output. `text` (the default) prints the answer on stdout and ends with one stderr line, `clio-coder run: session <id> · <outcome> · <N> requests · <in>/<out> tokens · <cost or unpriced>`. `json` writes one `run_end` result envelope (`schemaVersion: 2`) with `exitCode`, `outcome` and `causes[]`. `stream-json` writes a `session` frame, the event frames, then that envelope (with `--agent`, the run's `RunResult` is in `dispatch.runs`). See [The `run_end` frame](exit-codes-and-output.md#the-runend-frame). |
| `-o <path>` / `--output-last-message <path>` | Write the final answer to `<path>` when the run exits 0. With `--output-schema` the file holds the validated JSON. A path that cannot be written exits 2 before boot. |
| `--output-schema <file.json>` | Require the final answer to be one JSON object valid against this schema, which the host validates. The main agent gets one repair turn with no tools, and an `--agent` answer is validated once; a mismatch exits 1 with cause `schema_mismatch`. The schema needs root type `object`, `$ref` only to `#/$defs/`, and at most 64 KiB; any other schema exits 2 with cause `schema_unsupported` before any model request. The envelope carries the object as `result.structured` beside `result.enforcedBy`. |
| `--resume <id\|prefix\|name>` / `-r` | Append this turn to an existing session, named by id, unique id prefix or session name. A session another process holds open exits 2 with cause `session_live`. |
| `--continue` | Append this turn to the most recent session for the current working directory. After a yolo run stopped at its autonomous cap (exit 4) or by a judge streak (exit 3), it resumes with a fresh window. With `--agent`, `--continue <runId>` continues that earlier ACP delegation in its peer's own session (`session/resume` when the peer offers it, else `session/load`). |
| `--fork` | With `--resume` or `--continue`, branch a new session from that session's last committed turn and run there. The parent is read, never written, and may be open elsewhere. The `run_end` envelope names it as `parentSessionId`. |
| `--name <text>` | Name this run's session: the new, resumed or forked one. |
| `--exit-code` | Exit 1 when the main-agent run ends 0 but its sealed completion state is `partly_done` or `not_done`. A `done` claim the host lowered to `partly_done` counts; `done` and an undeclared run keep 0. Main agent only; with `--agent` it is a usage error. See [Completion and `--exit-code`](exit-codes-and-output.md#completion-and---exit-code). |
| `--fail-on-noop` | Exit 1 when the main-agent run was a no-op, and seal its run record as `failed` with `outcomeDetail: "noop"`. Main agent only; with `--agent` it is a usage error. See [Headless No-op Runs](#headless-no-op-runs). |
| `--timeout <duration>` | Wall-clock limit for the whole run, counted from process start, boot included. The value is a duration: `90`, `90s`, `15m`, `2h` or `500ms`, and a bare number is seconds. On expiry the run starts the coordinated shutdown a SIGTERM starts, seals its run record with outcome `timed_out`, and exits 124. A `--verify` check still running at the deadline is stopped and reads skipped. The limit may be no longer than 2,147,483 seconds (the timer ceiling in `src/core/timers.ts`); anything else is a usage error. With `--agent`, expiry aborts the worker and waits for it to settle, so the run is recorded as canceled before exit 124. |
| `--verify "<cmd>"` / `--verify-timeout <duration>` | Declare a shell command as this run's acceptance check, named `run-acceptance` (repeat the flag for `run-acceptance-2` and on). Nothing is written to `.clio-coder/verifiers.yaml`. The finish gate treats it like a declared verifier: when the agent changes files and then runs the command through bash, whole, after its last edit, that counts as a check, read like any other check: behind `timeout`, `time` or `nice`, piped to `tail`, or logged with `tee` or a redirect. Once the turn settles, the run itself runs each check with bash in the run's cwd, up to `--verify-timeout` each (default 300s, a duration as `--timeout`), and reports `{id, command, exitCode, passed, durationMs, timedOut, ranAfterLastEdit}` in a `{"type":"verify","checks":[...]}` frame under `--output-format stream-json` (the `run_end` envelope's `verify.checks` gives each check a `status`), and as one stderr line per check in text mode. `ranAfterLastEdit` is true when the agent itself ran the check after its last edit. The run's receipt seals the results as its host verification, which outranks the agent's own checks in `verification` and `evidence inspect`. A failed check does not change the exit code unless `--fail-on-verify` is passed; an interrupted run skips the checks. Main agent only; with `--agent` it is a usage error, and `--verify-timeout` without `--verify` is one too. |
| `--fail-on-verify` | Exit 1 with cause `verify_failed` when a `--verify` check failed or timed out. A check that a cancellation or the deadline skipped never counts, nor does a failure the run's starting commit fails the same way, which reads `not_implicated` with `base.status: failed`. Main agent only. |
| `--on-permission deny\|fail` | `deny` (the default) refuses an ask a headless run cannot approve and lets the turn go on. `fail` ends the run at the first such ask with exit 3 and cause `permission_required`. Main agent only. |
| `--dry-run` | Print what the run would do (route, admitted tools, delegated tools, autonomy, sandbox mode, limits and `--verify` checks) and exit 0. No session is created, no model is called and no check runs. Under `--output-format json` it is the `run_end` envelope with outcome `previewed` and a `plan`. Main agent only. |
| `--sandbox required` | Pin `safety.sandbox: required` for this run and its workers. It only tightens the setting. A host without an OS sandbox exits 2 before boot. |
| `--require-priced` | Refuse any unpriced route this run can reach, with exit 2 naming them: chat and compaction with `--no-delegate`, the fleet routes too otherwise, and the previewed route with `--agent`. Each dispatch is also refused at admission when its resolved route is unpriced. |
| `--max-requests <n>` | Cap the provider requests the main agent loop may send in this run, counted once per attempt. Retries, compaction, side calls and workers do not count. Reaching it exits 4 with cause `max_requests`. Refused with `--agent`. |
| `--max-tool-calls <n>` | Cap the tool calls the main agent may make in this run, refused ones and each call of a parallel batch included. A batch that would pass the cap does not run. Reaching it exits 4 with cause `max_tool_calls`. `safety.limits.chatToolCallsPerTurn` still applies per turn. Refused with `--agent`. |
| `--max-cost-usd <n>` | Positive finite USD cap on the priced spend this run adds. Reaching it stops the run with exit 4 and cause `max_cost_usd`. CLIO Coder warns about unpriced routes the cap cannot bound. With `--agent`, the worker's route is admitted only when its conservative cost estimate is under the cap. |
| `--answers <file.yaml>` | Answer the questions only the author may answer (extension interviews and `operator_only` `ask_user` questions) from this file. An author question the file does not script ends the run with exit 5. Main agent only. See [Script the author with --answers](#script-the-author-with---answers). |
| `--agent <recipe-id>` | Dispatch a user-facing fleet agent instead of the main agent. Unknown ids and shadow agents (`oracle`, `provenance`, `researcher`, `scout`, `world-knowledge`) fail fast; for their read-only work use `--agent coder --read-only`. |
| `--skill <path>` | Make one explicit skill file or skill directory available for this run. Repeatable; the model loads its instructions with `context(scope="skills", name=...)`. |
| `--no-skills` | Disable skill discovery for this run and automatic skill/marketplace prompt guidance while still honoring explicit `--skill` paths. |
| `--turn-mode <mode>` | Main-agent workflow guidance (`answer`, `proposal`, `change`). Guides prompt and turn continuation (`answer` and `proposal` disable autonomous continuation turns; `proposal` renders `tasks` `plan`/`add` as blocked proposals). Not an authorization grant: mutating tools (`write`, `edit`) are not denied by `mode` alone; use `--allow-tools` to restrict execution. `answer` and `proposal` also exempt the run from the no-op verdict; see [Headless No-op Runs](#headless-no-op-runs). See [Turn Constraints](#turn-constraints). |
| `--no-delegate` | Forbid worker delegation (`dispatch`) for this run; the agent must work directly. |
| `--delegate-tools <names\|none>` | Comma-separated capability names the workers this run dispatches may hold, independent of `--allow-tools`; `none` gives them no tools. Main agent only; with `--agent` it is a usage error. |
| `--allow-tools <names\|none>` | Comma-separated allowlist of capability names permitted for this turn, or `none` to disable all tools. Enforces mechanical restriction at admission and runtime. Main agent only; with `--agent` it is a usage error. |
| `--deny-tools <names>` | Comma-separated capability names removed from the main agent's tools whatever else admits them, including from an `--allow-tools` list. Without `--delegate-tools`, workers lose them too. Denying every allowed tool exits 2 (`flag_conflict`). Main agent only; with `--agent` it is a usage error. |
| `--record` | Save a bounded, redacted display asciicast of an `--agent` dispatch. |
| `--agent-profile <name>` | Use a named fleet profile for dispatch. |
| `--agent-runtime <id>` | Pick the first fleet profile whose target uses this runtime. |
| `--tool-profile <name>` | Restrict dispatched-agent tools: `minimal-local`, `science-local`, or `full-agent`. |
| `--require <capability>` | Require a target capability for dispatch. Repeatable. |
| `--worktree` | Run the `--agent` worker in a task worktree CLIO Coder creates, kept on its branch for review. |
| `--steer-channel <path>` | Read live steering lines from a FIFO or an appended regular file to steer the active run. Under `--output-format stream-json`, each line is acknowledged with a `steer` frame: `queued`, then `accepted`, or `refused` with a reason. |

### Limit cost for one headless run

Use `clio-coder run --max-cost-usd 1.50 "<task>"` to cap additional priced spend for a main-agent run. The value must be positive and finite; omitting it adds no run cap. The configured session ceiling (`safety.limits.sessionCostUsd`, default 5 USD) still applies, including earlier spend when continuing a session. The run cap counts only spend added by this invocation.

The main agent, compaction and dispatched workers are admitted while below the cap; reaching it stops the run with exit `4` and cause `max_cost_usd` and stops running workers. Calls already in flight can take spend past the cap, including one per running worker and the main agent's call. Unpriced routes cannot be bounded. Stderr names configured unpriced routes, but the preflight warning cannot cover a model the main agent later names for one dispatch. With `--agent`, the worker's route is admitted only when its conservative cost estimate is under the cap. `--require-priced` refuses unpriced routes up front. See [budget.ts](../../src/domains/scheduling/budget.ts) and [run.ts](../../src/cli/run.ts).

### Script the author with --answers

A headless run has no operator, so permission asks are denied and `ask_user` is not registered. `clio-coder run --answers <file.yaml>` scripts the author instead. It answers only the questions the author alone may answer: an extension's interview steps (its gate questions) and the `ask_user` questions the model marks `operator_only`. With it, `ask_user` is registered and extension interviews are asked, and each author question is answered from the file.

```yaml
answers:
  - id: plan-introduction          # an extension question's checkpoint id
    choice: Approve this plan as shown
  - header: Research question      # the question's header, exactly
    note: Does tiered caching cut tail latency?
  - match: "^Accept the"           # a regular expression over the question text
    choice: Keep it pending
```

The file is a mapping with one key, `answers`, a non-empty list. Each entry names exactly one rule:

- `id` matches an extension question's `checkpoint` ([checkpoints](harness-extensions.md#checkpoints-and-scripted-answers)).
- `header` matches the question's header exactly. An extension question's header is its label.
- `match` is a regular expression over the question text.

Each entry gives a `choice`, a `note`, or both. `choice` is an option label, or a list of labels for a multi-select question. `note` is typed text: beside the choice, or the whole answer to a question without options. The first entry in file order whose rule matches answers the author question as the operator, and the answer is recorded as scripted, naming the file and the entry (`answers[0] id "plan-introduction"`), on the decision ledger and on an extension's `InterviewAnswer.scripted`. A scripted answer to an `operator_only` question keeps its `operator_choice` mark beside `scripted`.

An author question no entry matches, or whose matching entry chooses an option the question does not offer or several options for a single-choice question, is never answered for you. Its round is cancelled as `unscripted`, the turn stops at the next tool boundary, and the run exits 5 with outcome `failed` and `outcomeDetail: "unscripted"`, naming the question by its header and checkpoint id, or by its first line when it has neither, so the file can be extended. Other calls already in that tool batch still run. Permission asks stay denied. A file that cannot be read or fails validation exits 2 before boot, naming the file and the offending entry.

Rules match author questions only. `id` is bound to an extension's gate, and `header` and `match` reach extension questions and `operator_only` questions alike. The model's ordinary `ask_user` call, one with no `operator_only` question, is never answered from the file, whatever its header or text: the call is refused with a tool error saying the run has no operator, no round is recorded, and the model goes on from the task prompt and its stated defaults, as in a run without the file. Whether a scripted answer counts as the author's is the extension's decision.

### Headless Prompt Assembly

The task is every non-flag argument joined with spaces. An argument that starts with `@` and has a path after it is a file reference, read relative to the working directory: text files follow the task and image files travel as images. The assembled prompt is the task, then the referenced file text, then stdin, joined by blank lines. Stdin is read only when `-` is passed: `run -` takes the task from stdin, and `run "<task>" -` appends stdin to the task as a `<stdin>` block. A pipe without `-` is ignored. An empty assembled task exits 2 with `clio-coder run: empty task; give it as text (run "<task>") or pass - to read it from stdin`. A missing `@file` path, a directory or an unreadable file exits 2 before any model call.

### File References

The same expansion serves `@path` mentions in the interactive composer and in `clio-coder run`. A quoted mention (`@"my file.txt"`) may contain spaces, and trailing punctuation after a plain mention is not part of the path. Each expansion becomes a `<file name="<absolute path>">` block:

- **Text files** up to 256 KiB are inlined whole. A larger text file is named with a note to read it in windows with `read` and `offset`/`limit`, and a warning, not an error.
- **Binary files** (a NUL byte in the file) are named with a pointer to `run_script` and a library for the format, plus the warning `binary file not inlined (<size>)`. They no longer end the run with exit 2.
- **PDFs**, recognised by extension or the `%PDF-` signature, render through the same extractor as `read` and are cut at 32 KiB. The marker `[PDF attachment truncated at 32 KiB; included pages 1-<n>, final page may be partial; use read with pages to inspect more.]` names the pages kept.
- **Archives** (zip, tar, gzip) become the listing `read` would show first, bounded at 32 KiB with the `read` call that continues it. A damaged archive is named with the reason.
- **Empty files** expand to nothing, and a missing path in the composer stays as typed.

PDF extraction can be slow, so it can be cancelled. In the composer the status line reads `reading <file> · Esc cancels and keeps your message`, and Esc, Ctrl+C or shutdown aborts it. In `clio-coder run`, Ctrl+C prints `clio-coder run: interrupted while reading file attachments; nothing was sent` and exits 130.

A task that begins with `/` is checked before boot. A name that is neither a skill invocation nor a prompt template is refused with exit 2: interactive slash commands are `interactive commands are not supported by clio-coder run; use interactive chat or the corresponding CLI command`, and an unknown name is `/<name> is not a command. Type /help for the list.` A display-only prompt template is answered on stdout without booting a provider or calling a model. `\/text` sends text that begins with a slash.

### Headless Working Directory

`clio-coder run --cwd <dir> "<task>"` behaves the same as `cd <dir> && clio-coder run "<task>"`. The process enters `<dir>` before it reads layered project settings, context files, skills, `@file` references, or the session ledger, and every tool path resolves against it. Relative paths in other arguments, such as `--skill`, `--steer-channel`, and `@file`, resolve against `<dir>` as well. The path is canonicalized first, so the run ledger records the physical directory as the run's `cwd`.

Image `@file` references in a headless prompt or stdin require the routed model's image-input capability. CLIO Coder refuses the turn before sending the image when the route is text-only. The run exits nonzero and prints `IMAGE_INPUT_UNSUPPORTED` with the target and model. A turn refused before admission has no run record. When the fleet profile named `vision` (`fleet.profiles.vision`) is configured, that sidecar describes the image and the turn proceeds on the text route.

Inline image references accept PNG, JPEG, GIF, or WebP bytes detected by file signature. CLIO Coder attempts to resize them to at most 2,000 by 2,000 pixels and below 4.5 MiB of base64 before submission; an image that cannot fit is omitted with a note. There is currently no settings key to disable images or change this inline cap.

- A missing path, a file, or a directory the process cannot enter fails with exit code 2 and a message naming the resolved path. No model is called.
- `--cwd` with no value is a usage error with exit code 2.
- An orchestrator that runs CLIO Coder inside a git worktree can pass the worktree path here instead of changing its own working directory before the spawn.
- `CLIO_CODER_HOME`, `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, and `CLIO_CODER_CACHE_DIR` are read as given and are not resolved before the process enters `<dir>`. A relative value therefore points under `<dir>`, not under the directory the driver spawned from. A driver that sets any of them together with `--cwd` must pass absolute paths.

### Headless No-op Runs

Every headless main-agent run record carries a `safety` summary and a `noop` flag, whatever the flags. `safety.decisions` counts how admission decided each call (`allowed`, `blocked` for a safety refusal, `guardBlocked` for a call a tool guard held back, `permissionRequested`; run records written before `guardBlocked` count guard blocks under `blocked`) and `safety.blockedAttempts` lists every call whose outcome was blocked, with its tool, action class, rule, and reason, except a call a tool guard held back: `safety.guardBlockedAttempts` lists those in the same shape and is absent when no guard blocked a call (run records written before it list guard blocks under `blockedAttempts`). These are the names and shapes a dispatched worker's run record already uses. A call that parked for approval and was denied, because a headless run has no operator to approve it or because the run was aborted first, counts under `permissionRequested` every time, including a repeat whose reason the loop guard replaced with its own guidance, and `safety.permissionRequestedAttempts` lists it in the same shape instead of `blockedAttempts`; the field is absent when no ask was denied (run records written before it list denied asks under `blockedAttempts`).

`safety.blockedAttempts` keeps the first 50 blocked calls, and clips each reason to 500 characters. When more calls than that were blocked, `safety.blockedAttemptsTruncated` counts the ones left out; the field is absent otherwise. `safety.guardBlockedAttempts` and `safety.permissionRequestedAttempts` keep their first 50 the same way, and `safety.decisions.guardBlocked` and `safety.decisions.permissionRequested` stay their exact counts. The per-tool `blocked` counts in `toolStats` stay exact either way.

`noop` is true when any of these conditions holds:

- at least one block remains unresolved and no mutating call succeeded,
- a dispatch call failed before any worker started (an unknown `node`, for example), no later dispatch started one, no other substantive call succeeded after it, and no mutating call succeeded, or
- the run called tools and none of them succeeded.

A refusal from the operator's `--read-only` ceiling stays in
`safety.blockedAttempts` but does not add an unresolved block. A redundant repeat
of a successful read withheld by the loop guard also adds no unresolved block.
The separate rule for a run with no successful tools still applies.

A run started with `--turn-mode answer` or `--turn-mode proposal` asked for no
change, so `noop` is always false for it and neither rule fails it, even under
`--fail-on-noop` when every call failed. A blocked
call along the way stays in `safety.blockedAttempts` (a denied ask in
`safety.permissionRequestedAttempts`), and when the run exits 0
stderr names those calls in one line, for example
`clio-coder run: answered with 1 blocked call: bash (yolo-sandbox-required)`.
Without `--turn-mode`, or with `change`, the rules above apply.

A mutating call is a successful call that wrote a path its own arguments name, the run receipt's record of written paths: `write`, `edit`, or a `bash` command whose redirect, `tee`, copy, move, delete, `git mv`, or `git rm` names its target. A `bash` call that names no target does not count, because it says only that a command ran; neither does a `web_fetch`, which writes no workspace path. A terminating result does not count. The `artifact` tool's plan, review, or report is the turn's answer written to a file, so a run whose every edit was blocked and that then wrote a report about it is still a no-op. A run that called no tool and answered in prose is not a no-op. The `observed` line's write count is the number of distinct paths so written, not the number of calls.

A later successful substantive read or command can recover a block of the same
action class. Bookkeeping, discovery, and terminal reports do not count as that
recovery. A successful dispatch counts as a write only when its task worktree
was merged into this workspace; other dispatch work does not, so inspect worker
run records when assessing delegated changes.

An unresolved block, or a delegated task that never started, with no successful
write exits 1 and seals `failed` with `outcomeDetail: "noop"`, even without
`--fail-on-noop`; stderr reads `clio-coder run: no-op: the delegated task never
started (<reason>) and no write succeeded` for the second. A successful `limitation`
call likewise records failure with detail `limitation`. The flag additionally
fails runs whose attempted tools all failed without a block. Existing errors,
interruptions, and timeouts retain their outcomes. The model's final prose is
still available; a normal provider stop alone does not prove task completion.

### Headless Session Continuity

A headless turn (`clio-coder run`) starts a fresh session unless `--resume <id|prefix|name>` or `--continue` specifies a session to append to.
- `--resume <id|prefix|name>` (or `-r`) appends the turn to the session with that id, unique id prefix or session name. An ambiguous prefix fails the run with the matching ids before any model call.
- `--fork` with `--resume` or `--continue` branches a new session from the named session's last committed turn and runs there. The parent is never written and may be open in another process. `--fork` alone is a usage error.
- `--name <text>` names the session the run writes: the new, resumed or forked one.
- Resuming a session another process holds open exits 2 with cause `session_live` before any model call.
- `--continue` appends the turn to the most recent session recorded for the current working directory.
- A resumed session continues on the target, model, and thinking level it last recorded, not on the default another session saved to `settings.yaml`. `--target`, `--model`, and `--thinking` override it, and the session records the override. Resuming never writes `settings.yaml`; a recorded target that is no longer configured keeps the current route and prints a notice.
- `--resume` and `--continue` are mutually exclusive. Specifying both causes the invocation to fail with exit code 2 before execution.
- Session continuity options apply strictly to main-agent execution. They are non-applicable to `--agent` fleet dispatches because dispatched agents execute in isolated worker processes with independent transcripts; specifying session flags alongside `--agent` exits with code 2.
- A named session that cannot be resumed (such as an unknown session ID or unreadable history) fails the run with exit code 2 before any model call is initiated.
- Under `--read-only`, `--resume` and `--continue` save the new turn like any run. Read-only limits what the agent changes outside CLIO Coder's home, not the session record.
- An explicit `--target <id>` resolves targets from layered project settings (`.clio-coder/settings.yaml`, `.clio-coder/settings.local.yaml`) as well as user settings before applying target-not-found validation.
- With no saved chat route, a run uses the one usable route for that run only and names it on stderr (a `notice` frame under `--output-format stream-json`): a saved target that holds its key, a stored login, or an API key in the environment. When several are usable it exits 2 and names each as `--target <id>`; a route whose runtime has no default model needs `--model <id>`, and without it the run exits 2. Copilot sign-in, loopback servers and targets defined in project settings are never used this way, and when a project's settings define `targets`, your own saved targets are not borrowed either.
- A text-mode run prints the `No CLIO-CODER.md detected` bootstrap hint and the imported-context refresh hint to stderr only when stderr is a terminal. A `--output-format json|stream-json` run or a piped one prints neither, and neither prints the interactive project-instructions line.
- The session ID is discoverable via the `session` event under `--output-format stream-json` (and `sessionId` on the `run_end` envelope) and on stderr via the `clio-coder run: session <id>` line in text mode. Standard output remains reserved for the assistant answer alone.

### JSON Event Streaming and Wire Projection Promise

When `--output-format stream-json` is passed, `clio-coder run` streams structured JSONL events: a `session` frame (`schemaVersion: 2`), the event frames, and one closing `run_end` envelope. `clio-coder schema run-events` and `clio-coder schema run-result` print their JSON Schemas.
- **Wire Projection Promise:** Content streams as increments without repeated growing snapshots; the final answer is also included on `turn_end` for scripts.
- Intermediate `message_update` events are dropped to prevent quadratic snapshot duplication over stdout.
- `text_delta` and `thinking_delta` events stream incremental text deltas rather than accumulating message snapshots.
- A `dispatch_scope_notice` event, `{type, code, level, message}`, reports a dispatch scope entry that did something its request did not say, such as a write root of `.` that sets no boundary, or narrow write roots that cost the worker its `bash` and `verify` because no OS sandbox enforces them, or a peer CLI that read its instruction files as they are while they hold rules the repository no longer supports (code `peer_instructions_stale`, which also carries `files` and `stale`). The same event, with code `worker_merged` and level `info`, reports a worker whose task worktree merged a commit onto the checkout (`<agent> <run id> merged <sha> onto <branch>`); scope notices have level `warning`. Text mode writes the same message to stderr. It is absent from `--output-format json`, which writes only the `run_end` envelope.
- `agent_end` events carry segment summary metrics (`messageCount` and a `usage` object whose `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning` and `totalTokens` are fact sums, whose `cost` is `{usd, free}` with `usd` a fact sum, and whose `apiCalls` counts the calls that reached a provider) instead of duplicating the full message transcript.
- `turn_end.message.content` preserves the final assistant text blocks, with `streamed: true` and `textLength`; thinking remains length-only. It drops `toolResults` array objects, each of which already crossed the wire in a preceding `tool_execution_end` event.
- Every frame field that names a tool call carries CLIO Coder's own id, `tc_<turn>_<n>`, as `toolCallId`, with the provider's id beside it as `providerToolCallId`.
- `tool_execution_start`, `tool_execution_update` and `tool_execution_end` name the capability that ran. A `gateway` op=call carries the capability as `toolName`, the capability's own arguments as `args`, and `via: "gateway"`, so a consumer of direct calls reads it unchanged. A `gateway` chain keeps its own frames, and its `tool_execution_end` is followed by a `tool_execution_start` and `tool_execution_end` pair per settled step, each with `toolCallId` `<parent's id>:<step id>`, `parentToolCallId`, the step's capability, arguments, result and `isError`, and `via: "gateway"`. A step whose `$from` binding failed never ran: its start frame carries the step's requested arguments with references unresolved, and its end frame adds `bindingError`. A call in a reply the output limit cut off never ran either: its end frame carries the engine's error result and `notRun: "output_limit"`, and run receipts, arena facts and the interactive footer count it as no call and no tool error. Assistant `toolCall` blocks and `toolResult` messages keep the wire name `gateway`.

Example:

```bash
clio-coder run \
  "Find the test command and summarize the project structure." \
  --target local-lmstudio \
  --model qwen3.8-27b
```

### Turn Constraints

#### Run without changing files with --read-only

To run with the mediated no-source-write policy, use `clio-coder run --read-only
"<task>"`. Native user files and Git metadata are covered by CLIO Coder's
admission and OS confinement; this is not a universal guarantee about a
trusted external server's implementation. CLIO Coder itself keeps working, so
the run records its session, run records and telemetry, refreshes its caches
and may write the project's `.clio-coder/` harness state; a run resumed with
`--session` or `--continue` saves the new turn. The main agent may read inside
the workspace. Its writes, edits and artifacts are refused, and its shell
commands run only in the [read-only
sandbox](../architecture/safety-model.md#the-read-only-sandbox), which
bubblewrap provides: they may write only a scratch directory under CLIO
Coder's state directory and a private `/tmp`. With no bubblewrap, on macOS,
or with `safety.sandbox: off`, shell commands are refused. Delegation runs
read-only on runtimes that CLIO Coder mediates per call or that confine their
own tools in an OS-level read-only sandbox; the Claude Code, Pi, OpenCode and
Antigravity subprocess runtimes, plugin runtimes that do not declare
`readOnlySandbox: "os"` and ACP peers are refused. A read-only dispatch cannot
create a task worktree or run host verification, and the sandboxed shell takes
no workspace snapshot. With `--agent`, the dispatched worker runs under the
same restriction. An extension runtime may write its own store but no
workspace directory. See [Read-only runs](../architecture/safety-model.md#read-only-runs)
for the enforced and tested boundaries, including MCP admission.

#### Other turn constraints

Headless runs can explicitly constrain one submitted turn and its continuations using host-enforced bounds ([turn-constraints.ts](../../src/core/turn-constraints.ts)). Turn constraints are never guessed from natural language or derived from model-generated arguments; they can only narrow existing safety, skill, and recipe policies.

- **Workflow mode (`--turn-mode <mode>`):** Selects workflow guidance (`answer` | `proposal` | `change`). Mode guides system prompt rendering and turn continuation discipline (`turnAllowsContinuation` disables autonomous continuation turns for both `answer` and `proposal`). Under `proposal`, tasks board `plan` and `add` actions automatically record `initialStatus: "blocked"` with a note awaiting operator authorization. **Important:** `mode` is prompt and workflow guidance, not an authorization boundary. `turnAllowsTool` ignores mode entirely; mutating tools such as `write` or `edit` are *not* denied by `--turn-mode proposal` alone. To mechanically restrict execution, pass an explicit capability allowlist (`--allow-tools read,grep,find,ls`).
- **Worker delegation (`--no-delegate`):** Sets `delegation: "forbidden"`. `turnAllowsTool` mechanically denies the `dispatch` tool, and prompt compilation instructs the model to work directly without spawning workers.
- **Capability allowlist (`--allow-tools <names|none>`):** Restricts executable tools to an explicit comma-separated list of capability names, or disables all tools when passed `none`. Mechanically enforced by `turnAllowsTool` and tool execution admission. Naming a secondary capability (such as `data` or `clio_docs`) automatically admits its gateway transport wrapper, while naming `gateway` alone never admits every capability behind it.
- **Skill discovery suppression (`--no-skills`):** Suppresses automatic skill discovery from catalog roots and marketplace guidance while still honoring explicitly specified skill paths (such as `--skill <path>`). Programmatic turn constraints can also set `skills: "disabled"`, which mechanically rejects `context(scope="skills")` calls at the tool boundary.

Turn constraints render as a `# Current task scope` block through `turnScopeGuidance` ([turn-constraints.ts](../../src/core/turn-constraints.ts)). The block rides in the `<system-reminder>` of the turn's user message, is repeated on continuations, and never enters the compiled system prompt, so adjusting constraints between turns leaves the prompt and its cache prefix untouched. Admission still enforces the constraints whether or not the model reads the block.

When the scope admits extension or MCP capabilities, the reminder also lists one compact argument signature per admitted registered capability within a 1600-byte budget and names the rest for `gateway(op="describe")`; built-in capabilities keep their shapes in the compiled capability map. When the scope keeps `bash` beside `read` or `grep`, one line says that `bash` is for the commands the task runs, that `read` and `grep` are for files, and that `find` and `ls` listings go through the gateway.

### Operator tool allowlists in interactive sessions

Start `clio-coder --allow-tools read,grep,find,ls --delegate-tools read,grep,find,ls` to restrict the main agent and its workers separately. Both flags take comma-separated capability names or `none`. Without `--allow-tools`, the operator adds no main-agent allowlist. Without `--delegate-tools`, workers inherit the main-agent allowlist. These are operator ceilings: a prompt, skill or worker recipe can narrow them but cannot widen them. `gateway` is a transport wrapper; allowing it alone does not allow the capabilities behind it. See [turn-constraints.ts](../../src/core/turn-constraints.ts).

### ACP session and prompt capability ceilings

An ACP client can send `_meta["clio-coder/ceiling"]` on `session/new`, `session/load`, `session/resume` or `session/prompt`. Its fields are `allowedTools` and `delegatedTools` (arrays of capability names), `delegation` (`allowed` or `forbidden`) and `readOnly` (`true`). An omitted field adds no client restriction; without `delegatedTools`, workers inherit `allowedTools`. An empty tool array permits no capabilities. A read-only ceiling applies the [mediated read-only restriction](../architecture/safety-model.md#read-only-runs), with the external-runtime and MCP boundaries stated there. Client ceilings intersect the operator's limits; they never grant authority.

`clio-coder acp --read-only` sets the operator's limit for the whole server: every session it creates, loads or forks carries `readOnly`, and no client ceiling can lift it. Sessions, run records and telemetry are saved as usual, so a loaded session's new turns are kept.

A session ceiling applies to its turns. A prompt ceiling narrows that prompt and its continuations, then the session ceiling applies again. Fork and handoff commit inherit the source session ceiling and may narrow it further. Load and resume apply the ceiling supplied with that request, alongside operator limits. Responses echo the applied ceiling; `{}` means none applies. Tool calls, their worker dispatches and slash commands are screened. Malformed ceilings return JSON-RPC `-32602` with code `invalid_ceiling`; a host unable to enforce them returns `ceiling_unsupported`. See [ACP types](../../src/engine/acp/types.ts) and [server.ts](../../src/engine/acp/server.ts).

### Which model answered an earlier turn?

The transcript's assistant model label comes from each recorded assistant message's provider and model, rather than the current route. CLIO Coder keeps that attribution when a session changes models or is resumed. `/export` includes the recorded model labels and `Model changed` notes in Markdown and HTML exports. A message without a recorded model has no inferred model label. See [assistant-model.ts](../../src/core/assistant-model.ts) and [transcript-export.ts](../../src/domains/session/transcript-export.ts).

## Interactive Slash Commands

Slash commands are available inside the TUI. Type `/` at the start of the prompt to open the grouped command palette autocomplete.

The registry table below lists every interactive slash command. A bare `/` opens one ranked list: everyday commands first (`/help`, `/model`, `/new`, `/resume` and the rest), led by your five most-used commands once CLIO Coder has counted them, then regular and rare ones. Typing narrows the list, best match first, by exact name, name prefix, alias, verb, letters in order and a word of the description; each row ends with its group, named for what the command is about (`Session`, `Model and context`, `Work`, `Clio`). The popup shows at most eight rows over a two-line detail panel. Each operation has one canonical spelling; autocomplete, help, and parsing all read the same registry. The "Usage" column details expected arguments, with brackets `[]` indicating optional arguments and angle brackets `<>` indicating required arguments. Every command follows `/noun [verb] [arguments] [--flags]`. A line that does not parse gets one answer, an error naming the reason followed by the usage line, and a command typed bare that needs an argument prints its usage as information; either way the line stays in the composer to correct.

Enter on a highlighted command that runs without arguments completes and runs it in one key when you typed its name or the start of it; a command that needs arguments completes and waits. After a bare `/`, or on a row matched by letters in order or by purpose, Enter completes the row like Tab and waits, so a stray Enter never runs a command you did not name. A retired name typed in full submits the line, which shows its notice, and an alias or prompt template name typed in full submits the line as typed, so `/review` with a `review` template runs that template instead of a palette row. Tab only completes. An argument list that opens by itself and holds only optional rows opens with nothing selected, so Enter submits the line as typed and Down or Tab moves into the list. A complete built-in name closes the command list, so `/skill` runs `/skill`.

Aliases resolve to their command: `/clear` is `/new`, `/exit` is `/quit`, `/cost` and `/status` are `/usage`, `/init` is `/context init`, `/login` is `/settings models`, `/undo` is `/rewind`, and `/compact` is `/context compact`. A command-shaped token that the registry does not claim (one word of letters, digits, hyphens or colons) is refused instead of reaching the model, and the notice names the closest command. `/eggs` and `/archive` still work but are hidden from `/` and `/help`.

Commands renamed or removed in 0.8.0 are gone and answer like any unknown command: `/health` and `/systemone` (now `/usage health`), `/skills`, `/prompts`, `/agents` and `/interop` (now `/library skills|prompts|agents|interop`), `/workspace` (now `/extensions`), `/workspace off` (now `/extensions leave`), `/library reload` and `/extensions reload` (now `/reload library|extensions`), `/branch` (now `/fork`), `/peer` (now `/panes peer`), `/share` (now `/fleet share`), `/delegate` (now `/run <agent-id> <task>`), and `/interrupt`, `/editor`, `/background` and `/notifications`, which became the keys `Alt+S`, `Alt+G`, `Ctrl+G` `d` and `Ctrl+G` `x`; typing one of those four names alone says which key replaced it (`/interrupt is now a key: press Alt+S.`) and clears the composer. `/resources`, `/plugins`, `/output` and `/share export|import` are no longer recognized either. Of the retired spellings, `/doctor deep` (now `/doctor --deep`), `/loop list` (now `/loop`) and `/loop cancel <id>` (now `/loop stop <id> --now`) are usage errors.

| Command | Usage | Purpose |
| --- | --- | --- |
| `/quit` | `/quit` | Exit CLIO Coder. Alias: `/exit`. |
| `/reload` | `/reload [settings\|library\|extensions\|prompts\|all]` | Re-read resources and report what applied and what needs a restart. Defaults to `all`. `prompts` re-reads prompt fragments, agent recipes, the project handbook and project rules and names the fragments that changed, and drops the cached `clio_docs` index; the safety rule pack still needs a restart. `library` reports what it reloaded. |
| `/restart` | `/restart [text]` | Save and restart into this session and workspace. It first checks that the build on disk can start and refuses, keeping the session, when it cannot. Text after the command becomes the restarted session's first turn. In CLIO Coder's own source tree, running from that tree's build, the model can ask for the same restart with `restart_session`: at `default` autonomy an approval card shows the text it would continue with, and the restart runs after the turn settles; at `yolo` or without a terminal the request is refused, and three model-requested restarts in a row without an operator `/restart` are refused. |
| `/trust` | `/trust` | Open the project trust card for this repository's untrusted or changed configuration: review each surface, or trust all of it and restart into the session to apply it. Says so when nothing is waiting. |
| `/help` | `/help [query]` | Open the interactive help center showing commands and keys |
| `/skill` | `/skill <name> [task]` or `/skill off` | Invoke a skill or clear its active tool surface; bare `/skill` opens the Library on Skills. |
| `/loop` | `/loop <every> <task> [flags]`, `/loop`, or `/loop status\|pause\|resume\|stop [id]` with `stop <id> --now` | Create or control a bounded recurring job. Bare `/loop` lists this session's jobs; `stop` lets the current run finish and `stop --now` aborts it. Use [job tool usage](tool-usage.md#bounded-main-runner-jobs) for the runner and limits. |
| `/library` | `/library [skills\|agents\|prompts\|playbooks\|plugins\|extensions] \| /library interop \| /library inspect\|install\|update\|enable\|disable\|remove <ref> [--user \| --project] \| /library import <path-or-url> [--user \| --project]` | Open the full-screen Library with Skills, Agents, Prompts, Playbooks, Plugins and Extensions tabs, on the tab a kind names. A named reference opens the browser on that row; `install`, `update`, `enable`, `disable`, `remove` and `import` show a reviewed plan first and write nothing until it is accepted. An accepted project-scope `install` into new or already trusted state can approve the package identities it writes; `import` never does. `interop` inspects local coding agents, their ACP, headless and pane modes, and supported resource adoption (see [Interop](interop.md)). `/reload library` refreshes installed components. Alt+L opens the same browser. |
| `/mcp` | `/mcp \| /mcp trust <id> [class] \| /mcp untrust <id>` | List MCP servers (bare, or `list`) or manage explicit trust for project MCP servers with optional action class |
| `/extensions` | `/extensions [dev\|mute\|unmute [target] \| leave]` | Inspect extensions, manage development and muted runtimes for this session, or leave the active extension workspace with `leave`. `/reload extensions` reloads them. See [Extensions](harness-extensions.md#running-and-managing-runtimes). |
| `/run` | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] [--worktree] [--read-only] [--share] <agent> <task>` | Run a worker or configured headless peer; `--worktree` preserves an isolated task branch and `--read-only` runs the worker [read-only](../architecture/safety-model.md#read-only-runs), on runtimes that can enforce it. |
| `/btw` | `/btw <question>` | Ask a side question that never enters the session transcript |
| `/draft` | `/draft [N] <request>` | Draft N answers in parallel (2-4, default 3). `Enter` on a finished draft puts it in the composer, unsent |
| `/oracle` | `/oracle <question>` | Ask a read-only advisor to challenge a question against this session's settled decisions |
| `/council` | `/council [--roster <name>] [--rounds <n>] [--synthesis <judge\|vote\|none>] [--agent <id>] [--deadline <N\|Ns\|Nm>] <task>` | Ask a roster of read-only members the same task, with an optional vote or judge synthesis; `--rounds` takes an integer from 1 to 3, `--agent` seats that agent for every member (default `scout`), and `--deadline` stops a member that runs past it and returns the others as a partial council |
| `/poll` | `/poll [--options <a\|b\|c>] [--models <target[/model]>,...] [--rationale] [--deadline <N\|Ns\|Nm>] <n> <question>` | Ask n participants (2 to 5) the same question independently, as a one-round vote council, and show the vote distribution. Members cycle over `--models`, else all run on the chat target and model; `--options` constrains the verdict to one choice (a ballot naming anything else gets a repair round; a choice may not hold `, ` or run past 64 bytes) and `--rationale` asks each for a short reason |
| `/usage` | `/usage [activity\|accounts\|session\|models\|workers\|health]` | Show workspace activity, subscription quota, credits, session token and cost totals, workers, and health, opening on the named tab. The Health tab shows telemetry journal losses, event-loop lag, transport, quota, route and System One breakers. Aliases: `/cost`, `/status`. |
| `/doctor` | `/doctor [--deep]` | Show a diagnostic report with errors and warnings first and full wrapped check details. Outside Detailed output, passed and informational checks fold into one `N routine checks folded` line; `--deep` adds live tool probes on the session's targets and a validation-contract dry run at the session's autonomy. See [Doctor](doctor.md). |
| `/upgrade` | `/upgrade` | Recheck the release, review an eligible npm-global or installer replacement, and ask before changing the package. An installer install follows the channel it recorded, and a pinned install is left alone with the command that unpins it. User data is preserved; after success CLIO Coder asks you to exit and restart. A source checkout is told to update through git; other installation kinds receive manager-specific instructions. |
| `/context` | `/context [compact [instructions] \| recall <ref> \| recover <handoffId> <reduce\|deliver> \| init [--preview] [--heuristic] [--adopt] [--global\|--include-global] [--propose\|--apply\|--rewrite] [--depth quick\|standard\|deep] \| init --accept [<proposal id>] \| refresh \| reset [--yes] [--all]]` | Context hub: bare `/context` opens the context window overlay; subcommands compact, recall, recover a paused handoff, init, refresh, and reset. `init --accept` writes a reviewed proposal as `clio-coder context init --accept` does. `reset` asks in a chooser; `--yes` and `--all` give the confirmation as flags for hosts without one. Alias: `/init` runs `/context init` |
| `/compact` | `/compact [instructions]` | Alias for `/context compact [instructions]`. Instructions bind the summarizer and are kept verbatim as an operator note, see [Context continuity](context-continuity.md) |
| `/fleet` | `/fleet [run [--var <key=value>] [--resume <runId>] <playbook> \| share [runId]]` | Open Fleet Runs, run a playbook with an approval preview, or share a worker result with the main agent. `--resume` validates the prior root against the plan and shows replayed steps in the preview. Bare `share` picks the newest finished run you started. Configure fleets with `/settings workers`. |
| `/decisions` | `/decisions` | Show settled interview decisions and operator revisions |
| `/research` | `/research` | Show this project's research campaigns read-only; Enter opens one campaign's timeline, the same lines `clio-coder research status` prints. Campaigns start from the CLI |
| `/tasks` | `/tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] <text> \| /tasks hand <id> \| /tasks done <id> \| /tasks drop <id>` | Show the session board or manage project operator tasks |
| `/memory` | `/memory [seed]` | Inspect, promote, or seed task memory |
| `/remember` | `/remember <text> \| /remember scope session\|project\|global [capture-id] \| /remember undo [capture-id] \| /remember forget <text>` | Remember a fact, preference, rule or command for this session, this project or all projects, move or undo the latest capture, or forget a memory. Never starts a model turn. Typed `remember that ...`, `# ...` and `forget that ...` do the same; see [Tell CLIO Coder what to remember](proactive-memory.md#tell-clio-coder-what-to-remember) |
| `/view` | `/view [filter] \| /view verify <runId>` | Browse session artifacts (transcript, accountability, evidence, finished runs by their sealed run record, dispatch runs, task ledger, workspace, tool output, protected artifacts, compactions, prompt manifests, and the safety decisions in this session's telemetry journals) and re-verify a run's seal. The providers live in `src/domains/session/view-artifacts.ts`; ACP clients read the same artifacts, see [ACP](../architecture/acp.md) |
| `/panes` | `/panes [show <run-or-agent> \| open <preset-or-argv> \| peer [--cwd <workspace>] <peer> [brief] \| zoom [target] \| close [target]]` | Bare `/panes` prints the pane layer status, including each running dock and whether it is hidden. `show` takes the workers dock over for a live run, opening or showing it without moving the keyboard, `open` opens a utility pane (`files`, `logs`, `shell`, `files --once`, or a command; a second open focuses the pane already there), `peer` opens an installed coding agent (`clio`, `claude-code`, `codex`, `opencode`, `antigravity` or `pi`) in an owned pane with no managed run, `zoom` toggles zoom (default: the watch pane) and `close` closes one CLIO Coder-owned pane or, with no target, all of them. See [Panes and the Files Pane](panes-and-files.md). In a session without a pane host, the palette lists `/panes` and its verbs dimmed with `needs a pane host; this session has none`, after the usable rows, and Enter on them does nothing. |
| `/files` | `/files [open\|hide\|close\|pick]` | Show or hide the files pane docked below the session, with the keyboard moving into it on a show. `open` opens, shows or focuses it, `hide` parks it with Yazi still running, `close` ends Yazi, and `pick` borrows it for one selection. Picks land in the composer as `@` mentions. See [Panes and the Files Pane](panes-and-files.md) |
| `/music` | `/music [on\|off\|pause\|next\|status\|station <name or url>]` | Bare `/music` does what `Alt+A` does: it opens the focus-radio pane and plays, shows a hidden pane, or hides a visible one. `on` plays, `pause` silences and keeps the pane, and `off` stops and closes it. The pane drives cliamp in a Herdr dock. It needs the pane layer and `integrations.music.enabled`, which is off by default. See [Music](music.md) |
| `/thinking` | `/thinking [level]` | Set the chat thinking level; bare `/thinking` opens a "Thinking level" list of the levels this model takes, with the current one marked |
| `/model` | `/model [pattern]` | Open the model picker, or set a model by name. Enter in the picker and `/model <pattern>` apply the model to this session; `s` on a picker row saves it for the project or globally |
| `/settings` | `/settings [area]` | Open the settings center, optionally at an area: `models`, `chat`, `workers`, `context`, `safety`, `workspace`, `advanced` (or `recent`); no other word opens one. In the settings center typing always filters, `*` pins the selected row and the arrows move. A second word after the area, and an unknown area, is a usage error. The `advanced` area ends with two rows that run on Enter: **Check setup** closes settings and runs the doctor, and **Edit settings file** opens your settings file or this project's in `$EDITOR`, including settings with no row, and checks the draft before saving. It creates the project settings file when the project has none, and carries project trust forward only when the saved file is exactly what you wrote. Aliases: `/login` and `/config` open `/settings models` |
| `/resume` | `/resume [id\|prefix\|name]` | Resume a past session on the route it last ran on. Exact ids take precedence, then id prefixes, then exact names. A unique match resumes directly; duplicate names or ambiguous prefixes open the picker with the text as its filter. Saved names lead picker rows and are searchable. The picker hides sessions with no model turn and shows status, age, turn count, folder and route; replay restores recorded turn durations. See [Resuming sessions](#resuming-sessions) |
| `/rename` | `/rename [name]` | Save a name for the current session without changing its id, conversation or route. Bare `/rename` proposes a short name locally from the conversation and saves only after confirmation, with no model call. Empty or whitespace-only names are refused. The name appears in the footer, session picker and exit summary. |
| `/new` | `/new` | Start a fresh session. While a run is active it cancels the run first and returns queued follow-ups to the editor. Alias: `/clear` |
| `/report` | `/report [bug\|feature\|question] [summary] \| /report status\|security \| /report send [--comment <n>\|--new] <draft> \| /report forget <id>` | Review, then send a report to CLIO Coder's maintainers; only `s` on the send step sends. Over ACP and in the desktop app it replies with the exact text, and only `/report send <draft>` sends; there `--comment <n>` adds it to a matching open issue and `--new` files it anyway, one or the other. In the terminal the review asks about a matching issue itself and these flags are not used. See [Report a problem to the maintainers](troubleshooting.md#report-a-problem-to-the-maintainers). |
| `/handoff` | `/handoff <goal>` | Hand this session's working state to a fresh session for a stated goal |
| `/tree` | `/tree` | Open session tree navigator. Press `p` to filter by current cwd, `o` to cycle tree order or most recent first, `e` to label the selected entry, and `Shift+T` to toggle timestamps. |
| `/rewind` | `/rewind` | Restore workspace files from a snapshot CLIO Coder took before its changes; `/tree` rewinds the conversation. See [Undoing file changes with /rewind](#undoing-file-changes-with-rewind). Alias: `/undo`. |
| `/fork` | `/fork [name]` | Pick an assistant turn to fork into a separate session, optionally naming it. Workspace files stay unchanged. |
| `/export` | `/export [path]` | Export a self-contained HTML transcript by default, to `.clio-coder/exports/<session-id>-<local date>.html` when no path is given; a `.md` path writes Markdown. An `exporting session <id>…` notice shows at once, before the file is written, so rendering a long session may hold input briefly; it ends with `wrote N lines to <path>`. |

The `/model` selector marks image-capable rows with `V` and spells out `image input yes` or `image input no` in the selected row's details. A completed `/model <pattern>` switch includes the same image-input state in its notice. The expanded dashboard's session capabilities always say `images yes` or `images no` for the active route. These states use the resolved deployment capability.

When a session with earlier images moves to a text-only model, the next turn shows a warning. CLIO Coder replaces each historical image block with an explicit omission note in that model's request. The saved session keeps the original blocks, so switching back to a vision-capable model can use them again.

### Subscription quota and session usage

`/usage` shows this session's token and cost accounting beside what the
connected subscription accounts report. `/cost` and `/status` open it too. It is a
live view of this session and of your accounts right now; `clio-coder usage
report` is the separate command for folding token and cost facts across past
sessions.

| View | What it shows |
| --- | --- |
| Activity | A heatmap of this workspace's recent session activity (Detailed output, or Default once the workspace has a session), git changes, session cost and tokens with elapsed time, and the first reported subscription window |
| Accounts | Subscription and credit meters, every reported model group, reset countdowns and local reset times with an explicit time zone, and stale or expired readings |
| Session | Recorded token and cost totals, verified outcomes with tokens and cost per outcome (see [Exit summary](#exit-summary)), cache traffic, reasoning, and the background-call categories (side questions, handoffs, pre-warms, memory steps) |
| Models | Each model's share of recorded processed tokens, including cache traffic, plus its detailed token and cost breakdown |
| Workers | Active and recent runs, recorded tokens and cost, context usage, and the shared account limit when the local credential owner is known |
| Health | Telemetry journal losses, event-loop lag, transport, quota, route and System One breakers, with System One's status lines when it runs. Minimal output omits the journal and responsiveness sections and shows the connection only when it reports a failure, an SSE pin or fallback, or a recovery |

Press 1–6, Tab/Shift+Tab, or ←/→ to change views; ↑/↓ or PgUp/PgDn to scroll;
Home/End or Ctrl+Home/Ctrl+End to jump to either end; and Esc to close. Each
view keeps its own scroll position while the overlay stays open.

#### Used, and what a percentage describes

One direction on every surface. A filled meter cell always means consumed
capacity, and every percentage counts what is used: Accounts labels its meters
`used`, and a footer or worker badge reads `weekly 9% used`.

Subscription percentages describe an account-wide provider window shared across
your sessions and devices. Session tokens and costs describe only what this
process recorded, and the two cannot be converted into each other. Context
occupancy is a third quantity again: it measures one request against a model's
window, not an account against its plan.

#### Where quota appears outside the overlay

The welcome header, the compact footer, the expanded dashboard, worker cards,
and fleet islands read the same cached readings the overlay does.

- The **Detailed welcome launchpad** carries an `AI usage · used` section beside the wordmark with an `Accounts` field when an account reported. It needs at least 48 columns and 30 rows. It reserves two rows from the first paint; a longer summary ends in `… /usage`. With no reading, those rows point at `/help` and `/context`, or stay blank beside the hint column from 160 columns. The Default and Minimal welcomes read no quota.
- The **compact footer** has two lines. Line 1 carries the working directory, the Git branch with a dirty marker, the context counter and tokens per second. Edits inside a submodule's checkout do not set the dirty marker; a submodule whose checked-out commit moved does. Line 2 carries one notice, tip, hint or urgent prompt on the left and, on the right, the active worker count, active skills and the selected model's weekly headroom. The weekly figure appears only when the account and model group are identifiable, and the footer never promotes an unrelated account's busier window in place of the selected model's.
- The expanded dashboard (`Alt+U`) is one glance page: what CLIO Coder is doing now, one
  context line, one spend line with the session ceiling, the workers with shared account
  usage under each live one, and live notices. Its heading names the running build
  (`0.8.0-dev@67b3247`, as the process title does) when the row has room for it beside the model. It is at most eight rows, a third of the
  terminal when shorter, and `Alt+PgUp`/`Alt+PgDn` scroll a longer workers list. Its last
  line names `/context`, `/usage` and `/fleet` for detail. The local machine block (CPU,
  memory, GPU, network and disk) is on the Health view of `/usage`, sampled only while
  that view is shown.

#### What CLIO Coder does not claim

Worker badges are shared account headroom, not a measured per-worker share.
CLIO Coder does not infer a worker's subscription consumption from its token counts or
from account deltas, and a badge appears only for a supported local credential
owner and the matching model group. Antigravity's Gemini group stays distinct
from its Claude and GPT group. Remote workers and generic transports stay
unlinked rather than being attributed to an account that may not be theirs.
CLIO Coder's own `openai-codex` sign-in is separate storage from the Codex CLI's
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
a weekly window and no 5h window, and the rows a provider actually
sent are printed instead of a fixed shape. Where a provider sends its own severity word,
that word wins over CLIO Coder's thresholds.

Two credentials on one Anthropic subscription (an `anthropic-max` sign-in and a
Claude Code sign-in) report identical windows, so they are folded into one
account and the apparent budget is not doubled. Accounts that merely happen to
show equal percentages are never merged.

### Notes on individual commands

| Workflow | Behavior |
| --- | --- |
| `/model` and `/thinking` | Choose a model for this session (Enter), or press `s` on a picker row to save it for the project or globally. Cancel leaves the active route unchanged. See [routing defaults](configuration-and-targets.md). |
| `/btw` and `/draft` | Run side questions or candidate answers without tools or transcript changes. Calls still count in `/usage`. Candidates differ by sampling temperature, or by prompt angle for models that refuse a sampler, with one retry without `temperature` on an `Unsupported parameter: temperature` rejection. In `/draft`, `Enter` on a finished draft closes the overlay and appends its text to the composer below anything already typed, never sending it, and `Esc` closes without taking anything. |
| `/council` | Runs a roster declared under `fleet.rosters` of two to five read-only members: the roster named `default`, or the one `--roster` names. With no `--roster` and no `default` roster, the notice points at `fleet.rosters` in `settings.yaml`. A council is a plan-scale dispatch, typed or asked for by the model alike, so at `default` autonomy it shows the plan approval card before any member starts; at `yolo`, contained or unconfined, it runs without that stop. Share the synthesis or an individual member explicitly with `/fleet share <runId>`. |
| `/run` | Start a worker or ACP peer as a managed run with a sealed run record. Its answer is separate from main-agent context until shared with `--share` or `/fleet share`. |
| `/handoff <goal>` | Review a bounded handoff document, then accept it to create a fresh session. The goal must describe a concrete continuation. |
| `/context` | Bare command opens the context ledger. Subcommands compact or recall session content and manage project context; see [Project context](#project-context). |
| `/tasks` | Inspect session tasks and the durable project task inbox. ↑/↓ select a row, Tab and Shift+Tab jump between sections, and a board taller than the dock scrolls to keep the selection in view, pages with PgUp/PgDn, and shows its position. `a` adds an operator task; `h`, `d` and `x` hand, finish or drop the selected one. Acceptance checks travel with handed tasks; receipts show whether they passed. |
| Unknown slash command | Rejected before model submission; nothing runs and the draft stays in the composer to correct. A near miss names the closest command, by the palette's own matching or within two typed letters of a name or alias: `/stauts is not a command. Closest: /status (runs /usage). /help lists them all.` Use `\/text` to send text that begins with a slash. The command list is [above](#interactive-slash-commands). |

The command spellings and arguments are the [slash-command registry](../../src/session-control/slash-commands.ts); this table calls out only session workflows that need explanation.

### Keys in list overlays

List overlays share one key model ([confirm-once.ts](../../src/interactive/overlays/confirm-once.ts)):

- **Move and page.** ↑/↓ (and `j`/`k` in Tree, Tasks, Decisions and Research) move the selection. PgUp, PgDn, Home and End move through Tree, Decisions, Research and the steering queue. PgUp, PgDn and Home page Fleet approval, Handoff and Drafts, where End jumps to the bottom only in Handoff, and PgUp and PgDn page an open run detail in Fleet runs.
- **Detail.** Tab opens the selected row's detail in Decisions and Fleet runs, and opens a review path in the Library; Enter also opens a fleet run's detail.
- **Action letters.** `x` is the destructive letter, and in Tasks (drop), the steering queue (remove), Memory (reject), Fleet runs (cancel), Decisions (supersede) and Interop (decline a proposal) it asks once: the rail shows `x again` to confirm, and any other key keeps the row. `x` also removes in the Library. Other letters: `o` orders the Tree, `m` steers a fleet run (in Fleet runs, `/` closes the board and starts a command in the composer), `r` refreshes the Library, `R` restarts extensions in Extensions after asking once, and `s` sets scope in Interop.
- **Moved letters.** Some overlay letters moved in 0.8.0, and the old letter no longer does anything there: Decisions `s` is now `x`, Tree `s` is `o`, Fleet runs `s` is `m` and `d` is Enter, Interop `d` is `x` and `p`/`u` are `s`, Library `R` is `r`, and Extensions `r` is `R`.
- **Filters.** In Help, typing goes to the filter, even after an arrow key. A filter given with `/view <text>` clears on the first Esc, and the next Esc closes the viewer. In Interop, Esc first leaves a pending plan, then closes.

### Change the model with /model

To change the model, open `/model` and press Enter on a row to use that model for this session. Press `s` on a row instead to open the card that saves it for the project or globally. Cancel leaves the active route unchanged. `/thinking` changes the thinking level.

A pick made during a turn applies from the next turn, with one exception. When the request is still waiting on its first output, or sits in a retry countdown, and the new route fits it, CLIO Coder moves that request to the new route instead of cancelling it, and a request in a retry countdown goes out at once. The move records no cancelled receipt, and the journal records `route_moved`. When the new route's context window is too small, it cannot read the turn's images, output has started or a tool is running, the pick applies from the next turn and the dialog says why ([overlay-model-selectors.ts](../../src/interactive/overlay-model-selectors.ts)). A session with history also hears that the new model starts with a cold prompt cache.

#### Use a bare model ID without a target

You can type just a model ID with `/model <model-id>` instead of opening the picker. CLIO Coder resolves the model against configured targets, trying an exact match before a substring match. Use `/model <target>/<model-id>` to name the connection explicitly. If several models match, the resolver warns and selects the first match. The [model resolver](../../src/domains/providers/resolver.ts) defines the matching order.

### Ask a side question with /btw

Ask a side question with `/btw <question>`. The answer uses no tools, stays out of the session transcript, and still counts in `/usage`.

### Get candidate answers with /draft

Use `/draft <prompt>` to get a few candidate answers without tools or transcript changes. Press Enter on a finished draft to append it to the composer for editing; it is not sent automatically. Esc closes without taking a candidate. The calls still count in `/usage`.

### Run a worker and share the answer

Use `/run <agent> <task>` to start a worker as a managed run with a sealed run record. Its answer stays separate from the main conversation until you share it with `/fleet share <runId>` or start the run with `--share`. The same `/run` starts a configured ACP peer: a fleet agent wins a name both use, `acp:<id>` forces the peer, and flags a peer cannot honour (`--agent-profile`, `--runtime`, `--target`, `--model`, `--thinking`, `--tool-profile`, `--require`, `--worktree`) are refused rather than dropped.

### Resuming sessions

To resume yesterday's session, start CLIO Coder with `clio-coder --resume` or enter `/resume` inside it to open the session picker. `/resume <id|prefix>` skips it: an exact session id wins, and otherwise a prefix that names exactly one session resumes that session directly. When the text matches no session, or several, CLIO Coder warns (`no session matches <text>` or `<text> matches <n> sessions`) and opens the picker with the text as its filter. The command runs only while no overlay is open.

The direct path and the picker share one switch. Any in-flight chat settles first, the transcript is replayed along the session's active branch (a `/tree` pin wins over the newest turn), the footer and `/usage` totals are rebuilt from that branch, and the session continues on the route it last recorded. When the recorded working directory is missing or unusable, a working-directory fallback dialog offers to continue in the current directory or to cancel, which restores the previous session (or reopens the picker when there was none).

From the command line, `clio-coder --resume <id|prefix>` (also `--resume=<id>` and `-r <id>`) opens the interactive session on that session, resolved exactly as `/resume <id|prefix>` resolves it. When the text matches no session, or several, CLIO Coder exits 2 before the TUI starts with `no session matches <text>` or `<text> matches <n> sessions`. A bare `clio-coder --resume` (no value, or the next token is another flag) opens the interactive session with the `/resume` picker open. `clio-coder --continue` (or `-c`) opens the most recent session for the working directory that reached a model turn, the session `clio-coder run --continue` picks; when there is none, a fresh session starts with one notice saying nothing was resumed. `--resume` together with `--continue`, and either flag before a subcommand, is refused with exit 2. `clio-coder --fork` with `--resume <id>` or `--continue` branches a new session from that one and never writes the parent. A headless turn appends to an earlier session with `clio-coder run --resume <id|prefix|name>` or `clio-coder run --continue` (see [Headless Session Continuity](#headless-session-continuity)). `clio-coder upgrade --restart` relaunches the CLI as a fresh session; `clio-coder --continue` picks up the last one. A clean exit prints the exact `clio-coder --resume <id>` line (see [Exit summary](#exit-summary)).

### Running setup with /config

`/config` opens `/settings models`: the settings overlay on Models, with the connections table first and the chat connection selected. It works during a turn and never leaves the TUI. **Add a target** and a connection's edit action run the setup wizard in the composer dock, and **Connect by URL** runs Quick Connect there: an endpoint URL, a key only when the endpoint needs one, and a model from its live list, which chat then uses. The full-screen flow is `clio-coder configure` in a terminal.


## Keybindings

Three rules cover every key:

1. **Ctrl edits text and talks to the terminal.** The editing keys are pi's readline-style defaults with a few portable overrides (table below).
2. **Alt+letter runs a CLIO Coder action.** `Alt+M` model, `Alt+L` library, and so on.
3. **`Ctrl+G` then the same letter runs the same action anywhere**, including terminals that never deliver Alt (stock macOS Terminal.app, some SSH and multiplexer setups). Actions too rare for a direct key live only in this menu, under their own letter.

`Shift+Tab` (thinking effort) is the one direct action key that is not Alt+letter; it is kept from pi, and its menu letter is `t`. On an empty composer `?` shows a card of these keys, and `/help` lists every effective binding with its scope, source and conflicts.

`Ctrl+G` opens a visible action menu with no timeout: press a letter, or use Up/Down and Enter. The menu lists only the actions that work in the current layout, so its seven viewport actions appear only in the fullscreen layout. It grows with the dock to show every entry and pages with PgUp, PgDn, Home and End. Unknown letters leave the menu open and keep the draft; `Ctrl+G`, `Esc` or `Ctrl+C` closes it without cancelling the turn, and a menu letter closes the Tasks and queue navigator overlays. Hints across CLIO Coder spell each action one way: its direct key, or `Ctrl+G` and the letter when it has none. In a terminal that composes Option-letter as text, hints spell the `Ctrl+G` route instead while the action menu stays bound, so a hint names a key that can arrive. With `clio-coder.leader` disabled there is no menu route, and hints fall back to the Alt key.

<!-- keyboard-model:start -->
| Alt key | Menu letter | Action | Command |
| --- | --- | --- | --- |
| `Alt+M` | `m` | Model picker | `/model` |
| `Shift+Tab` | `t` | Cycle supported thinking effort for this session | `/thinking` |
| `Alt+O` | `o` | Cycle output detail: Minimal, Default, Detailed | |
| `Alt+L` | `l` | Toggle the top-level Library | `/library` |
| `Alt+U` | `u` | Open the one-page dashboard; press again to close it | |
| `Alt+W` | `w` | Workers dock in a `--with-panes` session (first tap shows it and leaves the keyboard in CLIO Coder, a tap on a visible dock parks it, a second tap within 400 ms closes it); the Fleet Runs board without a pane host | `/fleet` |
| `Alt+E` | `e` | Show or hide the files pane (first tap), close it (second tap within 400 ms); bound inside Yazi too | `/files` |
| `Alt+A` | `a` | Show or hide the music pane (first tap), close it (second tap within 400 ms); bound inside cliamp too | `/music` |
| `Alt+S` | `s` | Send now: interrupt the run with the draft, or flush the queue when the draft is empty; ordinary send while idle | |
| `Alt+Q` | `q` | Open the queue navigator over the queued messages | |
| `Alt+G` | `g` | Edit the expanded draft in `$VISUAL`/`$EDITOR` | |
| — | `d` | Move the newest attached dispatch to the background | |
| — | `x` | Dismiss one notification | |
| — | `y` | Toggle default and yolo autonomy for this session (the first switch to yolo shows its acceptance card) | |
<!-- keyboard-model:end -->

`Alt+E` and `Alt+A` drive Herdr docks that hide instead of close; [Panes and the Files Pane](panes-and-files.md#showing-hiding-and-closing-docks) specifies the shared tap model. `Alt+W` is the workers dock key in a pane-host session and is covered in [Fleet Dispatch](fleet-dispatch.md). When the dock cannot open or show, because the pane is too narrow or the host refuses the split, `Alt+W` from the composer opens the Fleet Runs board instead and the notice gives the reason.

The menu also carries the transcript entries: `z` undoes the focused editable field, `r` toggles transcript search, `p`/`n` page the transcript up and down, and Home/End jump to its bounds; previous/next prompt are reachable with arrows and Enter. The menu names its seven viewport actions in CLIO Coder's own words: Search transcript, Page up, Page down, Top, Bottom, Previous prompt and Next prompt. Letters `b` and `j` are reserved for an active extension workspace.

On an empty composer: `?` key card, `/` commands, `!` shell command, `@` file mention, Left arrow the workers or Fleet Runs board, Down arrow the task board. `Esc` stops a run; `Ctrl+C` twice or `Ctrl+D` on an empty idle composer exits; `Ctrl+Z` suspends (run `fg` to resume; unavailable on Windows, and it also works from an open overlay and from transcript search). `/tasks`, `/decisions` and `/tree` keep their boards behind slash commands; scoped model cycling keeps configurable action IDs and has no default key.

| Editing or contextual key | Behavior |
| --- | --- |
| `Enter` | Accept completion first, otherwise send idle input or queue at the next steering slot |
| `Ctrl+J`, `Shift+Enter`, `Alt+Enter` | Composer newline; distinct Shift+Enter delivery is optional |
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
| Ctrl+C | Cancel the current search/modal/child; otherwise cancel work, or press twice while idle to quit, keeping any draft |

Reviews, model-scope choices, permissions and interviews own their input. They
expose no global send, navigation, background or quit actions. Top-level Library,
model, tree and Workers scopes can expose their owner toggle; editable fields
expose semantic undo. Nested Library reviews must finish or cancel before the
browser toggle becomes available. Permission deletion never resolves a user
submit binding. Enter allows only when its defined empty-draft condition holds,
and not in the first 400 ms after a permission card opens, so an Enter typed for
the prompt cannot allow a card unread; the `[Enter] allow` row is dimmed until
then, in the same words. Legacy LF/Ctrl+J is indistinguishable from Enter in
these single-line scopes.

**Mouse wheel.** In fullscreen the wheel scrolls the transcript and follows its speed: one row for a single notch, up to six on a fast spin, and five times that with Alt held. While any overlay is open the wheel still scrolls the transcript and never moves a list choice; choices move on keys only (`src/engine/application-input-tui.ts`). Pointer movement and window focus never count as keys, so a nudge of the mouse between two `Ctrl+C` presses does not cancel the exit, and the key card, the action menu and overlays do not react to it. Inside Herdr, tmux, zellij and screen, CLIO Coder tracks the mouse only while a button is held. An interview (an `ask_user` round) also turns off mouse tracking and alternate-scroll mode 1007 while it is visible, so the terminal selects and copies text natively and does not turn the wheel into arrow keys that would move the interview's choice. Mode 1007 and mouse tracking return when the interview closes or is hidden (`src/engine/instrumented-tui.ts`).

**Selecting and copying in fullscreen.** A mouse selection in the transcript copies what was written, not the screen. A wrapped paragraph, list item or prompt line comes out as one line and a wrapped code line as its source line, and the turn glyph, the gutter, the prompt bar, the code indent and the `↪` wrap mark stay out. Tables copy as drawn, and a tab copies as three spaces. Wrapped Chinese, Japanese and Korean text copies with no space added at the wrap and with the spaces between Korean words kept; Korean wrapped within a few characters of bold or code markup can still gain a space inside a word. You can select and copy while transcript search is focused or an overlay is open, and click the search box's buttons. A selection in the transcript beside an overlay copies as written too, and a drag over the overlay's own cells copies its screen rows without moving or confirming a choice. A selection is dropped when the terminal's width changes, because the text re-wraps, and when the transcript scrolls under an overlay. A resize keeps a scrolled-up view near its place in the transcript. While the transcript is scrolled up, a `↓ latest` marker sits on its last row; click it to return to the live edge, also with an overlay open. Search matches use the theme's colors. Regular mode leaves selection and copying to the terminal.

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
and the action's menu letter. Rebinding a direct key never moves its menu letter, and
`leader: []` disables the menu. Unknown action IDs and effective conflicts produce
a diagnostic; shipped fullscreen viewport keys that intentionally shadow unchanged
editor defaults carry no conflict tag, while user rebindings can still conflict.
Edits reload routing, components and hints together and cancel a pending menu, and
no preferences are rewritten. Inside the queue navigator `a` restores every queued
message to the composer; `clio-coder.message.dequeue` has no default and can be bound
to do that from the composer. The action `clio-coder.message.followUp` (Ctrl+Q) does
not exist: a keybindings file that names it gets a diagnostic that points to the
navigator's `t` toggle, which sets the end-of-turn slot.

**Terminal delivery.** On stock macOS Terminal.app, Option may compose text;
`Ctrl+G` and the same letter work without changing that setting, and CLIO Coder's hints spell that route there unless the action menu is disabled. A temporary profile with
Use Option as Meta enabled permits direct Alt keys. Windows Terminal/WSL2 can
retain native Alt+Enter, Alt+arrow, clipboard, Find and zoom controls. Ctrl+J
is the portable newline. Node raw mode normally disables flow control and
signal generation; an SSH/mux or terminal UI can still intercept keys, so
`Ctrl+G s` is available if Alt+S does not arrive. In the fullscreen interface, copying a selection tries the platform's clipboard tools in order (the native clipboard on macOS and Windows, then `wl-copy`, `xclip` or `xsel` on Linux, `clip.exe` or `powershell.exe` on Windows and WSL, `pbcopy` on macOS) and flashes a confirmation only when one of them reports success. When none does, it still sends OSC 52 and the flash reads `Copy unconfirmed: <reasons>; OSC 52 sent`, because no terminal acknowledges OSC 52. Over SSH the local tools are skipped, because they would write the remote machine's clipboard, unless X11 is forwarded, which allows `xclip` and `xsel`; without forwarded X11, OSC 52 is the only path and the flash reads `Sent to terminal clipboard (OSC 52)`. Copies in quick succession renew one flash instead of stacking several. Native terminal window
controls remain upstream. CLIO Coder does not own keys while Yazi, an external editor
or the host mux holds focus. Physical Windows/macOS acceptance is separate from
Linux PTY and protocol tests; no terminal profile is installed automatically.

### What Ctrl+C does

`Ctrl+C` is not a single action. It resolves against the current input boundary,
first match wins (`resolveApplicationCtrlCAction`, [application-controller.ts](../../src/interactive/application-controller.ts)):

| State | What Ctrl+C does |
| --- | --- |
| An overlay owns input (transcript search, Library, Settings, model picker) | Closes that overlay. It does not cancel a running turn and does not exit. Any armed shutdown is disarmed. |
| A permission card | Backs out one layer, as `Esc` does: it first closes open details, then open terms, and only then denies the parked call. It does not cancel the running turn and does not exit. |
| A `!` shell command running from the composer | Cancels that command. It does not arm shutdown. |
| Streaming or running a tool | Cancels the in-flight run. The turn seals its partial output in ledger order and the session stays open. The press does not arm shutdown. |
| Idle with messages queued | Protects the queue and says how to recover it: the queue key (`Alt+Q`), then `a`. |
| Idle, nothing queued | Arms shutdown and leaves any draft in the composer. The footer counts down `Ctrl+C again to quit`, preceded by `draft kept, printed on quit` when the composer holds text. A second `Ctrl+C` within 3,000 ms (`APPLICATION_DOUBLE_TAP_MS`) exits, and the kept draft is printed to stderr after the terminal is restored, under `Unsent draft, not delivered to Clio:`. |

In a permission card, `Esc` first closes open details and then open terms, and from the card itself denies the one parked call. `Alt+X` stops the turn, because denying one call does not stop the model from asking again. On a card for a sandbox escape (`unsandboxed: true`) whose only reason is leaving the sandbox, `Alt+P` approves it for this session over the exact scope the card names: the script files it runs (path and content hash), its working directory and its environment assignments, so a rerun of those unchanged files from that directory with that environment no longer asks, and an edited or other script still does. The action menu offers the same local actions: `Ctrl+G x` stops the turn, `Ctrl+G p` approves such an escape for the session, `Ctrl+G v` inspects available mutation details, and `Ctrl+G t` toggles terms while details are closed. These routes follow any rebinding of the menu key; unrelated global actions stay unavailable. Unprefixed letters typed while a card is open go to the composer, never to the card. Denying a permission card is a decision, not a dismissal:
the parked call is cancelled with `User denied this call at the permission
prompt. It will not run; no approval is pending.` (`User denied this call and
stopped the turn. The turn is over.` after `Alt+X`), and a parked *worker*
permission resolves as `deny`. The session itself keeps running.

### Typing before CLIO Coder has finished starting

Interactive startup mounts the editor before it loads its services, so the
composer accepts input from the first frame. Type and press Enter during
startup and the submission is held in a visible pending list, in order. When
hydration completes it adopts that same editor rather than rebuilding it, and
the held submissions drain once, in the order you sent them, through the
ordinary slash/bash/chat pipeline. A draft you have not submitted stays in the
composer with its cursor.

Before hydration, `Ctrl+C` also keeps the draft and uses the same three-second
double-tap window; another key disarms shutdown. Captured skill invocations wait
for any installation confirmation and reload before later submissions drain.
If a captured attachment read or installation is cancelled, its submission
remains available for recovery on exit rather than being acknowledged as sent.

If startup fails or you interrupt it before hydration finishes, the terminal is
restored and any pending submissions and draft text are printed to stderr rather
than discarded. `CLIO_CODER_INSTANT_SHELL=0` opts out and waits for a fully
hydrated first frame. The seam is [terminal-lease.ts](../../src/interactive/terminal-lease.ts).

## Exit summary

A clean interactive exit prints a session summary on stdout after the TUI has stopped and the terminal is restored. In regular mode the input box, its rails and the footer are cleared first, so the summary follows the transcript. In CLIO Coder's private pane host the summary also travels with the exit handshake, and the launcher prints it in your own terminal after the host closes, so the `clio-coder --resume <id>` line stays readable. `interface.exitSummary` picks the style: `auto` (the default), `brief`, `standard`, `report` or `off`. `auto` follows `interface.outputDetail`: `compact` gives `brief`, `standard` gives `standard` and `detailed` gives `report`. `clio-coder upgrade` rewrote the older value `full` to `standard`; a file that still says `full` is refused. Change it under Settings → Chat and display → Transcript → Session summary on exit or with `clio-coder configure --section chat`. The setting reloads hot, so the next exit uses the saved value.

**When it prints.** The summary runs on the application's own shutdown path: `/quit`, `Ctrl+D` on an empty idle composer, and the idle double `Ctrl+C`. It is skipped in these cases:

- A teardown step failed. The failure is reported and no summary follows.
- A signal such as SIGTERM ended the process. Signals go straight to the termination coordinator.
- The visit had no model activity: no assistant message finished, no tool call started, no worker was dispatched, and the session did not already hold a model turn. Nothing prints, even with `off`.
- The run was headless (`clio-coder run`) or an ACP session. Only the interactive session keeps the snapshot.

**What "this visit" means.** The collector in `src/interactive/exit-summary-collector.ts` folds events as they arrive, so exit makes no provider calls. Its only reads at exit are the session ledger's in-memory index and the sealed records of the session's worker runs, which the `Session verified` row counts from. It starts when the interactive session starts and keeps counting across `/resume`, `/fork`, `/tree` and `/new`: turns, files and workers cover every session of the visit, and when the visit spanned several the turns name the current session's own share (`5 turns (1 in this session)`), while `Tools` lists the current session's calls, its workers' included, and counts the other sessions' as `N calls in other sessions this visit`. Tokens, cost and model time come from the telemetry read model's live view of the session and cover every branch the session paid for; `This visit` counts this visit's own calls. A fork's `Session tokens` count only the calls the fork sent, but each of them resends the conversation it copied, so their input or cache read includes the parent's history up to the fork point. Wall time is measured from the start of the visit. When the read model has no view, those rows read `not available`.

**What it contains.** `src/interactive/exit-summary.ts` formats the snapshot and is pure. Every style except `off` starts with `Session` (the session name and id, or the id alone) and ends with the resume line.

| Style | Rows |
| --- | --- |
| `off` | One line: `To resume: clio-coder --resume <session id>`. |
| `brief` | `Model` with the last `target / model` used and `(+N others)` when there were more, `Session tokens` as one total, `Session cost` followed by the wall time, and `Session verified`. |
| `standard` | `This visit` (turns, model calls, files changed, workers; the key reads `This visit, workers included` when workers ran, since their calls and observed writes count, and a worker whose writes no record observed is named beside the file count), `Time` (wall and model time), `Session tokens`, `Session cost`, `Session verified` and `Compactions` when there were any; then up to three `Model` rows with `Models` counting the rest, `Tools` with the first 8 tools by name and a count of further kinds, and `Workers` with the count per outcome. A worker that failed over counts once, by its last attempt, and a council's sealed report is not a worker, since it runs no model. |
| `report` | The same `This visit`, `Time`, `Session tokens`, `Session cost`, `Session verified` and `Compactions` rows, plus a `Cache` row with the cached share of the session's prompt tokens and of its last turn (`45.0% of prompt tokens read from cache · last turn 90.0%`, the figures `clio-coder telemetry cache` reports, and, when a resumed session resent a transcript that differed from the one sent before, where it differed with its breaks and the tokens prefilled again, `resumed transcript differed at message[1]:assistant (1 break, up to 9,000 re-prefilled)`; absent when no call reported its cache read), then titled sections: `Models` (per model the call count, cost and token breakdown; a model no call record names reads `no call record names it`), `Calls by agent` (calls per agent role), `Tools` (calls and observed failures per tool), `Workers` (`agent · outcome · receipt · target / model · runId`), `Files` (change observations per path), `Approvals & refusals` and `Timeline`. |

Every style except `off` adds an `Unattended` row when CLIO Coder answered something alone while the operator was away, such as `2 questions auto-resolved · 1 permission ask timed out and denied` ([Running long jobs unattended](#running-long-jobs-unattended)). It also adds a `Git hooks` row when a git hook file or executable git config value changed during the visit, such as `changed .git/hooks/pre-commit · added core.fsmonitor in .git/config`, and an `Internal git` row when CLIO Coder's own git met that drift, such as `git worktree add without hooks (added .git/hooks/post-checkout)` ([CLIO Coder's own git](../architecture/safety-model.md#clio-coders-own-git)). A session that ran at yolo adds an `Autonomy` row: `contained yolo` or `unconfined yolo`, the tool calls, active time and tokens it used, whether the safety judge ended it or a cap paused it, and its open decisions, which outside `brief` lists the last four. Outside `brief`, `Session tokens` reads as input, output, cache read, cache write and reasoning counts. Changed files are the paths that successful mutating tool calls and worker receipts reported, relative to the working directory when inside it. A command's side effects that no receipt names are not counted. A `report` fits one terminal page of at most 80 rows: sections that do not fit are dropped with `… N more sections; resume to inspect`, and a section cut short ends with `… N more detail lines`.

`Session verified` counts the session's verified outcomes across every branch, a fork only those recorded after it was forked and none it copied from its parent, and divides the session's processed tokens and cost by them, such as `2 outcomes · 2 reproduce or numeric-compare passes · 4,115 session tokens per outcome · cost not measured`. An outcome is a `verify` result whose `reproduce` or `numeric-compare` judgement passed, a worker run whose sealed record says CLIO Coder's host verification passed, or a board task done with every required check observed passing. One verification is one outcome: the same check passing again on the same judged output is the same outcome, a worker run whose every host check judged output already counted as a pass adds nothing, and a done task counts only for a passing check that no other outcome already counts. A `command` or `perf-budget` pass is not counted. Processed tokens are input, output, cache read and cache write, the figure `/usage` shows as `processed`; reasoning is part of output and is not added again. Each share keeps its total's marks, so an unpriced route reads `cost not measured` and an estimate reads `~<amount> est per outcome`. With no verified outcome the row reads `no judged outcome this session; command checks such as unit tests are not counted`. The same figures are on the `/usage` Session view.

Cost reads `$0.00 local` when every call was priced free on a local-native runtime, `$0.00 free (declared)` or `$0.00 free (zero-rates)` when every call was free by that target rule, a plain `<amount>` when every call had a price, and `~<amount> est` when it includes estimates. When some calls had no price it reads `<amount> +?` (`~<amount> +?` with estimates in it), and when no call had a price it reads `not measured`. A partial token or time sum reads `≥` with the number of calls whose value is unknown. These renderings come from `src/core/telemetry/render.ts`. On a terminal the block is a themed frame headed `Clio Coder · Session summary`, or `· Session report` for `report`, with `this visit` on its right edge. On a pipe it is plain lines starting `Clio Coder · Session summary · this visit` (or `Session report`), with no color, frame or wrapping.

## Live Steering

While a run is active, a message you submit waits in CLIO Coder's own steering
queue, shown in the Steering Queue panel above the composer, until the engine
reaches a slot. Every queued message bound for that slot is handed over
together, in the order you typed them, and lands before one model call as
separate user messages. There are three modes, chosen per message; the default
is next slot.

| Mode | Key | Delivery |
| --- | --- | --- |
| Next slot | `Enter` | Between tool batches, mid-run. The agent keeps going and reads every queued message before its next model call. A message typed during the run's final model call is handed over at the end of that call, so the run carries on with it instead of ending. |
| End of turn | `t` on the entry in the queue navigator, or ACP mode `end-of-turn` | When the whole run settles and CLIO Coder would hand control back. A turn is the whole run, not one model round. |
| Send now | `Alt+S` or `Ctrl+G` `s` | Cancels the in-flight work the way `Esc` does (generation aborts; a running bash child gets SIGTERM, then SIGKILL), waits for the cancelled run to seal its tool results in ledger order, then submits the draft as a fresh prompt. Anything already queued stays queued and lands at the new run's first slot. With an empty draft, Alt+S flushes the queue, running or held: the first entry is the prompt and the rest land with its first model call. While a tool call is running, Alt+S asks whether to stop it or to send after it finishes; waiting queues the message ahead of everything else. |

A prompt template that sets `allowed-tools`, typed with `Enter` while a run is active, is never handed into the running turn, because its tool limits would not apply there. It is queued as a follow-up that keeps its typed line and its limits, and when the run settles it starts as its own turn, ahead of any yolo continuation. Clearing it, or moving it back to the editor, returns the typed line. ACP and headless runs still refuse such a template while a turn runs. Send now refuses a `/name` that expands to no template, as `Enter` does, instead of sending the literal line to the model.

### Queued messages after a stop

An operator stop (`Esc` or `Ctrl+C` on a running turn, or `Alt+X`) ends the run and sends nothing.
At a permission card, `Esc` denies only the one parked call, so the run and its queue go on. A loop-guard stop and a cancelled job keep their own settlement.
After an operator stop, queued messages stay in the panel as separate entries, in order, and a notice
says how many wait and which keys act on them. `Alt+S` with an empty composer
sends them in order, each as its own user message. A new prompt takes them at
its first slot. `Alt+Q` then `a` restores them to the composer. A peer's or other
machine-origin entry is dropped with a notice instead of being held.

A message you submit after the stop, while a slow tool is still dying, is the
prompt it would have been had the tool died sooner: it is sent when the run
settles, and the held entries take its first slot. Pressing `Esc` again holds
it with the rest.

A loop-guard or tool-budget stop was not your choice, so your queued messages
are delivered as a fresh prompt when the run settles. If a prompt never starts,
for instance because its target is gone, the entry it carried returns to the
head of the queue and the notice repeats. A local shell line or `/tree` move
keeps the queue. Changing session returns it to the composer with a notice.

### The queue navigator

`Alt+Q` opens the queued messages as a list. `Up`/`Down` select, `Shift+Up`/
`Shift+Down` move an entry, `e` takes it back to the editor, `x` removes it,
`t` flips it between the next slot and the end of the turn, `Enter` sends the
selected entry now and keeps the rest queued, and `a` puts everything back
in the editor. The panel shows each entry's slot word,
how long it has waited, and advisory marks: `!` when a reading found it urgent,
`·t` when steering triage relabeled it. Steering triage is experimental and
off by default (`chat.steering.triage`): when on, a bound System One route or
else a side model reads the queue once it has settled, moves an unrelated task to the end of the turn unless you
set its slot yourself, and may interrupt the run on a confident stop. A label route never interrupts.

### The same three modes against a background worker

The table above describes the main agent. Against a dispatched worker the three
modes are not symmetric:

- **Steer** reaches a worker. `@<agent> <text>` sends the message across the
  worker channel; the worker acknowledges it and keeps running.
- **End of turn** does not. A worker has no follow-up queue, so a new goal for
  it is a new dispatch.
- **Send now** is refused while an attached dispatch is running, for the reason
  given below. Cancel the worker itself with `Esc`, which stops the run and
  still leaves a sealed run record.

Send now is refused in two states and the message is queued at the head of the
queue for the next slot instead, with a notice saying why: while an attached
dispatch is running (the abort would kill the worker's run with no run record;
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

CLIO Coder resolves the token to an exact agent id first, then to a run-id prefix,
and forwards the text to an HTTP or SDK worker's steering channel. File-looking
tokens such as `@package.json` are rejected so ordinary repository references
do not accidentally become steering requests.

The Fleet Runs board (`/fleet`, `←` on an empty composer, or `Alt+W` without a pane host) makes this control path discoverable: use
Up/Down or `j`/`k` to select a run, `m` to close the board and prefill its
exact `@<runId> ` steering prefix, and `x`, pressed twice, to cancel a live worker or queued
retry. `Enter` or `Tab` toggles the selected run's detail, `Esc` folds an open detail before it closes the board, and with a pane host `w` takes the workers dock over for a live run. At narrow widths, the footer prioritizes available steer/cancel actions over navigation and detail hints; Enter still expands the selected card. Completed runs offer no steer/cancel actions. A steer first reports `queued`; only the worker's
`clio_coder_steer_received` acknowledgement reports `received`. Single-shot
subprocess runtimes and ACP delegation do not expose a live steering channel
and are labeled accordingly.

## Operating Posture and Autonomy

CLIO Coder has two autonomy levels. **default** contains shell work in an OS sandbox, snapshots before destructive steps, and has a safety judge review what escapes containment before anyone is asked. **yolo** is for work you leave running: nothing waits for you. It is contained by default, so the sandbox, snapshots and safety judge stay on and a call `default` would ask you about is refused back to CLIO Coder. Unconfined yolo (`safety.yoloConfinement: unconfined` in user settings, with its own acceptance) is the skip-permissions mode: nothing asks, and only a short floor of catastrophic actions, rules in an approved `.clio-coder/safety.yaml` and the run's ceilings block. Set the level in `/settings`, `clio-coder configure`, with `--autonomy`, the leader-key `y` toggle, or an ACP client's mode. `--turn-mode proposal` is workflow guidance, not a read-only permission boundary; use `--allow-tools` when execution must be restricted. An interactive session can preview a CLIO Coder settings change with `configure_clio`; at `default` applying it requests the host's Apply choice, and an edit to `fleet.default`, `fleet.profiles` or `fleet.agentProfiles` asks the operator on its own approval card, while `yolo` applies the exact preview directly. See the [settings reference](configuration-reference.md), [safety model](../architecture/safety-model.md), [Bash policy](tool-usage.md), and [information flow](information-flow.md) for source labels and approved destinations.

### Choosing an autonomy level

| Level | Choose it for | What happens |
| --- | --- | --- |
| `default` | Everyday work, attended or left running. | Workspace edits, and file edits inside the scratch roots, run. With a sandbox backend, `bash` and `run_script` run inside the main-session sandbox without asking: the workspace, the scratch roots and a private sandbox cache are writable while your own `~/.cache` and `~/.npm` stay read-only, credentials, credential variables, secret files such as `.env` and the SSH agent are hidden, new local Unix sockets are refused, and the network stays on. In a Git work tree, destructive workspace operations such as `git reset --hard` or `rm -rf build` run after a workspace snapshot. A call that leaves the sandbox, publishes, writes a git hook or config file, or trips a damage-control rule goes to the safety judge, which runs it or refuses it against your own messages. You are asked only when the judge has no verdict, after it has blocked repeatedly, or for decisions only you make: project settings, fleet routing, library installs, plan-scale dispatch and `ask_user` questions. |
| `yolo` | Long jobs that should not stop for approvals, interviews included. | No approval card waits for you, but CLIO Coder still asks you questions: an interview a skill runs (such as `plan-interview`), the close of a plan you asked for, and choices only you can make reach you as at `default`. A question nobody answers within `safety.unattendedAfterSeconds` takes its recommended option (one that leaves the workspace is declined, an outward one is answered no, and an `operator_only` one has no window and waits for you). At yolo that window is never unbounded: `0` reads as 300 seconds. Once a window lapses with no key pressed since, later questions wait at most 30 seconds until you type again. Your own answer counts as your words for the safety judge, so a push you approve on a question can run. Yolo is contained by default: the sandbox, snapshots and safety judge work as at `default`, dispatch plans and pipelines run without the plan approval, and any other call `default` would ask you about is refused back to CLIO Coder instead, so the job keeps going without it. An outward step (a push, a publish, a request that sends data) runs only when your own message or your answer to a question names it. Unconfined yolo (`safety.yoloConfinement: unconfined`, which has its own one-time card recorded as `safety.yoloUnconfinedAccepted`) is the skip-permissions mode for a container or another disposable environment: nothing asks and commands run unsandboxed as you, with your credentials; `safety.sandbox: required` sandboxes every command `default` would contain, and every script, and refuses `unsandboxed: true`. The footer shows `YOLO · contained` or `YOLO · UNCONFINED`. The floor still blocks deleting or overwriting `/`, your home directory or a system tree, `mkfs`, `wipefs`, writes to a block device, fork bombs, writes into CLIO Coder's own config, state and trust records, and reads of its credential store. The first interactive switch shows a one-time acceptance card, recorded as `safety.yoloAccepted`, and yolo is refused as root outside a container. |

The launchpad names the level and what it does here: `Default · auto in workspace`; `Default · auto edits · no OS sandbox` when no OS sandbox backend is available, where edits run without asking and shell commands keep their approval path; `Default · auto edits` before the sandbox probe has answered; `YOLO · contained · never waits`; or `YOLO · UNCONFINED · never asks`. At `yolo` the footer reads `YOLO · contained`, `YOLO · contained (no OS sandbox)` (`YOLO · no sandbox` when narrow) or `YOLO · UNCONFINED`.

Workers you dispatch inherit the level inside their own sandbox. At `default` the ordinary asks of native local workers go to the same safety judge (`fleet.permissions.mode: judge`); at contained `yolo` workers are dispatched as at `default` and their operator-only asks are denied; at unconfined `yolo` workers run the yolo way inside their dispatch scope. The exact rules are in the [safety model](../architecture/safety-model.md#what-runs-what-is-judged-what-blocks).

When a command fails because of the sandbox, for example because it needs a credential or writes outside the writable roots, CLIO Coder can rerun it with `unsandboxed: true`, and that call, recognized or not, goes to the safety judge, which lets it run when your request named the escape and otherwise asks you. A directory your scripts and file edits should always be able to write belongs in `safety.scratchRoots` in your user settings. `clio-coder doctor` shows whether this host contains shell commands and where they may write.

### Undoing file changes with /rewind

In a Git work tree with `safety.snapshots: auto` (the default), CLIO Coder writes a private snapshot of the work tree before the first change of each turn and before every destructive command, branch delete or `git reset` to another commit. Each snapshot also pins HEAD and your stash entries, and a branch delete pins the branch it removes, so `git gc` keeps those commits. Snapshots and pins live under `refs/clio-coder/snapshots/<session>/` and never touch your index, HEAD or branches. Ignored files, untracked files over 16 MiB and nested repositories are not captured.

`/rewind` lists this session's snapshots, newest first, with how many files each differs from the workspace by. `Enter` previews what a restore would change. Confirming takes one more snapshot first, so the rewind itself can be rewound, then restores modified and deleted files and removes files the snapshot did not have. Ignored files are left alone. A rewind never moves refs: the details list a snapshot's pinned refs, and the preview marks each one still in place, moved since or gone, with the command that brings it back, such as `git branch <name> <sha>` or `git stash store -m <message> <sha>`, for you to run. Wait for a running turn to finish, or stop it, before rewinding. `/rewind` restores files; `/tree` moves the conversation.

### Telling the safety judge about your environment

The judge reads your messages in this session and the proposed call, never the agent's reasoning or tool output. It blocks destroying data outside the workspace and scratch roots, publishing, rewriting shared history, sending secrets to unrelated hosts, changing shared or system configuration, weakening CLIO Coder's safety, killing processes the session did not start, mass cloud deletes and running code fetched from the network, unless one of your messages names that action. Facts it cannot infer go in your user `settings.yaml`:

```yaml
safety:
  judge:
    environment:
      - "Shared HPC cluster; /scratch/$USER is mine to create and delete in."
      - "The staging database on db-staging.internal is disposable."
    allow:
      - "restarting the dev containers this project's compose file defines"
    deny:
      - "anything that writes under /projects/shared"
```

`environment` lines describe your machine in your own words. `allow` and `deny` lines add rules to the judge's defaults. `target` and `model` pick the judge's route; left `null`, the judge asks the chat route. `enabled: false` turns the judge off, so every such call asks you instead. These keys are honored only in user settings and apply at the next review.

### Running long jobs unattended

- **Attended, then walk away.** `safety.unattendedAfterSeconds` (default `300`) bounds how long an approval card or `ask_user` question waits in the TUI, at either mode; a GUI or ACP client's question waits the shorter of it and the client's request timeout. An unanswered card is denied and the turn continues on another route; an unanswered question takes its recommended option unless that option leaves the workspace, and an outward one is answered no. An `operator_only` question, a choice only you can make, shows no recommended pick and no countdown in the TUI: CLIO Coder can never answer it, so it waits for you. Pressing any key while the countdown runs stops it. When you come back, `/decisions` shows what CLIO Coder chose for you, and the exit summary's `Unattended` line counts it. `0` waits forever.
- **Headless `clio-coder run` at `default`.** Containment, snapshots and the judge apply, and every ask the judge does not allow is denied at once. The judge reads only your prompt, so name the actions the job needs, such as "push the branch when tests pass".
- **Plan for what the sandbox refuses.** A contained command starts without credential variables and cannot open secret files or create local Unix sockets, so tools such as a local database client, Docker, the `tsx` CLI, X11 or D-Bus clients, and Python multiprocessing with the `forkserver` start method (the Linux default from Python 3.14) fail with `Operation not permitted`. CLIO Coder reruns such a command with `unsandboxed: true`, which the safety judge reviews, so name the tools the job needs in your request. A variable the job must keep inside the sandbox, such as a registry token a build reads, goes in `safety.sandboxPassEnv` in your user settings; `safety.sandboxUnixSockets: allow` turns the socket refusal off. A git command that would run a hook changed during the session always asks you; a headless run, or an unanswered card after the timeout, denies it.
- **`clio-coder run --autonomy yolo`.** Nothing stops the run for approval. Contained (the default), a call the safety judge does not allow is refused back to the run, as at headless `default`. Unconfined, these still stop it or its calls: the yolo floor, your `safety.yaml` rules, the session cost ceiling and `--max-cost-usd`, `--timeout`, the loop guard, and the per-turn tool budget (`safety.limits.chatToolCallsPerTurn`, 60 by default), which blocks further calls and ends the turn 15 calls past that. At yolo a turn that reached the budget then continues with a fresh one, and this repeats until the cost ceiling or the loop guard ends it. A turn stopped by a loop guard lock, the hard tool-call ceiling, an identical-call loop stop, exhausted retries or a failed compaction gets up to 3 continuations per operator prompt, and the last two causes wait 1, 5, then 15 minutes first, or the provider's Retry-After if that is longer. Run it where an unattended command cannot damage the host. As root outside a detected container it exits 2; set `CLIO_CODER_SANDBOXED=1` when the process already runs in a sandbox the detection does not recognize.
- **How an unattended reply reads.** In a headless run, and in any session at `yolo`, the final reply opens with its standing against the request: done, partly done or not done, naming any unmet part, and it says "Done" only when every part is met. Short Situation (what the request left unsaid), Actions (paths changed, commands run) and Results (expected against observed, then what is unverified) parts may follow when there is something to say.

### When a model stalls, loops or answers with nothing

- **A stream that repeats itself.** Once a streamed thinking or text block passes 4,000 characters, CLIO Coder checks its trailing 12,000 characters every 1,024. A sentence or line of 30 characters or more repeated five or more times, with units seen three times covering 60% of that window, aborts the call. The first such loop in an operator turn is dropped from context and the model gets one nudge to act or answer, with a notice saying so; a second loop ends the turn and says why on the message.
- **A reply with a call written out, or with nothing in it.** A reply that writes a tool call into its text or reasoning instead of making one, or that ends with no answer and no call, is re-prompted with a reminder. The two share a budget of three re-prompts in a row: a real call resets the count, so a long turn that keeps recovering is re-prompted each time, while a fourth such reply back to back with no real call between them ends the turn. A turn that ends on a dismissed interview is not re-prompted.
- **A repeated failing call.** When the loop guard blocks or locks a repeat of a call that failed, the refusal restates that call's earlier error: its first paragraph, on up to two lines, without the echoed arguments. At yolo the continuation after a loop lock or stop quotes the same error and asks for changed arguments before any retry.
- **The per-turn tool budget.** The refusal at `safety.limits.chatToolCallsPerTurn` lists the turn's calls by tool, most used first, counting a gateway call as its capability, so a summary can say which step spent the budget.

## Dispatch and Built-In Agents

Use `clio-coder agents` to inspect the installed agent catalog and `clio-coder run --agent <id> "<task>"` for a non-interactive dispatch. In the TUI, `/run` starts a fleet worker, a configured headless coding peer or a configured ACP peer, and `/panes peer` opens an interactive handoff pane. Fleet profiles determine target, model, and limits; worker execution and run records are covered by [Fleet dispatch](fleet-dispatch.md). Agent ids and recipe contracts are maintained in [Built-in agents](built-in-agents.md). See [Coding Agent Interoperability](interop.md) for peer setup and workspace choices.

## Environment Variables

CLIO Coder-specific and ambient variables are listed in the [environment variable reference](environment-variables.md).

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

**Alt+O** cycles **Minimal → Default → Detailed → Minimal**. Default is the startup tier, so the first press reveals Detailed. Changes are acknowledged in the footer. Cycling applies immediately to the current session, including startup chrome, streaming output, history and open background surfaces such as the fleet dock, the workers dock and `/usage` (see [TUI design](../architecture/tui-design.md#output-styles)). Save a preferred startup tier through **/settings chat → Output detail**, or `clio-coder configure --section chat`. The persisted values remain `compact`, `standard` and `detailed`.

| Content | Minimal | Default | Detailed |
| --- | --- | --- | --- |
| Answers and user messages | Complete | Complete | Complete |
| Supplied reasoning | Marker | 3 rows | 12 rows |
| Reads and searches | Consecutive successful observations grouped | Action and outcome | 8 result rows |
| File changes | Paths and change facts | 8 diff rows | 20 diff rows |
| Agent shell commands | Command and outcome | 3 output rows | 12 output rows |
| Your `!` / `!!` shell commands | 3 output rows | 6 output rows | 12 output rows |
| Workers | Identity, execution and validation outcome | 3 summary rows | 8 summary rows and bounded tool activity |
| Failures and refusals | Actionable reason, up to 4 rows | Actionable reason, up to 4 rows | Up to 12 rows |
| Reports (Doctor, multiline notices, command output, extension results) | Title and counters on one row | Up to 8 rows (Doctor lists errors first) | Every row and detail |
| Turn receipt | One row: the outcome mark, duration and local end time (`✓ 4.2s · 18:42`) | Completion, available duration and local end time (`✓ Done · 1m4s · 18:42`) | Usage and model-call facts, closing with the local end time |

A receipt's end time is the local wall clock to the minute; a turn that ended on another day adds the date (`Sep 17 18:42`), and another year adds the year. A replayed or resumed session shows each turn's recorded end time, and a turn with no recorded end time shows none.

Preview budgets count terminal rows **after wrapping**, including the `/view` overflow hint, and shrink on short terminals. Reasoning previews retain the newest text when streaming stops. Detailed remains bounded: a successful `cat` or file read cannot fill the transcript with the entire file.

Use **/view transcript** to select full available reasoning, tool arguments/results, local shell output, or worker details. Search the list, press Enter to inspect, and Escape to return. Offloaded tool and dispatch output remains available in the other `/view` categories; missing or truncated captured content is identified. Inspection applies secret redaction, and `!!` output remains excluded from model context.

Output style changes presentation only. **Shift+Tab** changes the model's thinking effort and does not reveal unavailable reasoning; CLIO Coder shows only reasoning supplied by the provider. There are no separate reasoning-expand or tool-expand shortcuts, and `/output` is not a command: it answers like any unknown command. `/help` names the output-detail shortcut, `/settings chat` saves a default and `/view` shows full details. `clio-coder upgrade` rewrote a saved `minimal`, `default` or `verbose` value to `compact`, `standard` or `detailed`; the older spellings are refused. How each segment of the reply renders is in [TUI design](../architecture/tui-design.md).

The footer owns live activity. Transcript actions have static running or outcome markers and update in place. Background workers add a count without replacing the main agent's current phase; a completed worker cannot clear a sibling's active state. Approval and user-input waits do not spin. Failed and cancelled turns retain their actual outcome, and an elapsed wait is described as silence rather than proof that a process is stuck. A worker's successful execution remains separate from its validation result.

### See full tool output with /view

To see the full available tool output, open `/view transcript`, search the list and press Enter to inspect a tool result. Escape returns to the list. Other `/view` categories hold offloaded tool and dispatch output; the viewer identifies missing or truncated captured content and applies secret redaction.

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
| You need a clean start | Use `clio-coder reset --state`, `--data`, `--cache`, `--auth`, `--settings`, or `--all`. |

For issue reports, include `clio-coder --version`, `node --version`, `clio-coder doctor`,
`clio-coder targets`, the command you ran, the target/model, expected behavior, and
actual behavior. Redact secrets and private repository content.

> [!NOTE]
> `clio-coder dev <command>` groups the instruments that answer a question about the
> harness rather than about your own work. Bare `clio-coder dev` or `clio-coder dev --help` prints
> developer instrument help and exits with code 0. The instruments resolve only under
> `dev`. The prefix exists so `clio-coder --help` stays the set of
> commands a person needs to read; `clio-coder --help --all` prints both lists. Across all
> CLI subcommands (`targets use/remove/rename/profile/convert`, `context refresh`,
> `fleet run/status/admission`, `playbook list`, `auth login`), passing `--help` prints
> usage instructions and exits with code 0.

## Operator-task handoff and continuation

`clio-coder tasks hand <uN>` prints the inbox record as JSON on stdout and an actionable pickup prompt on stderr. Submit that prompt to the intended session. Before task work, the model must pick the intended `uN`, confirm its durable session and board linkage, and use the returned `tN`. Handing a task does not itself pick it. Completion should be checked against the linked board and inbox with the actual IDs; manual CLI completion is an operator action, not evidence of model completion.

Acceptance rows labeled Required declare expected checks and timeout limits; they are not pending executions or passing results. Inspect verification receipts for outcomes. Under high rigor, the finish gate requires the applicable passing checks or explicit limitations.

Task-board guidance and ordinary continuation preserve proposal-only scope. Deferred implementation should be blocked or dropped while awaiting an explicit operator go-ahead. A skill-install decision is separate from implementation authorization, and yolo authority does not expand the task. Task guidance is included in the model prompt; tool admission independently applies the configured policy.

## Library packages

Use `/library` and `/library skills|agents|prompts` to browse resources. `/skill <name>` activates a loaded skill; `/library interop` reviews external coding-agent peers; `/extensions` manages extensions. See [Resource library](resource-library.md), [Interop](interop.md), and [Extensions and sharing](extensions-and-sharing.md).

With an empty composer, press `?` for the docked key card, `←` for the workers dock (Fleet Runs in a session without a pane host), or `↓` for Tasks. The next key closes the key card without taking another action. With a draft, `?` inserts text and the arrows move the cursor.

`/usage` opens the docked Activity tab with workspace session history and current consumption. Its six tabs are Activity (`1`), Accounts (`2`), Session (`3`), Models (`4`), Workers (`5`) and Health (`6`); `/usage <tab>` opens on one. Use Tab to switch tabs and PgUp/PgDn, Home or End to read a long tab.

Live Fleet runs reserve a section just above the composer. This summary never covers transcript text and disappears when no run is live. Open Fleet Runs with `/fleet` to inspect additional runs; `Alt+W` and `←` on an empty composer open it in a session without a pane host.

Open `/settings models` to add or edit targets inside the TUI. Choose **Add a target**, or select a target and choose **Edit URL, runtime and default model**. The shared configure wizard stays in the composer dock. Use arrows to select, type to edit or filter a model list, Enter to continue, Esc to go back, and Ctrl+C to cancel setup. Target settings remain a draft until **Save target**, which writes global settings; credentials are stored when browser sign-in succeeds. Editing a target preserves explicit chat, fleet and memory model defaults.

At the default CLIO Coder directories, authenticated sibling CLIs remain connected accounts even without a CLIO Coder target. When any resolved CLIO Coder directory differs from its platform/XDG default, sibling quota adapters are excluded unless their own home is explicitly set: `CODEX_HOME` for Codex CLI, `CLAUDE_CONFIG_DIR` for Claude Code, or `ANTIGRAVITY_HOME` for agy. Those directories contain `auth.json`, `.credentials.json`, and `antigravity-oauth-token`, respectively. Excluded adapters read no credentials, make no requests, and display no cached account rows. CLIO Coder-owned Anthropic Max and OpenAI Codex credentials remain available in relocated homes.

The Local AI `$0.00` quota row is shown only when settings contain a target whose registered runtime tier is `local-native`. A cloud-only configuration has no local-cost row.
