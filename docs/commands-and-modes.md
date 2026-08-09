# Commands and Modes

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/commands_blueprint.html](html/commands_blueprint.html) (Version: 0.3.0).


Clio Coder is a terminal-first alpha harness. This page keeps the command
reference, interaction modes, dispatch surface, verification lanes, and common
operator guidance out of the README so the release entry point stays short.

Source of truth: `src/cli/index.ts`, `src/interactive/slash-commands.ts`,
`src/domains/dispatch/**`, `src/tools/registry.ts`, and the current test suite.

## CLI Commands

| Command | Purpose |
| --- | --- |
| `clio` | Launch the interactive terminal UI. |
| `clio run "<task>" [flags]` | Run one headless main-agent turn. Use `--json` for JSONL events. |
| `clio run "<task>" --agent <id> [flags]` | Dispatch one explicit fleet agent non-interactively and write a receipt. |
| `clio acp` | Serve Clio as an ACP v1 agent over stdio for ACP frontends. |
| `clio --version` | Print the installed version. |
| `clio --api-key <key>` | Override the active target API key for one invocation. |
| `clio --no-context-files` / `clio -nc` | Skip `CLIO.md` project-context injection for one invocation. |
| `clio --no-skills` | Disable skill discovery for one invocation while still honoring explicit `--skill` paths. |
| `clio --skill <path>` | Load one explicit skill file or directory for one invocation (repeatable). |
| `clio configure` | Run the configuration wizard. |
| `clio configure --list` | List user-facing runtime ids. |
| `clio configure --list --all` | List every registered runtime, including aliases. |
| `clio targets [--json] [--probe] [--target <id>]` | List configured targets, health, auth, runtime, model, and capabilities. |
| `clio targets add` | Add a target interactively or through configure flags. |
| `clio targets use <id> [--model <id>] [--orchestrator-model <id>] [--fleet-model <id>]` | Set chat and fleet defaults to one orchestrator-capable target. |
| `clio targets profile list\|set\|remove\|rename\|bind\|unbind\|bindings` | Manage named fleet profiles and agent bindings. |
| `clio targets convert <id> --runtime <runtimeId>` | Convert older local target definitions to a runtime-specific target. |
| `clio targets remove <id>` | Remove a target. |
| `clio targets rename <old> <new>` | Rename a target id. |
| `clio models [search] [--target <id>] [--json] [--offline]` | List models. Live probing is the default; `--offline` skips it. |
| `clio paths [--json]` | Print the resolved config, data, state, and cache directories. |
| `clio auth list` | Show known auth entries. |
| `clio auth status [target-or-runtime]` | Inspect auth state. |
| `clio auth login [target-or-runtime] [--api-key <value>]` | Add credentials through the supported flow. |
| `clio auth logout [target-or-runtime]` | Remove stored credentials. |
| `clio doctor [--fix] [--json]` | Diagnose state; with `--fix`, create missing structure and templates, repair credential permissions, and refresh install metadata. Settings remain strict and are not migrated. |
| `clio reset [--state\|--data\|--cache\|--auth\|--config\|--all] [--dry-run] [--force]` | Reset selected Clio Coder state. `--state` is the default level. |
| `clio uninstall [--dry-run] [--remove-binary] [--force]` | Remove Clio Coder state and print uninstall guidance. |
| `clio upgrade [--dry-run] [--channel=<latest\|beta\|dev>] [--skip-migrations]` | Refresh state metadata, apply migrations, and update npm installs when applicable. |
| `clio agents [--json] [--all]` | List discovered agent specs. |
| `clio fleet list\|run\|status` | List fleet contracts, run a contract, or show dispatch state. |
| `clio dev components [list] [--json]` | List behavior-affecting harness components. |
| `clio dev components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio dev components diff --from <a> --to <b> [--json]` | Compare component snapshots. |
| `clio evidence build\|inspect\|list` | Build and inspect deterministic evidence artifacts. |
| `clio eval validate\|run\|report\|compare\|gate` | Validate, run, report, compare, and gate local evaluation suites (Suite v2). |
| `clio memory list\|propose\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. |
| `clio trace runs [--db PATH] [--limit N]` | List runs recorded in the durable trace mirror beside the ledger. |
| `clio trace phases <runId> [--db PATH]` | Show one run's recorded phases. |
| `clio trace tail <runId> [--follow] [--db PATH]` | Tail one run's recorded events; `--follow` streams as they land. |
| `clio trace procs <runId> [--db PATH]` | Show the processes one run spawned. |
| `clio trace sql <SELECT query> [--db PATH]` | Run one read-only SELECT against the mirror. Only SELECT is accepted. |
| `clio trace ui [--db PATH] [--port N]` | Serve the localhost-only waterfall viewer. The viewer is not part of the published package. |
| `clio dev evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio extensions list\|discover\|install\|enable\|disable\|remove` | Manage installed extension packages and resource roots. |
| `clio skills list\|search\|inspect\|validate\|install\|update\|sync\|eval` | Manage discovered skills, Clio-native skills, and local marketplace installs. |
| `clio docs [topic] [--no-open]` | Serve bundled HTML docs on 127.0.0.1. |
| `clio dev share export --out <path> [--project\|--user\|--both] [--context] [--prompts] [--skills] [--settings] [--extensions]` | Export project context, prompts, skills, settings fragments, and extension bundles. |
| `clio dev share import <path> [--dry-run] [--force] [--project\|--user] [--json]` | Import a share archive with conflict reporting. |
| `clio dev share inspect <path> [--json]` | Inspect a share archive without importing it. |
| `clio context` | Show project context status, preload class, codewiki freshness, and the codewiki digest when present. |
| `clio context init [--preview] [--heuristic] [--yes] [--json] [--adopt] [--propose\|--apply\|--rewrite] [--target <id> [--model <id>] [--thinking <level>]]` | Explore the repo and bootstrap or update project context: `CLIO.md`, `.clio/codewiki.json`, and `.clio/state.json`. |
| `clio context refresh [--wiki]` | Rebuild the codewiki and state without touching `CLIO.md`; with `--wiki`, update an existing Markdown wiki. |
| `clio context wiki [--update\|--status]` | Generate, update, or inspect the agent-authored Markdown wiki under `.clio/wiki/`. |
| `clio context reset [--all]` | Clear accumulated project context artifacts. |
| `clio context index [--json]` | Build the structural codewiki index without model calls; writes `.clio/codewiki.json` and `.clio/state.json` and prints coverage plus a structural hash. |

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

A headless turn (`clio run`) starts a fresh session unless `--session <id>` or `--continue` specifies a session to append to.
- `--session <id>` appends the turn to the session with id `<id>`.
- `--continue` appends the turn to the most recent session recorded for the current working directory.
- `--session` and `--continue` are mutually exclusive. Specifying both causes the invocation to fail with exit code 2 before execution.
- Session continuity options apply strictly to main-agent execution. They are non-applicable to `--agent` fleet dispatches because dispatched agents execute in isolated worker processes with independent transcripts; specifying session flags alongside `--agent` exits with code 2.
- A named session that cannot be resumed (such as an unknown session ID or unreadable history) fails the run with exit code 2 before any model call is initiated.
- The session ID is discoverable via the `session` event when running under `--json` mode and on stderr via the `clio run: session <id>` line in text mode. Standard output remains reserved for the assistant answer alone.

### JSON Event Streaming and Wire Projection Promise

When `--json` or `--json-events <mode>` (`full` | `terminal`) is passed, `clio run` streams structured JSONL events.
- **Wire Projection Promise:** Each piece of turn content crosses the wire exactly once.
- Intermediate `message_update` events are dropped to prevent quadratic snapshot duplication over stdout.
- `text_delta` and `thinking_delta` events stream incremental text deltas rather than accumulating message snapshots.
- `agent_end` events carry segment summary metrics (`messageCount` and a `usage` object containing `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `costUsd`, `apiCalls`, and `measured`) instead of duplicating the full message transcript.
- `turn_end` preserves the final assistant message while dropping `toolResults` array objects, each of which already crossed the wire in an preceding `tool_execution_end` event.

