# Pi-Coding-Agent Parity — Current State vs Port Plan

- **Status:** Living audit. Refresh whenever a port-phase task completes.
- **Baseline:** commit `5300d82` on branch `chore/pi-mono-0.68.1`, 2026-04-22, pi-mono pinned to `0.68.1`.
- **Source of truth for what "parity" means:** [`docs/superpowers/plans/2026-04-17-pi-coding-agent-port.md`](../superpowers/plans/2026-04-17-pi-coding-agent-port.md) (the spine; §2 is the IP-to-destination map, §4 is the per-phase scope).
- **Purpose:** supersede the stale `Status` column in the spine. The spine is the contract; this doc is the ledger.

## How to read this

| Marker | Meaning |
|---|---|
| ✅ present | Implemented with sufficient depth that the spine's feature description is satisfied. |
| 🟡 partial | File exists but functionality is skeletal, missing key behavior, or diverges architecturally. |
| ❌ missing | No file on disk; feature is not implemented. |
| ➕ beyond-plan | Landed in Clio but not a pi-coding-agent feature (mostly from the post-plan provider rebuild and the new test layer). |

Percentages per phase are file-count based (present + partial×0.5) / total. They track scope coverage, not code quality.

## Executive summary

| Phase | Area | Status | Coverage |
|---|---|---|---|
| 11 | TUI Selector Suite | In progress | **65%** — 6/8 overlays landed, resolver + list-models partial |
| 12 | Session Richness & Compaction | Mostly done | **75%** — entries, tree, fork, compaction, cwd-fallback present; retry + HTML export + share missing |
| 13 | Resources (skills, prompts, themes, context files) | Not started | **0%** — `src/domains/resources/` does not exist |
| 14 | Extensions System | Not started | **0%** — `src/domains/extensions/` does not exist |
| 15 | Package Manager | Not started | **0%** — `src/domains/packages/` does not exist |
| 16 | RPC + Print + JSON modes | Not started | **0%** — no `src/cli/modes/`, no SDK barrel |
| 17 | Auth & OAuth | Early | **30%** — `credentials.ts` is production-grade but monolithic; OAuth flows, resolver, login dialog missing |
| 18 | Keybindings (user-configurable) | Not started | **~10%** — 9 keybindings hardcoded in `src/interactive/index.ts`; no manager, no schema, no user overrides |
| 19 | Rich Components | Not started | **~5%** — only `renderers/compaction-summary.ts` exists; no diff, no bash-execution, no tool-execution renderer |
| 20 | Input Polish | Not started | **0%** — editor is basic; no `!`/`@` syntax, no paste-image, no `$EDITOR` round-trip |
| 21 | Export / Import / Share | Not started | **0%** — no export-html renderer, no share, no import |
| 22 | Retry, Diagnostics, Telemetry, Final Polish | Not started | **~5%** — basic in-memory telemetry counters only |

**Overall port completion (all 12 phases, file-count weighted): roughly 20%.** The session/compaction subsystem and the TUI selector suite carry most of the signal; every other port phase is essentially unstarted.

## Structural deltas from the plan baseline (v0.1.0-rc1 @ `ab37e13` → current)

Sessions since the spine was written moved Clio forward in ways that touch parity math but are not part of the pi-coding-agent port:

- ➕ **Provider subsystem rebuild** (`src/domains/providers/`, 37 runtime files). Mature subprocess + cloud + local runtime descriptors, a capabilities gate, knowledge-base YAMLs for 9 model families, a native LM Studio ApiProvider, an Ollama-native ApiProvider, llama.cpp advanced descriptors. This is deeper than the `model-registry` + `model-resolver` the plan calls for but does not fulfill the `providers/resolver.ts` glob/fuzzy/`:thinking` shorthand.
- ➕ **Endpoints contract** (`settings.yaml` `endpoints[]` collapsed from the earlier provider/providers/runtimes namespaces). Dispatch, worker-runtime, TUI overlays, chat-loop, footer, receipts, and all CLI commands were rewritten to consume it.
- ➕ **New test layer** (`tests/{unit,integration,boundaries,e2e}` replacing `scripts/diag-*.ts` theater). 235 tests + 21 e2e tests, plus `tests/harness/{spawn,pty}.ts` for driving the TUI. The spine's `scripts/diag-<area>.ts` pattern is superseded — that guidance is now **obsolete** (see `tests/boundaries/check-boundaries.ts` for the enforcement direction).
- ➕ **pi-mono boundary audit** refreshed to `0.68.1` (`docs/architecture/pi-mono-boundary-0.68.1.md`).

