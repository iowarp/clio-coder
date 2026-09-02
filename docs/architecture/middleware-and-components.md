# Middleware and Component Registry

> [!TIP]
> **Interactive Spec Available:** A source-checkout dashboard with a component scanner and dynamic hook-and-effect pipeline is available at [docs/html/middleware_blueprint.html](https://github.com/iowarp/clio-coder/blob/main/docs/html/middleware_blueprint.html).

Clio Coder has two related but separate surfaces:

1. **Components**: deterministic inventory of files that can affect harness behavior.
2. **Middleware**: an experimental hook/effect contract around tool, turn, and compaction lifecycle points.

The components surface is active and user-facing through `clio-coder components`. The middleware runtime is intentionally conservative in the current alpha: the hook/effect types, validation helpers, declarative rule engine, built-in registrations, and a receipted hook-file surface exist, but arbitrary repository or user middleware packages are not a shipped public extension point. Enforcing guard registrations ride the same hook runtime at the composition root: the loop guard, protected-artifacts guard, dispatch dedup, file and skill observers, tool-prose checks, and finish-contract assessor form the middleware tier of the safety net (see [safety-model.md](safety-model.md)).

---

## Component scanner

Source: `src/domains/components/scan.ts` and `src/domains/components/types.ts`.

The scanner reads files, computes SHA-256 hashes, and emits a stable `ComponentSnapshot`:

```ts
interface ComponentSnapshot {
  version: 1;
  generatedAt: string;
  root: string;
  components: HarnessComponent[];
}
```

It does not execute scanned files.

### Component kinds

`COMPONENT_KINDS` currently contains:

| Kind | Typical source | Authority |
| --- | --- | --- |
| `prompt-fragment` | `src/domains/prompts/fragments/**/*.md` | advisory |
| `agent-recipe` | `src/domains/agents/builtins/*.md` | advisory |
| `tool-implementation` | `src/tools/*.ts` | enforcing |
| `tool-helper` | selected helper files such as `src/tools/registry.ts` | enforcing |
| `runtime-descriptor` | `src/domains/providers/runtimes/**/*.ts` | runtime-critical |
| `safety-rule-pack` | `damage-control-rules.yaml` | enforcing |
| `config-schema` | `src/core/defaults.ts`, `src/core/config.ts` (scanner list in `src/domains/components/scan.ts`) | runtime-critical |
| `session-schema` | session entry/contract files | runtime-critical |
| `receipt-schema` | dispatch receipt/integrity files | runtime-critical |
| `context-file` | `CLIO-CODER.md`, `CONTRIBUTING.md`, `SECURITY.md` | advisory |
| `doc-spec` | currently `docs/specs/**/*.md` if present | descriptive |
| `middleware` | reserved kind | enforcing |
| `memory` | reserved kind | advisory |
| `eval-suite` | reserved kind | descriptive |

> [!WARNING]
> The current scanner still looks for `doc-spec` files under `docs/specs/`.
> Public reference pages now live under `docs/guide/`, `docs/architecture/`,
> `docs/process/`, and `docs/history/`, so they do not appear as `doc-spec`
> components unless the scanner's dedicated root is updated.

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
clio-coder components
clio-coder components --json
clio-coder components snapshot --out before.json
clio-coder components diff --from before.json --to after.json
```

Snapshots are useful in reviews because they show behavior-affecting changes even when the raw diff is broad.

---

## Middleware contract

Source: `src/domains/middleware/types.ts`, `validate.ts`, `budget.ts`, and `runtime.ts`.

Supported hooks:

| Hook ID | Current use |
| --- | --- |
| `before_tool` | Guard and annotate a tool call before execution. Rejected or parked attempts still reach loop detection. |
| `after_tool` | Observe or annotate a completed tool result. File mutation and skill activation observers listen here and cannot change the result. |
| `turn_start` | Inject visible `<system-reminder>` text into the accepted request. |
| `turn_end` | Buffer reminders for the next request, including stalled-turn, tool-prose, and finish-contract advisories. |
| `on_compaction` | Observe compaction events. Effects from this hook are discarded by design. |

Supported effect kinds:

| Effect | Current meaning |
| --- | --- |
| `inject_reminder` | Structured reminder payload. |
| `annotate_tool_result` | Append deterministic annotation to a tool result. |
| `block_tool` | Hard-block a tool before execution. |
| `protect_path` | Register a protected artifact path in session state. |
| `request_continuation` | Ask the chat loop for one bounded automatic continuation. |
| `require_tool` | Require a specific tool for the next turn. |
| `lock_tools` | Lock available tools to the current subset. |

Declarative rules run before coded registrations. Scoped registrations match by hook and, for tool hooks, by tool name. Hook failures emit diagnostics and later hooks still run.

Middleware hook budgets are phase-aware through `DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS`:
- `before_tool`: 25 ms
- `after_tool`: 25 ms
- `turn_start`: 50 ms
- `turn_end`: 75 ms
- `on_compaction`: 150 ms

Per-phase budgets can be overridden via `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` or global `CLIO_CODER_HOOK_BUDGET_MS`. Warmup grace exempts initial calls (`DEFAULT_HOOK_BUDGET_WARMUP_CALLS = 1`), and steady-state warnings trigger when at least 3 of the last 5 post-warmup calls exceed budget (`DEFAULT_HOOK_BUDGET_WINDOW = 5`, `DEFAULT_HOOK_BUDGET_THRESHOLD = 3`). Overruns are reported but do not abort the turn. The orchestrator and workers share the middleware contract, but worker guard state is process-local.

Middleware reminders are visible request text, not hidden prompt state. `turn_start` reminders flush into the same accepted request; `turn_end` reminders flush once on the next request. A `request_continuation` from any producer is capped at one automatic continuation per user prompt; a second producer in the same prompt gets a footer notice that the nudge is spent, and the turn is handed back to the operator rather than looped.

### Built-in registrations

These ship in every interactive session. Each is one bounded behavior with a visible reminder; none changes a tool policy or a safety verdict.

| Id | Hooks | What it does |
| --- | --- | --- |
| `nudge.stalled-turn` | `turn_end` | The one declarative rule. A turn that called no tools and ended on an announced action ("Next I will inspect `src/cli/index.ts`") is continued once with a reminder to perform it or say plainly that it is finished. Questions, "let me know", conditional offers ("if you want me to"), and completion statements are not announcements. |
| `observer.skills-reminder` | `turn_start`, `turn_end` | Once per session, on the first substantive turn, when installed or installable skills exist, injects one line teaching the suggestion protocol: list with `context(scope="skills")`, open the reply with `Suggested skill: /skill <name>` when one matches, then continue the task in the same turn. Only the operator loads a skill. At `turn_end`, a reply that made the suggestion and stopped with only listing calls behind it is continued once (#184): the suggestion is not the task. Greetings do not spend the session's one reminder; a resumed or forked session never gets one. |
| `observer.marketplace-offer` | `turn_start`, `after_tool` | On coordinator sessions, locally matches a substantive request against undeclined, uninstalled skills in Clio's marketplace and offers each matching skill at most once per session. Ordinary autonomy asks the operator through a tag-bound `ask_user` choice; `Not now` lasts for the session and `Never offer this skill` persists for that skill version. `full-auto` installs the match at project scope without the question. Both consented and autonomous installs pass the Clio-marketplace source gate, and installation never activates the skill; activation remains operator-gated. |
| `observer.task-board-reminder` | `turn_start` | Once per session, when the operator's text literally enumerates three or more steps (`1)`, `2.`, `step 3:`, or three bulleted lines), injects one line asking for `tasks action="plan"` before the first edit. Prose that merely mentions numbers never counts. |
| `nudge.open-tasks` | `turn_end` | A settled work turn (one that called tools) that ends while the session task board still has pending or active tasks is continued once with the open list. Pure conversation turns, aborted or errored turns, and boards where every remaining task is blocked do not trigger. |
| `nudge.detached-dispatch` | `turn_end` | A settled turn that ends while a detached dispatch batch has every run terminal and uncollected is continued once, naming the ready batches; `monitor mode="collect"` clears it, including across resume. Batches with runs still in flight, and surfaces without `monitor`, do not trigger. |
| `nudge.read-only-exploration` | `after_tool`, `turn_end` | After nine or more read-only calls (`read`, `grep`, `find`, `ls`, `code_nav`, read-only shell) in one user turn without a successful Scout dispatch, injects one advisory to delegate broad reconnaissance to Scout. One advisory per user turn, and only on surfaces that have `dispatch`. |
| `rail.unbacked-worker-claim` | `after_tool`, `turn_end` | A reply that reports worker or Scout results in a turn with no `dispatch` call gets one warning that the claim is not backed by a receipt. A `[worker result]` note the operator shared is receipt-backed and exempt. No continuation: the operator decides. |
| `observer.watchdog` | `after_tool`, `turn_end` | Opt-in through `watchdog.enabled` (default off). A turn that changed the tree is reviewed by one read-only `verifier` dispatch briefed with the turn's coalesced diff (per-path last-write-wins, bounded to 12 KiB) and the task board's current scope. Its failed checks become one transcript notice naming the count and the first three; a passing report emits nothing. `watchdog.cadenceToolCalls: N` also fires it every N tool calls inside the turn. One run in flight at a time; an overlapping trigger is dropped and counted. It emits no middleware effects, never continues a turn, and never mutates. Turns with no file mutations, headless runs, and ACP runs never fire it. |
| `observer.memory-intervention` | `before_tool`, `after_tool`, `turn_start`, `turn_end`, `on_compaction` | Tracks bounded task memory throughout the turn. Repeated failures and post-compaction knowledge can inject rules-only reminders without a model. Interval, error-streak, and loop triggers queue a detached background reflection at `turn_end`; it uses the configured memory route and can deliver a bounded reminder with the next submitted turn. Governed by the `context.memory` settings block. |

Two coded controls sit beside the registrations rather than among them. `tool-choice-control` turns `require_tool` and `lock_tools` effects into the provider's tool-choice field for the next round: a required tool clears when that tool starts, a lock lasts until the next submitted turn and outranks later requirements. `hook-receipts` is the durable ring (200 entries, throttled to one write per two seconds) of user-defined hook executions that `clio-coder config inspect` reads.

User-defined hook declarations load from three places: `<extensionRoot>/hooks.yaml`, `.clio-coder/hooks.yaml`, and `.clio-coder/hooks.local.yaml`. A hook can be `prompt`, `effect`, or `command`. Command hooks run an argv array without a shell, under the workspace with a timeout and bounded output, and every hook execution emits a receipt. Project files are read from disk; extension declarations come from the committed extension snapshot, which captured the `hooks.yaml` bytes during install-digest verification, so a file rewritten after verification is never reopened. A receipt for an extension hook carries the package provenance, the declarations digest, and the extension generation that admitted it.

User hooks are one owned registration set. The extensions domain publishes nothing when it starts. After the guard registrations and before the turn-end assessors, the composition root prepares boot generation 1 and its user hooks, checks that both candidates are current, and publishes their references in adjacent assignment-only calls. `/resources extensions reload` uses the same paired path for later generations. A replacement for an older or equal generation is refused during preparation; after final validation neither publication primitive can refuse or call out. Conflict diagnostics and the reload event run only after both references are live. An owned registration that would take a builtin or host id is dropped with a `registration_conflict` diagnostic; a later host registration with the same id evicts the owned one. Evaluation captures the registration list once per hook occurrence, so an asynchronous phase that started before a reload finishes against the list it started with.

---

## Validation helpers

Middleware validators enforce closed fields and known enum values. Minimal valid rule object:

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
