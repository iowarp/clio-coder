# Commands and Modes

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/commands_blueprint.html](html/commands_blueprint.html) (Version: 0.2.5).


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
| `clio --version` | Print the installed version. |
| `clio --no-context-files` / `clio -nc` | Skip `CLIO.md` project-context injection for one invocation. |
| `clio configure` | Run the configuration wizard. |
| `clio configure --list` | List user-facing runtime ids. |
| `clio targets [--json] [--probe] [--target <id>]` | List configured targets, health, auth, runtime, model, and capabilities. |
| `clio targets add` | Add a target interactively or through configure flags. |
| `clio targets use <id>` | Set chat and fleet defaults to one orchestrator-capable target. |
| `clio targets profile <name> <id>` | Register a named fleet profile. |
| `clio targets convert <id> --runtime <runtimeId>` | Convert older local target definitions to a runtime-specific target. |
| `clio targets remove <id>` | Remove a target. |
| `clio targets rename <old> <new>` | Rename a target id. |
| `clio models [search] [--target <id>] [--json] [--offline] [--probe]` | List models. Live probing is the default; `--offline` skips it and `--probe` is accepted for compatibility. |
| `clio paths [--json]` | Print the resolved config, data, state, and cache directories. |
| `clio auth list` | Show known auth entries. |
| `clio auth status [target-or-runtime]` | Inspect auth state. |
| `clio auth login <target-or-runtime>` | Add credentials through the supported flow. |
| `clio auth logout <target-or-runtime>` | Remove stored credentials. |
| `clio doctor [--fix]` | Diagnose state; with `--fix`, repair or create missing state. |
| `clio reset [--state\|--data\|--cache\|--auth\|--config\|--all]` | Reset selected Clio Coder state. `--state` is the default level. |
| `clio uninstall [--dry-run] [--remove-binary] [--force]` | Remove Clio Coder state and print uninstall guidance. |
| `clio upgrade` | Check for and apply runtime upgrades. |
| `clio agents` | List discovered agent specs. |
| `clio components [--json]` | List behavior-affecting harness components. |
| `clio components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio components diff --from <a> --to <b>` | Compare component snapshots. |
| `clio evidence build\|inspect\|list` | Build and inspect deterministic evidence artifacts. |
| `clio eval run\|report\|compare` | Run local eval task files and compare results. |
| `clio memory list\|propose\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. |
| `clio evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio extensions list\|discover\|install\|enable\|disable\|remove` | Manage installed extension packages and resource roots. |
| `clio skills list\|inspect\|validate\|create` | Manage discovered and Clio-native skills. |
| `clio share export --out <path>` | Export project context, prompts, skills, settings fragments, and extension bundles. |
| `clio share import <path> [--dry-run] [--force]` | Import a share archive with conflict reporting. |
| `clio share inspect <path> [--json]` | Inspect a share archive without importing it. |
| `clio context-init [--yes] [--preview|--heuristic|--adopt]` | Explore the repo and bootstrap project context: `CLIO.md` and codewiki. |
| `clio context-index [--json]` | Build the Stage 1 codewiki index without model calls; writes `.clio/codewiki.json` and `.clio/state.json` and prints coverage plus a structural hash. |

## Headless Run Flags

| Flag | Meaning |
| --- | --- |
| `--target <id>` | One-run main-agent or dispatch target override. |
| `--model <wireId>` | One-run model override. |
| `--thinking <level>` | One-run thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `--temperature <n>` / `--top-p <n>` / `--top-k <n>` / `--min-p <n>` | One-run sampler overrides when the selected runtime supports them. |
| `--presence-penalty <n>` / `--frequency-penalty <n>` / `--repeat-penalty <n>` | One-run penalty overrides when the selected runtime supports them. |
| `--json` | Stream JSONL events for main-agent runs; dispatch streams events and receipt JSON. |
| `--agent <recipe-id>` | Dispatch a fleet agent instead of the main agent. Unknown ids fail fast. |
| `--skill <path>` | Load one explicit skill file or skill directory for this run. Repeatable. |
| `--no-skills` | Disable skill discovery for this run while still honoring explicit `--skill` paths. |
| `--agent-profile <name>` | Use a named fleet profile for dispatch. |
| `--agent-runtime <id>` | Pick the first fleet profile whose target uses this runtime. |
| `--tool-profile <name>` | Restrict dispatched-agent tools: `minimal-local`, `science-local`, or `full-agent`. |
| `--require <capability>` | Require a target capability for dispatch. Repeatable. |
| `--steer-channel <path>` | Read live steering lines from a FIFO or an appended regular file to steer the active run. |


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
| `/context-init` | - | `/context-init [--preview] [--adopt] [--apply] [--propose] [--global] [--heuristic]` | Explore the repo and bootstrap project context: CLIO.md and codewiki |
| `/context-clear` | - | `/context-clear [--all] [--confirm] [--confirm-all]` | Clear accumulated project context artifacts |
| `/skill` | `/skill:`, `/skills:` | `/skill [name] [task]` | Open the Skills Hub or invoke a skill |
| `/prompts` | - | `/prompts` | List prompt templates |
| `/extensions` | - | `/extensions` | List installed extensions |
| `/share` | - | `/share export <path> \| /share import [--dry-run] [--force] <path>` | Export or import Clio archives |
| `/run` | - | `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local\|science-local\|full-agent>] [--require <cap>] <agent> <task>` | Run a fleet agent |
| `/delegate` | - | `/delegate <agent-id> <task>` | Run an ACP delegation agent |
| `/agents` | - | `/agents` | List Clio agents and ACP delegation agents |
| `/targets` | - | `/targets` | Show target hub for health, auth, models, and actions |
| `/cost` | - | `/cost` | Show session token and cost totals |
| `/context-view` | `/context`, `/ctx` | `/context-view` | Visualize the active context window and its breakdown |
| `/fleet` | - | `/fleet` | Show in-process dispatch running/retry status |
| `/view` | - | `/view [filter] \| /view verify <runId>` | Browse session artifacts and verify receipts |
| `/thinking` | - | `/thinking` | Open thinking-level selector |
| `/model` | `/models` | `/model [pattern]` | Open model selector or set a model |
| `/scoped-models` | - | `/scoped-models` | Edit the Alt+J / Alt+K model cycle set |
| `/settings` | - | `/settings` | Open interactive settings |
| `/resume` | - | `/resume` | Resume a past session |
| `/new` | - | `/new` | Start a fresh session |
| `/tree` | - | `/tree` | Open session tree navigator |
| `/fork` | - | `/fork` | Fork from an assistant turn |
| `/compact` | - | `/compact [instructions]` | Compact earlier context |


The `/targets` hub is the only interactive target command. Use `j`/`k` or the arrow keys to browse targets, `Enter` to expand or collapse details, `u` to use the selected target for chat, `c` to connect, `d` to disconnect, `r` to probe the selected target, and `R` to probe all targets. Worker-only targets such as `claude-sdk` and `claude-code` are selected for dispatch through fleet defaults or profiles, not through the chat target action.

The `/fleet` overlay displays live running, retrying, and completed fleet dispatch subagents in the current TUI process. It includes three distinct tabs: Status, Profiles, and Bindings. You can cycle between these tabs by pressing `Tab`. The Status tab shows active runs, their execution stats, and scheduled retries with backoff times. The Profiles tab allows creating, editing, renaming, and deleting worker profiles. The Bindings tab supports binding or unbinding specific agents to profiles.


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
| `Alt+W` | Toggle the dispatch board overlay. |
| `Alt+O` | Toggle the most recent tool segment between collapsed and full body. |
| `Alt+R` | Toggle thinking blocks between hidden marker and full body. |
| `Alt+G` | Open the current input in an external editor. |
| `Alt+X` | Dismiss footer notifications. |
| `Alt+Enter` | Queue the current input as a follow-up message. |
| `Alt+Up` | Restore queued follow-up messages to the editor. |
| `Ctrl+G`, then a letter | Portable leader fallback for Alt-letter actions. |
| `Ctrl+C` | Cancel a stream, clear input, or press twice to exit. |
| `Ctrl+D` | Exit. |
| `Esc` | Cancel a stream, close an active overlay, or collapse the dashboard. |

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

Agent recipes are the Markdown source files. The normalized agent spec is the
catalog/runtime view: category, capability class, latency class, tags, mode, and
tool set. This keeps Clio's product vocabulary stable while dispatch continues
to execute through the existing Pi-backed worker path, the sanctioned Claude Code worker runtimes (`claude-sdk` and `claude-code`), or external ACP delegation agents.

## Verification Lanes

| Command | Purpose |
| --- | --- |
| `npm run ci` | Local and GitHub PR gate: typecheck, Biome check, build, and deterministic tests. |
| `npm run ci:release` | Maintainer release gate: `npm run ci`, then `check-dist` packaging verification. |
| `npm run test:live` | Manual live-model smoke. Requires `CLIO_LIVE_SMOKE=1` and a configured real model target. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run lint` | Biome checks; warnings are reported in the release gate output. |
| `npm run test` | Contract, smoke, and boundary tests. |
| `npm run check:boundaries` | Boundary invariants only. |
| `npm run build` | Production bundle through `tsup`. |
| `npm run dev` | `tsup --watch`. |
| `npm run clean` | Remove `dist/`. |
| `npm run hooks:install` | Install the optional pre-commit hook. |

