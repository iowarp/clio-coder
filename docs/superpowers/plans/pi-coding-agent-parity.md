# Pi-Coding-Agent Parity — Current State vs Port Plan

- **Status:** Living audit. Refresh whenever a port-phase task completes or pi-mono bumps.
- **Baseline:** commit `747f71c` on branch `v0.2/parity`, 2026-04-22, pi-mono pinned to `0.69.0` (typebox 1.x migration applied this session; see `docs/architecture/pi-mono-boundary-0.69.0.md`).
- **Source of truth for what "parity" means:** [`docs/superpowers/plans/2026-04-17-pi-coding-agent-port.md`](2026-04-17-pi-coding-agent-port.md) (the spine; §2 is the IP-to-destination map, §4 is the per-phase scope).
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

## What pi-mono 0.69.0 unlocked

The 0.69.0 bump is mostly defensive (the typebox migration), but it ships three additive capabilities Clio should adopt now rather than letting them sit dormant.

| Capability | Where in pi-mono | Where it lands in Clio | Why it matters |
|---|---|---|---|
| `AgentToolResult.terminate?: boolean` | `agent/types.ts` | `src/tools/write-plan.ts`, `src/tools/write-review.ts` | In `advise` mode these tools are terminal: writing the artifact is the whole turn. Setting `terminate: true` skips the follow-up LLM call, halves the token bill, and ends the run cleanly without prompting the model to "summarize what you just wrote". Wire alongside an `afterToolCall` override in the worker registry so the hint is honored even when the tool returns from the subprocess. |
| `Terminal.setProgress(active)` | `tui/terminal.ts` | `src/interactive/chat-loop.ts` (around `agent_start`/`agent_end`) | Emits OSC 9;4 indeterminate progress so terminals like WezTerm, Ghostty, Konsole, and Windows Terminal show a taskbar/tab progress badge while the agent is working. Free polish, two lines of wiring. |
| `AutocompleteProvider.shouldTriggerFileCompletion?()` + `#` trigger | `tui/autocomplete.ts` | future Phase 13 (resources/skills) and Phase 14 (extensions) | Lets a future `/skills` or `#tag`-style autocomplete coexist with the existing `@file` completer without rewriting the Editor. Note the seam now so Phase 13 designs around it. |
| typebox 1.x runtime validator | `ai/utils/typebox-helpers.ts` | already migrated | Tool-arg validation now actually runs in eval-restricted runtimes. No immediate work, but unblocks any future Phase 16 work that hosts the worker in a sandboxed environment. |
| `transformMessages()` trailing tool-result synthesis | `ai/utils/transform-messages.ts` | `src/domains/session/compaction/` | Resuming a session whose last assistant turn was killed mid-tool-call no longer requires a manual fix-up. Verify by adding an integration test that loads a session ending in an unresolved `toolCall` and asserts replay succeeds. |
| `gemini-3.1-flash-lite-preview` model | `ai/providers/google-gemini-cli` | `src/domains/providers/models/gemini.yaml` | Audit whether the local knowledge-base YAML enumerates this model. If we manually curate, add it; if pi-ai's model list is the source of truth, confirm `list-models --probe` surfaces it. |

## Dormant pi-mono surface — wiring opportunities

These are pi-mono symbols that Clio either re-exports through `src/engine/` and never consumes, or could re-export to unblock a port phase. Each row is a concrete redesign opening, not a wishlist.

### From `pi-agent-core`

