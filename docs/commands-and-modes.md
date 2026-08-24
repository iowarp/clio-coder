# Commands and Modes

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/commands_blueprint.html](html/commands_blueprint.html) (Version: 0.3.6).


Clio Coder is a terminal-first alpha harness. This page keeps the command
reference, interaction modes, dispatch surface, verification lanes, and common
operator guidance out of the README so the release entry point stays short.

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
| `clio-coder configure` | Run the configuration wizard. |
| `clio-coder configure --interop` | Review other coding agents detected on this machine and connect one as a delegation peer. Without a TTY it prints the proposals and writes nothing. |
| `clio-coder configure --list` | List user-facing runtime ids. |
| `clio-coder configure --list --all` | List every registered runtime, including aliases. |
| `clio-coder config [inspect] [--json]` | Print the effective customization graph across settings, context files, rules, skills, prompts, agents, extensions, safety, memory, hooks, and operator profile. |
| `clio-coder targets [--json] [--probe] [--target <id>]` | List configured targets, health, auth, runtime, model, and capabilities. |
| `clio-coder targets add` | Add a target interactively or through configure flags. |
| `clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>] [--fleet-target <id>] [--fleet-model <id>]` | Point the orchestrator at one target. Without `--fleet-target` the fleet default follows it; with `--fleet-target` the fleet runs on a different node. `--worker-target` and `--worker-model` are accepted aliases from before the worker/fleet rename. |
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
| `clio-coder doctor [--fix] [--json]` | Diagnose state; with `--fix`, create missing structure and templates, repair credential permissions, and refresh install metadata. Settings remain strict and are not migrated. |
| `clio-coder reset [--state\|--data\|--cache\|--auth\|--config\|--all] [--dry-run] [--force]` | Reset selected Clio Coder state. `--state` is the default level. |
| `clio-coder uninstall [--dry-run] [--remove-binary] [--force]` | Remove Clio Coder state and print uninstall guidance. |
| `clio-coder upgrade [--dry-run] [--channel=<latest\|beta\|dev>] [--skip-migrations]` | Refresh state metadata, apply migrations, and update npm installs when applicable. |
| `clio-coder agents [--json] [--all]` | List discovered agent specs. |
| `clio-coder fleet list\|run\|status\|drain\|resume` | List `.clio-coder/fleets/*.md` contracts, run one, show dispatch state, or control admission. `drain` denies new execution starts for up to one hour and preserves running work; `resume` reopens admission immediately. `run <name>` takes `[--var k=v ...]` and `[--json]`; `status`, `drain`, and `resume` each take `[--json]`. |
| `clio-coder dev components [list] [--json]` | List behavior-affecting harness components. |
| `clio-coder dev components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio-coder dev components diff --from <a> --to <b> [--json]` | Compare component snapshots. |
| `clio-coder evidence build\|inspect\|list` | Build and inspect deterministic evidence artifacts. |
| `clio-coder eval validate\|run\|report\|compare\|gate` | Validate, run, report, compare, and gate local evaluation suites (Suite v2). |
| `clio-coder memory list\|propose\|promote\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. |
| `clio-coder trace runs [--db PATH] [--limit N] [--json]` | List runs recorded in the durable trace mirror beside the ledger. |
| `clio-coder trace phases <runId> [--db PATH]` | Show one run's recorded phases. |
| `clio-coder trace tail <runId> [--follow] [--db PATH]` | Tail one run's recorded events; `--follow` streams as they land. |
| `clio-coder trace procs <runId> [--db PATH]` | Show the processes one run spawned. |
| `clio-coder trace sql <SELECT query> [--db PATH]` | Run one read-only query against the mirror. Only a single `SELECT` or read-only `WITH` statement is accepted; anything else exits 2. |
| `clio-coder trace ui [--db PATH] [--port N]` | Serve the localhost-only waterfall viewer. The viewer is not part of the published package. |
| `clio-coder dev evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio-coder extensions list\|discover\|install\|enable\|disable\|remove` | Manage installed extension packages and resource roots. `clio-coder ext` is an accepted alias. |
| `clio-coder skills list\|search\|inspect\|validate\|install\|update\|sync\|eval` | Manage discovered skills, Clio-native skills, and local marketplace installs. |
| `clio-coder docs [topic] [--no-open]` | Serve the interactive HTML docs of a source checkout on 127.0.0.1; the npm package ships the Markdown guides only. |
| `clio-coder usage report [--repo <path>] [--days <n>] [--json]` | Cross-session usage facts and opportunities from the session and run ledgers. The window defaults to 30 days and the JSON schema is marked experimental. |
| `clio-coder dev share export --out <path> [--project\|--user\|--both] [--context] [--prompts] [--skills] [--settings] [--extensions]` | Export project context, prompts, skills, settings fragments, and extension bundles. |
| `clio-coder dev share import <path> [--dry-run] [--force] [--project\|--user] [--json]` | Import a share archive with conflict reporting. |
| `clio-coder dev share inspect <path> [--json]` | Inspect a share archive without importing it. |
| `clio-coder export --out <path> ...` / `clio-coder import <path> ...` | Top-level aliases for `dev share export` and `dev share import`. Each `dev` command also resolves without the `dev` prefix. |
| `clio-coder context` | Show project context status, preload class, codewiki freshness, and the codewiki digest when present. |
| `clio-coder context init [--preview] [--heuristic] [--yes] [--json] [--adopt] [--global] [--propose\|--apply\|--rewrite] [--target <id> [--model <id>] [--thinking <level>]]` | Explore the repo and bootstrap or update project context: `CLIO-CODER.md`, `.clio-coder/codewiki.json`, and `.clio-coder/state.json`. |
| `clio-coder context refresh [--wiki]` | Rebuild the codewiki and state without touching `CLIO-CODER.md`; with `--wiki`, update an existing Markdown wiki. |
| `clio-coder context wiki [--update] [--status] [--depth auto\|simple\|medium\|detailed] [--target <id>] [--model <id>] [--thinking off\|low\|medium\|high]` | Generate, update, or inspect the agent-authored Markdown wiki under `.clio-coder/wiki/`. |
| `clio-coder context reset [--all] [--yes]` | Clear accumulated project context artifacts; `--all` also removes `CLIO-CODER.md`. `--yes` (or `-y`) answers every confirmation and is required when stdin is not a terminal. |
| `clio-coder context index [--json]` | Build the structural codewiki index without model calls; writes `.clio-coder/codewiki.json` and `.clio-coder/state.json` and prints coverage plus a structural hash. |
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
| `--kv-cache-mode <mode>` | One-run KV-cache override for supported local runtimes: `f16`, `f32`, `none`, `false`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, or `q5_1`. |
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

### Headless Session Continuity

A headless turn (`clio-coder run`) starts a fresh session unless `--session <id>` or `--continue` specifies a session to append to.
- `--session <id>` appends the turn to the session with id `<id>`.
- `--continue` appends the turn to the most recent session recorded for the current working directory.
- `--session` and `--continue` are mutually exclusive. Specifying both causes the invocation to fail with exit code 2 before execution.
- Session continuity options apply strictly to main-agent execution. They are non-applicable to `--agent` fleet dispatches because dispatched agents execute in isolated worker processes with independent transcripts; specifying session flags alongside `--agent` exits with code 2.
- A named session that cannot be resumed (such as an unknown session ID or unreadable history) fails the run with exit code 2 before any model call is initiated.
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
  --model your-model-id
```