Live smoke example:

```bash
CLIO_LIVE_SMOKE=1 \
CLIO_LIVE_TARGET=openai-compat \
CLIO_LIVE_RUNTIME=openai-compat \
CLIO_LIVE_MODEL=your-model \
CLIO_LIVE_BASE_URL=http://localhost:8080/v1 \
npm run test:live
```

Live checks cost tokens or local GPU time and are not deterministic CI. They
are useful for OpenAI-compatible local gateways such as llama.cpp, LM Studio
with Dynamo-backed workers, vLLM, and SGLang, plus cloud targets when
credentials are available.

## Project Context

Clio uses the nearest checked-in `CLIO.md` as the canonical project guide. Run
`/context-init` in the TUI or `clio context-init` from the shell to create or refresh it.
During adoption, Clio can fold useful content from supported agent instruction
files into `CLIO.md` with provenance.

To skip project context for one invocation:

```bash
clio --no-context-files
clio -nc run --agent scout "..."
```

### Codewiki index

`clio context-index` builds the Stage 1 codewiki without any model calls and writes
`.clio/codewiki.json` plus `.clio/state.json`. Indexing is deterministic: the same tree
produces the same structural hash on every run, so the index is safe to rebuild in CI and
compare across machines. Extraction runs through web-tree-sitter WASM grammars and covers
TypeScript, JavaScript, Python, Go, Rust, C, C++, Java, and Ruby, with a fallback
extractor for trees the grammars do not parse. The v3 schema records files (path, language,
line count, role), symbols (name, kind, line, signature), and import edges (internal file
links and external modules). `clio context-init` builds the same index while bootstrapping
`CLIO.md`, and it no longer seeds a starter handoff file.