Example:

```bash
clio run \
  "Find the test command and summarize the project structure." \
  --target local-lmstudio \
  --model your-model-id
```

## Interactive Slash Commands

Slash commands are available inside the TUI. Type `/` at the start of the prompt to open autocomplete.

The registry table below lists the available interactive slash commands. The "Aliases" column shows alternative command triggers that invoke the same command. The "Usage" column details the expected arguments and options, with brackets `[]` indicating optional arguments and angle brackets `<>` indicating required arguments.

| Command | Aliases | Usage | Purpose |
| --- | --- | --- | --- |
| `/quit` | - | `/quit` | Exit Clio Coder |
| `/help` | - | `/help [query]` | Open the interactive help center showing commands and keys |
| `/skill` | `/skill:`, `/skills:` | `/skill [name] [task]` | Open the Skills Hub or invoke a skill |
| `/prompts` | - | `/prompts` | List prompt templates |
| `/extensions` | - | `/extensions` | List installed extensions |
| `/share` | - | `/share export <path> \| /share import [--dry-run] [--force] <path>` | Export or import Clio archives |
| `/run` | - | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] <agent> <task>` | Run a fleet agent |
| `/delegate` | - | `/delegate <agent-id> <task>` | Run an ACP delegation agent |
| `/agents` | - | `/agents` | List Clio agents and ACP delegation agents |
| `/targets` | - | `/targets` | Show target hub for health, auth, models, and actions |
| `/cost` | - | `/cost` | Show session token and cost totals |
| `/context` | `/ctx` | `/context compact [instructions] \| /context init \| /context refresh \| /context reset` | Context hub: window overlay plus compact, init, refresh, and reset |
| `/fleet` | - | `/fleet` | Show in-process dispatch running/retry status |
| `/tasks` | - | `/tasks` | Show the session task board the agent tracks with the tasks tool |
| `/memory` | - | `/memory seed` | Inspect task memory or seed it from the newest handoff |
| `/view` | - | `/view [filter] \| /view verify <runId>` | Browse session artifacts and verify receipts |
| `/thinking` | - | `/thinking` | Open thinking-level selector |
| `/output` | - | `/output [verbosity]` | Set transcript detail: minimal, default, or verbose |
| `/model` | `/models` | `/model [pattern]` | Open model selector or set a model |
| `/scoped-models` | - | `/scoped-models` | Edit the Alt+J / Alt+K model cycle set |
| `/settings` | - | `/settings` | Open interactive settings |
| `/resume` | - | `/resume` | Resume a past session |
| `/new` | - | `/new` | Start a fresh session |
| `/tree` | - | `/tree` | Open session tree navigator |
| `/fork` | - | `/fork` | Fork from an assistant turn |
| `/export` | - | `/export [path]` | Export the session transcript to Markdown |

`/context` with no arguments opens the context-window ledger overlay. The
subcommands own the durable project-context noun: `compact` summarizes older
turns in the session window, `init` bootstraps or updates `CLIO.md` and the
codewiki, `refresh` re-indexes the codewiki and refreshes `.clio/state.json`
without touching `CLIO.md`, and `reset` deletes accumulated
context artifacts (`.clio/codewiki.json`, `.clio/state.json`,
`.clio/handoffs/`, `.clio/proposals/`). Its interactive choice preserves or
deletes `CLIO.md`; cancellation makes no changes. Session reset stays `/new`;
there is deliberately no `/context clear`. The retired spellings `/compact`,
`/context-init`, `/context-clear`, and `/context-view` are no longer parsed.


The `/targets` hub is the only interactive target command. Use `j`/`k` or the arrow keys to browse targets, `Enter` to expand or collapse details, `u` to use the selected target for chat, `f` to set the selected target as the fleet default, `c` to connect, `r` to probe the selected target, and `R` to probe all targets. Worker-only targets such as `claude-sdk` and `claude-code` are selected for dispatch through fleet defaults or profiles, not through the chat target action.

The `/fleet` overlay displays current running and retrying fleet state. It includes four tabs: Status, Nodes, Profiles, and Bindings; cycle with `Tab`. Status shows active runs, aggregate execution stats, and scheduled retries with backoff times. Nodes shows fleet placement health. Profiles supports creating, editing, renaming, and deleting worker profiles. Bindings supports binding or unbinding agents to profiles. Recent terminal run cards live in the `Alt+W` Fleet Runs board.

The `/tasks` overlay shows the session task board the agent maintains through
the `tasks` tool: every task with its status, the evidence note recorded when
it was completed, and the reason recorded when it was blocked or dropped. The
board persists in the session ledger as `taskLedger` entries, so it survives
`/resume` and `/fork` and can be audited from the JSONL alone.

The read-only `/memory` overlay keeps durable and session memory attributable
in one place. It lists approved evidence-backed lessons, then the live task
bank by private status, knowledge, and procedural class, including each
entry's injection count and the last memory-step outcome. The welcome island
and expanded dashboard summarize whether intervention is on, its rules or LLM
tier, and current bank size.
After `/resume`, Clio offers `/memory seed` when the newest handoff contains a
structured snapshot. Seeding is explicit, deduplicated, and unavailable while
`memory.intervention.enabled` is off.

## Keybindings

App bindings use `Alt + <key>` as the primary scheme, plus `Shift+Tab`,
`Ctrl+D`, and a portable `Ctrl+G` leader. Modern terminals and Linux/meta
setups send Alt directly. Stock macOS Terminal.app needs **Use Option as Meta
key** enabled in Settings > Profiles > Keyboard for native Alt; otherwise use
`Ctrl+G` then the Alt binding letter.

| Binding | Action |
| --- | --- |
| `Shift+Tab` | Cycle thinking level. |
| `Alt+T` | Open the session tree navigator. |
| `Alt+U` | Toggle the footer dashboard between compact and expanded layouts. |
| `Alt+L` | Open the model and targets selector. |
| `Alt+J` / `Alt+K` | Cycle through the scoped model set. |
| `Alt+W` | Toggle the Fleet Runs board (task, run ID, live telemetry, retry, and terminal history). |
| `Alt+O` | Toggle the latest tool segment between collapsed and full body. |
| `Ctrl+Alt+O` / `Alt+Shift+O` | Toggle all tool segments between collapsed and full bodies. |
| `Alt+P` | Toggle live partial tool output in expanded tool bodies. |
| `Alt+R` | Toggle the latest thinking block between hidden marker and full body. |
| `Ctrl+Alt+R` / `Alt+Shift+R` | Toggle all thinking blocks between hidden markers and full bodies. |
| `Alt+G` | Open the current input in an external editor. |
| `Alt+X` | Dismiss footer notifications. |
| `Alt+Enter` | Queue the current input as a follow-up message. |
| `Alt+Up` | Restore queued follow-up messages to the editor. |
| `Ctrl+G`, then a letter | Portable leader fallback for Alt-letter actions. |
| `Ctrl+C` | With no overlay, cancel a stream, clear input, or press twice to exit. With an overlay open, close/cancel that overlay only. |
| `Ctrl+D` | Exit when the editor is empty; otherwise delete the next character (pi-compatible). It never exits from inside an overlay. |
| `Esc` | With an overlay open, stays inside it (list filters clear first, then close). With no overlay, cancel a stream/bash operation or collapse the dashboard. |

When scripting Clio inside tmux, prefer `tmux send-keys C-m` for submit/confirm keys instead of the literal `Enter` token; some tmux/terminal combinations do not deliver `Enter` reliably.

## Live Steering

During an active assistant stream, pressing `Enter` sends the current editor
text as steering for the active run instead of waiting for the turn to finish.
The input is delivered through `agent.steer` before the next model turn.
`Alt+Enter` keeps the after-run follow-up behavior.

For running dispatches, the editor also accepts:

```text
@<agentId-or-runId-prefix> <steering text>
```

Clio resolves the token to an exact agent id first, then to a run-id prefix,
and forwards the text to the native worker's steering channel. File-looking
tokens such as `@package.json` are rejected so ordinary repository references
do not accidentally become steering requests.

The `Alt+W` Fleet Runs board makes this control path discoverable: use
Up/Down or `j`/`k` to select a run, `s` to close the board and prefill its
exact `@<runId> ` steering prefix, and `x` to cancel a live worker or queued
retry. A steer first reports `queued`; only the worker's
`clio_steer_received` acknowledgement reports `received`. ACP delegation
runs do not expose a native steering channel and are labeled accordingly.

## Operating Posture and Autonomy

Clio Coder operates with a single, unified tool surface. There are no separate tool-visibility modes; what varies is the `autonomy` level (`read-only` | `suggest` | `auto-edit` | `full-auto`), edited in the `/settings` Autonomy & Safety section.

Tool and command execution is governed by:
- **Target Capabilities:** What the selected model target actually supports (such as tools, streaming, and vision).
- **Safety Net:** Granular rule packs loaded from `damage-control-rules.yaml`, project policies, and protected artifact paths; always on, identical at every autonomy level.
- **Autonomy Mapping:** Once the net passes a call, the level decides whether it runs, asks, or is denied. See [safety-model.md](safety-model.md) for the full matrix.

When an action asks for confirmation, whether from a safety-net rail or from the autonomy level, the call parks and the TUI displays a queued permission dialog whose `Asked by:` line names the asking axis. The operator can approve or deny that single action without changing the level.

Notice vocabulary, one prefix per mechanism: `[safety-net]` for level-independent blocks, `[approval]` for parked calls, `[autonomy]` for read-only denials, and `[middleware]` for hook diagnostics.

## Dispatch and Built-In Agents

Fleet dispatch runs focused agent recipes through configured targets. The final agent fleet includes:

| Agent | Category / Audience | Use it for |
| --- | --- | --- |
| `architect` | `plan` / `base` | Mapping boundaries, contracts, and migration slices. |
| `coder` | `implement` / `base` | Bounded implementation, repairs, and behavior-preserving refactors. |
| `debugger` | `quality` / `base` | Explaining a failing run, test failure, or session evidence without edits. |
| `documenter` | `implement` / `base` | Updating developer-facing docs, examples, and operational runbooks. |
| `tester` | `quality` / `base` | Focused tests for regressions and verification gaps. |
| `verifier` | `quality` / `base` | Independent test, lint, build, and quality gate reports. |
| `scout` | `explore` / `shadow` | Read-only repository exploration, symbol mapping, and context assembly. |
| `researcher` | `research` / `shadow` | Documentation, literature, and web-grounded investigation. |
| `provenance` | `operations` / `shadow` | Reading evidence files, receipts, diffs, and telemetry for handoffs. |

Examples:

```bash
clio run --agent coder "Find the main build, test, and lint commands."
clio run --agent architect "Plan a minimal change to add JSON output to the CLI."
clio run --agent verifier "Run tests and confirm the build passes."
```

Shadow agents (`scout`, `researcher`, `provenance`) are internal orchestration
helpers. They appear in `clio agents --all` and the main prompt catalog, but
user-origin `/run` and `clio run --agent` requests are rejected for them.
For broad repository reconnaissance, the operating contract and Scout catalog
description steer the model to author a Scout dispatch. The chat harness does
not mechanically route the request. A threshold nudge advises Scout delegation
after 9 or more manual read-only exploration calls in one turn.

Agent recipes are the Markdown source files. The normalized agent spec is the
catalog/runtime view: category, capability class, latency class, tags, mode, and
tool set. This keeps Clio's product vocabulary stable while dispatch continues
to execute through the existing Pi-backed worker path, the sanctioned Claude Code worker runtimes (`claude-sdk` and `claude-code`), or external ACP delegation agents.

## Verification Lanes

| Command | Purpose |
| --- | --- |
| `npm run ci` | Local and GitHub PR gate: typecheck, Biome check, skills pin check, build, and deterministic tests. |
| `npm run ci:release` | Maintainer release gate: `npm run ci`, then the `check-release` dist and packaging audit. |
| `npm run test:live` | Local manual live-model smoke. Requires `CLIO_LIVE_SMOKE=1` and a configured real model target. Add `-- --delegation` for `opencode` and `copilot` ACP delegation checks. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run lint` | Biome checks; warnings are reported in the release gate output. |
| `npm run test` | Contract, smoke, and boundary tests. |
| `npm run check:boundaries` | Boundary invariants only. |
| `npm run build` | Production bundle through `tsup`. |
| `npm run dev` | `tsup --watch`. |
| `npm run clean` | Remove `dist/`. |