| Symbol | Re-exported? | Current use | Suggested wiring |
|---|---|---|---|
| `AgentOptions.onResponse` / `StreamOptions.onResponse` | no | none | Wire alongside the existing `onPayload` in `src/engine/worker-runtime.ts:142` and `src/interactive/chat-loop.ts:377`. Capture `response.status`, `response.headers["x-ratelimit-*"]`, and any provider-specific request id into the receipt. Today receipts only know about request payloads; surfacing response metadata would fill the diagnostics gap Phase 22 calls out and make rate-limit triage tractable. |
| `Agent.signal` / per-turn `AbortSignal` plumbing | re-exported via `Agent` type | only used for `abort()` | Forward the signal into nested async work (e.g. `bash` exec children, `web-fetch` undici requests) so user `Esc` cancels in-flight subprocesses, not just the LLM stream. Currently the bash tool spawns with no signal and ignores aborts mid-execution. |
| `Agent.steer()` vs `Agent.followUp()` | re-exported | only `followUp()` paths exist | The interactive editor could expose `Alt+Enter` (queue follow-up) and a separate "interject now" key (steer) per the Phase 20 plan. Today steering is dead code. |
| `AgentTool.executionMode` per-tool override | re-exported | no per-tool overrides set | Mark `read`, `grep`, `glob`, `ls`, `web-fetch` as `parallel` (already the default) and `bash`, `write`, `edit` as `sequential` to prevent the model from launching two `bash` calls that race on the same file. The current global `parallel` mode is the right default but per-tool guards would catch the obvious foot-guns. |
| `AgentTool.prepareArguments` (added in 0.64) | re-exported | no implementations | Use it in `src/tools/registry.ts` to coerce legacy tool-call shapes when resuming sessions written by older clio builds. Phase 22's "session migration" gap implicitly needs this. |
| `streamProxy()` + `ProxyStreamOptions` | re-exported | unused | Required surface for the Phase 16 RPC tier if/when clio gains a hosted control plane. Keep on the radar; no work today. |
| Faux provider helpers (`fauxText`, `fauxThinking`, `fauxToolCall`, `fauxAssistantMessage`, `registerFauxProvider`) | re-exported and used inside `engine/ai.ts` for the `faux` text helper | not exposed to test layer | Expose via `tests/harness/` so e2e suites can stub deterministic LLM responses for slash-command flows. Today every e2e test depends on either no LLM or a real local provider; a faux-provider harness would let us assert on `/run`, `/compact`, `/fork` end-to-end without network. |

### From `pi-ai`

| Symbol | Re-exported? | Current use | Suggested wiring |
|---|---|---|---|
| `AnthropicOptions.thinkingDisplay`, `BedrockOptions.thinkingDisplay` (`"summarized" \| "omitted"`) | not re-exported | none | Add a settings toggle ("show thinking text"). When `omitted`, time-to-first-text-token drops noticeably on Opus 4.7 / Mythos. Surface in the `/thinking` overlay alongside the level selector. |
| `AnthropicEffort` (`"low" \| "medium" \| "high" \| "xhigh" \| "max"`) | not re-exported | thinking selector uses generic levels | Anthropic-specific effort enum is richer than the generic `ThinkingLevel`. Either map our generic levels onto Anthropic's effort when the active provider is Anthropic, or expose effort directly in the thinking overlay when the model is Anthropic-family. |
| `OpenAICompletionsCompat.cacheControlFormat: "anthropic"` | not re-exported | none | Local Qwen/Fireworks/OpenCode endpoints can opt into Anthropic-style prompt caching markers via OpenAI-compatible chat completions. Clio's local-model knowledge-base YAMLs (`src/domains/providers/models/*.yaml`) should set this for the families that support it (Qwen 3.5+, OpenCode Qwen). Net effect: meaningful prompt-cache hit rate on local backends, not just Anthropic cloud. |
| `OpenAICompletionsCompat.sendSessionAffinityHeaders` | not re-exported | none | Same plumbing for Fireworks / litellm proxy routing — emits `session_id` + `x-client-request-id` + `x-session-affinity` headers from `agent.sessionId`. Worth flipping on for Fireworks endpoints in the catalog. |
| `KnownProvider` includes `"fireworks"` (added 0.68.1) | re-exported via type | catalog status unknown | Audit `src/domains/providers/models/` — if Fireworks isn't enumerated as a 1P provider, add it now that pi-ai lists it natively. |
| `getEnvApiKey()` `<authenticated>` sentinel for Bedrock/Vertex | imported in `engine/oauth.ts` | one call site | The doctor command and providers overlay should treat `<authenticated>` as success rather than "missing key" when probing AWS-credential-resolved endpoints. Spot-check `src/cli/doctor.ts` and `src/interactive/providers-overlay.ts`. |
| `isContextOverflow()` + `getOverflowPatterns()` | not re-exported | clio rolls its own `src/domains/providers/errors.ts:isContextOverflowError()` | Replace clio's bespoke regex with pi-ai's curated patterns. Pi-ai keeps the list current with provider behavior changes; clio's local copy will drift. |
| `supportsXhigh()` | not re-exported | hardcoded comment in `src/domains/providers/models/gpt.yaml` | Read it programmatically when building the thinking-level menu so we don't expose `xhigh` for models that don't support it. Currently the menu is the same for every reasoning-capable model. |
| `StringEnum<T>()` typebox helper | not re-exported | none | Use in tool schemas where a parameter is a fixed string set (today we use raw `Type.String()` and validate manually). Better autocomplete on the model side and self-documenting. |