## Interactive Slash Commands

Slash commands are available inside the TUI. Type `/` at the start of the prompt to open the grouped command palette autocomplete.

The registry table below lists the available interactive slash commands. On a bare `/`, commands are presented in groups (`Run`, `Inspect`, `Configure`, `Sessions`) with compact argument hints. Each operation has one canonical spelling; autocomplete, help, and parsing all read the same registry. The "Usage" column details expected arguments, with brackets `[]` indicating optional arguments and angle brackets `<>` indicating required arguments.

| Command | Usage | Purpose |
| --- | --- | --- |
| `/quit` | `/quit` | Exit Clio Coder |
| `/help` | `/help [query]` | Open the interactive help center showing commands and keys |
| `/skill` | `/skill [name] [task]` | Open the Skills Hub or invoke a skill |
| `/prompts` | `/prompts` | List prompt templates |
| `/extensions` | `/extensions` | List installed extensions |
| `/interop` | `/interop` | Review other coding agents detected on this machine |
| `/share` | `/share [runId] \| /share export <path> \| /share import [--dry-run] [--force] <path>` | Share a worker result with the main agent, or export and import Clio archives |
| `/run` | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] [--share] <agent> <task>` | Run a fleet agent |
| `/delegate` | `/delegate [--share] <agent-id> <task>` | Run an ACP delegation agent |
| `/agents` | `/agents` | List Clio agents and ACP delegation agents |
| `/targets` | `/targets` | Open Settings → Targets: health, use, connect, probe, remove |
| `/cost` | `/cost` | Show session token and cost totals |
| `/context` | `/context compact [instructions] \| /context recall <ref> \| /context init \| /context refresh \| /context reset` | Context hub: window overlay plus compact, recall, init, refresh, and reset |
| `/fleet` | `/fleet` | Open Settings → Fleet: defaults, profiles, agent bindings, nodes |
| `/decisions` | `/decisions` | Show settled interview decisions and operator revisions |
| `/tasks` | `/tasks add <text> \| /tasks hand <id> \| /tasks done <id> \| /tasks drop <id>` | Show the session board or manage project operator tasks |
| `/memory` | `/memory seed` | Inspect, promote, or seed task memory |
| `/view` | `/view [filter] \| /view verify <runId>` | Browse session artifacts and verify receipts |
| `/thinking` | `/thinking [level]` | Set the chat thinking level, or open Settings → Orchestrator |
| `/output` | `/output [verbosity]` | Set transcript detail (minimal, default, verbose), or open Settings → Terminal |
| `/model` | `/model [pattern]` | Open model selector or set a model |
| `/scoped-models` | `/scoped-models` | Open Settings → Models: the Alt+J / Alt+K cycle set and favorites |
| `/settings` | `/settings [section]` | Open interactive settings |
| `/resume` | `/resume` | Resume a past session |
| `/new` | `/new` | Start a fresh session |
| `/tree` | `/tree` | Open session tree navigator |
| `/fork` | `/fork` | Fork from an assistant turn |
| `/export` | `/export [path]` | Export a self-contained HTML transcript by default; a `.md` path writes Markdown |

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

The `/resume` picker accepts Page Up and Page Down to move by its 12 visible rows. Arrow keys continue to move one session at a time, and typing continues to filter the list.

Only active commands run. Typing anything command-shaped that the registry does
not own checks the loaded prompt templates across native and foreign prompt roots.
Built-in command names are reserved across interactive and headless modes; a
template with the same basename is omitted from `/prompts` with a collision
diagnostic instead of shadowing a command on one surface and expanding on another.
If a matching template is found in an untrusted project root, Clio prints that the
prompt template comes from an untrusted project root and directs the operator to set
`skills.trustProjectCompatRoots`, sending nothing to the model. If the token names
neither a command nor a template, it reports `is not a command` and points at `/help`;
it is never sent to the model. That covers spellings removed outright, such as
`/status` and `/receipts`, as well as ordinary typos. It replaces the earlier
behavior where an unrecognized spelling reached the model as prose and was answered
conversationally, which left the operator believing a command had run when nothing had.

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

Configuration lives in one place: the `/settings` overlay. `/settings <section>` reaches every section directly. `/thinking <level>`, `/output <verbosity>`, and `/model <pattern>` stay as quick setters that apply without opening anything.

Settings → Targets presents an operational console table (`HEALTH`, `ID`, `ROLES`, `RUNTIME`, `LATENCY`) with an in-place action/detail drawer for URL, default model, last probe error, and reachability. `Enter` opens actions for `Use` (switches active chat target and rebases model), `Connect` (runs the API-key or OAuth flow then probes), `Probe`, and `Remove` (with preflight analysis of affected routes/profiles). Probing runs live when the overlay opens or when explicitly requested. Target creation is initiated via `clio-coder targets add`.

Settings → Fleet is an entity workbench organized with dim group headers (`Defaults`, `Profiles`, `Agent routes`, `Placement`). Dispatched worker defaults and profile rows render as compact summaries (`fast-local node-a/example-coder-model  high  auto`), drilling into fields (`target`, `model`, `thinkingLevel`, `node`) on `Enter`. Profile removal is a named destructive action with affected-route preflight. Running and retrying dispatches live in the `Alt+W` Fleet Runs board, which also steers and cancels them. `Enter` opens the selected run's worker detail: the phase, the running call with its redacted action descriptor, and the bounded tail of the worker's own prose.

`/run` and `/delegate` put the worker's answer on screen. Both echo the typed
line dim above the block, then stream the run into the transcript as an attributed
block: a header (`◇ coder · node-a/example-coder-model · run 2mkas6s` for fleet workers,
or `◇ codex (acp) · run 7hq2ab` for ACP peers), the worker's prose down a rail,
one coalesced line of tool names, and a one-line footer carrying the outcome glyph,
token count, duration, and contract status (such as `└ ✓ ok · 8.4k tok · 18s · contract unmeasured`),
with the failure reason printed on the rail above the footer when a run fails.
Runs the model itself asked for through the dispatch tool render as folded `◆`
cards under the spawning tool segment; operator-typed runs are `◇` and open.
The footer chip in the status line splits them (such as `◇1 ◆3`). `Alt+O` toggles
the newest foldable item (tool call or worker block), while `Ctrl+Alt+O` or
`Alt+Shift+O` toggles every one. Memory workers on the background target never
appear as transcript blocks. A run that fails over keeps one block and gains an
`↻ failed over → attempt 2 on node-b/example-coder-model` line inside it.

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
documented read-class exception described in [the safety model](safety-model.md):
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
`memory.intervention.enabled` is off.

The `/interop` overlay lists the other coding agents Clio found on this machine,
grouped `Detected`, `Configured`, and `Declined`. A detected row's detail pane
shows the exact `delegation.agents` entry that connecting it would append, plus
the two facts a new peer inherits: `projectContext: none`, so the peer receives
the task text and never the project projection, and `toolGovernance:
clio-policy`, so its tool calls are gated by Clio safety. Press `a` to connect
one or `d` to decline; the overlay reads the report this process already produced
at boot and never probes on a keystroke. Accepting applies to the live session,
because `delegation` hot-reloads.

Boot adds at most one line about interop, in the shape `clio: codex detected on
PATH and not configured. Run /interop to review.` It names only agents that are
installed, unconfigured, and undecided, it appears at most once per set of facts,
and it is never emitted in headless or ACP mode. Declining an agent silences it
until its binary version or path changes, at which point it becomes a fresh
proposal.

`clio-coder doctor` reports interop and never proposes anything. It emits one
`ok` row per detected agent naming its version, its path, and whether it is
configured, one `warn` row for a configured peer whose command no longer resolves
on PATH, and one aggregate row counting the skills loaded from foreign roots. A
machine with no other agents installed emits no interop rows at all. Reachability
for a stdio peer means the command resolves; doctor never starts a session with
one, and plain `doctor` writes nothing.

## Keybindings

App bindings use `Alt + <key>` as the primary scheme, plus `Shift+Tab`,
`Ctrl+D`, `Shift+Enter` / `Ctrl+J`, and a portable `Ctrl+G` leader. Modern terminals and Linux/meta
setups send Alt directly. Stock macOS Terminal.app needs **Use Option as Meta
key** enabled in Settings > Profiles > Keyboard for native Alt; otherwise use
`Ctrl+G` then the Alt binding letter.

`Alt+B` and `Alt+D` are approved application-input boundary overrides of Pi's
editor word-back and word-delete chords. Clio routes those two bindings before
the editor sees them so the task and decision boards remain global shortcuts.
They are intentional exceptions to the other app bindings' avoidance of Pi
editor reserves and can be rebound through `settings.yaml.keybindings`.

| Binding | Action |
| --- | --- |
| `Enter` | Send draft prompt (when idle) or deliver it at the next slot of the active run (when streaming). |
| `Shift+Enter` / `Ctrl+J` | Insert a newline into multiline editor input. |
| `Ctrl+P` / `Ctrl+N` | Browse backward / forward through prompts accepted in this interactive process; returning past the newest entry restores the unfinished draft. |
| `Alt+Enter` | End of turn: queue the current draft for delivery when the active run settles. |
| `Alt+I` | Interrupt: cancel the active run and deliver the current draft now. Refused while an attached dispatch runs or a permission ask is parked; the draft then queues for the next slot. |
| `Alt+Up` | Restore queued next-slot and end-of-turn messages to the editor. |
| `Shift+Tab` | Cycle orchestrator thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). |
| `Alt+T` | Open the session tree navigator (`/tree`). |
| `Alt+U` | Toggle the footer dashboard between compact (quiet 2-zone) and expanded (4-zone urgency) layouts. |
| `Alt+L` | Open the model and targets selector. |
| `Alt+J` / `Alt+K` | Cycle forward / backward through the scoped model set (when empty, displays a notice directing the operator to `/scoped-models`). |
| `Alt+W` | Toggle the Fleet Runs board (task, run ID, live telemetry, retry, and terminal history). Inside it, `Enter` opens the selected run's live worker detail, `s` steers, and `x` cancels. |
| `Alt+B` | Open the composite session and operator task board (`/tasks`). Approved application-boundary override of editor word-back. |
| `Alt+D` | Open the settled interview decision board (`/decisions`). Approved application-boundary override of editor word-delete. |
| `Alt+S` / `Ctrl+Alt+B` | Convert an active attached dispatch to a detached background batch. |
| `Alt+O` | Toggle the newest tool call or worker block between collapsed subline and full body. |
| `Ctrl+Alt+O` / `Alt+Shift+O` | Toggle all tool calls and worker blocks between collapsed sublines and full bodies. |
| `Alt+P` | Toggle streaming partial tool output in expanded tool bodies. |
| `Alt+R` | Toggle the latest thinking block between hidden marker and full body. |
| `Ctrl+Alt+R` / `Alt+Shift+R` | Toggle all thinking blocks between hidden markers and full bodies. |
| `Alt+G` | Open the current input in an external editor. |
| `Alt+X` | Dismiss footer notifications. |
| `Ctrl+G`, then a letter | Portable leader fallback for Alt-letter actions. |
| `Ctrl+C` | With no overlay: cancel stream, clear input, or press twice to exit. With an overlay open: close/cancel that overlay only. |
| `Ctrl+D` | Exit when the editor is empty; otherwise delete the next character. It never exits from inside an overlay. |
| `PageUp` / `PageDown` | In `/resume` and list overlays: scroll the selection by one full page (12 rows). |
| `Esc` | With an overlay open: clear non-empty filter first, move up drill-down level, then close/cancel. With no overlay: cancel stream/operation or collapse dashboard. |

When scripting Clio inside tmux, prefer `tmux send-keys C-m` for submit/confirm keys instead of the literal `Enter` token; some tmux/terminal combinations do not deliver `Enter` reliably.

## Live Steering

While a run is active, the key that submits a message chooses when it lands.
There are three modes, chosen per message; the default is next slot.

| Mode | Key | Delivery |
| --- | --- | --- |
| Next slot | `Enter` | Between tool batches, mid-run, through `agent.steer`. The agent keeps going and reads the message before its next model call. |
| End of turn | `Alt+Enter` | When the whole run settles and Clio would hand control back, through `agent.followUp`. A turn is the whole run, not one model round. |
| Interrupt | `Alt+I` (or `Ctrl+G`, `i`) | Cancels the in-flight work the way `Esc` does (generation aborts; a running bash child gets SIGTERM, then SIGKILL), waits for the cancelled run to seal its tool results in ledger order, then submits the message as a fresh prompt. Anything already queued returns to the editor. |

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
`clio_steer_received` acknowledgement reports `received`. Single-shot
subprocess runtimes and ACP delegation do not expose a live steering channel
and are labeled accordingly.

## Operating Posture and Autonomy

Clio Coder operates with a single, unified tool surface. There are no separate tool-visibility modes; what varies is the `autonomy` level (`read-only` | `suggest` | `auto-edit` | `full-auto`), edited in the `/settings` Autonomy & Safety section.

Tool and command execution is governed by:
- **Target Capabilities:** What the selected model target actually supports (such as tools, streaming, and vision).
- **Safety Net:** Granular rule packs loaded from `damage-control-rules.yaml`, project policies, and protected artifact paths; always on, identical at every autonomy level.
- **Autonomy Mapping:** Once the net passes a call, the level decides whether it runs, asks, or is denied. See [safety-model.md](safety-model.md) for the full matrix.

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
| `context-bootstrap` | `internal` / `internal` | Bootstrap agent behind `clio-coder context init` that inspects the repository and returns `CLIO-CODER.md`. |

Examples:

```bash
clio-coder run --agent coder "Find the main build, test, and lint commands."
clio-coder run --agent architect "Plan a minimal change to add JSON output to the CLI."
clio-coder run --agent verifier "Run tests and confirm the build passes."
```

Shadow agents (`scout`, `researcher`, `provenance`) are internal orchestration
helpers. They appear in `clio-coder agents --all` and the main prompt catalog, but
user-origin `/run` and `clio-coder run --agent` requests are rejected for them.
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
| `npm run ci` | Local and GitHub PR gate: typecheck, lint, skills pin check, build, the deterministic test suite, and the trace-viewer suite. |
| `npm run ci:release` | Maintainer release gate: `npm run ci`, then the `check-release` dist and packaging audit. |
| `npm run live:smoke -- --target <id>` | One real headless turn against a configured target. Add `--delegation` for the `opencode` and `copilot` ACP agents. The other operator-run drivers (`live:fleet-dispatch`, `live:tui`, `live:home`) are listed in `benchmarks/internal/README.md`. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run lint` | Biome checks plus `scripts/check-hygiene.ts`, which runs the boundary invariants, the skills pin check, and the README and docs drift rules. |
| `npm run test` | Contract and smoke tests through the sharded runner. |
| `npm run build` | Production bundle through `tsup`. |
| `npm run dev` | `tsup --watch`. |
| `npm run clean` | Remove `dist/`. |

