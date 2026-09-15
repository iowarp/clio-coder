# Commands and Modes

Clio Coder is a terminal-first coding agent. This page is the detailed command
reference for interactive sessions, headless runs, dispatch, verification, and
common operator workflows; the README remains an approachable product and
onboarding guide.

Source of truth: `src/cli/index.ts`, `src/interactive/slash-commands.ts`,
`src/domains/dispatch/**`, `src/tools/registry.ts`, and the current test suite.
For process exit codes, stdout deliverable guarantees, and machine-readable JSON streaming formats, see [exit-codes-and-output.md](exit-codes-and-output.md).

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
| `clio-coder --no-skills` | Disable skill discovery for one invocation while still honoring explicit `--skill` paths. |
| `clio-coder --skill <path>` | Load one explicit skill file or directory for one invocation (repeatable). |
| `clio-coder configure` | Run the configuration wizard. Ctrl+C reports `configuration cancelled`, writes no target, and exits 130; when first-run onboarding is cancelled, startup stops instead of opening the TUI with no usable target. |
| `clio-coder configure --interop` | Review other coding agents detected on this machine and connect one as a delegation peer. Without a TTY it prints the proposals and writes nothing. |
| `clio-coder configure --list` | List user-facing runtime ids. |
| `clio-coder configure --list --all` | List every registered runtime, including aliases. |
| `clio-coder config [inspect] [--json]` | Print the effective customization graph across settings, context files, rules, skills, prompts, agents, extensions, safety, memory, hooks, and operator profile. |
| `clio-coder targets [--json] [--probe] [--target <id>]` | List configured targets, health, auth, runtime, model, and capabilities. |
| `clio-coder targets add` | Add a target interactively or through configure flags. |
| `clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>] [--fleet-target <id>] [--fleet-model <id>]` | Select the named roles only when any role flag is present. `--background-model` selects memory; `--orchestrator-model` selects chat; `--fleet-model` or `--fleet-target` selects fleet. Other roles and thinking levels are preserved. Without role flags, chat and fleet use the target default (or shared `--model`), while memory is preserved. Confirmation names only roles whose settings changed. Model IDs must match a nonempty discovered or cached inventory exactly; unavailable discovery is reported explicitly. |
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
| `clio-coder doctor [--fix] [--json]` | Diagnose state. Plain `doctor` is read-only and leaves even a partially initialized home byte-for-byte untouched. With `--fix`, create missing structure and templates, repair credential permissions, and refresh install metadata. Settings remain strict; lifecycle migrations belong to `upgrade`, not `doctor --fix`. |
| `clio-coder tools list [--json]` | List the pinned external tool registry and whether each program resolves from `PATH`, Clio's vendored data directory, or nowhere. |
| `clio-coder tools status <id> [--json] [--reset-profile]` | Inspect one registered tool. `--reset-profile` applies only to yazi's generated profile. |
| `clio-coder tools install <id> [--force] [--json]` | Download the platform asset, verify every declared checksum, and atomically vendor it. |
| `clio-coder tools remove <id>\|--all [--json]` | Remove Clio-vendored copies without touching a program found on `PATH`. |
| `clio-coder panes install` | Alias for `clio-coder tools install herdr`. |
| `clio-coder panes theme` | Print Clio's theme tokens as a herdr `[theme.custom]` block to paste into herdr's `config.toml`; Clio never edits that file itself. See [Panes and the Files Pane](panes-and-files.md). |
| `clio-coder reset [--state\|--data\|--cache\|--auth\|--config\|--all] [--dry-run] [--force]` | Reset selected Clio Coder state. `--state` is the default level. |
| `clio-coder uninstall [--dry-run] [--remove-binary] [--force]` | Remove Clio Coder state and print uninstall guidance. |
| `clio-coder upgrade [--dry-run] [--channel=<latest\|beta\|dev>] [--skip-migrations]` | Refresh state metadata, apply migrations, and update npm installs when applicable. |
| `clio-coder agents [--json] [--all]` | List discovered agent specs. |
| `clio-coder fleet list\|run\|status\|drain\|resume` | List fleet contracts, run one, show dispatch state, or control admission. `drain` denies new execution starts for up to one hour and preserves running work; `resume` reopens admission immediately. `run <name>` takes `[--var k=v ...]` and `[--json]`; `status`, `drain`, and `resume` each take `[--json]`. |
| `clio-coder fleet view <runId\|fleetRootId> [--follow]` | Read the append-only run journal after verifying receipt trust. A fleet root prints its durable step index. Without `--follow`, the width-bounded snapshot is plain text with no ANSI control bytes. `--follow` requires an interactive terminal and one run id; `fleet view --help` prints this subcommand's own usage, including `--watch`. |
| `clio-coder fleet view --watch <selection-file>` | Follow the run id currently named by the selection file and retarget when it changes. This is the operator-pulled watch surface used by the pane integration. |
| `clio-coder dev components [list] [--json]` | List behavior-affecting harness components. |
| `clio-coder dev components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio-coder dev components diff --from <a> --to <b> [--json]` | Compare component snapshots. |
| `clio-coder evidence build\|inspect\|list` | Build and inspect deterministic evidence artifacts. |
| `clio-coder eval validate\|run\|report\|compare\|gate` | Validate, run, report, compare, and gate local evaluation suites (Suite v2). |
| `clio-coder memory list\|propose\|promote\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. |
| `clio-coder trace runs [--db PATH] [--limit N] [--json]` | List runs recorded in the durable trace mirror beside the ledger. |
| `clio-coder trace inspect --json` | Emit the fixed, bounded recent accounting projection used by the Workbench. It accepts no path, identifier, or limit and omits request text, error prose, event payloads, process commands, PIDs, and hosts. |
| `clio-coder trace phases <runId> [--db PATH]` | Show one run's recorded phases. |
| `clio-coder trace tail <runId> [--follow] [--db PATH]` | Tail one run's recorded events; `--follow` streams as they land. |
| `clio-coder trace procs <runId> [--db PATH]` | Show the processes one run spawned. |
| `clio-coder trace code-steps <rootId> [--json]` | Show the deterministic code-step records one fleet root wrote (argv, cwd, env names, exit code, duration, output digest, artifact paths). They are files beside the ledger, not rows in the mirror, so `--db` does not apply. |
| `clio-coder trace prune [--max-age-days N] [--max-bytes N] [--db PATH] [--json]` | Apply the trace-retention policy while protecting queued and running runs; JSON reports the resolved policy, rows, runs and bytes removed, protected runs, and whether vacuum ran. |
| `clio-coder trace sql <SELECT query> [--db PATH]` | Run one read-only query against the mirror. Only a single `SELECT` or read-only `WITH` statement is accepted; anything else exits 2. |
| `clio-coder dev evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio-coder extensions list\|discover\|install\|enable\|disable\|remove` | Manage installed extension packages and resource roots. `clio-coder ext` is an accepted alias. |
| `clio-coder library list\|search\|register\|inspect\|validate\|install\|update\|enable\|disable\|drift\|pin\|remove` | Manage packages of kind plugin, skill, agent, prompt or fleet at user/project scope; `install/update --dry-run` preview. `library skills` lists runtime skills; `library inventory --json` is the fixed GUI read. |
| `clio-coder docs [topic] [--no-open]` | Open the documentation in the web app, rendered directly from the canonical Markdown. Reuse the configured background app or start a foreground loopback server; `--no-open` prints its launch link. |
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
| `--target <id>` | One-run main-agent or dispatch target override. |
| `--model <wireId>` | One-run model override. |
| `--thinking <level>` | One-run thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--autonomy <level>` | One-run autonomy override: `read-only`, `suggest`, `auto-edit`, or `full-auto`; it does not change saved settings. |
| `--temperature <n>` / `--top-p <n>` / `--top-k <n>` / `--min-p <n>` | One-run sampler overrides when the selected runtime supports them. |
| `--presence-penalty <n>` / `--frequency-penalty <n>` / `--repeat-penalty <n>` | One-run penalty overrides when the selected runtime supports them. |
| `--max-context-tokens <n>` | One-run context-window override for supported local runtimes. |
| `--json` | Stream JSONL events for main-agent runs; dispatch streams events and receipt JSON. |
| `--json-events <mode>` | Main-agent JSON stream mode: `full` or `terminal`; implies `--json`. |
| `--session <id>` | Append this turn to an existing session identified by `<id>`. |
| `--continue` | Append this turn to the most recent session for the current working directory. |
| `--agent <recipe-id>` | Dispatch a fleet agent instead of the main agent. Unknown ids fail fast. |
| `--skill <path>` | Load one explicit skill file or skill directory for this run. Repeatable. |
| `--no-skills` | Disable skill discovery for this run while still honoring explicit `--skill` paths. |
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

