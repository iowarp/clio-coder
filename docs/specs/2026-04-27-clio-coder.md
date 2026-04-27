---
title: Clio Coder canonical specification
date: 2026-04-27
slug: clio-coder
status: snapshot
branch: feat/dev-mode-overhaul
package: "@iowarp/clio-coder@0.1.2"
pi-sdk: "@mariozechner/pi-* 0.70.x (lock 0.70.2)"
---

## Summary

Clio Coder is the coding agent in IOWarp's CLIO ecosystem of agentic
science. It is a custom orchestration harness layered over the pi SDK,
distributed as the `@iowarp/clio-coder` npm package, and consumed
through the `clio` binary. The harness owns the agent loop, the TUI,
the session format, the prompt compiler, the tool registry, and the
identity. The pi SDK is treated as a vendored engine confined to
`src/engine/**`. This document is the contributor-facing snapshot of
v0.1.2 plus the changes that landed on `feat/dev-mode-overhaul`.

## 1. Identity

The canonical identity fragment ships at
`src/domains/prompts/fragments/identity/clio.md` and is injected into
every model turn through the prompts domain. It opens with:

> You are Clio. You are Clio. You are Clio.
>
> You are the coding agent in IOWarp's CLIO ecosystem of agentic
> science, part of the NSF-funded IOWarp project at iowarp.ai. You
> specialize in HPC and scientific-software work for researchers
> and developers across research-software domains.

Positioning. Clio Coder targets HPC and scientific-software
developers across research-software domains. It is one component of
the IOWarp CLIO family alongside `clio-core` (Chimaera-based context
storage runtime) and `clio-kit` (MCP servers for HDF5, Slurm,
ParaView, Pandas, ArXiv, NetCDF, FITS, Zarr, and similar scientific
data sources). IOWarp itself is an NSF-funded project rooted at
iowarp.ai.

Identity guarantees carried by the fragment:

- A canned answer for "who made you / what model are you" that names
  Clio and IOWarp without naming the underlying weights.
- An explicit vendor-name negation list: not Claude, GPT, Qwen,
  Gemini, Llama, or Mistral; not from Anthropic, OpenAI, Alibaba,
  Google, Meta, or any other model vendor.
- Anti-leak clauses that pin name, voice, and origin claims to Clio
  regardless of which weights run the turn.
- A behavior preamble that names the orchestration role: subprocess
  dispatch, planning, routing, synthesizing, and respect for active
  mode, safety level, approval state, and git safety rails.

The fragment passes the prompt-fragment lint at
`tests/boundaries/check-prompts.ts`: dot-separated id, version 1,
positive integer `budgetTokens` (280), non-empty `description`, no
template variables for a static fragment.

## 2. Architecture invariants

Three hard invariants are enforced statically by
`tests/boundaries/check-boundaries.ts:139` (`runBoundaryCheck`).
Violation of any rule blocks `npm run test` and CI.

1. Engine boundary. Only files under `src/engine/**` may
   value-import `@mariozechner/pi-*`. Type-only imports are tolerated
   anywhere because they erase at compile time. Implemented as
   `rule1` in `runBoundaryCheck`. If a domain needs a pi-* type, it
   must be re-exported via `src/engine/types.ts` or hidden behind an
   engine wrapper.
2. Worker isolation. `src/worker/**` never value-imports
   `src/domains/**`. The single allowance is the worker-safe
   provider runtime rehydration set: `src/domains/providers/plugins.ts`,
   `src/domains/providers/registry.ts`, and
   `src/domains/providers/runtimes/builtins.ts` (see
   `isAllowedWorkerProviderValueImport` at
   `tests/boundaries/check-boundaries.ts:118`). Implemented as `rule2`.
3. Domain independence. `src/domains/<x>/**` never imports
   `src/domains/<y>/extension.ts` for `y != x`. Cross-domain access
   goes through the contract exported from
   `src/domains/<y>/index.ts`; cross-domain traffic flows through
   `SafeEventBus`. Implemented as `rule3`.

A fourth rule enforces that the self-development harness at
`src/harness/**` cannot reach into `src/engine/**`,
`src/domains/**` (other than `src/domains/providers`),
`src/interactive/**`, or `src/worker/**`. See `rule4` in the same
checker.

The prompt fragment lint at `tests/boundaries/check-prompts.ts`
enforces frontmatter shape, id uniqueness, token budget within 110 %,
and template-variable allow-list under `src/domains/prompts/fragments`.

## 3. Repository layout

The project map from `CLIO.md`:

```text
src/cli/           CLI entry points (clio, clio configure, clio doctor, ...)
src/interactive/   terminal UI (chat loop, overlays, dashboard, keybindings)
src/engine/        pi SDK boundary; the only place that value-imports @mariozechner/pi-*
src/worker/        worker subprocess runtime and IPC
src/domains/       domain logic (agents, prompts, providers, dispatch, safety, ...)
src/harness/       self-development harness (hot reload, restart, watcher)
src/tools/         tool registry and built-in tools
src/core/          shared utilities (XDG, config, bus, termination, ...)
src/entry/         orchestrator boot path
tests/unit/        pure logic, no I/O
tests/integration/ real fs ops in a scratch XDG home
tests/boundaries/  static analysis of src/ (import rules + prompt fragments)
tests/e2e/         real `clio` binary via spawn (non-interactive) + node-pty (TUI)
tests/harness/     spawn + pty test harnesses
docs/specs/        formal specifications (data formats, protocols, contracts)
damage-control-rules.yaml  hardcoded bash kill-switches
```