Live drivers pick their model with `--target <id>`, naming one of the targets
`clio-coder targets` lists; `--model <wireId>` and `--thinking <level>`
override that target's defaults for the run. The run happens in a scratch Clio
home holding only that target, so nothing touches the operator's real state:

```bash
npm run build
npm run live:smoke -- --target local-lmstudio --model qwen3.8-27b
npm run live:smoke -- --target anthropic --delegation
```

Live checks cost tokens or local GPU time and are not deterministic CI. They
are useful for OpenAI-compatible local gateways such as llama.cpp, LM Studio
with Dynamo-backed workers, vLLM, and SGLang, plus cloud targets when
credentials are configured.

## Environment Variables

Clio Coder's behavior can be customized or overridden using various environment variables (such as `CLIO_CODER_RIGOR`, `CLIO_CODER_HOME`, and guardrail overrides). For the complete, detailed, and maintained inventory of environment variables, please refer to [environment-variables.md](environment-variables.md).

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

Each page dispatch is bounded on its own wall clock, and the run is bounded
between pages. Neither bound loses work: a page that fails or times out is
recorded as still owed and the run continues to the next one, and every finished
page is assembled and promoted. When `generation.pagesWritten` is below
`generation.pagesPlanned`, run `clio-coder context wiki --update` to finish the rest;
it resumes from the plan rather than starting over.