Live smoke example:

```bash
CLIO_LIVE_SMOKE=1 \
CLIO_LIVE_TARGET=openai-compat \
CLIO_LIVE_RUNTIME=openai-compat \
CLIO_LIVE_MODEL=your-model \
CLIO_LIVE_BASE_URL=http://localhost:8080/v1 \
npm run test:live
```

Delegation validation is a separate opt-in flag because it depends on local
`opencode` and `copilot` commands:

```bash
CLIO_LIVE_SMOKE=1 npm run test:live -- --delegation
```

Live checks cost tokens or local GPU time and are not deterministic CI. They
are useful for OpenAI-compatible local gateways such as llama.cpp, LM Studio
with Dynamo-backed workers, vLLM, and SGLang, plus cloud targets when
credentials are available.

## Environment Variables

Clio Coder's behavior can be customized or overridden using various environment variables (such as `CLIO_RIGOR`, `CLIO_HOME`, and guardrail overrides). For the complete, detailed, and maintained inventory of environment variables, please refer to [environment-variables.md](environment-variables.md).

---

## Project Context

Clio uses the nearest checked-in `CLIO.md` as the canonical project guide. Run
`/context init` in the TUI or `clio context init` from the shell to create or
refresh it. During adoption, Clio can fold useful content from supported agent
instruction files into `CLIO.md` with provenance.