Domain annotations. Each domain ships a contract through its
`index.ts` and a private `extension.ts` registered with the domain
loader. The canonical surfaces:

- `src/domains/agents/` exposes `AgentsContract`, the recipe
  registry, and the fleet parser. Built-in recipes live under
  `src/domains/agents/builtins/` as Markdown plus YAML frontmatter.
- `src/domains/config/` owns `<configDir>/settings.yaml`, validates
  through `SettingsSchema`, computes diffs (`diffSettings`), and
  publishes hot-reload events.
- `src/domains/dispatch/` exposes `DispatchContract`, the
  `RunEnvelope`/`RunReceipt`/`RunStatus` types, and the
  `JobSpec` validation layer. Spawns OS-isolated worker subprocesses
  with NDJSON IPC.
- `src/domains/intelligence/` carries the intent observer (`IntentEvent`,
  `IntentKind`, `IntentObservation`); event-driven only and disabled
  by default.
- `src/domains/lifecycle/` owns install metadata, version info,
  doctor (`DoctorFinding`, `runDoctor`, `formatDoctorReport`),
  pending migrations (`listMigrations`, `runPending`), and state
  initialization (`ensureClioState`, `readStateInfo`).
- `src/domains/modes/` exposes `MODE_MATRIX`, `ALL_MODES`, and the
  `ModesContract`; gates tool visibility per mode.
- `src/domains/observability/` exposes `ObservabilityContract`,
  cost tracking (`CostEntry`, `UsageBreakdown`), metrics
  (`MetricsView`), and the telemetry feed (`TelemetrySnapshot`,
  `MetricKind`).
- `src/domains/prompts/` compiles per-turn prompts; the new
  `PromptsBundleOptions` plus `createPromptsDomainModule` thread
  the global `--no-context-files` flag through the domain loader.
  Owns the instruction merger and the context-file discovery walk.
- `src/domains/providers/` owns the runtime registry, model
  catalog, capability flags, credentials, OAuth, and probe surface.
  The contract surfaces `EndpointStatus`, `EndpointHealth`, the auth
  helpers, and `mergeCapabilities`.
- `src/domains/safety/` exposes `SafetyContract` and
  `SafetyDecision`; subscribes to dispatch and writes audit JSONL.
- `src/domains/scheduling/` owns budget verdicts (`BudgetVerdict`),
  cluster registry (`ClusterNode`), and the `SchedulingContract`.
  Cluster transport is scaffolded.
- `src/domains/session/` exposes the durable session entry stream
  (`SessionEntry` and friends), the `SessionContract`, and the
  Clio-specific session metadata extension.

## 4. Runtime topology

v0.1 admits exactly one runtime tier for chat: native subprocess
workers built around `pi-agent-core` and stood up by `src/worker/**`.
The `sdk` tier (Claude Agent SDK in-process worker path) and the
`cli` tier (Codex CLI, Claude Code CLI, Gemini CLI, Copilot CLI,
OpenCode CLI) are scaffolded but rejected by dispatch admission until
v0.2.

`src/domains/providers/runtimes/builtins.ts` registers the in-tree
runtime descriptors (`BUILTIN_RUNTIMES` constant). Grouped by tier:

Cloud (`tier: cloud`):

- `anthropic`, `bedrock`, `deepseek`, `google`, `groq`, `mistral`,
  `openai`, `openai-codex`, `openrouter`.

Protocol (`tier: protocol`):

- `openai-compat` (HTTP servers that speak the OpenAI completions
  protocol; the documented fallback when no native SDK exists).

Local native (`tier: local-native`). Each entry ships with an
`apiFamily`; the second column says whether a native chat transport
is installed under `src/engine/apis/`:

| Runtime id              | apiFamily                  | Native chat transport at `src/engine/apis/` |
|-------------------------|----------------------------|---------------------------------------------|
| `lmstudio-native`       | `lmstudio-native`          | yes (`lmstudio-native.ts`)                  |
| `ollama-native`         | `ollama-native`            | yes (`ollama-native.ts`)                    |
| `llamacpp-completion`   | `openai-completions`       | no (uses pi-ai over openai-compat shape)    |
| `llamacpp-anthropic`    | `anthropic-messages`       | no (uses pi-ai's anthropic transport)       |
| `llamacpp-embed`        | embeddings                 | no                                          |
| `llamacpp-rerank`       | rerank                     | no                                          |
| `lemonade-anthropic`    | `anthropic-messages`       | no                                          |
| `lemonade-openai`       | `openai-completions`       | no                                          |
| `vllm`                  | `openai-completions`       | no (openai-compat fallback)                 |
| `sglang`                | `openai-completions`       | no (openai-compat fallback)                 |

CLI runtimes (`tier: cli` plus `cli-gold`/`cli-silver`/`cli-bronze`
sub-tiers in the targets renderer): `claude-code-cli`, `codex-cli`,
`gemini-cli`, `copilot-cli`, `opencode-cli`.

SDK runtimes (`tier: sdk`): `claude-code-sdk` (Claude Agent SDK
worker path).

The `RuntimeDescriptor` shape lives at
`src/domains/providers/types/runtime-descriptor.ts`; registry
plumbing is at `src/domains/providers/registry.ts`. Out-of-tree
plugins are loaded by `src/domains/providers/plugins.ts` from
`<dataDir>/runtimes/`.

## 5. Native runtime residency contract

Multi-model local inference servers carry their own resident-model
lifecycle. The shape differs per server, so the runtime that owns
chat transport must also own residency where a native SDK exists.
`openai-compat` is the documented fallback for vLLM, SGLang, and
generic OpenAI-API hosts that have no native SDK. The contract was
written up in
`docs/.superpowers/sprints/2026-04-27-local-runtime-residency.md`.
All seven slices (S1 through S7) shipped behavior on this branch in
commit `7d51a9b`. Test coverage followed in commit `299c872` for
S1 and S2 only; S3 through S7 shipped behavior without dedicated
tests. Section 14 lists the consequence.

LM Studio. The OpenAI-compat endpoint JIT-loads any missing model
alongside the existing resident set, which spills VRAM into system
RAM under contention. The native SDK exposes `listLoaded()` and
per-entry `unload()`. `src/engine/apis/lmstudio-native.ts:65`
implements `ensureResidentModel(client, baseUrl, modelId, now)`:

- Per-runtime cache keyed on `baseUrl` with a 60-second TTL
  (`RESIDENT_TTL_MS = 60_000` at
  `src/engine/apis/lmstudio-native.ts:47`). Cache hit on the same
  `(baseUrl, modelId)` skips the round-trip.
- Cache miss issues `client.llm.listLoaded()`, filters non-target
  entries, and unloads each in parallel through
  `entry.unload().catch(() => undefined)` so unload races never
  raise. The cache is rewritten with the active entry on success.
- Test harness via `ResidentModelClient` and `ResidentModelEntry`
  structural interfaces; `resetResidentCache()` clears between
  tests. Coverage in
  `tests/unit/engine-apis-residency.test.ts` (commit `299c872`).

The `verbose` flag on `client.llm.model(...)` is gated by
`process.env.CLIO_RUNTIME_VERBOSE === "1"` (`lmstudio-native.ts:259`).
Off by default to silence the SDK's progress chatter; flip the env
var when triaging eviction or load behavior.

Ollama. The HTTP server keeps an LRU of resident models with a
default `keep_alive` TTL of five minutes; per-request override
accepts `keep_alive: -1` for indefinite pinning and `keep_alive: 0`
for immediate eviction. `src/engine/apis/ollama-native.ts:89`
(`buildRequest`) sets `keep_alive: -1` on every chat request so the
active model stays resident.
`src/engine/apis/ollama-native.ts:137`
(`evictOtherOllamaModels(baseUrl, keepModelId, headers, client)`)
calls `/api/ps`, filters by `model` and `name`, then fires a
fire-and-forget `generate({ model, prompt: "", keep_alive: 0,
stream: false })` against each non-target entry to release the
prior pin. Both signatures accept an injectable `OllamaEvictClient`
for tests; coverage in `tests/unit/engine-apis-residency.test.ts`.

Chat-loop wiring. The hot-swap path at
`src/interactive/chat-loop.ts:673` detects same-endpoint same-runtime
new-`wireModelId` switches. After mutating `agent.state.model` and
re-clamping `thinkingLevel`, line 689 fires
`evictOtherOllamaModels(...)` for `target.runtime.id ===
"ollama-native"` so the prior pinned weights release VRAM. The call
is fire-and-forget (`void evictOtherOllamaModels(...)`) so a slow
Ollama never blocks the model swap.

llama.cpp. Single-model server. `llamacpp-completion` and
`llamacpp-anthropic` probes report a diagnostic note via
`probeNotes` when the configured wire model id does not match the
server's loaded model. Surfaces in `EndpointStatus.probeNotes` and
the targets table renderer at `src/cli/targets.ts:482`. No
request-time intervention.

Doctor warning fingerprint. `src/domains/lifecycle/doctor.ts:121`
(`runDoctorRuntimeChecks`) walks `settings.endpoints` for entries
with `runtime: "openai-compat"` and probes each URL via
`fingerprintNativeRuntime` at
`src/domains/providers/probe/fingerprint.ts:24`. The probe issues
parallel timed `fetch` calls (750 ms) to `${url}/api/v0/models`
(LM Studio fingerprint) and `${url}/api/version` (Ollama
fingerprint). Returns `{ runtimeId, displayName }` on the first
match. The doctor then emits a `WARN` finding with the migration
hint:

```
target <id> WARN <displayName> detected at <url>; run `clio targets
convert <id> --runtime <runtimeId>` for proper resident-model
lifecycle
```

Migration path. `clio targets convert <id> --runtime <runtimeId>`
at `src/cli/targets.ts:337` rewrites the endpoint's runtime in
`settings.yaml` in place. The runtime id is validated against the
registry; capabilities and model survive untouched. A no-op
(target already on the requested runtime) prints OK and exits 0.

Guardrail. `openai-compat` remains the documented fallback. The
runtime-selection paragraph in `CLIO.md` lists vLLM, SGLang, and
generic OpenAI-API hosts as the correct targets for `openai-compat`.
Native runtimes own residency; the protocol runtime does not.

## 6. Self-development mode

Activation gate. `--dev` on the CLI, or `CLIO_DEV=1` /
`CLIO_SELF_DEV=1` in the environment, signals intent. The resolver
at `src/core/self-dev.ts:83` (`resolveSelfDevMode`) refuses to
activate unless `CLIO-dev.md` exists at one of:

- `<repoRoot>/CLIO-dev.md`
- `<clioConfigDir>/CLIO-dev.md`

The candidate list comes from `devSupplementCandidates(repoRoot)`
at `src/core/self-dev.ts:11`. On a missing supplement, the resolver
writes a stderr explanation and returns null; the orchestrator
distinguishes "user requested dev mode but the gate failed" via
`selfDevActivationSource` at `src/core/self-dev.ts:76` and exits 1
instead of silently continuing in default mode. `CLIO-dev.md` is
gitignored so it never ships.

Auto-branch on protected branches. On activation,
`ensureSelfDevBranch` at `src/core/self-dev.ts:253` reads the
current branch through `git branch --show-current`. When the branch
is `main`, `master`, `trunk`, or detached HEAD,
`ensureSelfDevBranch` prompts on stderr for a slug
(`defaultPromptSlug` uses `node:readline/promises` against
`process.stdin` and `process.stderr`). On a non-TTY stdin, the
prompt resolves to null and the activation fails fast. Otherwise
the slug is sanitized through `sanitizeSelfDevSlug`
(lowercase, non-alphanumerics collapsed to dashes, trimmed,
40-char cap), formatted as `selfdev/YYYY-MM-DD-<slug>`, and applied
via `git switch -c`. On cancellation or git failure the helper
returns null and the orchestrator exits 1.

Layered rule packs. `damage-control-rules.yaml` is now schema v2:
named `packs` keyed by id (`base`, `dev`, `super`). The base pack
carries always-on bash kill switches (`rm -rf /`, `dd of=/dev/`,
`mkfs`, fork bomb, `git push --force main`, `git reset --hard
origin/`, `curl ... | sh`, `wget ... | sh`,
`chmod -R [mode] /etc|usr|bin|sbin|var`). The dev pack adds
self-development extras (`git push`, `git --force`/`--force-with-lease`,
`git -f` shorthand, `git reset --hard`, `git clean -f`, `git
checkout --`, `gh pr merge`). The super pack is intentionally
empty: a placeholder for a future privileged-mode escalation set.

`src/domains/safety/rule-pack-loader.ts:143` (`applicablePacks`) is
the single consumer that flattens active packs into a flat
`DamageControlRule[]` for safety to enforce. The base pack always
applies; the dev pack applies when `selfDev` is true; the super
pack applies when `safetyMode === "super"`.
`src/core/self-dev.ts:195` (`evaluateSelfDevBashCommand`) walks the
cached dev pack instead of carrying its own regex array, so adding
a new self-development bash block is a one-line yaml change.

Self-dev path guards. `src/core/self-dev.ts:127`
(`evaluateSelfDevWritePath`) classifies write targets:

- Outside the repo root: blocked.
- `.git` or `.git/**`: blocked.
- `tests/fixtures/**`: blocked (read-only).
- `docs/.superpowers/boundaries/**` or `docs/boundaries/**`: blocked
  (boundary audit records are read-only).
- `src/engine/**`: blocked unless
  `CLIO_DEV_ALLOW_ENGINE_WRITES=1` was set when activation
  resolved. Allowed writes return `restartRequired: true` so the
  caller can surface the hot-reload-cannot-swap-engine signal.
- `src/**` while on a protected branch: blocked.

Hot reload classifier. The harness watches `src/`. Domain and tool
edits hot-swap in place; engine edits trip the
`restartRequired` flag and the orchestrator footer flips to
`restart required`. The boundary checker at `tests/boundaries/`
(rule 4) prevents the harness from reaching into engine, worker,
TUI, or non-providers domain code, so the harness itself cannot
poison the boundary it is meant to enforce.

The activation lifecycle, branch policy, and engine-write
prerequisites are restated in `CLIO-dev.md` (gitignored,
per-checkout) and feed the prompt merger as the highest-priority
section source (see Section 7).

## 7. Instruction merger

`src/domains/prompts/instruction-merge.ts` is the interop-aware
merger introduced on this branch (`eff9b70`, wired by `4af190f`).
It replaces the old "concatenate every context file" strategy.

Conflict policy. Each context file is parsed by `parseSections` at
`src/domains/prompts/instruction-merge.ts:50` into a map keyed by
H2 (`^##`) header. Content above the first H2 is the preamble,
keyed under the empty string. `mergeInstructions` at
`src/domains/prompts/instruction-merge.ts:98` then composes a
single deterministic block:

1. `CLIO-dev.md` overrides every section, including those defined
   by `CLIO.md`.
2. `CLIO.md` wins among the rest.
3. Among non-CLIO sources (CLAUDE.md, AGENTS.md, CODEX.md,
   GEMINI.md), the source closest to cwd wins. Callers pass sources
   in parent-to-child order; the merger keeps the last byte body
   for a given header.
4. Byte-identical bodies across non-CLIO sources are de-duplicated
   via SHA-256 (`hashBody` at line 82).
5. Section ordering follows `CLIO.md` when present, then any
   non-CLIO sources, then `CLIO-dev.md`.

Preambles. Content above the first H2 is emitted per source as a
synthetic section keyed `Notes from <basename>`. This guarantees
unstructured AGENTS.md or CLAUDE.md files still surface even when
they have no headers.

Provenance footer. The merger appends an HTML-comment provenance
trailer naming each contributor and the section list it actually
contributed. `CLIO-dev.md` carries a `[dev]` tag in its provenance
line and on the returned `InstructionContributor` entry. The
ordering follows `CLIO.md` first, then non-CLIO sources, then
`CLIO-dev.md`.

Loader. `src/domains/prompts/context-files.ts` walks every
directory between cwd and the filesystem root,
parent-to-child-ordered, and reads any of
`["CLIO.md", "CLAUDE.md", "AGENTS.md", "CODEX.md", "GEMINI.md"]`
that exist (`DEFAULT_CONTEXT_FILE_NAMES` at
`src/domains/prompts/context-files.ts:24`).
`loadProjectContextFiles` returns one `ProjectContextFile` per
hit. In dev mode, `loadDevContextFile` (line 100) loads
`CLIO-dev.md` from the repo root or the XDG config fallback and
emits it with `kind: "clio-dev"`.
`renderProjectContextFiles` (line 115) is now a thin wrapper that
maps each file into an `InstructionSource`, calls
`mergeInstructions`, and prepends a one-line orientation header
("Earlier files are broader repository context; later files are
more specific. CLIO.md wins on conflicts; CLIO-dev.md (when
present) overrides CLIO.md.").

The `--no-context-files` (alias `-nc`) top-level flag short-circuits
the entire chain. The flag is parsed by
`extractNoContextFilesFlag` and threaded into the prompts domain
through `createPromptsDomainModule(options)`.

## 8. CLI surface

`src/cli/index.ts` carries the routing surface. Subcommand files
live alongside it under `src/cli/`.

Entry:

- `clio` (no subcommand): launches the interactive TUI through
  `runClioCommand`.
- `clio --dev`: activates self-development mode (see Section 6).
- `clio --version`, `clio -v`: print package version through
  `runVersionCommand`.
- `clio --no-context-files` (alias `-nc`): skip every context-file
  injection for one invocation. Composes with subcommands.
- `clio --api-key <key>`: override the active target API key for
  one invocation.

Configuration:

- `clio configure`: interactive first-run/configuration wizard.
  Detects native local servers on a pasted URL and offers to switch
  the runtime to the native counterpart.
- `clio targets [--json] [--probe] [--target <id>]`: list configured
  targets with health, auth, runtime, model, and capability
  badges. The `--json` envelope is now `{ targets: [...] }` (see
  commit `d6f579a`).
- `clio targets add [configure flags]`: alias for the configure
  add path; same native-server detection.
- `clio targets use <id> [--model <id>] [--orchestrator-model <id>]
  [--worker-model <id>]`: point chat and worker defaults at one
  target.
- `clio targets workers [--json]`: list named worker profiles.
- `clio targets worker <profile> <id> [--model <id>] [--thinking
  <level>]`: set or update a worker profile.
- `clio targets remove <id>` and `clio targets rename <old>
  <new>`: identity-level edits.
- `clio targets convert <id> --runtime <runtimeId>`: rewrite a
  target's runtime in place. Used to migrate `openai-compat`
  targets onto the matching native runtime.

Diagnostics:

- `clio doctor [--fix] [--json]`: synchronous state checks plus
  the asynchronous `runDoctorRuntimeChecks` runtime fingerprinting
  pass. The `--json` envelope is `{ ok, fix, findings }` (see
  `src/cli/doctor.ts:28`). Exit code is 0 when every finding has
  `ok: true`, 1 otherwise.

Auth:

- `clio auth list`: enumerate stored credentials.
- `clio auth status [target-or-runtime]`: inspect resolution state.
- `clio auth login <target-or-runtime>`: run the supported flow
  (api-key, OAuth manual code, native CLI passthrough).
- `clio auth logout <target-or-runtime>`: drop stored credentials.

Lifecycle:

- `clio install` (implicit through `ensureClioState`): create XDG
  scaffolding on first run.
- `clio reset [--state|--auth|--config|--all] [--dry-run]
  [--force]`: recover or wipe selected Clio state.
- `clio uninstall [--keep-config] [--keep-data] [--dry-run]
  [--force]`: remove Clio state and print package-removal guidance.
- `clio upgrade`: check for and apply runtime upgrades plus pending
  migrations (`runPending` from
  `src/domains/lifecycle/migrations/index.ts`).

Runtime:

- `clio agents`: list discovered built-in agent recipes (under
  `src/domains/agents/builtins/`).
- `clio run [flags] "<task>"`: dispatch a one-shot worker
  non-interactively. Flags: `--worker-profile <name>` (alias
  `--worker`), `--worker-runtime <id>` (alias `--runtime`),
  `--target <id>`, `--model <wireId>`, `--thinking <level>`,
  `--agent <recipe-id>`, `--require <capability>`, `--json`. Writes
  a receipt under `<dataDir>/receipts/<runId>.json`.
- `clio models [search] [--target <id>]`: list discovered or known
  models for configured targets.

JSON envelopes (this branch):

- `clio doctor --json` writes `{ ok: boolean, fix: boolean,
  findings: DoctorFinding[] }` and exits 0 on `ok` else 1.
- `clio targets --json` writes `{ targets: SerializedStatus[] }`
  with each row carrying `target`, `runtime`, `available`,
  `reason`, `health`, `capabilities`, `discoveredModels`, `tier`,
  `detectedReasoning`, `reasoningCandidateModelId`, plus optional
  `probeCapabilities` and `probeNotes`.

## 9. Settings and configuration

Settings live in `<configDir>/settings.yaml` and are validated by
`SettingsSchema` at `src/domains/config/schema.js`. Surface keys:

- `version`: schema version integer.
- `endpoints` (alias `targets[]` in the README): id, runtime, url,
  defaultModel, capabilities (`contextWindow`, `reasoning`, etc.),
  optional auth (`apiKeyEnvVar`, `headers`, `gateway`).
- `orchestrator`: `endpoint`, `model`, `thinkingLevel`.
- `workers.default`: `endpoint`, `model`, `thinkingLevel`.
- `workers.profiles[name]`: per-profile override of endpoint, model,
  and thinking level.
- `scope`: list of endpoint ids participating in scoped-model
  cycling.
- `budget`: budget ceiling and concurrency caps consumed by
  `src/domains/scheduling/`.
- `defaultMode`: starting safety mode.
- `safetyLevel`: starting safety level.
- `runtimePlugins`: list of out-of-tree runtime descriptor
  directories.
- `theme`: TUI theme selection.
- `keybindings`: user overrides folded over the default keybinding
  table.
- `state`, `compaction`, `retry`: persisted run-state knobs.

Platform defaults:

| Platform | Default config path |
|---|---|
| Linux   | `~/.config/clio/settings.yaml`                                   |
| macOS   | `~/Library/Application Support/clio/settings.yaml`               |
| Windows | `%APPDATA%/clio/settings.yaml`                                   |

XDG and environment variables (full table from `CLIO.md`):

| Var | Effect |
|---|---|
| `CLIO_HOME` | Single-tree override. Sets every directory below to subdirs of this path. |
| `CLIO_CONFIG_DIR` | Location of `settings.yaml`. |
| `CLIO_DATA_DIR` | Receipts (`<dataDir>/receipts/<runId>.json`), audit JSONL (`<dataDir>/audit/YYYY-MM-DD.jsonl`), sessions, and ledger live here. |
| `CLIO_CACHE_DIR` | Transient cache. |
| `CLIO_DEV` / `CLIO_SELF_DEV` | Equivalent to `clio --dev`. Activates self-development when `CLIO-dev.md` is present at the repo root or `~/.config/clio/CLIO-dev.md`. |
| `CLIO_DEV_ALLOW_ENGINE_WRITES` | Opt-in for `src/engine/**` writes during self-development. Requires a Clio restart afterward. |
| `CLIO_RUNTIME_VERBOSE` | Opt-in for native local-runtime SDK progress logs (LM Studio JIT load progress). Off by default. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ... | Provider credentials referenced by `targets[].auth.apiKeyEnvVar`. |

Tests that touch the filesystem must use a scratch XDG home: set
`CLIO_HOME`, `CLIO_DATA_DIR`, `CLIO_CONFIG_DIR`, `CLIO_CACHE_DIR`
to a `mkdtempSync` path, call `resetXdgCache()` from
`src/core/xdg.js`, restore env, and `rmSync` in `afterEach`.

## 10. Safety modes

Three modes gate tool visibility at the registry layer:

- `default`: read, write, edit, bash, search, and dispatch tools are
  visible.
- `advise`: read-only mode. Filesystem mutation disabled; only
  `write_plan` (writes `PLAN.md`) and `write_review` (writes
  `REVIEW.md`) are exposed for write-class tools.
- `super`: privileged writes outside the working directory and
  outside the default scope. Requires explicit confirmation through
  the `Alt+S` overlay.

Mode changes are logged as `mode_change` rows in the audit JSONL
under `<dataDir>/audit/YYYY-MM-DD.jsonl`. Dismissing the Alt+S
overlay emits a `request_cancelled` `mode_change` row instead of
dropping silently.

Hardcoded bash kill-switches live in `damage-control-rules.yaml`
(see Section 6). The base pack is always on. The dev pack layers on
during self-development. The super pack is empty in v0.1.2.
Bash subprocess abort escalates `SIGTERM` to `SIGKILL` after a
five-second grace period so commands that ignore `SIGTERM` no
longer hang the chat-loop.

## 11. Test surface

Four-layer suite. Test counts on `feat/dev-mode-overhaul` (HEAD =
`d791a21`), verified by running the suite (lexical `it(` / `test(`
counts underreport parameterised and looped cases):

| Layer | Tests |
|---|---|
| `tests/unit/` + `tests/integration/` + `tests/boundaries/` | 713 |
| `tests/e2e/` | 44 |

Total under `npm run test`: 713 unit + integration + boundary cases.
`npm run test:e2e` builds first, then drives 44 end-to-end cases
through `tests/harness/spawn.ts` (non-interactive subprocesses) and
`tests/harness/pty.ts` (TUI under node-pty).

Per-change-site routing from `CLIO.md`:

| Change site | Run this first |
|---|---|
| `src/domains/<x>/*.ts` pure logic | `npm run test` |
| `src/domains/dispatch/state.ts` | `npm run test` (ledger integration) |
| `src/domains/providers/credentials.ts` | `npm run test` (credentials integration) |
| `src/domains/prompts/fragments/*.md` | `npm run test` (boundaries/prompts.test.ts) |
| any `src/` import change | `npm run test` (boundary rules 1/2/3) |
| `src/cli/*.ts` | `npm run test:e2e` (spawn harness) |
| `src/interactive/*.ts` or `src/entry/orchestrator.ts` | `npm run test:e2e` (pty harness) |

E2e pty tests match against the raw pty buffer (with ANSI). Match
by stable text (e.g. `/clio\s+IOWarp/`), wrap in `try/finally` with
`p.kill()`, and always `await runCli(["install"], ...)` before
spawning the TUI on a scratch home.

`npm run check:boundaries` runs the boundary suite alone.
`npm run ci` is the full gate: `typecheck` + `lint` + `test` +
`build` + `test:e2e`.

## 12. Recent changes (this branch)

Commits on `feat/dev-mode-overhaul` newer than `main`, in
chronological order:

1. `8f7e843 chore(release): clean package.json files manifest`.
   Drops the never-shipped `AGENTS.md`, `STATUS.md`, and
   `GOVERNANCE.md` entries from the published `files` list and
   adds the new `CLIO.md`. Aligns the package manifest with the
   actual repository tree before the canonical instruction file
   lands.
2. `b9c77c8 docs(readme): document CLIO.md, drop AGENTS.md
   references`. Promotes `CLIO.md` to the canonical project
   instruction file in the README. The supported context-file list
   becomes `CLIO.md, CLAUDE.md, AGENTS.md, CODEX.md, GEMINI.md`
   with merge semantics documented.
3. `1a56426 docs(contributing): drop AGENTS.md reference`.
   Companion edit in `CONTRIBUTING.md`: agents and contributors
   read `CLIO.md` plus `CHANGELOG.md` and `CONTRIBUTING.md`. The
   merger still loads `AGENTS.md` when present; it is no longer
   the source of truth.
4. `155fcf8 docs(clio): add canonical CLIO.md instruction file`.
   Introduces `CLIO.md` (216 lines). Follows the agents.md community
   protocol (Setup, Build, Test, Lint) blended with the CLAUDE.md
   narrative (project map, architecture invariants, commit
   discipline).
5. `5a08ca5 docs(clio): apply claude-md-improver findings`. Adds a
   standalone Environment section enumerating XDG and self-dev env
   knobs. Trims the Testing-workflow section to point back at the
   per-suite matrix in the Test section.
6. `eff9b70 feat(prompts): interop-aware instruction merger`.
   Adds `src/domains/prompts/instruction-merge.ts`:
   `parseSections`, `mergeInstructions`, the conflict policy and
   provenance footer. Pure module plus
   `tests/unit/prompts-instruction-merge.test.ts`. Integration
   into the loader follows in the next commit.
7. `4af190f feat(prompts): wire instruction merger into context
   loader`. Rewrites `src/domains/prompts/context-files.ts` around
   the merger. Adds `loadDevContextFile` for `CLIO-dev.md` resolution
   from repo root or XDG fallback. Threads `repoRoot` from the
   orchestrator so dev mode overlays cleanly. Updates
   `tests/unit/prompts.test.ts` and adds
   `tests/integration/context-files.test.ts` (a real cwd tree with
   all five candidate filenames at multiple depths).
8. `291d8ca refactor(safety): layered rule packs in
   damage-control-rules`. Rewrites `damage-control-rules.yaml`
   under schema v2 with named packs (`base`, `dev`, `super`).
   Adds `src/domains/safety/rule-pack-loader.ts`
   (`loadRulePacks`, `applicablePacks`, cached pack loader). The
   safety domain's existing `damage-control.ts` extension keeps
   its public contract by reading the base pack.
9. `7554879 refactor(self-dev): bash guard reads dev rule pack`.
   `evaluateSelfDevBashCommand` no longer carries an inline regex
   array; it walks `packs[id=dev].rules`. Adding a new
   self-development bash block becomes a one-line yaml change.
   `tests/unit/self-dev.test.ts` asserts the dev-pack rule
   descriptions match the yaml file.
10. `2cf967c feat(self-dev): require CLIO-dev.md presence to
    activate`. `resolveSelfDevMode` refuses to activate unless
    `CLIO-dev.md` exists at the repo root or
    `<clioConfigDir>/CLIO-dev.md`. The orchestrator detects "user
    requested dev mode but the gate failed" via
    `selfDevActivationSource` and exits 1 instead of dropping into
    default mode. `CLIO-dev.md` is added to `.gitignore`. The e2e
    self-dev test seeds `CLIO-dev.md` inside a scratch
    `CLIO_HOME`.
11. `59358b7 feat(self-dev): auto-branch off protected branches on
    activation`. When dev mode resolves on `main`, `master`,
    `trunk`, or detached HEAD, prompts for a slug and runs
    `git switch -c selfdev/YYYY-MM-DD-<slug>`. The helper is async
    with injectable seams (`readBranch`, `promptSlug`, `runGit`,
    `now`); the default prompt uses `node:readline/promises`
    against `process.stderr` and resolves to null on a non-TTY
    stdin. On cancellation or git failure, returns null so the
    orchestrator surfaces exit 1.
12. `47242f2 docs(changelog): record CLIO.md auto-load and files
    cleanup`. Documents the CLIO.md auto-load contract and the
    `package.json files` manifest cleanup under `[Unreleased]
    Added` and `Changed`.
13. `d6f579a fix(cli): doctor --json output and targets --json
    envelope`. `clio doctor --json` now emits
    `{ ok, fix, findings }`. `clio targets --json` now wraps rows
    in `{ targets: [...] }` for forward compatibility. E2e tests
    in `tests/e2e/cli.test.ts` are updated.
14. `7d51a9b feat(runtimes): native local-server residency and
    routing default`. The largest commit on this branch (17 files,
    348 insertions). Implements all seven slices (S1 through S7) of
    the residency sprint in a single commit: LM Studio eviction
    inside `runStream` (S1), Ollama `keep_alive: -1` plus eviction
    sweep on hot-swap (S2), llama.cpp probe diagnostic notes (S3),
    doctor warning on `openai-compat` URLs that fingerprint as
    native servers (S4), `clio targets convert` (S5), interactive
    runtime steering in configure / targets add (S6), CLIO.md +
    README.md + CHANGELOG.md updates (S7). Adds
    `src/domains/providers/probe/fingerprint.ts` and the
    `EvictResidentEntry` / `OllamaEvictClient` interfaces. Ships
    behavior without test coverage; the follow-up commit
    `299c872` covers S1 and S2 only.
15. `299c872 test(engine): cover lmstudio + ollama residency
    hooks`. Locks the contract for the residency code that landed
    in `7d51a9b` without test coverage. `ensureResidentModel`
    grows an injectable `now` and a structural client interface;
    `evictOtherOllamaModels` grows an optional last-arg client.
    `tests/unit/engine-apis-residency.test.ts` (139 lines) asserts
    eviction of non-target loaded models, the 60 s TTL cache
    hit-skip, and the Ollama `keep_alive: 0` sweep.
16. `a48b261 chore(runtimes): silence lmstudio progress logs by
    default`. Defaults the LM Studio SDK `verbose` flag to false.
    Set `CLIO_RUNTIME_VERBOSE=1` to re-enable JIT load progress
    when triaging eviction or load behavior. CLIO.md environment
    table records the new var.
17. `d791a21 docs(identity): position Clio Coder inside IOWarp's
    CLIO ecosystem`. Final commit on the branch. Aligns the
    identity messaging across the system prompt fragment, CLIO.md
    identity section, README opening, package.json metadata, CLI
    help text, orchestrator banner subtitle, chat-loop fallback
    identity, and CHANGELOG. No behavior changes; architecture,
    engine boundaries, runtime selection, and test surfaces
    untouched.

Commits 6 and 7 are a paired slice (merger introduction plus loader
wiring). Commits 8 and 9 are a paired slice (yaml packs plus the
guard refactor). Commits 10 and 11 are the dev-mode activation
gate slice. Commits 14 and 15 are the residency slice plus its
follow-up test commit. Commits 1 through 5 and 12 through 13 plus
17 are documentation, manifest, and CLI hygiene.

## 13. Development workflow

`npm link` semantics. `npm install && npm run build && npm link`
exposes the `clio` binary from `dist/cli/index.js`. The link is
sticky: it points at the `dist/` symlink, not at TypeScript source.
Re-running `npm run build` is sufficient to refresh the linked
command; you do not need to `npm link` again. The `prepublishOnly`
script gates publication on `typecheck` + `lint` + `build` +
`scripts/check-dist.mjs`.

Iteration loops:

- `npm run dev`: `tsup --watch`. Fastest path for compilation
  feedback when iterating on non-TUI code; pair it with
  `npm run typecheck` and `npm run test` from a second shell.
- `clio --dev`: hot-reload mode. The harness watches `src/`. Tool
  and prompt edits swap in place. Engine edits (`src/engine/**`)
  trip a `restart required` footer because the engine cannot be
  re-instantiated without rebuilding the agent loop. Engine writes
  also require `CLIO_DEV_ALLOW_ENGINE_WRITES=1` and the resulting
  restart afterward (see Section 6).
- Production-style rebuild: `npm run build` after edits, then
  re-run `clio` from a fresh shell. The linked binary picks up the
  new `dist/`.

Gates before any commit:

- `npm run typecheck`: `tsc -p tsconfig.tests.json` (includes
  `tests/` so test code is type-checked too).
- `npm run lint`: `biome check .`.
- `npm run test`: unit + integration + boundary suites.
- `npm run test:e2e`: rebuilds `dist/` then drives the spawn and
  pty harnesses.
- `npm run ci`: all of the above plus `npm run build`. This is
  the same script the GitHub Actions workflow runs.

Optional pre-commit hook: `npm run hooks:install` runs
`scripts/install-hooks.sh`.

Branch and commit discipline. Imperative lowercase types: `feat`,
`fix`, `build`, `ci`, `docs`, `refactor`, `chore`, `test`. Optional
scope: `feat(cli): ...`. Subject 72 characters or fewer, no
trailing period. Branch from `main`. Never force-push `main`.
Every commit must leave `npm run ci` green; do not stack broken
commits. ASCII punctuation only; no em-dash clause separators.

## 14. Open questions and known limitations

- v0.1 dispatch admits only the native subprocess worker. The
  `sdk` tier (Claude Agent SDK) and the `cli` tier (Codex CLI,
  Claude Code CLI, Gemini CLI, Copilot CLI, OpenCode CLI) are
  scaffolded but rejected by dispatch admission until v0.2.
- The residency sprint at
  `docs/.superpowers/sprints/2026-04-27-local-runtime-residency.md`
  shipped behavior for all seven slices (S1 through S7) in commit
  `7d51a9b`. Test coverage in commit `299c872` covers only S1
  (LM Studio eviction) and S2 (Ollama keep_alive). S3 (llama.cpp
  probe diagnostic), S4 (doctor warning), S5 (`clio targets
  convert`), and S6 (configure wizard runtime steering) shipped
  behavior without dedicated tests. S7 is documentation. The
  sprint open questions about per-target `keep_alive` configuration
  in `settings.yaml` and silent-versus-prompt wizard steering remain
  outstanding.
- The super safety pack (`damage-control-rules.yaml` `packs[id=super]`)
  is an empty placeholder. A future iteration carries a privileged
  escalation rule list.
- `CLIO-dev.md` activation requires either a TTY for the slug
  prompt on protected branches or a non-protected branch already
  checked out. Non-interactive activation on `main`/`master`/`trunk`
  exits 1 by design.
- LM Studio passkey is observed via `options.apiKey` and forwarded
  to the SDK as `clientPasskey`; there is no first-class
  `targets[].auth.passkey` setting in the schema.
- Windows is best-effort. Full parity is Linux and macOS.
- Hot reload cannot swap engine code; the watcher classifier
  forces a restart. The boundary checker prevents the harness
  itself from importing engine, worker, TUI, or non-providers
  domain code, which is the structural reason hot reload is
  layered above the engine.
- `clio agents` discovers the built-in recipes under
  `src/domains/agents/builtins/`. Out-of-tree agent discovery
  (e.g. `<dataDir>/agents/*.md`) is design-listed in the v0.1
  plan but not yet a documented contract on this branch.