`clio-coder context wiki --update` requests update mode explicitly. It rewrites the
pages whose front-matter `sources` git reports as changed since the recorded
wiki `gitHead`, and leaves the rest alone.
`clio-coder context wiki --status` is read-only: it prints whether wiki metadata is
present, page count, `updatedAt`, recorded `gitHead`, whether that head differs
from current `HEAD`, and how many planned pages remain unwritten. It dispatches
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

## Reasoning and Live Thinking Controls

Clio Coder features direct, interactive controls for model reasoning and thinking streams:

- **Thinking Level (`Shift+Tab`):** Allows operators to cycle through available thinking configurations. This is useful for dialing model reasoning budgets up or down in real time.
- **Thinking Blocks Toggle (`Alt+R`):** Toggles the latest assistant thinking block between a compact, single-line folded marker and an expanded, full-body view.
- **All Thinking (`Ctrl+Alt+R` / `Alt+Shift+R`):** Toggles every thinking block in the transcript.
- **Tool Body Toggle (`Alt+O`) / All Tools (`Ctrl+Alt+O` / `Alt+Shift+O`):** Expand the latest tool or every tool body. The single-target key takes the newest foldable thing of either kind, so a worker card that just landed opens before the tool call above it; exactly one surface advertises the chord at a time.
- **Live Tool Output (`Alt+P`):** Pause or resume cumulative partial tool output in expanded live tool bodies; the tool still executes.
- **Live Streaming:** During active assistant turns, thinking increments stream live into the chat panel down a rail-prefixed segment. Reasoning totals marked `≈` are approximations from visible text; provider-reported totals are shown without that marker. Neither implies complete or cryptographically verified hidden reasoning.
- **Thinking Replay:** When continuing a conversation, prior thinking is preserved and replayed in the history according to target-specific rules.