To skip project context for one invocation:

```bash
clio --no-context-files
clio -nc run --agent scout "..."
```

### Codewiki index

`clio context index` builds the structural codewiki without any model calls. It
writes `.clio/codewiki.json` plus
`.clio/state.json`, records `codewikiVersion`, and prints coverage plus a
structural hash. The same builder is used by `clio context init`, `clio context
refresh`, session freshness checks, tool-demand backfill, and in-session
incremental updates.

The current artifact is schema v5. It records files with path, language, line
count, role, content hash, imports, and optional summary; declaration-only
symbols with name, kind, file id, line, and optional signature; and import edges
to internal files or external modules. The writer emits compact JSON.
Tree-sitter extraction covers TypeScript, JavaScript, Python, Go, Rust, C, C++,
Java, Ruby, and C#, with per-file regex fallback where a regex extractor exists.

### Markdown wiki commands

`clio context wiki` generates the optional agent-authored wiki under
`.clio/wiki/` by dispatching the `wiki-writer` agent through the configured
model target. It makes one planning dispatch, which revises the page plan the
codewiki index derived, then one dispatch per page. `quickstart.md` and every
directory `index.md` are generated deterministically from the pages' front
matter after the run, so no dispatch writes them. `.clio/wiki/meta.json` records
the page list, model label, content hash, git head, indexed source-tree hash,
and the plan.