### From `pi-tui`

| Symbol | Re-exported? | Current use | Suggested wiring |
|---|---|---|---|
| `KeybindingsManager` + `getKeybindings()` / `setKeybindings()` + `TUI_KEYBINDINGS` | all re-exported via `engine/tui.ts:25` | **none** — Clio still hardcodes 9 bindings via `matchesKey()` in `src/interactive/index.ts` | This is the single biggest dormant surface. Wiring `KeybindingsManager` as the spine for Phase 18 collapses ~half of Phase 18's work. The manager already supports declaration-merge for app-specific bindings; clio just needs the `AppKeybindings` schema (`src/domains/config/keybindings.ts`) and a `setKeybindings()` call at boot. |
| `SlashCommand.argumentHint` | not re-exported (we use our own `SlashCommand` type in `src/interactive/slash-commands.ts`) | none | Either adopt pi-tui's `SlashCommand` type and feed our handlers through pi-tui's autocomplete provider (cleaner, gets us free fuzzy matching), or mirror `argumentHint` on our local type so `/run`, `/receipt verify <id>`, `/edit <session>` show their argument syntax in the dropdown. |
| `CombinedAutocompleteProvider` | not re-exported | none | Required scaffolding for stacking `@file` + `#tag` + slash-command completers when Phase 13 (skills/resources) or Phase 14 (extensions) lands. Add to `engine/tui.ts` re-exports preemptively. |
| `Loader.setIndicator()` + `LoaderIndicatorOptions` | not re-exported | only the default Loader is used at `src/interactive/providers-overlay.ts:253` | Custom frames per long-running operation (probing models, compacting, dispatching subagent) make the TUI feel snappier and give the user a hint about what's happening. Cheap win. |
| `hyperlink(text, url)` + `detectCapabilities().hyperlinks` | not re-exported | none | Render OSC 8 hyperlinks in the markdown renderer so file paths in tool output, source links in receipts, and `/help` references become clickable in supporting terminals. Falls through to plain text under tmux/screen automatically (0.67.6 default). |
| `setCapabilities()` (test override) | not re-exported | none | Add to engine for test code so `tests/e2e/` can deterministically pin `hyperlinks: true` regardless of host terminal. |
| `Terminal.setProgress(active)` (new in 0.69.0) | not re-exported | none | Wrap with an engine helper and wire at agent_start/agent_end. See "0.69.0 unlocked" table above. |
| `Image` component + Kitty/iTerm2 image protocols | re-exported | none | Phase 19's compaction-summary, branch-summary, and bash-execution renderers could embed inline images for screenshots/charts produced by tools. Foundational scaffolding for the eventual "vision" tool path. |
| `SettingsList.submenu` | re-exported via type | unused in `settings-overlay.ts` | The current settings overlay is a flat list. Submenus would let us nest the keybindings editor (Phase 18), the per-endpoint thinking config, and the safety-mode allowlist editor without inflating the top level. |
| `addInputListener()` / `removeInputListener()` | re-exported via `TUI` | unused | Lets a future Phase 14 extension intercept raw input before component handling (e.g. for vim-mode or a custom key recorder). Keep documented. |

