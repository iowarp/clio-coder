# Middleware and Component Registry

The [harness extensions guide](../guide/harness-extensions.md) explains how operators install command tools.

Clio Coder has two related but separate surfaces:

1. **Components**: deterministic inventory of files that can affect harness behavior.
2. **Middleware**: a hook and effect contract around tool, turn, and compaction lifecycle points.

The components surface is user-facing through `clio-coder components`. The middleware runtime carries Clio's built-in registrations and the operator's declared user hooks. Arbitrary repository or user middleware packages are not a public extension point: the only declarative rule source is `builtin`, and hook files compile into coded registrations that grant no tool authority. Enforcing registrations ride the same hook runtime at the composition root ([orchestrator.ts](../../src/entry/orchestrator.ts)). The loop guard, protected-artifacts guard, dispatch dedup, injection screen, tool-prose assessor, finish-contract assessor and citation-grounding assessor form the middleware tier of the safety net (see [safety-model.md](safety-model.md)).

---

## Component scanner

Source: [scan.ts](../../src/domains/components/scan.ts) and [types.ts](../../src/domains/components/types.ts).

The scanner reads files, computes SHA-256 hashes, and emits a stable `ComponentSnapshot`:

```ts
interface ComponentSnapshot {
  version: 1;
  generatedAt: string;
  root: string;
  components: HarnessComponent[];
}
```

It does not execute scanned files. It scans the Clio package root, not the project workspace. The root is the nearest directory with a `package.json` above the running code, or `CLIO_CODER_PACKAGE_ROOT` when that variable is set ([package-root.ts](../../src/core/package-root.ts)). The published package ships `src/`, `damage-control-rules.yaml`, `CONTRIBUTING.md` and `SECURITY.md`, so an installed Clio scans its own sources.

Each `HarnessComponent` has `id` (`<kind>:<path>`), `kind`, `path` (repository-relative with forward slashes), `ownerDomain`, `mutable` (always `true`), `authority`, `reloadClass`, `contentHash` (SHA-256 hex) and an optional `description`. Components sort by kind in the table order below, then by path.

### Component kinds

`COMPONENT_KINDS` currently contains:

| Kind | Source | Authority | Reload class |
| --- | --- | --- | --- |
| `prompt-fragment` | Markdown files under `src/domains/prompts/fragments/` | advisory | `hot` |
| `agent-recipe` | Markdown files under `src/domains/agents/builtins/` | advisory | `next-dispatch` |
| `tool-implementation` | TypeScript files under `src/tools/` except the three helpers below | enforcing | `hot` |
| `tool-helper` | [bootstrap.ts](../../src/tools/bootstrap.ts), [registry.ts](../../src/tools/registry.ts), [truncate-utf8.ts](../../src/tools/truncate-utf8.ts) | enforcing | `restart-required` |
| `runtime-descriptor` | TypeScript files under `src/domains/providers/runtimes/` | runtime-critical | `restart-required` |
| `safety-rule-pack` | one component per pack in `damage-control-rules.yaml`, id `safety-rule-pack:<pack id>`; a version 1 file is the single pack `base` | enforcing | `restart-required` |
| `config-schema` | [defaults.ts](../../src/core/defaults.ts), [config.ts](../../src/core/config.ts) | runtime-critical | `restart-required` |
| `session-schema` | [entries.ts](../../src/domains/session/entries.ts), [contract.ts](../../src/domains/session/contract.ts), [session.ts](../../src/engine/session.ts) | runtime-critical | `restart-required` |
| `receipt-schema` | [types.ts](../../src/domains/dispatch/types.ts), [receipt-integrity.ts](../../src/domains/dispatch/receipt-integrity.ts) | runtime-critical | `restart-required` |
| `context-file` | `CLIO-CODER.md`, `CONTRIBUTING.md`, `SECURITY.md` at the root | advisory | `hot` |
| `doc-spec` | `docs/specs/**/*.md` | descriptive | `static` |
| `middleware` | reserved, never emitted | enforcing | `restart-required` |
| `memory` | reserved, never emitted | advisory | `hot` |