When the next port phase starts, these structural deltas matter: Phase 16 RPC work should assume the endpoints contract, not the legacy provider/model pair; Phase 14 extension tests should land under `tests/`, not as diag scripts.

## Per-phase parity ledger

### Phase 11 — TUI Selector Suite — 65%

| Plan item | Expected path | Status | Evidence |
|---|---|---|---|
| Model selector overlay | `src/interactive/overlays/model-selector.ts` | ✅ | 170 LOC; health glyph, endpoint/model filter; `Ctrl+L` wired |
| Scoped-models overlay | `src/interactive/overlays/scoped-models.ts` | ✅ | 126 LOC; checkbox list; `Ctrl+P`/`Shift+Ctrl+P` wired |
| Thinking selector | `src/interactive/overlays/thinking-selector.ts` | ✅ | 95 LOC; cycle/toggle; `Shift+Tab` wired |
| Settings overlay | `src/interactive/overlays/settings.ts` | ✅ | 163 LOC; categorized sections |
| Session selector (`/resume`) | `src/interactive/overlays/session-selector.ts` | ✅ | 77 LOC; cwd/model/endpoint rendering |
| Session-selector fuzzy search | `src/interactive/overlays/session-selector-search.ts` | ❌ | File absent; SelectList may filter internally but dedicated fuzzy picker missing |
| Message picker (fork source) | `src/interactive/overlays/message-picker.ts` | ✅ | 139 LOC; assistant turns, most-recent first |
| Hotkeys overlay (preview) | `src/interactive/overlays/hotkeys.ts` | ✅ | Read-only key↔action map |
| `clio --list-models [search]` | `src/cli/list-models.ts` | 🟡 | 110 LOC; supports `--json`, `--probe`, `--endpoint` filter; plan-defined `search` positional missing |
| Provider resolver (glob, fuzzy, `:thinking`) | `src/domains/providers/resolver.ts` | ❌ | No resolver module; endpoint resolution lives in dispatch/providers extension, keyed by id |

### Phase 12 — Session Richness & Compaction — 75%

| Plan item | Expected path | Status | Evidence |
|---|---|---|---|
| Session entry union | `src/domains/session/entries.ts` | ✅ | 165 LOC; all 9 entry kinds |
| Session migrations | `src/domains/session/migrations/` | ✅ | `v1-to-v2.ts` + `index.ts`; `CURRENT_SESSION_FORMAT_VERSION = 2` |
| Tree manager | `src/domains/session/tree/manager.ts` | ✅ | 148 LOC; label map, `readTreeBundle` |
| Tree navigator | `src/domains/session/tree/navigator.ts` | ✅ | 139 LOC; leaf tracking, snapshots |
| Fork operation | `src/domains/session/tree/fork.ts` | ✅ | 50 LOC; `forkFromState`, parent-pointer enrichment |
| Compaction orchestrator | `src/domains/session/compaction/compact.ts` | ✅ | 217 LOC; CUT_POINT + SUMMARY flow |
| Branch summary | `src/domains/session/compaction/branch-summary.ts` | ✅ | 147 LOC; `serializeConversation`, 2000-char tool-result truncation |
| Cut-point picker | `src/domains/session/compaction/cut-point.ts` | ✅ | 143 LOC; tool_result guard preserved |
| Token estimation | `src/domains/session/compaction/tokens.ts` | ✅ | 179 LOC; `getLastAssistantUsage` helper |
| Missing-cwd fallback | `src/domains/session/cwd-fallback.ts` | ✅ | 66 LOC; 3-way probe result |
| Retry settings + countdown | `src/domains/session/retry.ts` | ❌ | Compact-and-retry hinted at in dispatch comments; no dedicated module |
| Tree selector (`/tree`) | `src/interactive/overlays/tree-selector.ts` | ✅ | 353 LOC; submodes (browse, edit-label, confirm-delete); `shift+t` timestamps; `e`/`d` deletions |
| Branch-summary renderer | `src/interactive/renderers/branch-summary.ts` | ❌ | Missing |
| Compaction-summary renderer | `src/interactive/renderers/compaction-summary.ts` | ✅ | Minimal placeholder |
| Messages union (BashExecution, Custom, BranchSummary, CompactionSummary) | `src/domains/session/entries.ts` | ✅ | Covered by entry union above |

