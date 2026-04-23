# Pi-Coding-Agent Feature Port to Clio-Coder

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port every user-visible and developer-facing feature of `@mariozechner/pi-coding-agent` 0.67.4 (~42,619 LOC) into Clio-Coder natively, without taking a runtime dependency on `pi-coding-agent`. Features enter Clio through its own engine boundary (`src/engine/` over pi-mono) and land in the domain, interactive, and core layers already scaffolded by the v0.1 roadmap.

**Architecture:** Inspiration-only port. Pi-coding-agent source is read, not imported. Every feature is re-implemented in Clio's layout (§16 of the design spec) to preserve the three hard invariants (engine boundary, worker isolation, domain independence). Pi-coding-agent itself remains a **Phase 7 CLI worker adapter** only.

**Tech Stack:** Node ≥20, TypeScript 5.7 strict, tsup, Biome, `@mariozechner/pi-agent-core@0.67.4`, `@mariozechner/pi-ai@0.67.4`, `@mariozechner/pi-tui@0.67.4`, `@sinclair/typebox`, `yaml`, `chalk`, `undici`. No new deps without justification; if a pi-coding-agent feature needs `diff`, `marked`, `cli-highlight`, `strip-ansi`, `proper-lockfile`, `ajv`, `ignore`, `hosted-git-info`, `extract-zip`, `file-type`, `uuid`, `minimatch`, `glob`, `@mariozechner/jiti`, or `@silvia-odwyer/photon-node`, the owning phase task introduces it with exact pinning.

---

## 1. Port Strategy

### 1.1 Why port, not depend

The Clio-Coder v0.1 design (§2, §19) locks:

1. **No dependency on `@mariozechner/pi-coding-agent`.** Clio owns the agent loop wiring, slash commands, session format, prompt compilation, tool registry, and identity completely.
2. **Pi-coding-agent re-enters as one worker adapter** among many (CLI tier) in `src/domains/providers/runtimes/cli/pi-coding-agent.ts`.
3. **`src/engine/` is the sole pi-mono import boundary.** All feature ports must pass through it.

Therefore, "port" means: read pi-coding-agent's source as reference IP, implement natively in Clio's layout, honor the three hard invariants, and keep the spec's 13-domain decomposition.

### 1.2 What already exists in Clio v0.1.0-rc1

From the current-state audit (commit `ab37e13`, branch `main`):