A listed file that does not exist is skipped. `doc-spec` reads only `docs/specs/`, a directory the repository does not contain, so no `doc-spec` component appears. The public reference pages under `docs/guide/` and `docs/architecture/` are not scanned.

### Reload classes

| Reload class | Meaning |
| --- | --- |
| `hot` | Can be reread during an active process where supported. |
| `next-dispatch` | Affects the next fleet worker dispatch. |
| `restart-required` | Low-level schemas/rules/runtimes should be treated as restart-bound. |
| `static` | Descriptive specs and suites. |

---

## Component CLI

```bash
clio-coder components [list] [--json]
clio-coder components snapshot --out <path>
clio-coder components diff --from <snapshot-a.json> --to <snapshot-b.json> [--json]
```

Source: [components.ts](../../src/cli/components.ts).

- `list` is the default. It prints a component count and one row per component with kind, authority, reload class and path. `--json` prints the snapshot instead.
- `snapshot --out <path>` writes the snapshot JSON, creating parent directories, and prints `wrote <path>`. `--json` is refused with `snapshot`.
- `diff` loads two snapshots and prints `N added, N removed, N changed, N unchanged`, then one line per component marked `+`, `-` or `~` (a changed line ends with its changed field names). `--json` prints the diff object: `version`, `from` and `to` (`root`, `generatedAt`, `componentCount`), `summary`, `added`, `removed` and `changed` entries with `before`, `after` and `changedFields`. Components match by `id`, and a duplicate id in a snapshot is an error.
- Exit codes: `0` on success, `2` on a usage error (the message and help go to stderr), `1` when a snapshot for `diff` is missing, is not valid JSON, or fails the version 1 shape check.

Snapshots are useful in reviews because they show behavior-affecting changes even when the raw diff is broad.

---

## Middleware contract

Source: [types.ts](../../src/domains/middleware/types.ts), [validate.ts](../../src/domains/middleware/validate.ts), [budget.ts](../../src/domains/middleware/budget.ts), [runtime.ts](../../src/domains/middleware/runtime.ts) and [registrations.ts](../../src/domains/middleware/registrations.ts).

Supported hooks:

| Hook ID | Current use |
| --- | --- |
| `before_tool` | Guard and annotate a tool call before execution. The first `block_tool` effect decides the verdict. Rejected or parked attempts still reach loop detection. |
| `after_tool` | Observe or annotate a completed tool result. File mutation and skill activation observers listen here and cannot change the result. |
| `turn_start` | Inject visible `<system-reminder>` text into the accepted request, show operator tips, and steer the next round's tool choice. A continuation round fires it with `metadata.requestContinuation = true`, which registrations that judge the operator's request skip. |
| `turn_end` | Buffer reminders for the next request, including stalled-turn, tool-prose, and finish-contract advisories. An `error` or `aborted` stop reason applies no effects. |
| `on_compaction` | Observe compaction events. Effects from this hook are discarded by design. |