## TUI Surface Refinements

The Clio TUI has been enhanced to maximize readability, operational focus, and command discovery:

- **Adaptive Welcome Launchpad:** Before the first prompt, renders a compact launchpad with bold CAPS section tags (`WORKSPACE`, `ROUTE`, `NEXT`), honest readiness indicators, and context-sensitive next actions. Upon first prompt submission, it deliberately collapses into a single-line session header (`>C_ Clio Coder vX.Y.Z · <workspace · git branch> · <target·model · ready> · ctx ready · type a task`) so the conversation transcript owns the viewport.
- **Unmistakable Clio Composer:** The input editor features an explicit left section tag reflecting current prompt semantics (`MESSAGE` while idle, `FOLLOW-UP` while Clio runs, and orange `STEER` when Enter steers in-flight execution). Includes the dim placeholder `Ask Clio…  / for commands` and lower-rail hint `Enter send · Shift+Enter newline` at wider widths.
- **Progressively Disclosed Footer:** The compact footer uses a quiet two-zone status layout that suppresses idle decoration (`tools none`, `◌ idle`, and default-output tags). Line 1 displays workspace location, git branch/dirty state, and active phase only when meaningful; Line 2 displays the context window gauge and best current/last-turn receipt. `Alt+U` toggles the expanded dashboard, which orders information by operational urgency (Activity, Context, Session, Workspace).
- **Footer Notification Degradation Ladder:** The footer notification badge reserves the severity head (`glyph count noun`) and `[Alt+X] dismiss` tail first, allocating remaining width to an ellipsized message body. Under narrow terminal constraints, it degrades cleanly down the ladder without clipping action keys.
- **Grouped Slash Command Palette:** Typing `/` opens an autocomplete command palette grouped by operational category (`Run`, `Inspect`, `Configure`, `Sessions`) with compact argument hints. Every suggestion is the command's one canonical spelling.
- **Voice-First Transcript & Receipts:** User (`› `) and assistant (`✦ `) prose are formatted with a two-cell hanging indent, ensuring wrapped continuation lines remain visually tied to their voice prefix. Tool ledgers maintain full terminal width. Completed turn receipts honor output verbosity (`minimal` none, `default` compact dim `turn · in N · out M`, `verbose` full receipt with call counts, cache reads/writes, reasoning provenance, and verification caveats).
- **Transactional Settings Center:** Open via `/settings` (or deep links `/targets`, `/fleet`, `/scoped-models`, `/thinking`, `/output`). Grouped into `CORE`, `ROUTING`, `RUNTIME`, and `EXPERIENCE` sections. Value edits are transactional: `Enter` opens value pickers/checklists and constructs immutable change plans offering `Apply this session`, `Apply and save globally`, or `Cancel`. Includes the Fleet entity workbench, Targets console table with in-place action drawer, scoped-model checklist, and narrow-terminal drill-down navigation below 72 columns.

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
- Split overlays such as `/view` gracefully fall back to a single-pane presentation with `[Tab]` switching between list and content panes.
- Settings provides a drill-down navigation stack below 72 columns (sections → rows → details) with breadcrumbs and `Esc` backtracking.
- Text content and detail descriptions wrap cleanly without line truncation.

## Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio-coder: command not found` | Run `npm run install:local`, then `hash -r`; confirm `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}` is on `PATH`. |
| No model target is available | Run `clio-coder configure`, then `clio-coder targets --probe`. |
| Local model does not respond | Confirm the runtime is running and the target URL is correct. |
| Cloud model auth fails | Check `clio-coder auth status <target>` and verify the relevant API key or login flow. |
| Source changes do not appear | Re-run `npm run build`; linked CLI points at `dist/`. |
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