Each page dispatch is bounded on its own wall clock, and the run is bounded
between pages. Neither bound loses work: a page that fails or times out is
recorded as still owed and the run continues to the next one, and every finished
page is assembled and promoted. When `generation.pagesWritten` is below
`generation.pagesPlanned`, run `clio context wiki --update` to finish the rest;
it resumes from the plan rather than starting over.

`clio context wiki --update` requests update mode explicitly. It rewrites the
pages whose front-matter `sources` git reports as changed since the recorded
wiki `gitHead`, and leaves the rest alone.
`clio context wiki --status` is read-only: it prints whether wiki metadata is
present, page count, `updatedAt`, recorded `gitHead`, whether that head differs
from current `HEAD`, and how many planned pages remain unwritten. It dispatches
nothing and spends no model tokens.

`clio context refresh` rebuilds only the structural codewiki and state. It does
not run a model and does not touch `CLIO.md` or `.clio/wiki/`. If a wiki exists
and its recorded git head is stale, the command prints the hint:

```text
wiki is stale; run clio context refresh --wiki or clio context wiki --update
```

`clio context refresh --wiki` is the explicit model-spend path for refresh. It
first rebuilds the structural codewiki, then updates an existing wiki when
`.clio/wiki/meta.json` exists. If no wiki metadata exists, the flag is accepted
and no wiki model call is made; use `clio context wiki` to create the first
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
- **Tool Body Toggle (`Alt+O`) / All Tools (`Ctrl+Alt+O` / `Alt+Shift+O`):** Expand the latest tool or every tool body.
- **Live Tool Output (`Alt+P`):** Pause or resume cumulative partial tool output in expanded live tool bodies; the tool still executes.
- **Live Streaming:** During active assistant turns, thinking increments stream live into the chat panel down a rail-prefixed segment. Reasoning totals marked `≈` are approximations from visible text; provider-reported totals are shown without that marker. Neither implies complete or cryptographically verified hidden reasoning.
- **Thinking Replay:** When continuing a conversation, prior thinking is preserved and replayed in the history according to target-specific rules.