`text` on a hook input (the operator's prompt at `turn_start`, the final assistant text at `turn_end`) is cut to 16,000 characters when the runtime clones the input. A registration may also provide `evaluateAsync`, a serialized I/O phase. The chat loop awaits it after the synchronous phase at `turn_end` and runs it alone at the end of a tool batch (`after_tool` with `metadata.stage = "tool_batch_end"`). Tool admission never awaits it, and only `observer.memory-intervention` uses it.

Supported effect kinds:

| Effect | Current meaning | Applied at |
| --- | --- | --- |
| `inject_reminder` | Structured reminder payload with a `severity` of `info`, `advisory`, `warn` or `hard-block`. `source: "memory"` titles the transcript callout. `audience: "model"` marks advice for the model alone: it rides the next request and is recorded in the ledger, but never shows as a transcript callout. A `hard-block` reminder at `turn_end` interrupts the turn unless a streaming cutoff already aborted it. | `turn_start`, `turn_end` |
| `annotate_tool_result` | Append `[middleware:info]` or `[middleware:warn]` plus the message to a tool result. | `before_tool`, `after_tool` |
| `block_tool` | Hard-block a tool before execution. | `before_tool` |
| `protect_path` | Register a protected artifact path in session state. | `before_tool`, `after_tool` |
| `request_continuation` | Ask the chat loop for one bounded automatic continuation, honored only when the turn's constraints allow a continuation. An optional `note` is the footer line that says what was asked. | `turn_end` |
| `require_tool` | Require a specific tool on the next provider round. | `before_tool`, `after_tool`, `turn_start` |
| `lock_tools` | Set tool choice to `none`, so the next provider rounds answer in text only, until the next submitted turn. | `before_tool`, `after_tool`, `turn_start` |
| `notify_operator` | Show the operator a tip or info notice, keyed by the effect `key`. The model does not see it. | `turn_start`, `turn_end` |

An effect returned at any other hook is dropped. `on_compaction` applies none. A user-defined hook whose event cannot apply the effect it produces is refused at load with an issue naming the events that can, so its receipt never reports an effect that was dropped. A `prompt` hook produces `inject_reminder`, a `command` hook produces `annotate_tool_result` or, with `as: reminder`, `inject_reminder`, and an `effect` hook produces its declared kind.

One ordered table holds three registration tiers in one id namespace:

- **Fixed.** The declarative rules from [rules.ts](../../src/domains/middleware/rules.ts): `nudge.stalled-turn` and `safety.untrusted-instructions`. They are immutable and always evaluate first.
- **Host.** Coded registrations the composition root appends with `registerHook`. The first registration of an id wins.
- **Owned.** A registration set replaced as one unit under a strictly increasing generation. The only owner is `user-hooks`.

Every registration whose hook and tool names match runs in table order and its effects accumulate. `priorEffects` carries earlier effects to later registrations in the same run, which is how the protected-artifacts guard absorbs `protect_path`. A registration with `toolNames` never matches an input that has no tool name. A throwing registration emits a diagnostic, contributes no effects, and later registrations still run.

Middleware hook budgets are phase-aware through `DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS`:
- `before_tool`: 25 ms
- `after_tool`: 25 ms
- `turn_start`: 50 ms
- `turn_end`: 75 ms
- `on_compaction`: 150 ms

A budget times the synchronous `evaluate` of one registration. Per-phase budgets can be overridden via `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS`, where `<PHASE>` is the upper-case hook name (`TURN_END`), or global `CLIO_CODER_HOOK_BUDGET_MS`. Invalid or non-positive values are ignored. Warmup grace exempts the first call per registration and hook (`DEFAULT_HOOK_BUDGET_WARMUP_CALLS = 1`, override `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS`, where `0` disables the grace). Steady-state warnings trigger when at least 3 of the last 5 post-warmup calls exceed budget (`DEFAULT_HOOK_BUDGET_WINDOW = 5`, `DEFAULT_HOOK_BUDGET_THRESHOLD = 3`, override `CLIO_CODER_HOOK_BUDGET_WINDOW` and `CLIO_CODER_HOOK_BUDGET_THRESHOLD`; the threshold is capped at the window). Overruns are reported but do not abort the turn. Every post-warmup overrun, hook failure and registration conflict is published on the bus as `middleware.hookFailed`. The interactive warn notice shows hook failures and conflicts, and shows steady-state overruns once per registration and hook. A non-interactive run writes the same to stderr, with lone overruns only under `CLIO_CODER_HOOK_BUDGET_DEBUG=1`. The variables are listed in [environment variables](../guide/environment-variables.md).

The orchestrator and workers share the middleware contract, but workers evaluate tool hooks only: a worker rebuilds its middleware from the builtin declarative rules in its spec snapshot, never fires `turn_start`, `turn_end`, or `on_compaction` through it, and never receives user-defined hooks. The snapshot omits any rule that declares `notify_operator`, because a worker has no operator surface. A worker registers its own `guard.loop` and `guard.protected-artifacts` in [worker-runtime.ts](../../src/engine/worker-runtime.ts). The protected-artifacts guard starts from the parent session's snapshot and has no persistence sink. Worker guard state is process-local.

Middleware reminders are visible request text, not hidden prompt state. `turn_start` reminders flush into the same accepted request; `turn_end` reminders flush once on the next request. A `request_continuation` from any producer is capped at one automatic continuation per user prompt; a second producer in the same prompt gets a footer notice that the nudge is spent, and the turn is handed back to the operator rather than looped. The footer names what the continuation asked the model to do; the plan-close continuation stays silent because its approval card already announces the question.

### Built-in registrations

These are the advisory and observer registrations of an interactive session. Each is one bounded behavior with a visible reminder, and none changes a tool policy or a safety verdict. The surfaces named in a row are the ones that register it; a headless run omits the skills reminder, guidance and plan-close registrations.

| Id | Hooks | What it does |
| --- | --- | --- |
| `nudge.stalled-turn` | `turn_end` | A declarative rule (it travels in the worker snapshot but never fires there, because workers run no `turn_end`). A turn that called no tools, stopped normally, and ended on an announced action ("Next I will inspect [index.ts](../../src/cli/index.ts)") is continued once with a reminder to perform it or say plainly that it is finished. Questions, "let me know", conditional offers ("if you want me to"), waits on the operator, and completion statements are not announcements. |
| `observer.skills-reminder` | `turn_start`, `turn_end` | Not registered in headless runs or with skills disabled. Once per session, on the first substantive turn, when installed skills exist, injects one `[Skills]` line with the ready count. Any session that is not read-only may activate skills itself, so the line teaches loading a matching ready skill with `context(scope="skills", name="<name>")` and continuing in the same turn. When marketplace skills exist it adds that installation requires operator approval. At `turn_end`, a reply that opened with `Suggested skill:` and stopped with only listing calls behind it is continued once (#184): the suggestion is not the task. Greetings do not spend the session's one reminder; a resumed or forked session never gets one. |
| `observer.marketplace-offer` | `turn_start`, `after_tool` | Registered with skill discovery, coordinator sessions only. Locally matches a substantive request against undeclined, uninstalled skills in Clio's marketplace and offers each matching skill at most once per session. In an interactive session the reminder has the model put a tag-bound `ask_user` question with four options: `Install for this project`, `Install globally`, `Not now` and `Never offer this skill`. Both `default` and `yolo` wait for the operator's answer, and only an answer whose question carries the offer's binding tag is acted on. The tag stays out of the question the operator reads. `Not now`, `Never` or a typed answer pauses all offers for the rest of the session, and `Never` also persists for that skill version. Built-in `dispatch` and git cover their own work, so the reminder tells the model not to offer for those. A non-interactive session gets a plain line naming `clio-coder library install <name>`. Consented installs pass the Clio-marketplace source gate; installation does not itself load the skill. |
| `observer.task-board-reminder` | `turn_start` | Once per session, when the operator's text literally enumerates three or more steps (`1)`, `2.`, `step 3:`, or three bulleted lines), injects one line asking for `tasks action="plan"` before the first edit. Prose that merely mentions numbers never counts. |
| `nudge.open-tasks` | `turn_end` | A settled work turn (one that called tools) that ends while the session task board still has pending or active tasks is continued once with the open list. Pure conversation turns, aborted or errored turns, proposal and answer turns, surfaces without the `tasks` tool, and boards where every remaining task is blocked do not trigger. |
| `nudge.detached-dispatch` | `turn_end` | A settled turn that ends while a detached dispatch batch this session owns has every run terminal and uncollected is continued once. The turn controller then collects the ready batches before the next model call; `monitor mode="collect"` clears it, including across resume. Batches another session or project dispatched, batches with runs still in flight, and surfaces without `monitor` do not trigger. |
| `nudge.read-only-exploration` | `before_tool`, `after_tool`, `turn_end` | After nine or more read-only calls (`read`, `grep`, `find`, `ls`, `code_nav`, `git`, workspace-scope `context`, read-only shell) in one user turn without a successful Scout dispatch, injects one model-only advisory to delegate broad reconnaissance to Scout. One advisory per user turn, and only on surfaces that have `dispatch`. |
| `rail.unbacked-worker-claim` | `after_tool`, `turn_end` | A reply that states a worker or Scout result as fact in a turn with no `dispatch` call gets one warning that the claim is not backed by a receipt. Only a definite, specific worker followed by a result verb counts, so prose that explains how dispatch works ("when the worker has completed") does not. A `[worker result]` note the operator shared is receipt-backed and exempt. No continuation: the operator decides. |
| `observer.watchdog` | `after_tool`, `turn_end` | Opt-in through `safety.review.enabled` (default `false`, applied hot at the next turn boundary). A turn that changed the tree is reviewed by one read-only `verifier` dispatch briefed with the turn's coalesced diff (per-path last-write-wins, bounded to 12 KiB and 40 paths) and the task board's current scope. `safety.review.target` names a configured target for the run (the session's active target when unset). Its failed checks become one transcript notice naming the count and the first three; a passing report emits nothing. `safety.review.cadenceToolCalls: N` (an integer of at least 1, unset by default) also fires it every N tool calls inside the turn. One run in flight at a time; an overlapping trigger is dropped and counted. It emits no middleware effects, never continues a turn, and never mutates. Turns with no file mutations, headless runs, and ACP runs never fire it. |
| `nudge.plan-close` | `turn_start`, `after_tool`, `turn_end` | Interactive sessions with an answering `ask_user` handler only. Explicit proposal mode arms the registration on an operator turn, and so does a cached System One turn intent of `plan`. A plan-only request (`plan` wording together with `plan only`, `only a plan`, or a refusal to edit, modify, change, implement or execute) arms it regardless of the verdict. Without a turn verdict, the operator's request naming a plan (`plan`, `plans` or `planning` as a word) arms it; a fitted verdict that reads the turn as something else keeps it unarmed. When armed, a model-only turn-start reminder tells the model to end the plan text without a question or option list, so `ask_user` is the only close. At a normal stop, if no `edit`, `write` or workspace-mutating `dispatch` call occurred and no "Carry out this plan?" card was asked, it requests one continuation to ask that question without restating the plan. The card puts the recommended option first and ends with "Revise the plan first" so the operator can decline. A preliminary `ask_user` interview on another topic does not count as the close. For a plan-only request the card offers "Keep the plan (Recommended)" first, then any implementation choices, then "Revise the plan first", as one single-select question, and a trailing prose option list that repeats the card is stripped from the plan text. It never reads the reply text for classification, makes no classification call and stays quiet on continuation turns. Proposal mode's existing continuation restriction still applies. |
| `observer.guidance` | `turn_start`, `after_tool`, `turn_end` | Interactive sessions only (not headless or ACP), gated by `interface.demo` (default `true`). Scores a small lesson catalog against the turn and the operator's harness profile and shows at most one capability tip per session as a fading operator-only footer line beginning `tip: ...` after the turn. A lesson retires after 2 showings across sessions or when the operator uses its feature. The model never sees a tip. |
| `observer.decision-hints` | `turn_start` | Delivers the System One turn site's scope and plan hint lines to the main agent as an `info` reminder in the submitted message. It adds nothing on a continuation turn, when the host set explicit turn constraints, or when the site is unbound or unfitted. The plan hint is dropped when the turn controller already acted. No tool is removed or gated. See [system-one.md](system-one.md). |
| `observer.decision-prewarm` | `turn_start` | Holds the worker that a landed System One turn reading predicts, so an immediate dispatch can adopt it. It emits no effects, skips continuation turns, and holds a worker only when `fleet.speculativeDispatch` is true. See [system-one.md](system-one.md). |
| `observer.turn-outcome` | `turn_start`, `before_tool`, `after_tool`, `turn_end` | Collects host facts for the operator turn (control decision, dispatches, harness reads, clarification streak) for the ledger and System One outcome rows. It emits no effects and does not steer the turn. |
| `observer.memory-intervention` | `before_tool`, `after_tool`, `turn_start`, `turn_end`, `on_compaction` | Tracks bounded task memory throughout the turn. Repeated failures and post-compaction knowledge can inject rules-only reminders without a model. Interval, error-streak, and loop triggers queue a detached background reflection through `evaluateAsync`; it uses the configured memory route, keeps at most one call in flight, and can deliver a bounded model-only reminder at the next tool-batch boundary or the next submitted turn. A rerun the operator asked for, or one that follows a workspace change, is not counted as a repeated failure. Governed by the `context.memory` settings block. |

### Safety-net registrations

These registrations enforce or assess. The composition root registers the loop guard first, the dispatch dedup next, user hooks after the skill-activation, task-board, memory-intervention and file-mutation observers, and the protected-artifacts guard after the user hooks so it can absorb their `protect_path` effects. The tool-prose assessor registers before the finish-contract assessor so an interruption precedes the advisory in effect order. The [safety model](safety-model.md) describes what each one decides.

| Id | Hooks | What it does |
| --- | --- | --- |
| `safety.untrusted-instructions` | `after_tool` | A declarative rule scoped to `web_fetch`, `read`, `bash`, `dispatch` and `monitor`. When the raw result contains an instruction-shaped marker (checked by the registry before result shaping), it prepends the untrusted-content warning to the result as a `[middleware:warn]` annotation. It travels in the worker snapshot, so workers apply it too. |
| `guard.loop` | `before_tool`, `after_tool` | Blocks a repeated identical tool call, including attempts the safety net refused. After 2 loop blocks in a user turn it locks the turn to synthesis, with a bounded backstop that stops a model that keeps calling tools. It enforces the per-turn tool-call budget `safety.limits.chatToolCallsPerTurn` (default 60, hard ceiling 15 calls above it), applies a worker's tool-call cap, and annotates substantial identical read results across distinct arguments. The orchestrator and every worker each register one. |
| `guard.dispatch-dedup` | `before_tool`, `after_tool` | Scoped to `dispatch`. Blocks re-running a dispatch whose normalized fingerprint already completed successfully in the same user turn, a scout-only dispatch after Clio already ran Scout for orientation that turn, and an exact dispatch that already failed with `permission_required`. Orchestrator only. |
| `guard.protected-artifacts` | `before_tool`, `after_tool` | Blocks mutations of protected paths and absorbs `protect_path` effects from earlier registrations into the session's protection state. If persisting that state fails, protection stays live and every later non-read call is blocked until a trustworthy state replaces it. The orchestrator and workers each register one. |
| `assessor.tool-prose-loop` | `turn_end` | On `local-native` runtimes, a reply that narrates tool calls instead of making structured ones emits a `hard-block` reminder that interrupts the turn and carries recovery guidance into the next request. |
| `assessor.finish-contract` | `turn_start`, `before_tool`, `turn_end` | Records the state of each mutation target before the session first touches it, then at a settled `turn_end` assesses completion evidence. It emits a `warn` reminder when the change has no validation evidence or the coverage of the checks is unknown. At high rigor an unvalidated change also requests one continuation to validate or record a `limitation`. Registered when a session exists. |
| `assessor.citation-grounding` | `turn_start`, `after_tool`, `turn_end` | Records which line numbers a tool printed (a numbered `read` or a `grep` match) and which files were read without numbers. A final answer that cites a line in such a file that no tool printed is continued once with the list. Files the session changed or never read through `read` are not judged. Registered on every surface, headless included. |
| `observer.skill-activation`, `observer.file-mutation` | `after_tool` | Record successful skill activations in the session ledger and report successful file mutations to the context domain for incremental index refresh. They emit no effects, and a sink failure never changes tool execution. |

Two coded controls sit beside the registrations rather than among them. `tool-choice-control` turns `require_tool` and `lock_tools` effects into the provider's tool-choice field for the next round: a required tool clears when that tool starts, a lock lasts until the next submitted turn and outranks later requirements. `hook-receipts` is the durable ring (200 entries, throttled to one write per two seconds) of user-defined hook executions that `clio-coder config inspect` reads.

---

## User-defined hooks

User-defined hook declarations load from three places: `<extensionRoot>/hooks.yaml`, `.clio-coder/hooks.yaml`, and `.clio-coder/hooks.local.yaml`. A declaration file is a list of hooks or a map with a `hooks` list. On an id collision the later source wins in the order extension, project, project-local, and the loser is reported as overridden. A hook without an `id` gets `<extension id or origin>.<kind>.<hash>`.

| Field | Meaning |
| --- | --- |
| `on` | One of the five hooks. |
| `kind` | `command`, `prompt` or `effect`. |
| `tools` | Optional exact tool names, for tool hooks. |
| `enabled` | Optional boolean, default `true`. |

- A `prompt` hook has a `message` (non-empty, cut to 2,000 characters) and an optional reminder `severity` (default `info`).
- An `effect` hook has an `effect` object that [validate.ts](../../src/domains/middleware/validate.ts) checks for closed fields and known values. The validator rejects fields outside each effect's declared shape (`kind`, `message` and `severity` for `inject_reminder`), so a user effect cannot set `audience`, `source` or `note`.
- A `command` hook has a non-empty `argv` array run without a shell, an optional `cwd` that must resolve under the workspace, a `timeoutMs` clamped to 100 to 5,000 ms (default 2,000), and `as: annotate` (default) or `as: reminder`. The output is stdout, or stderr when stdout is empty, trimmed and capped at 4,000 characters. A timeout or empty output produces no effect. A nonzero exit with output still produces one and records `command-failed`.

Project hook files are an operator-approved surface. They load only after `clio-coder config trust hooks` approves the exact bytes; an unapproved file is skipped with a trust notice. If the files change or the approval is revoked after the hooks were published, each project hook records a `skipped` receipt and runs nothing until the operator reapproves and reloads extensions. Extension declarations come from the committed extension snapshot, which captured the `hooks.yaml` bytes during install-digest verification, so a file rewritten after verification is never reopened. A receipt for an extension hook carries the package provenance, the declarations digest, and the extension generation that admitted it.

Every hook execution emits a receipt with the hook id, origin, source path, content hash, event, kind, and an outcome of `emitted`, `command-ok`, `command-failed`, `command-timeout` or `skipped`. The ring keeps 200 receipts and persists to `hook-receipts.json` in the state directory, at most once every two seconds and again at shutdown. A hook cannot grant a permission the safety net denies. It can add effects, including `block_tool`.

User hooks are one owned registration set. The extensions domain publishes nothing when it starts. After the loop guard, dispatch dedup and those observers, and before the protected-artifacts guard and the turn-end assessors, the composition root prepares boot generation 1 and its user hooks, checks that both candidates are current, and publishes their references in adjacent assignment-only calls. If the extensions domain is missing or its candidate is rejected at boot, the project's hooks publish alone under generation 1. `/extensions reload` uses the same paired path for later generations. A replacement for an older or equal generation is refused during preparation; after final validation neither publication primitive can refuse or call out. Conflict diagnostics and the plugin resource reload, which publishes `plugins.reloaded`, run only after both references are live. An owned registration that would take a builtin or host id is dropped with a `registration_conflict` diagnostic; a later host registration with the same id evicts the owned one. Evaluation captures the registration list once per hook occurrence, so an asynchronous phase that started before a reload finishes against the list it started with.

---

## Validation helpers

`validateMiddlewareEffect` enforces closed fields and known enum values for an effect object. A worker spec's `middlewareSnapshot` is checked by `validateMiddlewareSnapshot` in [spec-contract.ts](../../src/worker/spec-contract.ts), which requires the rule fields below and `source: "builtin"`. Minimal valid rule object:

```json
{
  "id": "lab.require-validation",
  "source": "builtin",
  "description": "Require validation after generated artifact writes.",
  "enabled": true,
  "hooks": ["turn_end"],
  "effectKinds": ["request_continuation"]
}
```

Minimal valid effect object examples:

```json
{ "kind": "block_tool", "reason": "protected path", "severity": "hard-block" }
```

```json
{ "kind": "protect_path", "path": "out/checkpoint.nc", "reason": "validated output" }
```

The current `MiddlewareRuleSource` is only `builtin`. Hook files compile into coded registrations on the same runtime, but they are not custom declarative rule sources and do not grant new tool authority.