### Phase 13 — Resources — 0%

Every expected path is missing. `src/domains/resources/` does not exist. No `assets/themes/`. No context-files loader. No skills validator. No prompt templates. The plan calls for a new minor domain; it has not been created.

| Plan item | Expected path | Status |
|---|---|---|
| Resources domain scaffold | `src/domains/resources/{manifest,index,extension,contract}.ts` | ❌ |
| Unified resource discovery | `src/domains/resources/loader.ts` | ❌ |
| Collision resolution | `src/domains/resources/collision.ts` | ❌ |
| Context-files loader (AGENTS.md, CLAUDE.md) | `src/domains/resources/context-files/loader.ts` | ❌ |
| Skills: loader, validator, invocation | `src/domains/resources/skills/` | ❌ |
| Prompt templates: loader, substitute | `src/domains/resources/prompts/` | ❌ |
| Theme engine + schema | `src/domains/resources/themes/` | ❌ |
| Theme assets | `assets/themes/{default,dark,light}.json` | ❌ |
| Slash commands `/theme`, `/skills`, `/prompts` | `src/interactive/slash-commands.ts` | ❌ |
| `--no-context-files` / `-nc` flag | `src/cli/args.ts` | ❌ |

### Phase 14 — Extensions — 0%

| Plan item | Expected path | Status |
|---|---|---|
| Extensions domain scaffold | `src/domains/extensions/{manifest,index,extension,contract}.ts` | ❌ |
| TS/JS loader via jiti | `src/domains/extensions/loader.ts` | ❌ |
| Runner + sandbox | `src/domains/extensions/{runner,sandbox}.ts` | ❌ |
| Public type surface (40+ interfaces) | `src/domains/extensions/types.ts` | ❌ |
| Command/tool/flag/shortcut registry | `src/domains/extensions/registry.ts` | ❌ |
| UI context wrapper | `src/domains/extensions/ui-context.ts` | ❌ |
| Event definitions (session/agent/tool/provider/user) | `src/domains/extensions/events/` | ❌ |
| Overlays: extension-selector / extension-editor / extension-input | `src/interactive/overlays/` | ❌ |
| Example extensions | `examples/extensions/` | ❌ (directory does not exist) |
| `--extension`/`-e`, `--no-extensions` flags | `src/cli/args.ts` | ❌ |

### Phase 15 — Package Manager — 0%

| Plan item | Expected path | Status |
|---|---|---|
| Packages domain scaffold | `src/domains/packages/{manifest,index,extension,contract}.ts` | ❌ |
| Install/remove/update/list orchestrator | `src/domains/packages/manager.ts` | ❌ |
| Source handlers (git, npm, local) | `src/domains/packages/sources/` | ❌ |
| `pi.{skills,extensions,prompts,themes}` manifest resolver | `src/domains/packages/resolver.ts` | ❌ |
| Package-config overlay | `src/interactive/overlays/package-config.ts` | ❌ |
| `clio install/remove/update/list/config` CLI subcommands | `src/cli/packages.ts` | ❌ |