## Updated Phase 17 ledger note

The ledger row "OAuth flows | ❌ | No OAuth code anywhere" is **stale**. Since this doc was written, `src/domains/providers/auth/` has grown to six modules (826 LOC total): `storage.ts` (524 LOC AuthStorage contract), `backend-file.ts` (194 LOC mode-0600 yaml), `backend-memory.ts` (17 LOC), `api-key.ts` (25 LOC env-var resolver), `oauth.ts` (36 LOC engine wrapper), and `index.ts` (30 LOC barrel). The engine side (`src/engine/oauth.ts`) re-exports `OAuthProviderId`, `OAuthCredentials`, `OAuthLoginCallbacks`, `OAuthProviderInterface` plus login helpers. Phase 17 is closer to **65%**, not 30%. What's still missing:

- Login dialog overlay (`src/interactive/overlays/login-dialog.ts`)
- OAuth selector overlay (`src/interactive/overlays/oauth-selector.ts`)
- `/login` and `/logout` slash commands
- `--api-key <key>` CLI flag

Refresh the executive-summary row and the per-phase table when this audit is next regenerated.

## Structural deltas from the plan baseline (v0.1.0-rc1 @ `ab37e13` → current)

Sessions since the spine was written moved Clio forward in ways that touch parity math but are not part of the pi-coding-agent port:

- ➕ **Provider subsystem rebuild** (`src/domains/providers/`, 37 runtime files). Mature subprocess + cloud + local runtime descriptors, a capabilities gate, knowledge-base YAMLs for 9 model families, a native LM Studio ApiProvider, an Ollama-native ApiProvider, llama.cpp advanced descriptors. This is deeper than the `model-registry` + `model-resolver` the plan calls for but does not fulfill the `providers/resolver.ts` glob/fuzzy/`:thinking` shorthand.
- ➕ **Endpoints contract** (`settings.yaml` `endpoints[]` collapsed from the earlier provider/providers/runtimes namespaces). Dispatch, worker-runtime, TUI overlays, chat-loop, footer, receipts, and all CLI commands were rewritten to consume it.
- ➕ **New test layer** (`tests/{unit,integration,boundaries,e2e}` replacing `scripts/diag-*.ts` theater). 235 tests + 21 e2e tests, plus `tests/harness/{spawn,pty}.ts` for driving the TUI. The spine's `scripts/diag-<area>.ts` pattern is superseded — that guidance is now **obsolete** (see `tests/boundaries/check-boundaries.ts` for the enforcement direction).
- ➕ **pi-mono boundary audit** refreshed to `0.69.0` (`docs/architecture/pi-mono-boundary-0.69.0.md`). Adds the typebox 1.x migration plus deltas for `AgentToolResult.terminate`, `Terminal.setProgress`, and the `AutocompleteProvider.shouldTriggerFileCompletion?` extension seam.

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
- The pi-mono pin is now `0.69.0` (this doc's baseline). Capabilities available to any port phase that wants them: per-tool `executionMode` (`AgentTool`), `onResponse` (`AgentOptions`/`StreamOptions`), `AgentToolResult.terminate` for tools that should short-circuit the follow-up LLM call, `Terminal.setProgress` (OSC 9;4), and the typebox 1.x runtime validator. See "Dormant pi-mono surface" above for the full list and where each lands in clio.

## When to refresh this doc

Refresh on any of:

1. A port-phase task commit that lands a file listed above. Flip its status, update the phase percentage, update the executive-summary row.
2. A pi-mono bump. Update the baseline commit, pi-mono version, and re-check any rows that reference pi-mono surface.
3. A structural change to Clio's domain layout, CLI subcommand surface, or test infrastructure. Update the cross-cutting section and the execution notes.

Do not refresh for in-progress work that has not committed. The ledger reflects the branch tip at `HEAD`.
