# Middleware and Component Registry

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with an interactive component scanner and a dynamic hook-and-effect pipeline is located at [docs/html/middleware_blueprint.html](html/middleware_blueprint.html) (Version: 0.2.4).

Clio Coder has two related but separate surfaces:

1. **Components**: deterministic inventory of files that can affect harness behavior.
2. **Middleware**: an experimental hook/effect contract around tool, turn, and compaction lifecycle points.

The components surface is active and user-facing through `clio components`. The middleware runtime is intentionally conservative in the current alpha: the hook/effect types, validation helpers, declarative rule engine, and built-in registrations exist, but repository or user middleware packages are not yet a shipped public extension point. Enforcing guard registrations ride the same hook runtime at the composition root: the loop guard, protected-artifacts guard, dispatch dedup, file and skill observers, tool-prose checks, and finish-contract assessor form the middleware tier of the safety net (see [safety-model.md](safety-model.md)).

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
| `config-schema` | `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/config/schema.ts` | runtime-critical |
| `session-schema` | session entry/contract files | runtime-critical |
| `receipt-schema` | dispatch receipt/integrity files | runtime-critical |
| `context-file` | `CLIO.md`, `CONTRIBUTING.md`, `SECURITY.md` | advisory |
| `doc-spec` | currently `docs/specs/**/*.md` if present | descriptive |
| `middleware` | reserved kind | enforcing |
| `memory` | reserved kind | advisory |
| `eval-suite` | reserved kind | descriptive |

> [!WARNING]
> The current scanner still looks for `doc-spec` files under `docs/specs/`. Most public docs now live flat under `docs/*.md`, so public docs may not appear as `doc-spec` components until the scanner is updated.

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
clio components
clio components --json
clio components snapshot --out before.json
clio components diff --from before.json --to after.json
```

Snapshots are useful in reviews because they show behavior-affecting changes even when the raw diff is broad.

---

## Middleware contract

Source: `src/domains/middleware/types.ts`, `validate.ts`, and `runtime.ts`.

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

Declarative rules run before coded registrations. Scoped registrations match by hook and, for tool hooks, by tool name. Hook failures emit diagnostics and later hooks still run. Soft-budget overruns are reported but do not abort the turn. The orchestrator and workers share the middleware contract, but worker guard state is process-local.

Middleware reminders are visible request text, not hidden prompt state. `turn_start` reminders flush into the same accepted request; `turn_end` reminders flush once on the next request. The built-in stalled-turn rule can request one automatic continuation for a user prompt, then stops rather than looping forever.

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

The current `MiddlewareRuleSource` is only `builtin`; repository/user middleware package loading is not yet a shipped public extension point.