### Headless Session Continuity

A headless turn (`clio-coder run`) starts a fresh session unless `--session <id>` or `--continue` specifies a session to append to.
- `--session <id>` appends the turn to the session with id `<id>`.
- `--continue` appends the turn to the most recent session recorded for the current working directory.
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
| `/extensions` | `/extensions [reload]` | Inspect harness extensions or reload their hooks and operator runtimes. |
| `/interop` | `/interop` | Inspect another local coding agent and review adoption of supported resources. |
| `/share` | `/share [runId]` | Share a worker result with the main agent |
| `/archive` | `/archive export <path> \| /archive import [--dry-run] [--force] <path>` | Export or import a full Clio archive |
| `/run` | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] [--share] <agent> <task>` | Run a fleet agent |
| `/delegate` | `/delegate [--share] <agent-id> <task>` | Run an ACP delegation agent |
| `/btw` | `/btw <question>` | Ask a side question that never enters the session transcript |
| `/oracle` | `/oracle <question>` | Ask a read-only advisor to challenge a question against this session's settled decisions |
| `/council` | `/council [--roster <name>] [--rounds <n>] [--synthesis <judge\|vote\|none>] <task>` | Ask a roster of read-only members the same task, with an optional vote or judge synthesis |
| `/agents` | `/agents` | Open the Library on Agents. |
| `/cost` | `/cost` | Show session token and cost totals |
| `/context` | `/context compact [instructions] \| /context recall <ref> \| /context init \| /context refresh \| /context reset` | Context hub: window overlay plus compact, recall, init, refresh, and reset |
| `/fleet` | `/fleet run [--var <key=value>] <name>` | Open Settings → Fleet, or run a fleet contract with an approval preview |
| `/decisions` | `/decisions` | Show settled interview decisions and operator revisions |
| `/tasks` | `/tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] <text> \| /tasks hand <id> \| /tasks done <id> \| /tasks drop <id>` | Show the session board or manage project operator tasks |
| `/memory` | `/memory seed` | Inspect, promote, or seed task memory |
| `/view` | `/view [filter] \| /view verify <runId>` | Browse session artifacts and verify receipts |
| `/panes` | `/panes show <run-or-agent> \| /panes open <preset-or-argv> \| /panes zoom [target] \| /panes close [target]` | Inspect the pane layer, watch a live run in a pane, or open a utility pane (`files`, `logs`, `shell`, `files --once`, or a command); a second open focuses the pane already there |
| `/files` | `/files [open\|close\|pick]` | Toggle the files pane docked below the session; picks land in the composer as `@` mentions. See [Panes and the Files Pane](panes-and-files.md) |
| `/thinking` | `/thinking [level]` | Set the chat thinking level, or open Settings → Orchestrator |
| `/model` | `/model [pattern]` | Open model selector or set a model |
| `/settings` | `/settings [chat\|fleet\|targets\|context\|safety\|interface\|integrations] [group]` | Open interactive settings, optionally at a durable area and UI group |
| `/resume` | `/resume` | Resume a past session |
| `/new` | `/new` | Start a fresh session |
| `/handoff` | `/handoff <goal>` | Hand this session's working state to a fresh session for a stated goal |
| `/tree` | `/tree` | Open session tree navigator. Press `p` to filter by current cwd and `s` to cycle tree order or most recent first. |
| `/fork` | `/fork` | Fork from an assistant turn |
| `/export` | `/export [path]` | Export a self-contained HTML transcript by default; a `.md` path writes Markdown |

Operator tasks are durable project work in `.clio-coder/user-tasks.json`. Use
`clio-coder tasks add "Fix the solver" --expect src/solver.ts --verify test:solver:60000`
or `/tasks add Fix the solver --expect src/solver.ts --verify test:solver:60000`.
Both `--expect <path>` and `--verify <checkId>[:timeoutMs]` are repeatable. Expected
outputs use repository-relative paths; verification ids must exist in the project
verifier catalog or package scripts when added. An omitted timeout uses the
check's declared timeout, and requested timeouts are bounded as in dispatch
intent. If a complete value matches a declared id containing colons, it names
that check; otherwise the final numeric suffix is the timeout. Acceptance travels
with the task when handed and picked, and seeds the board's required validation
evidence. Under high rigor, a turn that changes files while this task is active
must record a passing validation receipt for every named check or a successful
`limitation` receipt whose `paths` array includes the exact check id. A task's
completion note alone does not satisfy acceptance. `clio-coder tasks list`,
`hand <uN>`, `done <uN>`, and `drop <uN>` manage the same inbox as `/tasks`.

Retired commands are rejected before model submission. Old Library browsing forms, including `/resources`, `/library <kind>` and `/agents connect`, explain the canonical route. Browse with `/library`, `/skills`, `/agents` or `/prompts`; use `/interop` for local-agent adoption and `/extensions` for harness extensions.

`/context` with no arguments opens the context-window ledger overlay, including
the working-set section (policy, evicted items and tokens, events, recalls, churn).
The subcommands own the durable project-context noun: `compact` summarizes older
turns in the session window, `recall <ref>` prints an evicted tool-result body
back into the transcript by the ref its `[evicted ...]` marker names (it never
enters model context; the model recalls with `context(scope="recall", ref=...)`),
`init` bootstraps or updates `CLIO-CODER.md` and the
codewiki, `refresh` re-indexes the codewiki and refreshes `.clio-coder/state.json`
without touching `CLIO-CODER.md`, and `reset` deletes accumulated
context artifacts (`.clio-coder/codewiki.json`, `.clio-coder/state.json`,
`.clio-coder/handoffs/`, `.clio-coder/proposals/`). Its interactive choice preserves or
deletes `CLIO-CODER.md`; cancellation makes no changes. Session reset stays `/new`;
there is deliberately no `/context clear`. The spellings `/context-init`,
`/context-clear`, and `/context-view` are gone and are not aliased to anything.
There are no slash-command aliases. `/context compact`, `/quit`, `/model`,
`/settings`, and `/skill <name>` are their only spellings. Retired or foreign
spellings stay errors that name `/help` instead of guessing which operation the
operator intended.

`/model` never changes routing on its own. Both spellings, the picker and
`/model <pattern>`, resolve the swap and then ask where it lands: `Apply this
session`, `Apply and save globally`, or `Cancel`. Session is the default and
touches no file, so a mid-conversation experiment dies with the session that
made it; global is the same write the settings center performs, and it is the
only one a later launch inherits. Cancel leaves the model where it was. A
thinking level named in the pattern follows the same choice.

`/btw <question>` runs one model round beside the session and renders the answer
in an overlay. It sends the same compiled message history the next turn would
send, as read-only input, under a short system instruction saying this is a side
question, with no tools. Nothing about the round is appended: not the session
JSONL, not the transcript panel, not the context ledger, not the task board. That
is the point of it. A fleet run briefs its workers from the transcript, so a
question the operator asks to orient themselves mid-run would otherwise become
context every worker inherits. Esc closes the overlay, and cancels the round if it
is still streaming. `/btw` during an in-flight turn is refused with a notice
rather than queued, because a side question answered after the run it was asked
during has already missed its moment. The round's token usage still shows in
`/cost`, labeled as a side question, because it was a real call and cost real
money; it is deliberately not counted as a turn.

`/council [--roster <name>] [--rounds <n>] [--synthesis judge|vote|none] <task>`
asks a roster of two to five read-only members the same task and puts the group on
the Fleet Runs board as one card. It owns no dispatch path of its own: the command
builds dispatch-tool arguments and admits them through the tool registry, so a
supervised autonomy level parks the call and the approval overlay names every
member's label, target, model, node, round count, and synthesis mode before
anything runs. Members are pinned to read-only autonomy and the council tool
surface by admission, exactly as they are for a council the model asks for.

`--roster` names a `fleet.rosters` entry. Without it the command takes
`fleet.rosters.default` when that roster exists, and with neither it refuses
and names the setting to declare. A roster that is the only one configured is
still not the default: seating a council from whichever roster happens to be
present would run models the operator never chose. `--rounds` accepts one to
three and `--synthesis` accepts `judge`, `vote`, or `none`, which are the tool's
own bounds, enforced where the operator typed them so a council is never refused
after its plan has already been shown. `/council` during an in-flight turn is
refused with a notice rather than queued, for the same reason `/fleet run` is: an
approved plan describes the workspace as it stands. Nothing the members produce
enters the main agent's context until an operator runs `/share`.

`/handoff <goal>` carries this session's working state into a fresh session for a
goal the operator states. The goal is required and gated: a goal shorter than 12
characters is refused, and so is one of a small stoplist of non-goals such as
"continue", "next", or "resume". Both refusals name the rule they enforce, because
"keep going" is exactly the instruction a handoff exists to replace.

One model round then runs on the same out-of-turn seam `/btw` uses. It reads the
compiled message history the next turn would send, sends no tools, and answers
with JSON validated against a fixed response schema of decisions, facts, files,
commands, and open questions. Every list and every string is bounded; output over
a bound is truncated with a visible marker and the document names each bound that
fired, so nothing is cut silently and an over-eager answer is never a refusal.

Every file path the model names is checked against this session's read ledger and
never against the filesystem. Paths the session did not touch are dropped and
listed in the document under their own heading so the operator can see what the
model invented. Extracted decisions are merged with the session's settled decision
board, and the board wins. The result is one Markdown document opened for review:
Enter accepts it, `e` hands it to `$EDITOR`, and Esc cancels the whole handoff with
nothing written anywhere.

On accept, Clio mints a new session, writes the reviewed document into it as
bounded data labelled as a handoff from the old session id, and replays the old
session's skill activations so loaded skills carry forward. The document is never
written as a fabricated user turn. The old session is left untouched apart from one
terminal note recording the target session id. A handoff is a session operation
throughout: it writes no memory promotion candidate and never calls the task-memory
bank. `/handoff` during an in-flight turn is refused with a notice rather than
queued, because a document summarizing a session that is still moving would be
wrong by the time it was read.

The `/resume` picker accepts Page Up and Page Down to move by its 12 visible rows. Arrow keys continue to move one session at a time, and typing continues to filter the list.

Only active commands run. Typing anything command-shaped that the registry does
not own checks the loaded prompt templates across native and foreign prompt roots.
Built-in command names are reserved across interactive and headless modes; a
template with the same basename is omitted from `/prompts` with a collision
diagnostic instead of shadowing a command on one surface and expanding on another.
If a matching template is found in an untrusted project root, Clio prints that the
prompt template comes from an untrusted project root and directs the operator to set
`integrations.projectResources.trustProjectImports`, sending nothing to the model. If the token names
neither a command nor a template, it reports `is not a command` and points at `/help`;
it is never sent to the model. That covers spellings removed outright, such as
`/status` and `/receipts`, as well as ordinary typos. It replaces the earlier
behavior where an unrecognized spelling reached the model as prose and was answered
conversationally, which left the operator believing a command had run when nothing had.

A headless `clio-coder run "/typo"` refuses the same way. The verdict is reached
before boot, so no session is opened and no turn is spent; the diagnostic names
the token on stderr and the run exits `2`, the usage-error code.

Command-shaped means one word of letters, digits, hyphens, or colons after the slash, so
paths such as `/home/user/notes.md` still reach the model unchanged. One word
followed by prose is treated as a command, because `/status please` and `/tmp is
full` are indistinguishable. To send such a line as text, escape the slash:
`\/tmp is full` reaches the model as `/tmp is full`. The escape claims a single
backslash and only in front of a slash, so `\\server\share` is unchanged, and it
works on a real command too, so `\/help` is a question about `/help` rather than
the help overlay.

A rejected command stays in the input line. The error names the spelling and the
text is still there to correct, rather than having to be retyped. Retired spellings (such as `/status`, `/receipts`, `/context-init`, `/context-clear`, `/context-view`, and `/skill:<name>`) are not recognized and fail closed with `/<token> is not a command. Type /help for the list.`

The accepted spelling of every command is the table under [Interactive Slash Commands](#interactive-slash-commands); there is exactly one per operation, and nothing else is parsed as a command.

Configuration lives in one place: the `/settings` overlay. `/settings <section>` reaches every section directly. `/thinking <level>` and `/model <pattern>` stay as quick setters that apply without opening anything.

Settings → Targets presents an operational console table (`HEALTH`, `ID`, `ROLES`, `RUNTIME`, `LATENCY`) with an in-place action/detail drawer for URL, default model, last probe error, and reachability. `Enter` opens actions for `Use` (switches active chat target and rebases model), `Connect` (runs the API-key or OAuth flow then probes), `Probe`, and `Remove` (with preflight analysis of affected routes/profiles). Probing runs live when the overlay opens or when explicitly requested. Target creation is initiated via `clio-coder targets add`.

Settings → Fleet is an entity workbench organized with dim group headers (`Defaults`, `Profiles`, `Agent routes`, `Placement`). Dispatched worker defaults and profile rows render as compact summaries (`fast-local node-a/example-coder-model  high  auto`), drilling into fields (`target`, `model`, `thinkingLevel`, `node`) on `Enter`. Profile removal is a named destructive action with affected-route preflight. Running and retrying dispatches live in the `Alt+W` Fleet Runs board, which also steers and cancels them. `Enter` opens the selected run's worker detail: the phase, the running call with its redacted action descriptor, and the bounded tail of the worker's own prose.

`/run` and `/delegate` put the worker's answer on screen. Both echo the typed
line dim above the block, then stream the run into the transcript as an attributed
block: a header (`◇ coder · node-a/example-coder-model · run 2mkas6s` for fleet workers,
or `◇ codex (acp) · run 7hq2ab` for ACP peers), the worker's prose down a rail,
one coalesced line of tool names, and a one-line footer carrying the outcome glyph,
token count, duration, and contract status (such as `└ ✓ ok · 8.4k tok · 18s · contract unmeasured`),
with the failure reason printed on the rail above the footer when a run fails.
Model-launched workers use `◆` and operator-launched workers use `◇`; both follow the same Output style. Standard shows a short reported summary, Detailed adds bounded activity, and Compact keeps identity and outcome. The footer shows the active worker count alongside the main agent's phase. Use `/view transcript` or `/view dispatch:<runId>` for full available details. Memory workers do not appear as transcript blocks. A failover keeps one block with an attempt annotation.

That block is the only place a `/run` answer goes. The main agent is not told
about it, which is what makes a side run a side run; asked about the answer, it
will say it has not seen one. `--share` on either command hands the result over
when the run finishes, and `/share [runId]` does it afterwards for a run already
on screen. Bare `/share` takes the newest finished run the operator started
themselves (never a model-asked `◆` run), while `/share <runId>` may name a
model-asked run explicitly. What crosses is the receipt's own bounded text under a
`[worker result] coder · run 2mkas6s · ok · shared by the operator` header,
entering the session through the ordinary user-turn path so replay and
compaction treat it as operator text. The header names the operator as the
origin, and the system prompt tells the main agent that such a note is
operator steering whose run id names a receipt it can read, so a model that
never dispatched the run does not discard it as unattributed output. A turn
that only relays a shared note does not trip the unbacked-worker-claim
advisory.
A council run shares as a council. `/share <synthesis runId>` brings the whole
`council-report` in as one bounded block: every final-round member's answer under
its roster label, each with its verdict when it declared one, then the synthesis
line naming the mode, the verdict, the tally, and the judge run when there was
one. `/share <member runId>` brings that one member's answer in under its roster
label, so a single voice never reaches the main agent as an unattributed one. A
synthesis run whose sealed text does not parse as a report is shared verbatim
rather than dropped, because the operator named that run.

`/new` resets the transcript and the pool bare `/share` draws from, so a run
from the previous session cannot be shared into the new one. Worker tool
arguments never cross at all: the transcript carries tool names only, the same
rule the dispatch board follows.

Blocks survive a resume. Each attempt writes a `workerRun` session entry naming
the run, its origin, and its runtime, and `/resume` rebuilds the block from that
entry plus the sealed receipt under `<state>/receipts/<runId>.json`. The session
file's `workerRun` entries carry ids, origins, and runtime references only, without
prose; the replayed answer is bounded from the receipt exactly like the live one.
A run whose receipt is gone replays with a `receipt unavailable` footer rather
than a header with nothing under it. The entries are bookkeeping: they cost nothing
in the context window and never become model context, so resuming a session full
of side runs does not spend the window on them.

The `/tasks` overlay combines the live session board, terminal task history,
successful workspace artifacts, and the project-scoped operator task inbox.
The live board shows every task with its status, operator provenance, completion
evidence, or block/drop reason. It persists as full `taskLedger` snapshots, so
stable board history and `userTaskId` pickup links survive `/resume` and `/fork`
and can be audited from `current.jsonl`. Operator tasks persist separately in
`.clio-coder/user-tasks.json`; the overlay can add, hand, finish, or drop them.
The model-facing `tasks` tool's session-ledger and inbox bookkeeping is the
documented read-class exception described in [the safety model](../architecture/safety-model.md):
calls remain audited as `read` and do not grant workspace mutation authority.

The `/decisions` overlay shows completed and cancelled `ask_user` interviews
from the active branch. It retains settled and superseded values from
`decisionLedger` snapshots, expands the source question and answer, and lets the
operator supersede a decision or enter a correction. A correction is submitted
to the model as an ordinary operator turn after the durable snapshot changes.

The read-only `/memory` overlay keeps durable and session memory attributable
in one place. It lists approved evidence-backed lessons, then the live task
bank by private status, knowledge, and procedural class, including each
entry's injection count and the last memory-step outcome. The welcome launchpad
and expanded dashboard summarize whether intervention is on, its rules or LLM
tier, and current bank size.
After `/resume`, Clio offers `/memory seed` when the newest handoff contains a
structured snapshot. Seeding is explicit, deduplicated, and unavailable while
`context.memory.enabled` is false.

The `/interop` overlay lists the other coding agents Clio found on this machine,
grouped `Detected`, `Configured`, `Declined`, and `Inventory`. A detected row's detail pane
shows the exact `integrations.externalAgents.entries` entry that connecting it would append, plus
the two facts a new peer inherits: `projectContext: none`, so the peer receives
the task text and never the project projection, and `toolGovernance:
clio-coder-policy`, so its tool calls are gated by Clio safety. Press `a` to connect
one or `d` to decline. Opening the overlay refreshes the disk inventory and runs
bounded version probes; navigation and plan approval start no agent session. Accepting applies to the live session,
because `delegation` hot-reloads.

Boot adds at most one line about interop. `/interop` opens the inventory and connection review. The hint names installed, unconfigured, undecided agents and stays silent in headless or ACP mode. Declining an agent silences its connection proposal until its binary version or path changes.

`clio-coder interop inspect [--json]` reports host resources and wiring. `clio-coder interop adopt <host> [--kind skill|agent|prompt|plugin] [--project|--user] [--yes] [--dry-run]` shows a plan and requires approval before installing safe resources through the library. `/interop` offers the same adoption plan with source and destination scope, kind selection, and explicit approval. See [Coding agent interoperability](interop.md) for layouts, limits, and trust semantics.

`clio-coder doctor` reports interop and never proposes anything. It emits one
`ok` row per detected agent naming its version, its path, and whether it is
configured, one `warn` row for a configured peer whose command no longer resolves
on PATH, and one aggregate row counting the skills loaded from foreign roots. A
machine with no other agents installed emits no interop rows at all. Reachability
for a stdio peer means the command resolves; doctor never starts a session with
one, and plain `doctor` writes nothing.

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
| `Alt+U` | Toggle dashboard | `u` |
| `Alt+W` | Toggle Workers | `w` |
| `Alt+E` | Toggle files from Clio focus | `e` |
| `Shift+Tab` | Cycle supported thinking effort | `t` |
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
first match wins (`resolveApplicationCtrlCAction`, `src/interactive/application-controller.ts`):

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
hydrated first frame. The seam is `src/interactive/terminal-lease.ts`.

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
retry. A steer first reports `queued`; only the worker's
`clio_coder_steer_received` acknowledgement reports `received`. Single-shot
subprocess runtimes and ACP delegation do not expose a live steering channel
and are labeled accordingly.

## Operating Posture and Autonomy

Clio Coder operates with a single, unified tool surface. There are no separate tool-visibility modes; what varies is the `autonomy` level (`read-only` | `suggest` | `auto-edit` | `full-auto`), edited in the `/settings` Autonomy & Safety section.

Tool and command execution is governed by:
- **Target Capabilities:** What the selected model target actually supports (such as tools, streaming, and vision).
- **Safety Net:** Granular rule packs loaded from `damage-control-rules.yaml`, project policies, and protected artifact paths; always on, identical at every autonomy level.
- **Autonomy Mapping:** Once the net passes a call, the level decides whether it runs, asks, or is denied. See [safety-model.md](../architecture/safety-model.md) for the full matrix.

When an action asks for confirmation, whether from a safety-net rail or from the autonomy level, the call parks and three surfaces say so at once. The transcript row reads `⏸ awaiting approval` with `action ·`, `axis ·`, and `target ·` lines under it; the footer phase pill reads `⏸ confirm`; and a consequence-tier dialog opens with the tool, target, action, authenticated requester, one-shot authority, reversibility, and deny and stop effects. Titles distinguish workspace authority, outward consequences, safety-net confirmation, system changes, and worker escalations. The dialog sits at bottom center with five rows reserved for the composer and footer, and it re-anchors on resize. The composer rail switches to `CONFIRM` and repeats the keys while the prompt owns the keyboard.

The keys are the same on both surfaces: `Enter` allows this one call, `Esc` denies it, and `s` denies it and stops the turn so nothing asks again. `Enter` allows only from an empty composer. While the composer holds a draft, the habitual send key does nothing, the rail and the dialog footer read `[Backspace] clear draft` instead of `[Enter] allow`, and only the deletion keys (`Backspace`, `Delete`, `Ctrl+U`, `Ctrl+W`, `Ctrl+K`) reach the editor until the draft is gone. Every other key is swallowed. A call that parks while another overlay holds the screen is announced with an `[approval]` notice and the dialog opens as soon as that overlay closes; the dialog lays itself out for any terminal width, so no width is too narrow for it. Approving or denying never changes the level.

Notice vocabulary, one prefix per mechanism: `[safety-net]` for level-independent blocks, `[approval]` for parked calls, `[autonomy]` for read-only denials, and `[middleware]` for hook diagnostics.

## Dispatch and Built-In Agents

Fleet dispatch runs focused agent recipes through configured targets. The final agent fleet includes:

| Agent | Category / Audience | Use it for |
| --- | --- | --- |
| `architect` | `plan` / `base` | Mapping boundaries, contracts, and migration slices. |
| `coder` | `implement` / `base` | Bounded implementation, repairs, and behavior-preserving refactors. |
| `debugger` | `quality` / `base` | Explaining a failing run, test failure, or session evidence without edits. |
| `documenter` | `implement` / `base` | Updating developer-facing docs, examples, and operational runbooks. |
| `git-master` | `implement` / `base` | Bounded git repository operations, history, commits, worktrees, and PR preparation. |
| `tester` | `quality` / `base` | Focused tests for regressions and verification gaps. |
| `verifier` | `quality` / `base` | Independent test, lint, build, and quality gate reports. |
| `wiki-writer` | `implement` / `base` | Planning one repository wiki or researching and writing one wiki page. |
| `scout` | `explore` / `shadow` | Read-only repository exploration, symbol mapping, and context assembly. |
| `researcher` | `research` / `shadow` | Documentation, literature, and web-grounded investigation. |
| `provenance` | `operations` / `shadow` | Reading evidence files, receipts, diffs, and telemetry for handoffs. |
| `oracle` | `plan` / `shadow` | Challenging one question against the session's settled decisions through `/oracle`. |
| `context-bootstrap` | `internal` / `internal` | Bootstrap agent behind `clio-coder context init` that inspects the repository and returns `CLIO-CODER.md`. |

Examples:

```bash
clio-coder run --agent coder "Find the main build, test, and lint commands."
clio-coder run --agent architect "Plan a minimal change to add JSON output to the CLI."
clio-coder run --agent verifier "Run tests and confirm the build passes."
```

Dispatchable shadow helpers (`scout`, `researcher`, `provenance`) appear in
`clio-coder agents --all`, the full agent catalog, and the compact fleet prompt,
but user-origin `/run` and `clio-coder run --agent` requests are rejected for
them. `oracle` also appears in `--all` and the full catalog, but it is deliberately
excluded from the compact prompt and is reached only through `/oracle`.
For broad repository reconnaissance, the operating contract and Scout catalog
description steer the model to author a Scout dispatch. The chat harness does
not mechanically route the request. A threshold nudge advises Scout delegation
after 9 or more manual read-only exploration calls in one turn.

Agent recipes are the Markdown source files. The normalized agent spec is the
catalog/runtime view: category, capability class, latency class, tags, mode, and
tool set. This keeps Clio's product vocabulary stable while dispatch continues
to execute through the existing engine worker path, the sanctioned Claude Code worker runtimes (`claude-sdk` and `claude-code`), or external ACP delegation agents.

## Verification Lanes

| Command | Purpose |
| --- | --- |
| `pnpm run ci` | Local and GitHub PR gate: typecheck, lint, library package pin and skill audit checks, build, the deterministic test suite, and the web application suite. |
| `pnpm run ci:release` | Maintainer release gate: `pnpm run ci`, then the `check-release` dist and packaging audit. |
| `pnpm run typecheck` | Strict TypeScript pass. |
| `pnpm run lint` | Biome checks plus `scripts/check-hygiene.ts`, which runs the boundary invariants, the library package pin and skill audit checks, and the README and docs drift rules. |
| `pnpm test` | Focused contract and smoke files through plain `node --test`. |
| `pnpm run build` | Production bundle through `tsup`. |
| `pnpm run dev` | `tsup --watch`. |
| `pnpm run clean` | Remove `dist/`. |

Live provider checks cost tokens or local GPU time and are deliberately not
part of deterministic CI. Maintainers perform them explicitly against an
isolated Clio home and a named configured target, recording the target, wire
model id, serving configuration, and result with the release evidence. This is
the appropriate lane for local gateways such as llama.cpp, LM Studio, vLLM,
and SGLang, and for cloud targets with operator-provided credentials.

## Environment Variables

Clio Coder also reads environment variables for platform paths, diagnostics, lifecycle integration, tests, and process-local behavior such as `CLIO_CODER_RIGOR`. Durable guardrail policy lives only in settings. For the complete maintained inventory, see [environment-variables.md](environment-variables.md).

---

## Project Context

Clio uses the nearest checked-in `CLIO-CODER.md` as the canonical project guide. Run
`/context init` in the TUI or `clio-coder context init` from the shell to create or
refresh it. During adoption, Clio can fold useful content from supported agent
instruction files into `CLIO-CODER.md` with provenance.

To skip project context for one invocation:

```bash
clio-coder --no-context-files
clio-coder -nc run --agent scout "..."
```

### Codewiki index

`clio-coder context index` builds the structural codewiki without any model calls. It
writes `.clio-coder/codewiki.json` plus
`.clio-coder/state.json`, records `codewikiVersion`, and prints coverage plus a
structural hash. The same builder is used by `clio-coder context init`, `clio-coder context
refresh`, session freshness checks, tool-demand backfill, and in-session
incremental updates.

`clio-coder context map` derives an archify architecture specification from the structural index without model calls and writes it to `.clio-coder/artifacts/maps/<repo>.architecture.json` (or `--out <path>`). Map generation reconciles the existing structural index before mapping; missing index refuses, naming `clio-coder context index`. Pinned source citations require that the workspace is clean at repository root and indexed file bytes match current files and Git blobs under a GitHub origin and full `HEAD` revision. Unknown or dirty source states fall back cleanly to usable uncited seeds; `--json` reports path, counts, repository metadata, reconciled index status, and source state (`clean`, `dirty`, or `unknown`). Clio produces the deterministic seed while Archify validates and delivers it. Standard validation checks schema conformance and layout composition, while source review assesses semantic claims and visual review in a browser assesses layout presentation. Custom model-authored maps can remain layout-invalid until refined.

### Working-set replay

`clio-coder context replay --sessions <path>...` accepts individual session directories,
Clio sessions roots, and ledger JSONL files; `--synthetic <ids>` adds one or more procedural
corpora (`science-long`, `refactor`, `exploration`) generated in memory from a fixed seed, so
the committed tables can be rebuilt byte for byte on any checkout without private transcripts.
Clio traces remove prior eviction/recall sidecars and select the active branch. Both sources
drive the live fold, projection, policy, and eviction planner at deterministic turn
boundaries. The default inclusion cascade for ledgers requires at least eight turns, eight
tool results, and one file re-read; `--no-filter` retains every otherwise-readable trace.
Markdown goes to stdout unless `--md` names a file, while `--json` writes a stable report
including the configuration, the corpus, git revision when available, and exact command line.
`--protect-last-turns` and `--min-evictable-tokens` override those two working-set settings
for the replay only; they never update saved settings. Saturated events is pooled over
applied eviction events and reports how often a policy exhausted its usable candidates,
which distinguishes a budget that measures policy choice from one that simply runs out of
evictable material. Recall tokens is the token-weighted complement of precision: what a
perfect recall would read back for evicted items the session referenced again. Cold prefix
tokens is the projected working set after the earliest evicted position of each event, which
is what an exact-prefix cache re-prefills on the next request. The replay also models the
summary stage: when the projection is still over the threshold after an eviction, it applies
the same `findCutPoint(keepRecentTokens)` cut the live path uses, appends a stand-in
`compactionSummary`, counts it, and treats what the cut removed as lost for retention.
Summaries (mean) is therefore the number of lossy, token-spending compactions a policy forced
per trace. The summary-headroom mean always carries its contributing trace count because
traces that never require summary compaction do not enter that nullable mean.

`clio-coder context working-set --session <id|path>` is a read-only inspection command for
one ledger. It prints evicted refs with reason, superseding ref, and token count; aggregate
event, recall, and churn facts; path-observation counts by operation; and paths whose earlier
reads were followed by writes or edits. A persisted `/tree` pin is honored when the session
metadata is available, so the report does not resurrect an abandoned branch.

The current artifact is schema v5. It records files with path, language, line
count, role, content hash, imports, and optional summary; declaration-only
symbols with name, kind, file id, line, and optional signature; and import edges
to internal files or external modules. The writer emits compact JSON.
Tree-sitter extraction covers TypeScript, JavaScript, Python, Go, Rust, C, C++,
Java, Ruby, and C#, with per-file regex fallback where a regex extractor exists.

### Markdown wiki commands

`clio-coder context wiki` generates the optional agent-authored wiki under
`.clio-coder/wiki/` by dispatching the `wiki-writer` agent through the configured
model target. It makes one planning dispatch, which revises the page plan the
codewiki index derived, then one dispatch per page. `quickstart.md` and every
directory `index.md` are generated deterministically from the pages' front
matter after the run, so no dispatch writes them. `.clio-coder/wiki/meta.json` records
the page list, model label, content hash, git head, indexed source-tree hash,
and the plan.

Ordinary planner, page, and whole-run time and tool estimates are advisory across
generation, not automatic aborts. An explicit caller deadline (`timeout_ms`) or
operator cancellation remains authoritative. Failed writers remain pending; admission
rejection does not consume a writer attempt. When `generation.pagesWritten` is below
`generation.pagesPlanned`, run `clio-coder context wiki --update` to continue pending pages
and refresh stale pages based on changed source dependencies, or run `clio-coder context wiki --retry-pending`
to retry each pending page once, including exhausted pages, without erasing cumulative attempts
or replanning at the same depth.

Coverage depth is controlled by `--depth auto|simple|medium|detailed` and is harness-owned;
explicit upgrades and downgrades requeue coverage while retaining existing prose, and
default retries retain saved depth. Both original writer output and saved pages pass nonmutating
mechanical validation (missing/escaping paths, invalid line ranges, malformed source/test
metadata, or empty bodies keep pages pending); mechanical checks do not establish semantic
accuracy or that the model read the source.

`clio-coder context wiki --update` requests update mode explicitly. It revalidates
pages against bounded source-byte evidence and recorded source and test dependencies
rather than assuming unmentioned pages remain fresh. Pages with changed inputs or
dependencies, as well as pages whose Git evidence is missing, unreadable, or changed,
are re-queued for generation, while verified up-to-date pages are preserved; it is not a
promise to overcome exhausted attempts.
`clio-coder context wiki --status` is read-only: it prints whether wiki metadata is
present, page count, `updatedAt`, recorded `gitHead`, whether that head differs
from current `HEAD`, and retained failure diagnostics for unwritten planned pages. It dispatches
nothing and spends no model tokens.

`clio-coder context refresh` rebuilds only the structural codewiki and state. It does
not run a model and does not touch `CLIO-CODER.md` or `.clio-coder/wiki/`. If a wiki exists
and its recorded git head is stale, the command prints the hint:

```text
wiki is stale; run clio-coder context refresh --wiki or clio-coder context wiki --update
```

`clio-coder context refresh --wiki` is the explicit model-spend path for refresh. It
first rebuilds the structural codewiki, then updates an existing wiki when
`.clio-coder/wiki/meta.json` exists. If no wiki metadata exists, the flag is accepted
and no wiki model call is made; use `clio-coder context wiki` to create the first
wiki.

### code_nav modes

Agents query the codewiki through the read-only `code_nav` tool instead of
grepping the tree. Every mode reads local artifacts, so lookups are fast and
model-free.

| Mode | Arguments | Returns |
| --- | --- | --- |
| `symbol` | `query=<name>` | Declaration records with path, line, kind, and signature. |
| `path` | `query=<glob \| /regex/ \| substring>` | Indexed files whose path matches the pattern. |
| `entries` | `[limit=<n>]` | Likely entry points from file roles and `package.json` main/bin. |
| `outline` | `query=<path>` | Declarations in one indexed file. |
| `deps` | `query=<path>` | The file's internal and external imports. |
| `dependents` | `query=<path>` | Indexed files that import the target file. |
| `wiki` | none | Wiki pages plus absent/fresh/stale state and layout warnings. |

`entries` defaults to 25 results and caps at 200. `path` accepts a
`/pattern/flags` regex, a glob using `*`, `?`, or `[...]`, or a plain substring.
`outline`, `deps`, and `dependents` resolve an exact indexed path or a unique
substring match.

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

## TUI Surface Refinements

The Clio TUI has been enhanced to maximize readability, operational focus, and command discovery:

- **Welcome header:** Before your first prompt the header is three rows and no box: a masthead (`>C_ Clio Coder v0.4.7` on the left, `~/iowarp/clio-coder · main*` on the right), the route (`✓ dynamo · qwen3.8-27b`), and one next step (`describe a task · Enter to send · / for commands`). The next step names whatever actually blocks work first: no route or model sends you to `/model`, an unavailable or degraded route to `/settings targets`, a missing or stale `CLIO-CODER.md` to `/context init` or `/context refresh`. A healthy route shows no latency; a failing one shows its reason. Your first submit collapses the header to one live row, `>C_ Clio Coder v0.4.7 · dynamo · qwen3.8-27b · ~/iowarp/clio-coder · main*`, which follows a mid-session model change. `/new` returns to the three-row form; `/resume`, `/tree`, `/fork`, `/handoff` and `--continue` open collapsed. See [tui-design.md](../architecture/tui-design.md#51-welcome-launchpad--session-header) for the width-degradation order and route vocabulary.
- **Unmistakable Clio Composer:** The input editor features an explicit left section tag reflecting current prompt semantics (`MESSAGE` while idle, `FOLLOW-UP` while Clio runs, and orange `STEER` when Enter steers in-flight execution). Includes the dim placeholder `Ask Clio…  / for commands` and lower-rail hint `Enter send · Ctrl+J newline` at wider widths.
- **Progressively Disclosed Footer:** The compact footer uses a quiet two-zone status layout that suppresses idle decoration (`tools none`, `◌ idle`, and duplicate turn receipts). Line 1 displays workspace location, git branch/dirty state, and active phase only when meaningful; Line 2 displays the context window gauge, current Output style, and session cost. `Alt+U` toggles the expanded dashboard, which orders information by operational urgency (Activity, Context, Session, Workspace).
- **Footer Notification Degradation Ladder:** The footer notification badge reserves the severity head (`glyph count noun`) and `[Ctrl+G x] dismiss` tail first, allocating remaining width to an ellipsized message body. Under narrow terminal constraints, it degrades cleanly down the ladder without clipping action keys.
- **Grouped Slash Command Palette:** Typing `/` opens an autocomplete command palette grouped by operational category (`Run`, `Inspect`, `Configure`, `Sessions`) with compact argument hints. Every suggestion is the command's one canonical spelling.
- **Voice-First Transcript & Receipts:** User (`› `) and assistant (`✦ `) prose are formatted with a two-cell hanging indent, ensuring wrapped continuation lines remain visually tied to their voice prefix. Tool ledgers maintain full terminal width. Completed turn receipts honor output verbosity (`minimal` none, `default` compact dim `turn · in N · out M`, `verbose` full receipt with call counts, cache reads/writes, reasoning provenance, and verification caveats).
- **Transactional Settings Center:** Open `/settings` or deep-link to one of
  `chat`, `fleet`, `targets`, `context`, `safety`, `interface`, or
  `integrations`. Value edits construct change plans offering `Apply this
  session`, `Apply and save globally`, or `Cancel`; narrow terminals use a
  drill-down layout below 72 columns.

## Overlay and Presentation Conventions

Clio Coder follows strict presentation guidelines across all TUI surfaces:

### Hint Grammar
All TUI overlays construct footer hints using a standard grammar. Keys are displayed in brackets and normalized to canonical casing (`Enter`, `Esc`, `Space`, `Tab`, `↑↓`, `r`, `R`, `type`), separated by a middle dot (` · `):
- Format: `[Key] action · [Esc] close`

### Browse vs. Commit Modes
Overlays operate in one of two modes which govern the Escape key behavior:
- **Browse Mode:** Used for read-only viewing or exploration. The Escape key is labeled `close` (`[Esc] close`).
- **Commit Mode:** Used for forms, selections, or settings changes that alter state. The Escape key is labeled `cancel` (`[Esc] cancel`).

### Notice Levels
Diagnostic writes in the transcript use the themed notice channel instead of raw ANSI or bracket prefixes. Notices render a single themed line containing a colorized glyph and the message:

| Level | Glyphs | Color Token | Purpose |
| --- | --- | --- | --- |
| `info` | `ℹ` | `info` | Informational notices and general system status |
| `success` | `✓` | `success` | Operation completed successfully |
| `warn` | `⚠` | `warning` | Non-fatal issue or precaution |
| `error` | `✗` | `error` | Fatal issue or operation failure |

### ListOverlay Behavior
The `ListOverlay` component provides a reusable kit for filterable, grouped, and selectable lists with an optional detail pane.

Navigation keys include the up and down arrow keys, as well as the 'j' and 'k' keys when the filter input is not focused. These keys wrap selection around the ends of the list.

The Tab key, or the Enter key when no primary action is defined, toggles the detail pane below the list.

For filtering, typing in the input row dynamically filters items using a fuzzy search that matches both the item label and the group name. Group headers that have no matching items are hidden. The Escape key clears a non-empty filter, and pressing it again closes or cancels the overlay.

The detail pane displays structured descriptions, usage, or state metadata using the Markdown component with the Clio markdown theme.

### Responsive Width Adaptation

All TUI overlays fluidly adapt to narrow terminals down to 40 columns:
- `/view` falls back to one pane on narrow terminals. Type to filter, use Enter to read, Escape to return to the list, and Escape again to close. Ctrl+U clears the filter; long text wraps and scrolls. Tab also switches panes.
- Settings provides a drill-down navigation stack below 72 columns (sections → rows → details) with breadcrumbs and `Esc` backtracking.
- Text content and detail descriptions wrap cleanly without line truncation.

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

## Package evals

`clio-coder eval validate --package <path|kind:name> --eval <name>` validates a named package suite. `clio-coder eval run` with the same package flags runs it; `--user` or `--project` selects the installed copy. Materio declares `scripts` for its offline Python contracts. The experimental skill-scenario lane is `clio-coder eval skill <name|path> [--scenario <id>]`. See [Library packages](resource-library.md).

The old top-level CLI `skills` and `plugins` groups are retired; use `clio-coder library`. In the editor, `/library`, `/skills`, `/agents` and `/prompts` open the shared browser. `/resources` and `/plugins` give a replacement hint. `/skill <name>` activates a skill; `/interop` handles local-agent discovery and reviewed adoption.