## TUI Surface Refinements

The Clio TUI has been enhanced to maximize readability and command discovery:

- **Redesigned Compact Footer:** The footer dashboard displays real-time token, cost, and target indicators in a single-row layout. Use `Alt+U` to toggle the footer between compact and expanded widgets.
- **Relocated Telemetry:** Per-turn telemetry is surfaced in the footer activity area, keeping token consumption and execution costs visible without adding extra transcript noise.
- **Overlay Navigation:** Standardized overlays are available for settings, model selection, `/help` key reference, target health, and session tracking.

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
| `info` | `·` | `dim` | General system information and usage |
| `success` | `✓` | `success` | Operation completed successfully |
| `warn` | `!` | `warning` | Non-fatal issue or precaution |
| `error` | `✗` | `error` | Fatal issue or operation failure |

### ListOverlay Behavior
The `ListOverlay` component provides a reusable kit for filterable, grouped, and selectable lists with an optional detail pane.

Navigation keys include the up and down arrow keys, as well as the 'j' and 'k' keys when the filter input is not focused. These keys wrap selection around the ends of the list.

The Tab key, or the Enter key when no primary action is defined, toggles the detail pane below the list.

For filtering, typing in the input row dynamically filters items using a fuzzy search that matches both the item label and the group name. Group headers that have no matching items are hidden. The Escape key clears a non-empty filter, and pressing it again closes or cancels the overlay.