- **13 domains present** (`src/domains/{config,providers,safety,modes,prompts,session,agents,dispatch,observability,scheduling,intelligence,lifecycle,ui}`) with manifests, contracts, extensions.
- **10 tools** (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`, `web_fetch`, `write_plan`, `write_review`) behind `ToolRegistry` admission.
- **Native worker subprocess** (`src/worker/entry.ts`, NDJSON, heartbeat, graceful shutdown).
- **Interactive skeleton**: slash router (`/run`, `/providers`, `/cost`, `/receipts`, `/receipt verify`, `/help`, `/quit`), 5 overlays (providers, cost, receipts, dispatch-board, super-confirm), footer, chat loop streaming `AgentEvent`.
- **Session JSONL** (`current.jsonl` + `tree.json` + `meta.json`), checkpoint/resume/history.
- **Prompt compiler** with SHA-256 `staticCompositionHash` + `renderedPromptHash`, 9 fragment files.
- **Safety**: action classifier, scope specs, damage-control rules, audit trail, loop detector.
- **8 provider runtimes** (anthropic, openai, google, groq, mistral, openrouter, bedrock, claudesdk) + 5 local engines + 6 CLI adapters scaffolded.
- **7 builtin agent recipes** (scout, planner, worker, reviewer, researcher, delegate, context-builder).
- **CI green** on ubuntu + macos (typecheck, lint, check:boundaries, check:prompts, build, verify).

### 1.3 Phase insertion

The existing roadmap ends at Phase 10 (observability/scheduling/polish). This port plan adds **Phases 11–22** after Phase 10. Each port phase has:

- **Depends on:** previous phase(s) and named Clio subsystems
- **Produces:** concrete file list under Clio's layout
- **Exit criteria:** verifiable acceptance checks (CI green, scripted diag, manual TUI drill)
- **Inspired by:** exact pi-coding-agent file paths for IP reference
- **Destination:** exact Clio file paths

Phases are sized so any single phase can be written as a dedicated detailed plan file (`2026-04-17-clio-phase-NN-<name>.md`) when its turn comes, in the same just-in-time pattern the original roadmap uses. This file is the **spine** — it enumerates tasks, sequences them, sets exit criteria, and maps every pi-coding-agent feature to its Clio destination. The engineer assigned to a phase writes the bite-sized plan from this spine plus the reference map.

### 1.4 Non-goals

These pi-coding-agent features are **not ported**:

- `pi` brand identity, ASCII art, Earendil/Armin/Daxnuts Easter eggs (Clio has its own identity per §23).
- Bundled Doom overlay example extension (out of scope).
- Subscription-auth warnings for Anthropic (Clio is provider-neutral).
- `PI_CODING_AGENT=true` env flag (Clio sets `CLIO_RUNNING=true` instead for consistency with its own CLI adapter detection).
- pi.dev share viewer URL (Clio ships `/share` with a configurable viewer URL, default `about:blank` in v0.1 and a real IOWarp-hosted viewer post-1.0).
- Bun-binary build (`build:binary`) — deferred past v1.0. Clio ships as npm only for v0.1–v0.3.
- `@mariozechner/clipboard`, `@silvia-odwyer/photon-node` native addons — replaced with platform-native clipboard (xclip/wl-paste/pbpaste/powershell) and `sharp` or no-dependency PNG decoding. If neither fits, image paste falls back to "attach-by-path" behavior in v0.1.

### 1.5 Phase sequencing (addition to roadmap §Phase dependency graph)

```
Phase 10 (polish) landed
  └── Phase 11 TUI Selector Suite          (high value, low risk)
        └── Phase 12 Session Richness & Compaction
              ├── Phase 13 Resources: Skills, Prompts, Themes, Context Files
              │     └── Phase 14 Extensions System
              │           └── Phase 15 Package Manager
              ├── Phase 16 RPC + Print + JSON modes
              └── Phase 17 Auth & OAuth
                    └── Phase 18 Keybindings (user-configurable)
                          └── Phase 19 Rich Components (footer, diff, bash exec)
                                └── Phase 20 Input Polish (bash-from-editor, external editor, images, queue)
                                      └── Phase 21 Export / Import / Share
                                            └── Phase 22 Retry, Diagnostics, Telemetry, Final Polish
```

Phases 13–17 can fan out after Phase 12. Phases 18–22 sequence serially.

---

## 2. Feature Map (pi-coding-agent → Clio destination)

This is the authoritative IP-to-destination map. Every item lists: **pi-coding-agent source** (file, LOC) → **Clio destination** (file or directory) → **phase** owning the work → **status** in v0.1.0-rc1.

### 2.1 CLI & Entry

| pi-coding-agent | LOC | Clio destination | Phase | Status |
|---|---|---|---|---|
| `src/cli.ts` (shebang entry) | 17 | `src/cli/index.ts` (present) | ongoing | present, keep |
| `src/main.ts` (argv routing, migrations, runtime, mode dispatch) | 736 | `src/cli/clio.ts` + `src/entry/orchestrator.ts` | 22 | partial; lacks print/json/rpc modes and most flags |
| `src/cli/args.ts` (flag parser: 25+ flags, `@file`, unknownFlags → extensions) | 345 | `src/cli/args.ts` (new) | 16, 20, 22 | missing — port flag catalog below |
| `src/cli/file-processor.ts` (@file with image auto-resize, mime, exif) | — | `src/cli/file-processor.ts` (new) | 20 | missing |
| `src/cli/initial-message.ts` (build first message from args/stdin/files) | — | `src/cli/initial-message.ts` (new) | 16 | missing |
| `src/cli/list-models.ts` (--list-models [search]) | — | `src/cli/list-models.ts` (new) | 11 | missing |
| `src/cli/session-picker.ts` (TUI session selector for --resume) | — | `src/interactive/overlays/session-selector.ts` (new) | 11 | overlay missing |
| `src/cli/config-selector.ts` (package config TUI) | — | `src/interactive/overlays/package-config.ts` (new) | 15 | missing |
| `src/config.ts` (XDG paths, install method detection, piConfig) | 261 | `src/core/xdg.ts` (present) + `src/core/install-method.ts` (new) | 22 | XDG present; install-method detection missing |
| `src/package-manager-cli.ts` (`install`/`remove`/`update`/`list`/`config` subcommands) | 270 | `src/cli/packages.ts` (new) | 15 | missing |
| `src/migrations.ts` (session + settings migrations with deprecation warnings) | 314 | `src/domains/lifecycle/migrations/` (present, 1 migration) | 12, 22 | scaffolded; needs session-version migrations |

**Clio flag surface after Phase 22** (mirrors pi-coding-agent's full set, brand-renamed):

```
--provider <name>
--model <pattern>                    (supports provider/pattern, :thinking shorthand)
--api-key <key>
--system-prompt <text>
--append-system-prompt <text>        (repeatable)
--mode <text|json|rpc>
--print, -p
--continue, -c                        (latest session for cwd)
--resume, -r                          (TUI session picker)
--session <path|prefix>               (file path or UUID prefix, global search w/ fork prompt)
--fork <path|prefix>                  (new session from existing)
--session-dir <dir>
--no-session                          (ephemeral)
--models <patterns>                   (comma-separated, glob, fuzzy, cycle order)
--tools <names>                       (comma-separated, subset of 10 tools)
--no-tools                            (empty toolset; combine with --tools to add back)
--thinking <off|minimal|low|medium|high|xhigh>
--extension, -e <path>                (repeatable)
--no-extensions, -ne
--skill <path>                        (repeatable, file or dir)
--no-skills, -ns
--prompt-template <path>              (repeatable)
--no-prompt-templates, -np
--theme <path>                        (repeatable)
--no-themes
--no-context-files, -nc               (disables AGENTS.md/CLAUDE.md auto-load)
--export <path> [out.html]            (export session to HTML)
--list-models [search]
--verbose
--offline                             (sets CLIO_OFFLINE=1)
--help, -h
--version, -v
@<file>                               (attach file to initial message; images auto-resized)
--<unknown> [value]                   (forwarded to extension flag registry)
```

Subcommands (the pi-style leading-word dispatch):

```
clio install <source> [-l]            → domains/packages.install
clio remove <source> [-l]             → domains/packages.remove
clio uninstall <source> [-l]          → alias
clio update [source]                  → domains/packages.update
clio list                             → domains/packages.list
clio config                           → TUI package-config overlay

clio doctor                           → existing
clio upgrade                          → existing
clio version                          → existing
clio providers                        → existing
clio agents                           → existing
clio run <agent> <task>               → existing (headless dispatch)
```

### 2.2 Core runtime

| pi-coding-agent | LOC | Clio destination | Phase | Status |
|---|---|---|---|---|
| `core/agent-session.ts` | 3076 | `src/engine/agent.ts` (thin) + `src/core/agent-session-runtime.ts` (factory) + `src/interactive/chat-loop.ts` | 12 | thin wrapper + chat-loop skeleton present; missing queue modes, model/thinking cycle, compaction triggers, branching |
| `core/agent-session-runtime.ts` | 329 | `src/core/agent-session-runtime.ts` (new) | 12 | missing |
| `core/agent-session-services.ts` | 197 | `src/core/agent-session-services.ts` (new) | 12 | missing |
| `core/session-manager.ts` (tree JSONL, 20+ entry types, migrations) | 1425 | `src/engine/session.ts` (thin IO) + `src/domains/session/{manager,tree,entries,migrations}.ts` | 12 | basic present; rich entries + tree manager missing |
| `core/session-cwd.ts` (missing-cwd fallback) | 59 | `src/domains/session/cwd-fallback.ts` | 12 | missing |
| `core/settings-manager.ts` (global + project, scoped models, compaction/retry/image settings) | 970 | `src/domains/config/manager.ts` (present, basic) | 12, 22 | basic YAML only; project-local overlay + typed sub-sections missing |
| `core/auth-storage.ts` (OAuth + API key, pluggable) | 493 | `src/domains/providers/auth/{storage,oauth,api-key,backend-file,backend-memory}.ts` | 17 | basic credentials.yaml read only; no OAuth |
| `core/model-registry.ts` | 844 | `src/domains/providers/catalog.ts` (present, ~500) | 11 | catalog present; needs models.json extensibility |
| `core/model-resolver.ts` (glob, fuzzy, scoped, thinking shorthand) | 628 | `src/domains/providers/resolver.ts` (new) | 11 | missing |
| `core/resource-loader.ts` (global + project + CLI path discovery; AGENTS.md/CLAUDE.md) | 916 | `src/domains/resources/{loader,context-files,collision}.ts` (new domain — see §3) | 13 | missing; new minor domain |
| `core/package-manager.ts` (git/npm/local resources) | 2257 | `src/domains/packages/{manager,source-git,source-npm,source-local,registry}.ts` (new domain) | 15 | missing; new minor domain |
| `core/compaction/{compaction,branch-summarization,utils}.ts` | 823+355+170 | `src/domains/session/compaction/{compact,branch-summary,cut-point,tokens}.ts` | 12 | missing |
| `core/skills.ts` (Agent Skills standard, validation) | 508 | `src/domains/resources/skills/{loader,validator,invocation}.ts` | 13 | missing |
| `core/prompt-templates.ts` ($1/$@/${@:N:L} substitution) | 294 | `src/domains/resources/prompts/{loader,substitute}.ts` | 13 | missing |
| `core/extensions/{loader,runner,wrapper,types,index}.ts` | 557+915+unknown+1452+164 | `src/domains/extensions/{loader,runner,sandbox,types,registry}.ts` (new domain) | 14 | missing; new major domain |
| `core/keybindings.ts` (27 app keybindings + TUI) | 305 | `src/interactive/keybinding-manager.ts` + `src/domains/config/keybindings.ts` | 18 | 5 keybindings hardcoded in interactive; schema + user overrides missing |
| `core/system-prompt.ts` (build + append support) | 168 | `src/domains/prompts/builder.ts` (fragment composer already present) | 13 | fragment composer present; `--append-system-prompt` routing missing |
| `core/bash-executor.ts` (spawn + timeout + truncation + temp file) | 171 | `src/tools/bash.ts` (present, ~75 LOC) | 20 | basic shell exec; large-output temp-file + child-tracking missing |
| `core/footer-data-provider.ts` (git branch, extension statuses) | 339 | `src/interactive/footer-panel.ts` (present, minimal) | 19 | shows mode/model/cost; needs git branch + extension slots |
| `core/export-html/{index,ansi-to-html,tool-renderer,template.html,template.css,template.js,vendor/*}` | — | `src/domains/session/export-html/` + shipped template assets | 21 | missing |
| `core/slash-commands.ts` (registry + builtin list) | 38 | `src/interactive/slash-router.ts` (present, 7 cmds) | 11, 21, 22 | 7/20 builtins present |
| `core/messages.ts` (BashExecution, Custom, BranchSummary, CompactionSummary) | 195 | `src/domains/session/entries.ts` | 12 | missing |
| `core/defaults.ts` | — | `src/core/defaults.ts` (present) | — | present |
| `core/diagnostics.ts` | — | `src/core/diagnostics.ts` (new) | 22 | missing (uses `console.error` today) |
| `core/timings.ts` | 31 | `src/core/startup-timer.ts` (present) | — | present |
| `core/source-info.ts` | 40 | `src/core/source-info.ts` (new) | 14 | missing |
| `core/event-bus.ts` | 33 | `src/core/event-bus.ts` (present) | — | present |
| `core/exec.ts` | 107 | `src/core/exec.ts` (new) | 20 | missing; replaces ad-hoc child_process calls |
| `core/sdk.ts` (programmatic API re-exports) | 364 | `src/sdk.ts` (new) | 22 | missing; package exports stub only |
| `core/output-guard.ts` (stdout takeover for non-interactive) | 74 | `src/cli/output-guard.ts` (new) | 16 | missing |
| `core/resolve-config-value.ts` (`~/`, env var expansion) | 142 | `src/core/resolve-config-value.ts` (new) | 13 | missing |

### 2.3 Tools

| pi-coding-agent | LOC | Clio destination | Phase | Status |
|---|---|---|---|---|
| `core/tools/bash.ts` (BashOperations abstraction, detached process tracking) | 450 | `src/tools/bash.ts` | 20 | basic; needs Operations abstraction + detached tracking |
| `core/tools/edit.ts` + `edit-diff.ts` (atomic edit w/ diff preview) | 481+445 | `src/tools/edit.ts` + `src/tools/edit-diff.ts` (new) | 19 | edit present; diff preview missing |
| `core/tools/read.ts` | 269 | `src/tools/read.ts` | — | present |
| `core/tools/write.ts` | 285 | `src/tools/write.ts` | — | present |
| `core/tools/grep.ts` (ripgrep integration) | 388 | `src/tools/grep.ts` | — | present |
| `core/tools/find.ts` (fd integration, .gitignore-aware) | 386 | `src/tools/find.ts` (new, alias of glob?) + `src/tools/glob.ts` (present) | 19 | glob present; fd-integrated find missing |
| `core/tools/ls.ts` | 233 | `src/tools/ls.ts` | — | present |
| `core/tools/truncate.ts` (head/tail/line) | 265 | `src/tools/truncate-utf8.ts` (present, 13 LOC) | 19 | minimal truncation; needs head/tail/line helpers |
| `core/tools/render-utils.ts` | 64 | `src/tools/render-utils.ts` (new) | 19 | missing |
| `core/tools/path-utils.ts` | 94 | `src/tools/path-utils.ts` (new) | 20 | missing |
| `core/tools/tool-definition-wrapper.ts` (wraps AgentTool ↔ ToolDefinition) | 43 | `src/tools/tool-definition-wrapper.ts` (new) | 14 | missing |
| `core/tools/file-mutation-queue.ts` (serializes concurrent edits) | 39 | `src/tools/file-mutation-queue.ts` (new) | 14 | missing |
| `utils/tools-manager.ts` (managed fd/rg binaries under `<agentDir>/bin/`) | — | `src/domains/lifecycle/tools-manager.ts` (new) | 22 | missing |

### 2.4 Interactive TUI (38 components + theme + overlays)

| pi-coding-agent | LOC | Clio destination | Phase | Status |
|---|---|---|---|---|
| `modes/interactive/interactive-mode.ts` | 4800 | `src/interactive/{index,layout,chat-panel,editor-panel,footer-panel,overlay-manager}.ts` | 11–21 | skeleton + 5 overlays |
| `modes/interactive/theme/theme.ts` + `{dark,light,theme-schema}.json` | 1141 | `src/domains/resources/themes/{engine,schema.json}` + `assets/themes/{default,dark,light}.json` | 13 | missing; basic ANSI colors today |
| `components/tree-selector.ts` (`/tree`, 1239 LOC — largest component) | 1239 | `src/interactive/overlays/tree-selector.ts` | 12 | missing |
| `components/session-selector.ts` (`/resume`) | 1010 | `src/interactive/overlays/session-selector.ts` | 11 | missing |
| `components/session-selector-search.ts` | 194 | `src/interactive/overlays/session-selector-search.ts` | 11 | missing |
| `components/config-selector.ts` (package config) | 592 | `src/interactive/overlays/package-config.ts` | 15 | missing |
| `components/settings-selector.ts` (`/settings`) | 444 | `src/interactive/overlays/settings.ts` | 11 | missing |
| `components/model-selector.ts` (`/model`, Ctrl+L) | 338 | `src/interactive/overlays/model-selector.ts` | 11 | providers overlay exists (read-only); selector missing |
| `components/scoped-models-selector.ts` (`/scoped-models`) | 341 | `src/interactive/overlays/scoped-models.ts` | 11 | missing |
| `components/thinking-selector.ts` (cycle/toggle) | 74 | `src/interactive/overlays/thinking-selector.ts` | 11 | missing |
| `components/theme-selector.ts` | 67 | `src/interactive/overlays/theme-selector.ts` | 13 | missing |
| `components/extension-selector.ts` | 107 | `src/interactive/overlays/extension-selector.ts` | 14 | missing |
| `components/extension-editor.ts` (live-edit extension) | 147 | `src/interactive/overlays/extension-editor.ts` | 14 | missing |
| `components/extension-input.ts` | 87 | `src/interactive/overlays/extension-input.ts` | 14 | missing |
| `components/login-dialog.ts` (`/login`) | 178 | `src/interactive/overlays/login-dialog.ts` | 17 | missing |
| `components/oauth-selector.ts` | 121 | `src/interactive/overlays/oauth-selector.ts` | 17 | missing |
| `components/tool-execution.ts` | 344 | `src/interactive/renderers/tool-execution.ts` | 19 | basic stdout lines today |
| `components/bash-execution.ts` | 218 | `src/interactive/renderers/bash-execution.ts` | 20 | missing |
| `components/assistant-message.ts` | 130 | `src/interactive/renderers/assistant-message.ts` | 19 | basic today |
| `components/user-message.ts` | 33 | `src/interactive/renderers/user-message.ts` | 19 | basic today |
| `components/user-message-selector.ts` (pick message for fork) | 143 | `src/interactive/overlays/message-picker.ts` | 12 | missing |
| `components/branch-summary-message.ts` | 58 | `src/interactive/renderers/branch-summary.ts` | 12 | missing |
| `components/compaction-summary-message.ts` | 59 | `src/interactive/renderers/compaction-summary.ts` | 12 | missing |
| `components/custom-message.ts` | 99 | `src/interactive/renderers/custom-message.ts` | 14 | missing |
| `components/skill-invocation-message.ts` | 55 | `src/interactive/renderers/skill-invocation.ts` | 13 | missing |
| `components/diff.ts` + `renderDiff` | 147 | `src/interactive/renderers/diff.ts` | 19 | missing |
| `components/bordered-loader.ts` | 68 | `src/interactive/components/bordered-loader.ts` | 19 | missing |
| `components/dynamic-border.ts` | 25 | `src/interactive/components/dynamic-border.ts` | 19 | missing |
| `components/visual-truncate.ts` | 50 | `src/interactive/components/visual-truncate.ts` | 19 | missing |
| `components/show-images-selector.ts` | 50 | `src/interactive/overlays/show-images.ts` | 20 | missing |
| `components/footer.ts` | 220 | `src/interactive/footer-panel.ts` (present, 44 LOC) | 19 | minimal today |
| `components/countdown-timer.ts` (auto-retry backoff) | 38 | `src/interactive/components/countdown-timer.ts` | 22 | missing |
| `components/keybinding-hints.ts` | 24 | `src/interactive/components/keybinding-hints.ts` | 18 | missing |
| `components/custom-editor.ts` (editor with slash/@file/!bash/paste-image) | 80 | `src/interactive/editor-panel.ts` | 20 | basic today |
| `components/{armin,daxnuts,earendil-announcement}.ts` (brand easter eggs) | 599 | not ported (see §1.4) | — | skip |

### 2.5 Modes (run modes)

| pi-coding-agent | LOC | Clio destination | Phase | Status |
|---|---|---|---|---|
| `modes/interactive/interactive-mode.ts` | 4800 | `src/interactive/index.ts` + overlays (above) | 11–21 | existing skeleton |
| `modes/print-mode.ts` (text + json output) | 167 | `src/cli/modes/print.ts` (new) | 16 | missing |
| `modes/rpc/rpc-mode.ts` (JSONL server, 39 command handlers) | 733 | `src/cli/modes/rpc.ts` (new) | 16 | missing |
| `modes/rpc/rpc-client.ts` (Node client lib for embedders) | 506 | `src/sdk/rpc-client.ts` (new) | 16 | missing |
| `modes/rpc/rpc-types.ts` (36 command schemas, response types) | 262 | `src/sdk/rpc-types.ts` (new) | 16 | missing |
| `modes/rpc/jsonl.ts` (LF-strict framing, UTF-8 safe) | 59 | `src/cli/modes/jsonl.ts` (new) | 16 | missing |
| `modes/index.ts` | 10 | `src/cli/modes/index.ts` (new) | 16 | missing |

### 2.6 Docs & examples

| pi-coding-agent | Clio destination | Phase | Status |
|---|---|---|---|
| `docs/rpc.md` | `docs/reference/rpc-protocol.md` | 16 | missing |
| `docs/json.md` | `docs/reference/json-mode.md` | 16 | missing |
| `docs/sdk.md` | `docs/guides/sdk.md` | 16, 22 | missing |
| `docs/session.md` | `docs/reference/session-format.md` | 12 | missing |
| `docs/settings.md` | `docs/reference/settings.md` | 22 | missing |
| `docs/extensions.md` | `docs/guides/extensions.md` | 14 | missing |
| `docs/skills.md` | `docs/guides/skills.md` | 13 | missing |
| `docs/prompt-templates.md` | `docs/guides/prompt-templates.md` | 13 | missing |
| `docs/themes.md` | `docs/guides/themes.md` | 13 | missing |
| `docs/packages.md` | `docs/guides/packages.md` | 15 | missing |
| `docs/keybindings.md` | `docs/reference/keybindings.md` | 18 | missing |
| `docs/providers.md` | `docs/reference/providers.md` | 17 | partial |
| `docs/models.md` | `docs/reference/models.md` | 11 | partial |
| `docs/compaction.md` | `docs/reference/compaction.md` | 12 | missing |
| `docs/tree.md` | `docs/reference/session-tree.md` | 12 | missing |
| `docs/terminal-setup.md` + `docs/tmux.md` + `docs/windows.md` + `docs/termux.md` | `docs/guides/platform-setup.md` | 18 | missing |
| `examples/sdk/*.ts` (13 numbered examples) | `examples/sdk/` | 22 | missing |
| `examples/extensions/*.ts` (30+) | `examples/extensions/` | 14 | missing |

### 2.7 Test infrastructure

Clio locked "no vanity test suite" (§21). Pi-coding-agent ships 81 vitest files. The port stance:

- **Keep Clio's inline-verification model** (scripts/verify.ts, diag-*.ts).
- Port the **important correctness tests** from pi-coding-agent into `scripts/diag-*.ts` form:
  - `rpc-jsonl` → `scripts/diag-rpc-jsonl.ts` (Unicode boundaries, LF framing).
  - `skills` validation → `scripts/diag-skills.ts` (Agent Skills standard compliance).
  - `agent-session-branching` → `scripts/diag-session-branching.ts`.
  - `agent-session-compaction` → `scripts/diag-compaction.ts`.
  - `agent-session-concurrency` → `scripts/diag-concurrency.ts`.
  - `agent-session-retry` → `scripts/diag-retry.ts`.
  - `agent-session-dynamic-tools` → `scripts/diag-dynamic-tools.ts`.
  - `agent-session-auto-compaction-queue` → `scripts/diag-auto-compaction.ts`.
  - `extensions-discovery` → `scripts/diag-extensions-discovery.ts`.
  - `extensions-runner` → `scripts/diag-extensions-runner.ts`.
  - `extensions-input-events` → `scripts/diag-extensions-input.ts`.
  - `system-prompt` → `scripts/diag-system-prompt.ts`.
  - `settings-manager` → `scripts/diag-settings.ts`.
  - `auth-storage` → `scripts/diag-auth.ts`.
  - `print-mode` → `scripts/diag-print-mode.ts`.
  - `rpc-prompt-response-semantics` → `scripts/diag-rpc-semantics.ts`.

Each diag script: deterministic, exits 0 on success, non-zero on failure, runs under `npm run ci` in <30s.

---

## 3. New minor domains

The feature port introduces **2 new domains** beyond the 13 in §5 of the spec:

### 3.1 `resources` domain (Phase 13)

- **Owns:** skills, prompt templates, themes, context files (AGENTS.md/CLAUDE.md).
- **Depends on:** `config`, `providers` (for theme palette reference).
- **Exposes:** `ResourcesContract.skills()`, `.prompts()`, `.themes()`, `.contextFiles(cwd)`, `.reload()`.
- **Files:**
  ```
  src/domains/resources/
    manifest.ts index.ts extension.ts contract.ts
    loader.ts              # unified resource discovery (global + project + CLI paths)
    collision.ts           # priority resolution (CLI > project > user > package)
    context-files/
      loader.ts            # AGENTS.md + CLAUDE.md, system-prompt inject
      test-fixtures/
    skills/
      loader.ts validator.ts  # Agent Skills standard compliance
      invocation.ts        # <skill name="..." location="..."> parsing, prompt injection
    prompts/
      loader.ts substitute.ts # $1, $@, ${@:N:L}
    themes/
      engine.ts            # palette, hot-reload, custom theme files
      schema.json          # JSON Schema for theme files
  ```

### 3.2 `packages` domain (Phase 15)

- **Owns:** pi-package lifecycle (git/npm/local sources bundling skills + extensions + prompts + themes).
- **Depends on:** `config`, `resources`, `extensions`.
- **Exposes:** `PackagesContract.install()`, `.remove()`, `.update()`, `.list()`, `.config()`.
- **Files:**
  ```
  src/domains/packages/
    manifest.ts index.ts extension.ts contract.ts
    manager.ts             # install/remove/update orchestration
    registry.ts            # tracks installed sources in settings.yaml
    sources/
      git.ts               # git://, gist:, github:user/repo
      npm.ts               # npm package fetch via `npm view` (non-default registries ok)
      local.ts             # file:// or absolute path
    resolver.ts            # pi.{skills,extensions,prompts,themes} manifest parse
    progress.ts            # ProgressCallback events
  ```

### 3.3 `extensions` domain (Phase 14) — new **major** domain

The extensions system in pi-coding-agent is 2924 LOC of types + loader + runner. It warrants a full domain in Clio.

- **Owns:** extension discovery, loading, sandboxing, runtime lifecycle, custom command registry, custom tool registry, custom UI registration, event dispatch to extensions.
- **Depends on:** `config`, `resources`, `providers`, `session`, `modes`, `safety`, `prompts`, `agents`, `dispatch`.
- **Exposes:** `ExtensionsContract.list()`, `.reload()`, `.invokeCommand()`, `.runHook(event)`, `.registerFlag()`, `.registerTool()`.
- **Files:**
  ```
  src/domains/extensions/
    manifest.ts index.ts extension.ts contract.ts
    loader.ts              # TS/JS discovery, jiti-based load (runtime TypeScript)
    runner.ts              # lifecycle, hook dispatch, error routing
    sandbox.ts             # isolate extension failures from orchestrator
    types.ts               # 40+ public interfaces (events, UI context, tool defs)
    registry.ts            # command + tool + flag + shortcut registry
    ui-context.ts          # ExtensionUIContext wrapper over Clio TUI
    source-info.ts         # synthetic sourceInfo for programmatic extensions
    events/
      session.ts           # session_start, _end, _before_compact, _compact, _before_fork,
                           # _before_switch, _before_tree, _tree, _shutdown
      agent.ts             # agent_start, agent_end, before_agent_start, turn_start, turn_end
      tool.ts              # tool_call, tool_result (per-tool variants)
      provider.ts          # before_provider_request, after_provider_response
      user.ts              # input, context, user_bash
  ```

**Engine-boundary note:** extensions execute user code. They live in a separate subprocess only when marked `sandbox: true` (v0.2 work). In v0.1 they run in-process; any extension throwing unhandled errors routes through `ExtensionErrorListener` to the `/extensions` overlay and does not kill the orchestrator.

---

## 4. Phase plans (spine)

Each phase below is a one-page summary. When a phase is next in line, an engineer authors a detailed `2026-04-17-clio-phase-NN-<name>.md` plan from this spine. The spine is not itself executable without the per-phase plan.

### Phase 11 — TUI Selector Suite

**Depends on:** Phase 10 polish landed.

**Produces:**
- `src/interactive/overlays/{model-selector,scoped-models,thinking-selector,settings,session-selector,session-selector-search,message-picker}.ts`
- `src/cli/list-models.ts` (`clio --list-models [search]`)
- Slash commands: `/model`, `/scoped-models`, `/thinking`, `/settings`, `/resume`, `/new`, `/hotkeys` (partial, full version lands in Phase 18)
- Keybindings (hardcoded for now, user-config lands Phase 18):
  - `Ctrl+L` → open model selector
  - `Ctrl+P` / `Shift+Ctrl+P` → cycle scoped models forward/back
  - `Shift+Tab` (reassigned from mode-cycle) → cycle thinking level
  - `Alt+M` → cycle mode (repurposes old `Shift+Tab` binding)
- `src/domains/providers/resolver.ts` (glob, fuzzy, `:thinking` shorthand)

**Exit criteria:**
- `Ctrl+L` opens a scrollable SelectList of all available models grouped by provider, health dots, cost labels.
- `/scoped-models` opens a multi-select to pin the Ctrl+P cycle set; persists to `settings.yaml` under `provider.scope[]`.
- `/settings` opens a categorized SettingsList overlay (Provider, Safety, UI, Keybindings, Budget, Runtimes) that reads/writes settings.yaml atomically.
- `/resume` opens a session picker (fuzzy search by session ID / name / cwd).
- `diag-selectors.ts` script drives every overlay through open → nav → select → close and asserts state transitions.

**Inspired by:** `src/modes/interactive/components/{model-selector,scoped-models-selector,thinking-selector,settings-selector,session-selector,session-selector-search,user-message-selector}.ts`.

**Task count estimate:** ~95 tasks across 8 overlays + resolver + list-models.

---

### Phase 12 — Session Richness & Compaction

**Depends on:** Phase 11.

**Produces:**
- `src/domains/session/entries.ts` — SessionEntry union covering: message, bashExecution, custom, modelChange, thinkingLevelChange, fileEntry, branchSummary, compactionSummary, sessionInfo.
- `src/domains/session/migrations/` — version migration chain; current → `CURRENT_SESSION_VERSION = 2` (v0.1 baseline is v1).
- `src/domains/session/tree/{manager,navigator,fork}.ts` — tree operations (branch from any message, fork new session, switch branch).
- `src/domains/session/compaction/{compact,branch-summary,cut-point,tokens}.ts` — full compaction engine with:
  - `calculateContextTokens()` / `estimateTokens()`
  - `shouldCompact(contextTokens, threshold)` trigger check
  - `findCutPoint()` — picks safe cut preserving tool-call/result pairs
  - `findTurnStartIndex()` — turn boundary discovery
  - `collectEntriesForBranchSummary()` / `prepareBranchEntries()` / `generateBranchSummary()` — branch summary generation
  - `serializeConversation()` — for summary prompt
  - `generateSummary()` — calls a dedicated compaction model
  - `compact()` — full operation orchestrating the above
  - `getLastAssistantUsage()` — extract usage from last assistant message
  - `DEFAULT_COMPACTION_SETTINGS`
  - Context-overflow recovery (automatic retry on provider context-overflow error)
- `src/domains/session/cwd-fallback.ts` — when resumed session's cwd no longer exists, prompt user to continue in current cwd.
- `src/interactive/overlays/tree-selector.ts` — `/tree` navigator (1239 LOC reference), `Shift+T` toggle timestamps, label editing, delete session with/without files, fold/unfold.
- `src/interactive/renderers/{branch-summary,compaction-summary}.ts`.
- Slash commands: `/compact [instructions]`, `/fork`, `/tree`.
- Keybinding `Alt+T` → open tree.

**Exit criteria:**
- `CompactionSettings` (threshold%, auto, model, system prompt) read from `settings.yaml`.
- `/compact` streams a compaction summary and persists it as `compactionSummary` entry; messages before cut-point removed from live context, still in JSONL.
- Auto-compaction fires when `shouldCompact(tokens, threshold)` → `compact()` → live without user intervention.
- Overflow recovery: on first context-overflow error, compact automatically and retry once; on second, report error.
- `/fork` at any prior message creates a new session with its own `sessionId`, `parentSessionId`, `parentTurnId`.
- `/tree` opens navigator; selecting a branch calls `runtime.switchSession(branch.sessionId)` — rebuilds services if cwd differs.
- `diag-compaction.ts` verifies cut-point preserves tool-call/result pairs and branch summary prompt is deterministic per fixture.

**Inspired by:** `core/compaction/*.ts`, `core/session-manager.ts`, `core/messages.ts`, `components/tree-selector.ts`.

**Task count estimate:** ~140 tasks (largest port phase; isolate across 4 detailed plan files if needed).

---

### Phase 13 — Resources: Skills, Prompts, Themes, Context Files

**Depends on:** Phase 12 (session entries land; `custom` + `skillInvocation` types needed).

**Produces:**
- New `resources` domain (§3.1).
- `src/domains/resources/skills/{loader,validator,invocation}.ts`:
  - Agent Skills standard: `SKILL.md` at top of skill dir with YAML frontmatter (`name`, `description`, `disable-model-invocation`?).
  - Validation rules: name ≤64 chars, description ≤1024 chars, matches parent dir, no collisions.
  - Discovery: package skills < user skills (`~/.config/clio/skills/`) < project skills (`.clio/skills/`) < CLI `--skill` paths.
  - `<skill name="..." location="...">...</skill>` parsing in user messages → inject skill body into system prompt.
- `src/domains/resources/prompts/{loader,substitute}.ts`:
  - Template files at `~/.config/clio/prompts/<name>.md` with optional frontmatter.
  - `$1`, `$2`, ..., `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}` substitution (bash-style).
  - Slash invocation: `/templateName arg1 "arg 2" arg3` expands to template body.
- `src/domains/resources/themes/engine.ts` + `assets/themes/{default,dark,light}.json`:
  - Palette schema: `bg`, `fg`, `primary`, `accent`, `muted`, `success`, `warning`, `error`, `info`, `border`, `selection`.
  - Per-component overrides (editor, chat, footer, overlay, dispatch-board).
  - Hot-reload: `fs.watch` on theme file changes → emit `theme.changed` bus event → TUI repaints.
  - Custom themes in `~/.config/clio/themes/<name>.json` and `.clio/themes/<name>.json`.
- `src/domains/resources/context-files/loader.ts`:
  - Walk up from cwd, collect `AGENTS.md` + `CLAUDE.md` (in that order), concat with separators.
  - Exported as `loadProjectContextFiles(cwd)` for extensions/SDK per pi-coding-agent 0.67.4.
  - `--no-context-files` / `-nc` flag disables discovery.
- Slash commands: `/theme`, `/skills`, `/prompts`.
- `src/interactive/renderers/skill-invocation.ts`.

**Exit criteria:**
- Resources discovered and listed in `/skills`, `/prompts`, `/theme` overlays.
- Collision priority respected (CLI > project > user > package).
- Context files injected into compiled prompt under a `project-context/dynamic.md` fragment.
- `/theme <name>` switches theme live; settings.yaml updates.
- Skill invocation in user message triggers body inclusion; skill rendered as `SkillInvocationMessage` in chat.
- `diag-skills.ts` validates all fixtures from pi-coding-agent's `test/fixtures/skills/` namespace.

**Inspired by:** `core/skills.ts`, `core/prompt-templates.ts`, `core/resource-loader.ts`, `modes/interactive/theme/theme.ts`, `docs/{skills,prompt-templates,themes}.md`.

**Task count estimate:** ~110 tasks.

---

### Phase 14 — Extensions System

**Depends on:** Phase 13 (resources; extensions ship bundled skills/prompts/themes too).

**Produces:**
- New `extensions` major domain (§3.3).
- Event definitions (40+) with discriminated unions.
- UI context wrapper: `ExtensionUIContext` maps to Clio TUI primitives; RPC mode gets limited variant (no custom editors / setWidget factory / setFooter / setHeader / setEditorComponent).
- CLI flag registration: unknown `--flags` route to `ExtensionFlag[]` registry, shown in `--help` under "Extension CLI Flags".
- Custom tool registration via `defineTool()` (typebox schema + handler), merged into `ToolRegistry` subject to current mode's admission.
- Custom shortcut registration.
- `MessageRenderer` interface for custom message types.
- `after_provider_response` hook lets extensions inspect provider HTTP status + headers before stream consumption.
- `session_start` unified event with `reason: "startup" | "reload" | "new" | "resume" | "fork"` and optional `previousSessionFile`.
- Extensions shipped inline via `main(args, { extensionFactories })` for embedded integrations.
- `src/interactive/overlays/{extension-selector,extension-editor,extension-input}.ts`.
- Slash command `/reload` reloads keybindings, extensions, skills, prompts, themes without restart.

**Exit criteria:**
- Extension loaded from `--extension` path; registers a command, a flag, and a tool; invoked via slash command and CLI flag.
- `session_start` fires with correct `reason` for each entry path.
- Extension error surfaces in overlay; does not kill orchestrator.
- `discoverAndLoadExtensions()` returns collisions + errors as diagnostics (not throws).
- `diag-extensions-*.ts` scripts mirror pi-coding-agent's extension tests.
- Ported examples under `examples/extensions/` include: `permission-gate.ts`, `todo.ts`, `status-line.ts`, `custom-footer.ts`, `timed-confirm.ts`, `custom-compaction.ts`, `provider-payload.ts`, `subagent.ts`, `sandbox.ts`, `file-trigger.ts`, `input-transform.ts`, `widget-placement.ts`, `trigger-compact.ts`, `auto-commit-on-exit.ts`, `session-name.ts`.

**Inspired by:** `core/extensions/{types,loader,runner,wrapper,index}.ts`, `examples/extensions/*.ts`, `docs/extensions.md`.

**Task count estimate:** ~180 tasks (split across 3–4 detailed plan files).

---

### Phase 15 — Package Manager

**Depends on:** Phase 14.

**Produces:**
- New `packages` domain (§3.2).
- `src/cli/packages.ts` subcommands: `install`, `remove`, `uninstall` (alias), `update`, `list`, `config`.
- Source types: `git:<url>`, `gist:<id>`, `github:<user>/<repo>`, `npm:<name>[@version]`, `file:<path>`, `local:<path>` (`-l` flag).
- `pi.{skills,extensions,prompts,themes}` manifest field in `package.json` lists bundled resources; loader picks them up from the installed package.
- Progress callback emits events to TUI during clone/npm install/extract.
- Update check: `npm view <name> version` for non-default registries (fixes bug from pi-coding-agent 0.67.1).
- Installed sources persist in `settings.yaml` under `packages.sources[]` with version pin option.
- `clio config` → package-config overlay (`src/interactive/overlays/package-config.ts`): enable/disable individual resources from installed packages.
- Slash command `/packages`.

**Exit criteria:**
- `clio install git:github.com/user/pi-ext` installs → resources show up in `/skills`, `/extensions`, `/prompts`, `/theme`.
- `clio update` respects `pin: true` in settings.
- Removal tears down resources and reloads runtime.
- `diag-packages.ts` exercises install + reload + remove on a local fixture package.

**Inspired by:** `core/package-manager.ts`, `src/package-manager-cli.ts`, `docs/packages.md`.

**Task count estimate:** ~85 tasks.

---

### Phase 16 — RPC + Print + JSON modes

**Depends on:** Phase 12 (session state machine must be stable for RPC `get_state`).

**Produces:**
- `src/cli/modes/print.ts` — headless single-shot text or JSON output.
- `src/cli/modes/rpc.ts` — JSONL server (LF-only framing) with 36+ command handlers.
- `src/cli/modes/jsonl.ts` — strict LF framing, UTF-8 boundary safe.
- `src/sdk/rpc-client.ts` — typed Node client (auto-discovers `dist/cli/index.js`, correlates by UUID).
- `src/sdk/rpc-types.ts` — command + response + event type unions.
- `src/cli/output-guard.ts` — stdout takeover for non-interactive modes.
- `src/cli/file-processor.ts` — `@file` argument handling with image auto-resize (replace photon with sharp or no-op fallback).
- `src/cli/initial-message.ts` — merges argv + @file + stdin into first message.

**RPC command surface** (brand-renamed from pi-coding-agent):

| Command | Purpose |
|---|---|
| `prompt` | Send user message with optional images, streamingBehavior. Preflight returns success/fail. |
| `steer` | Interrupt current stream with new user message. |
| `follow_up` | Queue message after current stream finishes. |
| `abort` | Cancel current stream. |
| `new_session` | Start a new session (optional parent). |
| `get_state` | Full session snapshot (model, thinking, streaming flags, message count, etc.). |
| `set_model` / `cycle_model` / `get_available_models` | Model management. |
| `set_thinking_level` / `cycle_thinking_level` | Thinking level. |
| `set_steering_mode` / `set_follow_up_mode` | Queue behavior. |
| `compact` / `set_auto_compaction` | Compaction. |
| `set_auto_retry` / `abort_retry` | Retry behavior. |
| `bash` / `abort_bash` | Shell exec. |
| `get_session_stats` / `export_html` / `switch_session` / `fork` / `get_fork_messages` / `get_last_assistant_text` / `set_session_name` / `get_messages` / `get_commands` | Session ops. |

**Extension UI subset in RPC mode:** `select`, `confirm`, `input`, `notify`, `setStatus`, `setTitle`, `setEditorText`, `editor`, `theme` (read-only), `getToolsExpanded`.

**Exit criteria:**
- `clio -p "hello"` prints final assistant response, exit code 0.
- `clio --mode json -p "hello"` streams JSONL events (session header + deltas + final).
- `clio --mode rpc` accepts JSONL commands on stdin, emits JSONL responses on stdout.
- Piped stdin merges into initial message except in RPC mode.
- `RpcClient` example roundtrips 10 commands correctly.
- `diag-rpc-jsonl.ts` verifies Unicode line-splitting edge cases.
- `diag-print-mode.ts` verifies piped stdin + JSON output + error exit codes.

**Inspired by:** `modes/{print-mode,rpc/rpc-mode,rpc/rpc-client,rpc/rpc-types,rpc/jsonl}.ts`, `docs/{rpc,json}.md`.

**Task count estimate:** ~130 tasks.

---

### Phase 17 — Auth & OAuth

**Depends on:** Phase 11 (login dialog overlay).

**Produces:**
- `src/domains/providers/auth/{storage,oauth,api-key,backend-file,backend-memory}.ts`.
- OAuth flows for Anthropic (subscription auth), OpenAI Codex, Google (Vertex ADC), AWS Bedrock (profile, access key, bearer token).
- `AuthStorage` is pluggable: `FileAuthStorageBackend` (default, `<configDir>/credentials.yaml` mode 0600) and `InMemoryAuthStorageBackend` (for SDK embedding).
- `src/interactive/overlays/{login-dialog,oauth-selector}.ts`.
- Slash commands: `/login`, `/logout`.
- Env var resolution order: `{PROVIDER}_API_KEY`, `{PROVIDER}_OAUTH_TOKEN`, then `credentials.yaml`, then OS keychain (post-1.0).
- Subscription-auth warning is replaced with a neutral "auth source" label in footer.
- Azure OpenAI env support (`AZURE_OPENAI_*`), AWS_REGION, AWS_PROFILE, all variants.
- Runtime API key injection for `--api-key <key>` flag, scoped to current session's model.

**Exit criteria:**
- `clio` with missing keys prompts `/login`; completing OAuth writes credentials and proceeds.
- `/logout` clears stored auth for selected provider.
- `diag-auth.ts` exercises file + memory backends and env-var resolution.

**Inspired by:** `core/auth-storage.ts`, `components/{login-dialog,oauth-selector}.ts`, `docs/providers.md`.

**Task count estimate:** ~80 tasks.

---

### Phase 18 — Keybindings (user-configurable)

**Depends on:** Phase 17 (all overlays in place; keybindings must reach every surface).

**Produces:**
- `src/domains/config/keybindings.ts` — `AppKeybindings` schema (27 keybindings from pi-coding-agent's `core/keybindings.ts`), plus pi-tui's TUI keybindings.
- `src/interactive/keybinding-manager.ts` — wraps pi-tui's `KeybindingsManager`; merges TUI defaults + app defaults + user overrides from `settings.yaml` under `keybindings.<id>: <key>`.
- Slash command `/hotkeys` — opens read-only overlay showing current key ↔ action map, grouped by section.
- Platform-specific handling: Kitty super-modified (`super+k`, `super+enter`), Zellij (xterm `modifyOtherKeys` mode 2), tmux (Ctrl+Alt letters via CSI-u fallback), Windows (no Ctrl+Z suspend).
- Settings overlay surfaces keybindings editor section.
- `docs/reference/keybindings.md`, `docs/guides/platform-setup.md`.

**Default keybindings** (after Phase 18):

| Keybinding ID | Default key | Action |
|---|---|---|
| `app.interrupt` | `escape` | Cancel or abort |
| `app.clear` | `ctrl+c` | Clear editor |
| `app.exit` | `ctrl+d` | Exit when editor empty |
| `app.suspend` | `ctrl+z` (non-Win) | Suspend to background |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.model.cycleForward` | `ctrl+p` | Cycle scoped models forward |
| `app.model.cycleBackward` | `shift+ctrl+p` | Cycle scoped models back |
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.tools.expand` | `ctrl+o` | Toggle tool output |
| `app.thinking.toggle` | `ctrl+t` | Toggle thinking blocks |
| `app.session.toggleNamedFilter` | `ctrl+n` | Toggle named session filter |
| `app.editor.external` | `ctrl+g` | Open external editor |
| `app.message.followUp` | `alt+enter` | Queue follow-up message |
| `app.message.dequeue` | `alt+up` | Restore queued messages |
| `app.clipboard.pasteImage` | `ctrl+v` (non-Win) | Paste image |
| `app.session.new` | unbound | Start new session |
| `app.session.tree` | `alt+t` | Open session tree |
| `app.session.fork` | unbound | Fork current session |
| `app.session.resume` | unbound | Resume a session |
| `app.tree.foldOrUp` | `left`/`h` | Collapse / up |
| `app.tree.unfoldOrDown` | `right`/`l` | Expand / down |
| `app.tree.editLabel` | `e` | Edit node label |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Toggle timestamps |
| `app.session.togglePath` | `p` | Toggle cwd display |
| `app.session.toggleSort` | `s` | Sort order |
| `app.session.rename` | `r` | Rename session |
| `app.session.delete` | `d` | Delete session + files |
| `app.session.deleteNoninvasive` | `shift+d` | Delete session, keep files |
| `clio.mode.cycle` (new, replaces old Shift+Tab) | `alt+m` | Cycle default⇄advise |
| `clio.mode.super` | `alt+s` | Enter super (confirmation) |
| `clio.overlay.dispatchBoard` | `ctrl+b` | Toggle dispatch board |

**Exit criteria:**
- Settings overlay rebinds `app.thinking.cycle` to `alt+e` and the change takes effect next keystroke.
- `/hotkeys` lists every binding with current key.
- `diag-keybindings.ts` asserts resolver collapses conflicts with clear precedence (user > project > defaults).

**Inspired by:** `core/keybindings.ts`, `docs/keybindings.md`.

**Task count estimate:** ~70 tasks.

---

### Phase 19 — Rich Components

**Depends on:** Phase 13 (theme engine active).

**Produces:**
- `src/interactive/footer-panel.ts` — git branch (utils/git.ts helper) + extension status slots + provider/model + cost + session tokens.
- `src/interactive/renderers/{tool-execution,assistant-message,user-message,diff,bash-execution}.ts` — per-type rendering with tool renderers supporting `renderShell: "self"` for self-rendered bodies (stable edit diffs during permission dialogs, per 0.67.3).
- `src/interactive/components/{bordered-loader,dynamic-border,visual-truncate,countdown-timer}.ts`.
- `src/tools/edit-diff.ts` — `RenderDiffOptions`, `renderDiff()` with syntax highlighting via `cli-highlight`.
- Replace ad-hoc stdout lines with component-based render tree across chat panel.
- `ctrl+o` toggles tool output expansion.
- `ctrl+t` toggles thinking block visibility.

**Exit criteria:**
- Edit tool preview shows colored diff; stays stable while permission overlay open.
- Bash tool execution shows command header, live output, exit code, truncation marker, "full output: <path>" link.
- Auto-retry shows live countdown (from Phase 22 but components land here).
- `diag-renderers.ts` drives each renderer with fixture inputs and asserts output lines.

**Inspired by:** `components/{tool-execution,assistant-message,user-message,bash-execution,diff,bordered-loader,dynamic-border,visual-truncate,countdown-timer,footer}.ts`, `core/tools/edit-diff.ts`.

**Task count estimate:** ~110 tasks.

---

### Phase 20 — Input Polish

**Depends on:** Phase 19.

**Produces:**
- Editor panel enhancements:
  - `/command` routing (handled by slash-router).
  - `!command` executes via `createLocalBashOperations()` and inserts `BashExecutionMessage`.
  - `!!command` marks `excludeFromContext: true` (excluded from LLM).
  - `@file` and `@image` at cursor drops content into message; images auto-resize.
  - `ctrl+g` opens $EDITOR, returns edited content into editor buffer.
  - Paste-image from clipboard (ctrl+v on Linux/mac, alt+v on Windows). Clipboard-image → PNG via OS-native utility; PNG → resized via `sharp` (or pass-through if too large and `photon` unavailable).
  - Alt+Enter queues a follow-up message during streaming.
  - Alt+Up restores last dequeued message into editor.
  - Sticky-column cursor tracking around paste markers (0.67.1 fix).
- `src/utils/{clipboard,clipboard-image,image-convert,image-resize,exif-orientation,photon}.ts` (photon is optional; fall back gracefully).
- Tool execution: bash child-process tracking. SIGTERM/SIGHUP kills tracked children (0.67.4 fix).
- Editor external editor respects `$VISUAL`, `$EDITOR`, then `nano`/`vi` probe.

**Exit criteria:**
- `!pwd` runs bash; output appears in chat; included in next LLM turn.
- `!!git status` runs but is excluded from LLM context.
- `@README.md` attaches file content to message.
- Clipboard paste of an image attaches resized PNG to message.
- `ctrl+g` round-trips edited text via $EDITOR.
- Ctrl+C during a long bash tool kills child; orchestrator remains alive.
- `diag-editor-input.ts` drives every input combo.

**Inspired by:** `components/custom-editor.ts`, `utils/{clipboard,clipboard-image,image-convert,image-resize,exif-orientation,photon,child-process}.ts`, `core/tools/bash.ts`.

**Task count estimate:** ~95 tasks.

---

### Phase 21 — Export / Import / Share

**Depends on:** Phase 19 (renderers for HTML export), Phase 12 (session format stable), Phase 14 (extensions can subscribe to session events).

**Produces:**
- `src/domains/session/export-html/{index,ansi-to-html,tool-renderer}.ts` + shipped template assets under `assets/export-html/{template.html,template.css,template.js,vendor/*}`.
- `src/cli/export.ts` — `clio --export <session.jsonl> [out.html]`.
- `src/cli/import.ts` — `clio import <session.jsonl>` copies session into user's sessions dir and re-keys IDs if needed.
- `src/domains/session/share.ts` — upload JSONL to a secret GitHub Gist via `gh` CLI (no API key), return viewer URL (`CLIO_SHARE_VIEWER_URL` env, default `about:blank` in v0.1).
- Slash commands: `/export [path]`, `/import`, `/share`, `/copy` (copies last assistant text to system clipboard), `/name <name>` (sets session display name), `/changelog` (reads shipped CHANGELOG.md, shows new entries since `lastChangelogVersion`).

**Exit criteria:**
- `/export` produces a self-contained HTML file with styled chat, syntax-highlighted code, collapsible tool outputs, inline images.
- `/import foo.jsonl` copies session, opens it.
- `/share` outputs a gist URL (or "no `gh` CLI available" message in v0.1).
- `/copy` writes last assistant message to clipboard.
- `diag-export-html.ts` exports a fixture session and verifies HTML structure with cheerio-style assertions.

**Inspired by:** `core/export-html/`, slash commands in `core/slash-commands.ts`, `docs/session.md`.

**Task count estimate:** ~75 tasks.

---

### Phase 22 — Retry, Diagnostics, Telemetry, Final Polish

**Depends on:** Phase 21.

**Produces:**
- `src/domains/session/retry.ts` — `RetrySettings` (enabled, maxAttempts, baseDelayMs, maxDelayMs), live countdown via `countdown-timer`, abort via `/abort-retry`.
- `src/core/diagnostics.ts` — structured `{type: "info"|"warning"|"error", message, context?}` returned from every boot step; reported to TUI footer briefly + logged to `<agentDir>/clio-debug.log`.
- `src/domains/lifecycle/telemetry.ts` — opt-out anonymous install-ping per pi-coding-agent 0.67.1 model: `https://clio.iowarp.org/install?version=x.y.z`, fire-and-forget, disabled by `CLIO_OFFLINE`, `CLIO_TELEMETRY=0`, `settings.telemetry.enableInstallTelemetry=false`.
- Settings: `quietStartup`, `clearOnShrink`, `showHardwareCursor`, `imageAutoResize`.
- `CLIO_STARTUP_BENCHMARK` env — measures boot timing, prints to stderr, exits 0 (does not enter interactive loop).
- `PI_CODING_AGENT` env compat — when `CLIO_RUNNING=true`, also set `PI_CODING_AGENT=true` so subprocess adapters that look for it still work (only in CLI-adapter code paths).
- Session-cwd fallback overlay from Phase 12 refined; shows "continue in current cwd / cancel" for missing-cwd sessions.
- `clio install`, `clio upgrade`, `clio doctor` fully populated diagnostic panels (Node version, platform, provider health, XDG paths, installed packages, extensions, skills, prompts, themes, keybindings conflicts, telemetry state).
- Final README pass: usage, commands, keybindings, config reference.
- Final `CHANGELOG.md` entry for 0.2.0 with full feature list.

**Exit criteria:**
- `diag-retry.ts` triggers a transient provider error twice then success; counts attempts, verifies backoff bounds.
- `/doctor` shows all diagnostics categorized; CI-green on ubuntu + macos.
- Telemetry URL fires once after fresh install (captured by local mitm in diag), never fires in print/json/rpc modes, never fires with `CLIO_OFFLINE=1`.
- Full v0.2.0-rc1 builds; `scripts/verify.ts` passes end-to-end; `scripts/stress.ts` runs 10 concurrent workers with compaction triggering and shutdown is clean.

**Inspired by:** `core/{diagnostics,session-cwd,bash-executor}.ts`, `migrations.ts`, `src/main.ts` startup path, 0.67.1 telemetry notes, `docs/settings.md`.

**Task count estimate:** ~100 tasks.

---

## 5. Dependency and deferred work

### 5.1 New npm dependencies introduced by the port

| Dependency | Purpose | Phase | Pin |
|---|---|---|---|
| `@mariozechner/jiti` | Runtime TypeScript extension loading | 14 | `^2.6.2` |
| `ajv` | Schema validation for themes/settings | 13, 18 | `^8.17.1` |
| `cli-highlight` | Syntax-highlighted code in diffs/messages | 19 | `^2.1.11` |
| `diff` | Edit-tool diff preview | 19 | `^8.0.2` |
| `extract-zip` | Unpack npm/git-fetched packages | 15 | `^2.0.1` |
| `file-type` | Mime sniff for `@file` attachments | 20 | `^21.1.1` |
| `glob` | Glob matching (may already be in deps tree) | 13, 15 | `^13.0.1` |
| `hosted-git-info` | Parse `github:user/repo`, `gist:id` sources | 15 | `^9.0.2` |
| `ignore` | `.gitignore`-aware find | 13, 19 | `^7.0.5` |
| `marked` | Markdown → HTML for export + changelog viewer | 21 | `^15.0.12` |
| `minimatch` | Settings pattern matching | 15, 18 | `^10.2.3` |
| `proper-lockfile` | Atomic settings + session writes | 12, 22 | `^4.1.2` |
| `strip-ansi` | RPC + print JSON output cleanup | 16 | `^7.1.0` |
| `uuid` | New session IDs, run IDs (v7 for time locality) | 12 | `^11.1.0` |
| `sharp` **or fallback** | Image resize for clipboard paste | 20 | `^0.33.x` — optional; fallback is attach-by-path |

**Not added:** `@mariozechner/clipboard`, `@silvia-odwyer/photon-node` (native addons, license/complexity risk). Use platform clipboard CLIs (`xclip`, `wl-paste`, `pbpaste`, PowerShell) and `sharp`.

### 5.2 Deferred past v0.2

- Bun binary distribution (`build:binary` equivalent).
- Full extension sandbox subprocess (extensions run in-process in v0.2; sandbox via V8 isolates in v0.3+).
- Remote/sandbox tool operations (pi-coding-agent's `BashOperations`/`EditOperations`/etc. abstractions — skeleton in place for Phase 14, remote impl in v0.3+).
- OS keychain for credentials (file-backed in v0.2).
- Session sharing backend hosted at clio.iowarp.org (v0.3+).
- Full MCP integration (Clio's dispatch primitives cover the same need; MCP adapter optional in v0.3+).
- Extension marketplace / skill packs registry (v1.0+).
- Theme-live-edit in settings overlay (read-only file import in v0.2).

### 5.3 Maintained deviations from pi-coding-agent

- **Three modes (default/advise/super)** vs. pi-coding-agent's flat toolset. Port respects Clio's mode admission gate — extension-registered tools enter visibility only via mode matrix updates.
- **TUI-first config, no LLM-callable config tools.** pi-coding-agent allows extensions to write settings; Clio forbids it structurally. Extensions requesting `write settings` get a rejection with TUI-guided alternative.
- **Dispatch-first architecture.** pi-coding-agent's single-agent loop is one worker type in Clio (the "chat" native worker). Sub-agent dispatch, chains, batches remain Clio's primary orchestration.
- **Identity: Clio brand.** No "pi" leakage. Easter eggs (Armin/Daxnuts/Earendil) not ported.
- **SHA-256 prompt hashes in every audit + receipt.** pi-coding-agent's system-prompt is opaque; Clio's receipts carry deterministic reproducibility.

---

## 6. Verification strategy (port-wide)

Every phase adds at least one `scripts/diag-<area>.ts` script. The full `npm run ci` chain grows to include them, gated by a new umbrella target:

```
npm run ci:port  ← runs every diag-<phase>-<area>.ts added by this port
```

A dedicated `scripts/port-coverage.ts` reads this plan's §2 feature map, cross-references `src/` for destination files, and fails CI if a destination file promised by an "exit criteria" is missing. This prevents plan decay.

---

## 7. Total estimated task count

| Phase | Tasks | Cumulative |
|---|---|---|
| 11 Selectors | 95 | 95 |
| 12 Session & Compaction | 140 | 235 |
| 13 Resources | 110 | 345 |
| 14 Extensions | 180 | 525 |
| 15 Packages | 85 | 610 |
| 16 RPC/Print/JSON | 130 | 740 |
| 17 Auth/OAuth | 80 | 820 |
| 18 Keybindings | 70 | 890 |
| 19 Rich Components | 110 | 1000 |
| 20 Input Polish | 95 | 1095 |
| 21 Export/Import/Share | 75 | 1170 |
| 22 Retry/Diag/Telemetry/Polish | 100 | 1270 |

**≈1,270 bite-sized tasks** across 12 port phases. Each phase yields a dedicated detailed plan file at phase start. This spine is the contract: if a feature listed in §2 is not present in the target file after its phase lands, the phase is incomplete.

---

## 8. Execution handoff

This plan is **the spine**. It does not itself execute. Two execution options for any given phase:

**1. Subagent-Driven (recommended for Phases 12, 14, 16, 19)** — I dispatch a fresh subagent per detailed-plan task, review between tasks, fast iteration.

**2. Inline Execution (recommended for Phases 11, 13, 15, 17, 18, 20, 21, 22)** — Execute tasks in-session using `superpowers:executing-plans`, batch execution with checkpoints.

Before any phase starts, an engineer writes the detailed `2026-04-17-clio-phase-NN-<name>.md` plan from this spine plus the §2 feature map. Once that plan exists and passes self-review per `superpowers:writing-plans`, execution begins.

**Next action after this spine is accepted:** author `2026-04-17-clio-phase-11-selectors.md` in detail and begin Phase 11.