### Phase 16 — RPC + Print + JSON modes — 0%

| Plan item | Expected path | Status |
|---|---|---|
| Print mode | `src/cli/modes/print.ts` | ❌ |
| RPC mode (36+ command handlers) | `src/cli/modes/rpc.ts` | ❌ |
| JSONL framing | `src/cli/modes/jsonl.ts` | ❌ |
| Mode dispatch | `src/cli/modes/index.ts` | ❌ |
| RPC client library | `src/sdk/rpc-client.ts` | ❌ |
| RPC types | `src/sdk/rpc-types.ts` | ❌ |
| SDK root barrel | `src/sdk.ts` | ❌ |
| Output guard | `src/cli/output-guard.ts` | ❌ |
| `@file` handling + image auto-resize | `src/cli/file-processor.ts` | ❌ |
| Initial message composer | `src/cli/initial-message.ts` | ❌ |
| `--print`, `-p`, `--mode <text\|json\|rpc>` flags | `src/cli/args.ts` | ❌ |

### Phase 17 — Auth & OAuth — 30%

| Plan item | Expected path | Status | Evidence |
|---|---|---|---|
| AuthStorage contract | `src/domains/providers/auth/storage.ts` | ❌ | Contract absent |
| File backend (credentials.yaml 0600) | `src/domains/providers/auth/backend-file.ts` | 🟡 | Logic lives monolithically in `src/domains/providers/credentials.ts` (178 LOC: atomic YAML write, mode 0600, keychain scaffold, env-var detection). Backend split missing. |
| Memory backend | `src/domains/providers/auth/backend-memory.ts` | ❌ | Not implemented |
| OAuth flows | `src/domains/providers/auth/oauth.ts` | ❌ | No OAuth code anywhere |
| API-key resolver | `src/domains/providers/auth/api-key.ts` | ❌ | Env-var resolution currently inline in credentials.ts |
| Login dialog overlay | `src/interactive/overlays/login-dialog.ts` | ❌ | |
| OAuth selector overlay | `src/interactive/overlays/oauth-selector.ts` | ❌ | |
| `/login`, `/logout` slash commands | `src/interactive/slash-commands.ts` | ❌ | |
| `--api-key <key>` flag | `src/cli/args.ts` | ❌ | |

### Phase 18 — Keybindings (user-configurable) — ~10%

| Plan item | Expected path | Status | Evidence |
|---|---|---|---|
| `AppKeybindings` schema (27 bindings) | `src/domains/config/keybindings.ts` | ❌ | Not created. `src/domains/config/schema.ts` carries keybindings as an untyped `Record<string, string>`. |
| Manager wrapping pi-tui's `KeybindingsManager` | `src/interactive/keybinding-manager.ts` | ❌ | Not created. `src/engine/tui.ts` re-exports `TUI_KEYBINDINGS` but nothing consumes it. |
| `/hotkeys` read-only overlay | `src/interactive/overlays/hotkeys.ts` | ✅ | Exists, but populated from hardcoded list, not resolver |
| Platform-specific handling (Kitty, Zellij, tmux, Windows) | `src/interactive/keybinding-manager.ts` | ❌ | |
| Settings overlay keybindings section | `src/interactive/overlays/settings.ts` | ❌ | |
| Default keybindings | `src/interactive/index.ts` | 🟡 | 9 bindings hardcoded via `matchesKey` in `routeInteractiveKey` (`Shift+Tab`, `Ctrl+D`, `Ctrl+B`, `Ctrl+L`, `Ctrl+P`, `Shift+Ctrl+P`, `Alt+S`, `Alt+M`, `Alt+T`) |

### Phase 19 — Rich Components — ~5%

