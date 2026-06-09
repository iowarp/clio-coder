# Commands and Modes

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/commands_blueprint.html](html/commands_blueprint.html) (Version: 0.2.2).


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
| `clio targets use <id>` | Set chat and fleet defaults to one target. |
| `clio targets profile <name> <id>` | Register a named fleet profile. |
| `clio targets convert <id> --runtime <runtimeId>` | Convert older local target definitions to a runtime-specific target. |
| `clio targets remove <id>` | Remove a target. |
| `clio targets rename <old> <new>` | Rename a target id. |
| `clio models [search] [--target <id>] [--json] [--probe]` | List known or discovered models. |
| `clio auth list` | Show known auth entries. |
| `clio auth status [target-or-runtime]` | Inspect auth state. |
| `clio auth login <target-or-runtime>` | Add credentials through the supported flow. |
| `clio auth logout <target-or-runtime>` | Remove stored credentials. |
| `clio doctor [--fix]` | Diagnose state; with `--fix`, repair or create missing state. |
| `clio reset [--state\|--auth\|--config\|--all]` | Reset selected Clio Coder state. |
| `clio uninstall [--keep-config] [--keep-data]` | Remove Clio Coder state and print uninstall guidance. |
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
| `clio init [--yes] [--preview|--adopt]` | Bootstrap or adopt agent configs into `CLIO.md`. |

## Headless Run Flags

| Flag | Meaning |
| --- | --- |
| `--target <id>` | One-run main-agent or dispatch target override. |
| `--model <wireId>` | One-run model override. |
| `--thinking <level>` | One-run thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `--json` | Stream JSONL events for main-agent runs; dispatch streams events and receipt JSON. |
| `--agent <recipe-id>` | Dispatch a fleet agent instead of the main agent. Unknown ids fail fast. |
| `--skill <path>` | Load one explicit skill file or skill directory for this run. Repeatable. |
| `--no-skills` | Disable skill discovery for this run while still honoring explicit `--skill` paths. |
| `--agent-profile <name>` | Use a named fleet profile for dispatch. |
| `--agent-runtime <id>` | Pick the first fleet profile whose endpoint uses this runtime. |
| `--tool-profile <name>` | Restrict dispatched-agent tools: `minimal-local`, `science-local`, or `full-agent`. |
| `--require <capability>` | Require a target capability for dispatch. Repeatable. |

Example:

```bash
clio run \
  "Find the test command and summarize the project structure." \
  --target local-lmstudio \
  --model your-model-id
```

## Interactive Slash Commands

Slash commands are available inside the TUI. Type `/` at the start of the
prompt to open autocomplete.

| Command | Purpose |
| --- | --- |
| `/run <agent> <task>` | Dispatch a fleet agent and stream events into the transcript. |
| `/init` | Create or refresh the checked-in `CLIO.md` project guide. |
| `/targets` | Show target health, auth, runtime, model, and capabilities. |
| `/connect [target]` | Connect to a target or runtime. |
| `/disconnect [target]` | Disconnect a target or runtime when Clio owns connection state. |
| `/model [pattern[:thinking]]` | Open the model selector or set the orchestrator model. |
| `/scoped-models` | Edit the model list used by model cycling. |
| `/thinking` | Open the thinking-level selector. |
| `/settings` | Open interactive settings controls. |
| `/resume` | Resume an existing session. |
| `/new` | Start a fresh session. |
| `/tree` | Navigate the session tree. |
| `/fork` | Branch from an earlier assistant turn. |
| `/compact [instructions]` | Compact earlier session context. |
| `/cost` | Show token and USD totals for completed runs in the session. |
| `/receipts` | Browse saved run receipts. |
| `/receipts verify <runId>` | Verify a receipt against the persisted run ledger. |
| `/skills [query]` | List discovered skills with scope, source, and trust state. |
| `/skill:name args` | Force-activate a skill by expanding its body into the message. |
| `/prompts [query]` | List available prompt templates. |
| `/extensions` | List installed extension packages and active/shadowed/disabled state. |
| `/share export <path>` | Export current project resources to a share archive. |
| `/share import [--dry-run] [--force] <path>` | Preview or apply a share archive import. |
| `/help` | Show the slash-command reference. |
| `/hotkeys` | Show resolved keyboard bindings. |
| `/quit` | Exit the TUI cleanly. |

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

## Operating Posture

Clio Coder operates under a single, unified operating posture. There are no separate read-only, default-deny, or privileged modes, and no user-facing mode toggles.

Tool and command execution is governed entirely by:
- **Target Capabilities:** What the selected model target actually supports (such as tools, streaming, and vision).
- **Safety Policy Engine:** Granular rule packs loaded from `damage-control-rules.yaml`, project policies, and protected artifact paths. See [safety-model.md](safety-model.md) for details on safety gates and default-deny Bash behaviors.

When an action requires confirmation, the safety engine registers an authorization demand and pauses execution. The TUI displays a queued permission confirmation dialog. The operator can then approve or deny that single action without changing the overall operating posture.

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
to execute through the existing Pi-backed worker path.

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
`/init` in the TUI or `clio init` from the shell to create or refresh it.
During adoption, Clio can fold useful content from supported agent instruction
files into `CLIO.md` with provenance.

To skip project context for one invocation:

```bash
clio --no-context-files
clio -nc run --agent scout "..."
```

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
- **Overlay Navigation:** Standardized overlays are available for settings, model selection, hotkey references, target health, and session tracking.

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
| You need a clean start | Use `clio reset --state`, `--auth`, `--config`, or `--all`. |

For issue reports, include `clio --version`, `node --version`, `clio doctor`,
`clio targets`, the command you ran, the target/model, expected behavior, and
actual behavior. Redact secrets and private repository content.
