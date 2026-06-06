# Middleware and Component Registry

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with an interactive component scanner and a dynamic hook-and-effect pipeline is located at [docs/html/middleware_blueprint.html](html/middleware_blueprint.html) (Version: 0.2.1).

Clio Coder has two related but separate surfaces:

1. **Components**: deterministic inventory of files that can affect harness behavior.
2. **Middleware**: an experimental hook/effect contract around model/tool/session/dispatch lifecycle points.

The components surface is active and user-facing through `clio components`. The middleware runtime is intentionally conservative in the current alpha: the hook/effect types and validation helpers exist, but the built-in rule list is empty and the default runtime returns no effects.

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

| Hook family | Hook IDs |
| --- | --- |
| Model | `before_model`, `after_model` |
| Tool | `before_tool`, `after_tool`, `on_blocked_tool` |
| Finish/retry/compaction | `before_finish`, `after_finish`, `on_retry`, `on_compaction` |
| Dispatch | `on_dispatch_start`, `on_dispatch_end` |

Supported effect kinds:

| Effect | Current meaning |
| --- | --- |
| `inject_reminder` | Structured reminder payload. |
| `annotate_tool_result` | Append deterministic annotation to a tool result. |
| `block_tool` | Hard-block a tool before execution. |
| `protect_path` | Register a protected artifact path in session state. |
| `require_validation` | Validation requirement signal. |
| `record_memory_candidate` | Candidate lesson plus evidence refs. |

`src/tools/registry.ts` already knows how to consume `before_tool` and `after_tool` effects returned by a middleware contract. In the default alpha build, `runMiddlewareHook()` returns an empty effect list.

---

## Validation helpers

Middleware validators enforce closed fields and known enum values. Minimal valid rule object:

```json
{
  "id": "lab.require-validation",
  "source": "builtin",
  "description": "Require validation after generated artifact writes.",
  "enabled": true,
  "hooks": ["after_tool"],
  "effectKinds": ["require_validation"]
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