| Plan item | Expected path | Status | Evidence |
|---|---|---|---|
| Footer with git branch + extension slots | `src/interactive/footer-panel.ts` | 🟡 | Footer exists but minimal; no git branch, no extension status slots |
| Tool-execution renderer | `src/interactive/renderers/tool-execution.ts` | ❌ | |
| Assistant-message renderer | `src/interactive/renderers/assistant-message.ts` | ❌ | Basic inline rendering in `chat-renderer.ts` |
| User-message renderer | `src/interactive/renderers/user-message.ts` | ❌ | Basic inline rendering |
| Diff renderer | `src/interactive/renderers/diff.ts` | ❌ | |
| Edit-tool diff preview | `src/tools/edit-diff.ts` | ❌ | |
| Bash-execution renderer | `src/interactive/renderers/bash-execution.ts` | ❌ | |
| Branch-summary renderer | `src/interactive/renderers/branch-summary.ts` | ❌ | |
| Compaction-summary renderer | `src/interactive/renderers/compaction-summary.ts` | ✅ | Minimal placeholder |
| Custom-message renderer | `src/interactive/renderers/custom-message.ts` | ❌ | |
| Skill-invocation renderer | `src/interactive/renderers/skill-invocation.ts` | ❌ | |
| Bordered loader, dynamic border, visual truncate, countdown timer | `src/interactive/components/` | ❌ | `src/interactive/components/` does not exist |
| `Ctrl+O` toggle tool output | `src/interactive/index.ts` | ❌ | |
| `Ctrl+T` toggle thinking blocks | `src/interactive/index.ts` | ❌ | |

### Phase 20 — Input Polish — 0%

| Plan item | Expected path | Status |
|---|---|---|
| `!command` and `!!command` editor syntax | `src/interactive/chat-panel.ts` | ❌ |
| `@file` and `@image` editor syntax | `src/interactive/chat-panel.ts` | ❌ |
| `Ctrl+G` external editor (`$VISUAL`/`$EDITOR`/nano/vi probe) | `src/interactive/chat-panel.ts` | ❌ |
| `Alt+Enter` follow-up queue | `src/interactive/chat-panel.ts` | ❌ |
| `Alt+Up` dequeue | `src/interactive/chat-panel.ts` | ❌ |
| Clipboard paste-image | `src/utils/clipboard-image.ts` | ❌ (directory `src/utils/` does not exist) |
| Image utilities (`clipboard`, `image-convert`, `image-resize`, `exif-orientation`) | `src/utils/` | ❌ |
| Bash `BashOperations` abstraction + detached child tracking | `src/tools/bash.ts` | 🟡 | 75 LOC `execFile` wrapper with timeout; no BashOperations, no child tracking |
| `git.ts` helper (for footer branch) | `src/utils/git.ts` | ❌ |

### Phase 21 — Export / Import / Share — 0%

| Plan item | Expected path | Status |
|---|---|---|
| HTML export renderer | `src/domains/session/export-html/` | ❌ |
| ANSI-to-HTML | `src/domains/session/export-html/ansi-to-html.ts` | ❌ |
| Tool-specific HTML renderers | `src/domains/session/export-html/tool-renderer.ts` | ❌ |
| Template assets | `assets/export-html/{template.html,template.css,template.js,vendor/*}` | ❌ |
| `clio --export` / `/export` | `src/cli/export.ts` + slash route | ❌ |
| `clio import` / `/import` | `src/cli/import.ts` + slash route | ❌ |
| Share via gist | `src/domains/session/share.ts` | ❌ |
| `/copy`, `/name`, `/changelog` | `src/interactive/slash-commands.ts` | ❌ |

### Phase 22 — Retry, Diagnostics, Telemetry, Final Polish — ~5%