### code_nav modes

Agents query the codewiki through the read-only `code_nav` tool instead of grepping the
tree. Every mode reads the persisted index, so lookups are local and fast.

| Mode | Arguments | Returns |
|------|-----------|---------|
| `symbol` | `query=<name>` | Declaring files plus each match's path, line, kind, and signature. |
| `path` | `query=<glob \| /regex/ \| substring>` | Files whose path matches the pattern. |
| `entries` | `[limit=<n>]` | Likely entry points from file roles and `package.json` main/bin. |
| `outline` | `query=<path>` | Symbols declared in the file with kinds and line numbers. |
| `deps` | `query=<path>` | The file's imports: internal file paths and external modules. |
| `dependents` | `query=<path>` | Files that import the given file. |

`entries` defaults to 25 results and caps at 200. `path` accepts a `/pattern/flags` regex,
a glob using `*`, `?`, or `[...]`, or a plain substring. `outline`, `deps`, and
`dependents` resolve an exact indexed path or a unique suffix match.

## Reasoning and Live Thinking Controls

Clio Coder features direct, interactive controls for model reasoning and thinking streams:

- **Thinking Level (`Shift+Tab`):** Allows operators to cycle through available thinking configurations. This is useful for dialing model reasoning budgets up or down in real time.
- **Thinking Blocks Toggle (`Alt+R`):** Toggles assistant thinking blocks between a compact, single-line folded marker and an expanded, full-body view.
- **Live Streaming:** During active assistant turns, thinking increments stream live into the chat panel down a rail-prefixed segment.
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