The detail pane displays structured descriptions, usage, or state metadata using the Markdown component with the Clio markdown theme.

## Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio: command not found` | Run `npm run install:local`, then `hash -r`; confirm `${CLIO_BIN_DIR:-$HOME/.local/bin}` is on `PATH`. |
| No model target is available | Run `clio configure`, then `clio targets --probe`. |
| Local model does not respond | Confirm the runtime is running and the target URL is correct. |
| Cloud model auth fails | Check `clio auth status <target>` and verify the relevant API key or login flow. |
| Source changes do not appear | Re-run `npm run build`; linked CLI points at `dist/`. |
| Session replay looks incomplete | Confirm durable session entries exist for the relevant tool, bash, or display activity. |
| Doctor reports stale state metadata | Run `clio doctor --fix`; upgrades also refresh install metadata after reinstalling. |
| You need a clean start | Use `clio reset --state`, `--data`, `--cache`, `--auth`, `--config`, or `--all`. |

For issue reports, include `clio --version`, `node --version`, `clio doctor`,
`clio targets`, the command you ran, the target/model, expected behavior, and
actual behavior. Redact secrets and private repository content.

> [!NOTE]
> `clio dev <command>` groups the instruments that answer a question about the
> harness rather than about your own work. Nothing under it is deprecated: every
> name still resolves without the prefix, so scripts and agents driving Clio over
> bash keep working unchanged. The prefix exists so `clio --help` stays the set of
> commands a person needs to read; `clio --help --all` prints both lists.