| Plan item | Expected path | Status | Evidence |
|---|---|---|---|
| Retry settings module | `src/domains/session/retry.ts` | ❌ | |
| Structured diagnostics | `src/core/diagnostics.ts` | ❌ | Today uses `console.error` |
| Install-telemetry ping | `src/domains/lifecycle/telemetry.ts` | ❌ | |
| In-memory counters/histograms | `src/domains/observability/telemetry.ts` | 🟡 | 46 LOC; counters + histograms + snapshot/reset; not the install-ping the plan describes |
| Tools-manager (fd/rg under agentDir/bin) | `src/domains/lifecycle/tools-manager.ts` | ❌ | |
| `clio install`/`upgrade`/`doctor` diagnostic panels | `src/cli/{install,upgrade,doctor}.ts` | 🟡 | All three subcommands exist but panels are thin |
| `CLIO_STARTUP_BENCHMARK` env | `src/entry/orchestrator.ts` | ❌ | |
| `PI_CODING_AGENT` env compat (CLI adapter path) | `src/domains/providers/runtimes/subprocess/` | ❌ | |
| Settings: `quietStartup`, `clearOnShrink`, `showHardwareCursor`, `imageAutoResize` | `src/domains/config/schema.ts` | ❌ | |

## Cross-cutting surface not yet present

These are structural pieces that show up in many phases and are currently absent from Clio. Call them out explicitly so they are not double-counted per phase.

- **Comprehensive flag parser** (`src/cli/args.ts`). Today `src/cli/shared.ts` ships a 26-LOC minimal `parseFlags()` that splits `--key value` without schema. The port demands ~345 LOC covering 25+ flags, `@file` handling, stdin capture, and unknown-flag forwarding to extensions. This single file is the choke point for Phases 11, 13, 14, 16, 17, 20, 21, and 22.
- **`src/core/exec.ts`**. Wraps `child_process` uniformly with signal handling, timeouts, and structured output. Absent today; every tool that needs to spawn a subprocess currently rolls its own `execFile`.
- **`src/core/diagnostics.ts`**. Structured `{type: info|warning|error, message, context?}` returned from boot steps. Routes to footer + log file. Absent; boot path uses `console.error`.
- **`src/core/resolve-config-value.ts`**. `~/` and env-var expansion. Absent; env resolution is scattered.
- **`src/utils/`** directory. Does not exist. All the clipboard, image, git, and OS-shim modules expected by Phase 20 would land here.

## What parity means in practice

Phases 11 and 12 are the only port phases that are materially advanced. Everything else is blocked on at least one of:

- the flag parser (`src/cli/args.ts`),
- the three new domains (`resources`, `extensions`, `packages`),
- the auth split (`src/domains/providers/auth/**`),
- the keybinding manager (`src/interactive/keybinding-manager.ts`),
- the renderer tree (`src/interactive/renderers/**` + `src/interactive/components/**`).

Phase 16 (RPC/print/JSON) and Phase 21 (export/import/share) are net-new surface. The rest of the work is re-homing pi-coding-agent features under Clio's 13-domain layout with the three hard invariants intact.

## Execution notes

- The spine's "no tests, use `scripts/diag-*.ts`" stance (§2.7, §6) is **superseded** by the `tests/{unit,integration,boundaries,e2e}` layer that landed after the spine was written. New port work adds tests under `tests/`, not diag scripts. See `.claude/skills/clio-testing/SKILL.md` for the current test discipline.
- The post-plan provider rebuild changed the runtime contract (endpoints + runtime descriptors), so Phase 16 RPC commands that touch provider state must be written against `EndpointDescriptor` + `RuntimeDescriptor`, not the legacy provider/model pair the spine references.
- The pi-mono pin is now `0.68.1` (this doc's baseline). Per-tool `executionMode` (new in `AgentTool`) and `onResponse` on `AgentOptions`/`StreamOptions` are available to any port phase that wants them.

## When to refresh this doc

Refresh on any of:

1. A port-phase task commit that lands a file listed above. Flip its status, update the phase percentage, update the executive-summary row.
2. A pi-mono bump. Update the baseline commit, pi-mono version, and re-check any rows that reference pi-mono surface.
3. A structural change to Clio's domain layout, CLI subcommand surface, or test infrastructure. Update the cross-cutting section and the execution notes.

Do not refresh for in-progress work that has not committed. The ledger reflects the branch tip at `HEAD`.
