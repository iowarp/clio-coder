# Typed Dispatch Intent: Migration and Refusal Policy

Typed dispatch intent is the structured declaration of what a dispatched worker
may read, may write, is expected to produce, and must verify. It replaces the
practice of reconstructing that answer from optional `writeRoots` plus path-like
tokens recalled from task and briefing prose.

This page is the migration contract. It names every dispatch producer and every
persisted structure typed intent touches, states what happens when intent is
omitted, partial, versioned differently, or contradictory, lists the stable
reason codes an operator or integrator can branch on, and states the measurable
condition under which the legacy inference fallback may be proposed for removal.

Related pages: [tool-usage.md](tool-usage.md) for the `dispatch` tool arguments,
[fleet-dispatch.md](fleet-dispatch.md) for fleet contracts,
[artifact-versions.md](artifact-versions.md) for the serialization registry, and
[safety-model.md](safety-model.md) for how a resolved write boundary is enforced.

---

## 1. The Shape

```jsonc
{
  "intent": {
    "read_roots":     ["src/domains/dispatch/"],
    "write_roots":    ["src/domains/dispatch/", "tests/contracts/"],
    "relevant_paths": ["docs/dispatch-typed-intent.md"],
    "expected_outputs": ["src/domains/dispatch/intent-compatibility.ts"],
    "verification":   [{ "check": "typecheck" }, { "check": "lint", "timeout_ms": 60000 }]
  }
}
```

Every path is a repository-relative POSIX path under the boundary grammar in
`src/core/path-boundary.ts`. A trailing `/` means the subtree; no trailing `/`
means that exact file. Absolute paths, `..`, `.` segments, backslashes, and
globs are refused rather than interpreted. Each list is normalized,
deduplicated, and sorted by code point, holds at most 32 entries, and each entry
is at most 512 UTF-8 bytes. `verification` holds at most 8 entries and every
`check` is a declared id resolved from package scripts or
`.clio-coder/verifiers.yaml`, never a shell command.

Normalization is in `src/domains/dispatch/intent.ts`. The normalized object
carries `version: 2` and a `pathProvenance` array binding every policy-bearing
path to the field that declared it, its provenance kind, and its confidence.
`src/domains/dispatch/path-scope.ts` resolves the request's path scope from it.
`src/domains/dispatch/intent-compatibility.ts` owns every rule on this page.

---

## 2. Compatibility Rules

Each rule resolves to exactly one of three decisions.

| Decision | Meaning | Where it surfaces |
| :--- | :--- | :--- |
| **accept** | The request is unambiguous. | Nothing is reported. |
| **warn** | The request is compatible, but its policy-bearing scope rests on something weaker than a declaration. The dispatch runs with the authority it would have had anyway. | The approval artifact renders the full resolved scope before a supervised dispatch runs; `pathScope` is sealed on the receipt. |
| **refuse** | The request states two incompatible things about authority, or states one this build cannot interpret. | Terminal admission error carrying the reason code. The dispatch never runs. |

The invariant that separates `warn` from `refuse`: **a warning is never the
difference between a narrow grant and a wide one.** No compatibility path widens
read, write, or verification authority to resolve an ambiguity. When the
compatible reading and the declared reading disagree about what a worker may
touch, the answer is a refusal, never the union of the two.

### 2.1 Omitted intent

Accepted, with a warning. Policy-bearing scope is resolved by
`legacyPathScope()`: legacy `writeRoots` become the write boundary with
provenance `derived`, and path-like tokens in the task (confidence `medium`) and
briefing (confidence `low`) become working-context paths with provenance
`inferred`.

Inferred paths select project rules and compile worker context. They never
become write boundaries and never add a verification requirement. The only path
into a write boundary without a declaration is the explicit legacy `writeRoots`
field, which the caller had to set on purpose. This is what makes omission a
warning rather than a refusal: nothing about it can widen authority.

An absolute or malformed path token in prose is not silently dropped. It throws
`DispatchPathScopeInferenceError` with code `legacy_scope_path_absolute` or
`legacy_scope_path_malformed`, because a token the inference cannot normalize is
exactly where a silent omission would hide an applicable rule.

### 2.2 Partial intent

Accepted. Every field is independently optional and an omitted list normalizes
to empty. A declaration is not required to be complete to be authoritative:
declaring only `write_roots` is a complete statement about write scope.

One partial shape gets a warning. Intent that declares `write_roots` or
`expected_outputs` but no `verification` describes work that changes the tree
with nothing the orchestrator itself runs to prove the change is sound
(`intent_partial_verification_absent`).

One partial shape is refused. An `expected_outputs` entry outside every declared
`write_root` (`intent_outputs_outside_write_roots`) means the write boundary
would block exactly the artifact the task is required to produce. Refusing that
at admission costs a rejected call; accepting it costs a full worker run that
cannot succeed.

### 2.3 Stale or unsupported version

Refused, never migrated. `DISPATCH_INTENT_SUPPORTED_VERSIONS` is `[2]` and
membership in that list is the whole test. It is deliberately not a range: a
reader that accepts "2 or newer" accepts fields it cannot interpret, and a
reader that accepts "2 or older" reads a v1 statement about authority under v2
rules. Both are the ambiguity typed intent exists to remove.

Raw model-facing intent may echo `version: 2` so a caller can replay a
declaration it was shown. Any other value fails normalization with
`intent_version_unsupported`. A normalized intent arriving on a job spec at
another version fails admission with the same code. The remedy in both messages
is the same: restate the fields on a fresh dispatch call.

### 2.4 Contradictory intent

Refused. Three contradictions are enumerated.

- **Legacy against declared write scope.** `writeRoots` and `intent.write_roots`
  resolving to different trees is `intent_write_roots_contradiction`. Neither the
  union nor the legacy field wins; the caller drops `writeRoots` and declares
  once.
- **Narrowed against enclosing scope.** A per-task intent in a batch, or any
  other narrowed declaration, reaching outside the intent it narrows is
  `intent_scope_widening`. Narrowing is monotonic: downstream may shrink and may
  never reach outside. Read scope is checked against reads plus writes, because a
  declared write root is necessarily readable.
- **Write scope against run authority.** `write_roots` declared on a request
  whose autonomy is `read-only` is `intent_write_without_authority`. Silently
  dropping the declaration would leave the request claiming a write scope nothing
  enforces.

The declared-versus-inferred case is not a contradiction and is not refused.
When a request declares intent, prose inference stops resolving scope entirely;
paths mentioned only in prose are reported as omitted through
`typed_scope_replaced_inferred_paths` and take no part in rule selection or
authority. Declared always outranks inferred.

---

## 3. Producer Compatibility Table

Every producer that can reach a worker passes through `validateJobSpec()` in
`src/domains/dispatch/validation.ts`, which is where the classifier runs. The
rules above therefore hold for every row below, including the rows that cannot
declare intent yet: those rows resolve scope by inference and are refused only
when they state a contradiction.

| Dispatch producer | Source | Typed intent | Behavior without declaration | Refuses on |
| :--- | :--- | :--- | :--- | :--- |
| **`dispatch` tool, singular `task`** | `src/tools/dispatch-arguments.ts` | Declared, top-level `intent` | Legacy inference from `writeRoots` + task/briefing tokens | All codes |
| **`dispatch` tool, batch `tasks[]`** | `src/tools/dispatch-arguments.ts` | Declared per task, shallow-merged over the top-level default | Same as singular, per task | All codes, plus `intent_scope_widening` against the top-level ceiling |
| **`dispatch` modes parallel / sequential / pipeline / detached** | `src/tools/dispatch-admission.ts` | Inherited unchanged from the task that declared it | Legacy inference | All codes |
| **`dispatch` mode compete, candidates** | `src/tools/dispatch-admission.ts` | Inherited unchanged from the single base task | Legacy inference | All codes. `verification` is refused for the mode (`verification_unsupported_for_mode`) |
| **`dispatch` mode compete, judge** | `src/tools/dispatch-admission.ts` | None. The judge is a fresh read-only request | Legacy inference over the judge's own task | All codes |
| **`dispatch` mode council, members** | `src/tools/dispatch-admission.ts` | Inherited, narrowed to read-only: declared write roots arrive as read roots | Legacy inference | All codes. `verification` is refused for the mode (`council_verification_unsupported`) |
| **`dispatch` mode council, synthesis judge** | `src/tools/dispatch-admission.ts` | None. Fresh read-only request | Legacy inference over the judge's own task | All codes |
| **`dispatch` review gate, builder** | `src/tools/dispatch-admission.ts` | Inherited unchanged | Legacy inference | All codes |
| **`dispatch` review gate, reviewer** | `src/tools/dispatch-admission.ts` | None on the request. `expected_outputs` and `verification` reach the reviewer as rendered *requirements*, never as evidence | Legacy inference over the reviewer's own task | All codes |
| **`dispatch` `apply_winner`** | `src/tools/dispatch-admission.ts` | Not applicable. Branch application runs no worker | Not applicable | Branch-shape refusals only |
| **`from_scout` continuation** | `src/tools/dispatch-scout-admission.ts` | **None today.** The compiled continuation plan carries no intent | Legacy inference per step | Contradiction codes only |
| **Fleet contract agent step (v4+ `writes:`)** | `src/domains/dispatch/fleet-run.ts` | Declared. The contract's `writes:` compiles to `relevant_paths` | Legacy inference for pre-v4 contracts and readonly steps | All codes |
| **Fleet contract gate / plan step** | `src/domains/dispatch/fleet-run.ts` | Declared, same path (`writes` is the gate path or the plan step's boundary) | Legacy inference when undeclared | All codes |
| **Fleet delegation-plan spliced step** | `src/domains/dispatch/fleet-run.ts` | Declared from the validated plan task's `writes` | Legacy inference when the task declares none | All codes |
| **Fleet code step** | `src/domains/dispatch/code-step.ts` | Not applicable. Runs a declared command, not a worker | Not applicable | Not applicable |
| **ACP delegation target** | `src/domains/dispatch/extension.ts` | Accepted and carried into the plan, but the external agent runs its own tool surface | Legacy inference | All codes, plus a hard refusal of any resolved `writeRoots` on this transport |
| **Custom agent recipe** | `src/domains/agents/` | Not a producer. A recipe narrows the tool surface and capability class; it never declares dispatch scope | Not applicable | Not applicable |
| **Extension-authored `DispatchRequest`** | Any `DispatchContract` consumer | Declared, if the extension builds one through `declaredScopeIntent()` or the normalizer | Legacy inference | All codes |
| **`clio-coder run --agent`** | `src/cli/run.ts` | **None today** | Legacy inference | Contradiction codes only |
| **`clio-coder wiki generate`** | `src/cli/wiki-generate.ts` | **None today.** Sets legacy `writeRoots` | Legacy inference plus a derived write boundary | Contradiction codes only |
| **`clio-coder bootstrap generate`** | `src/cli/bootstrap-generate.ts` | **None today** | Legacy inference | Contradiction codes only |
| **Interactive slash commands, overlays, watchdog** | `src/interactive/` | **None today** | Legacy inference | Contradiction codes only |

"All codes" means every code in section 5 that can apply to the row's shape.
"Contradiction codes only" means the row cannot declare intent, so only the
`intent_absent_legacy_inference` warning and the legacy inference errors apply.

---

## 4. Persisted and Serialized Contract Table

| Contract | Version | Carries intent | Migration policy |
| :--- | :--- | :--- | :--- |
| **`DispatchIntent`** | `2` | It *is* the intent | **Refused, never migrated.** Any other version fails admission with `intent_version_unsupported`. A stored declaration is restated on a fresh call. |
| **`DispatchPathScopeProvenance`** | `1` | Resolved scope with field source and confidence, never source prose | Sealed inside the receipt; shares the receipt's policy. |
| **Run Receipt** | `20` | `intent` and `pathScope`, both inside the integrity digest | **Refused, never migrated.** A receipt below v20 is reported as retired: intact, but never read as evidence. |
| **`ResolvedDispatchPlanArtifact`** | `3` | `intent` and `resolvedVerification` per task | **Refused, never migrated.** `resolvedDispatchPlanFromArgs` returns `null` for any version but 3, and a task whose `intent` fails `isDispatchIntent` invalidates the whole artifact. The call falls back to unresolved admission rather than executing a half-understood plan. |
| **Dispatch plan approval text and hash** | Rendered, hashed | `intent_sha256` for a declared task; the full inferred scope table for a legacy task | Not persisted across versions. The hash binds the exact rendering an operator approved. |
| **Worker Spec** | `3` | **No.** Carries the *resolved* `writeRoots`, not the declaration | Fail-closed preflight rejection. Deliberate: a worker receives an enforced boundary, never a statement of intent it could reinterpret. |
| **Execution Plan** | `4` | **No.** Carries per-step `writes` | Preflight rejects unsupported plan versions. Intent is built from `writes` at request construction, so the plan hash is unchanged by this. |
| **Fleet Contract** | `1..5` | **No.** v4+ carries per-step `writes:` | Reader refuses contracts whose version features it does not support. A pre-v4 contract declares nothing and stays on inference. |
| **Fleet Run Record** | `1` | **No** | Resume refuses a changed plan hash. Adding intent to steps does not change the hash, so existing records stay resumable. |
| **Durable Assignment Store** | `1` | **No** | Unsupported or unreadable store reads as empty. |
| **Detached Batch Store** | `1` | **No** | Unsupported version reads as empty. |
| **Code Step Record** | `1` | **No.** Deterministic command, not a worker | Records at other versions are skipped. |

Nothing is archived. Every affected structure either refuses an unsupported
version or ignores the record; no reader rewrites a stored artifact in place, so
a downgrade never encounters a file a newer build silently rewrote.

### 4.1 Determinism across source and installed-package paths

`intent-compatibility.ts` and the version rules in `intent.ts` read no
filesystem, no clock, no environment, and no package layout. The supported
version set is a compiled-in constant, not a lookup. A source checkout, a global
npm install, and a bundled `dist/` therefore classify identical input
identically, which is what makes the version policy verifiable rather than
environmental. `tests/contracts/dispatch-intent-compatibility.test.ts` asserts it
by classifying the same input from two different working directories.

The one input that is legitimately environmental is the *verification catalog*:
`check` ids resolve from the project's `package.json` scripts and
`.clio-coder/verifiers.yaml`, which are properties of the workspace, not of the
Clio installation. An undeclared id fails closed with
`verification_check_undeclared` naming both sources.

---

## 5. Reason Codes

Every code is stable and appears as the prefix of its diagnostic, in the form
`<code>: <what is wrong and what to do about it>`.

| Code | Decision | Meaning |
| :--- | :--- | :--- |
| `intent_absent_legacy_inference` | warn | No typed intent; scope came from legacy inference. |
| `intent_partial_verification_absent` | warn | Declares tree-changing work with no verification requirement. |
| `typed_scope_replaced_inferred_paths` | warn | Typed intent was declared, so prose-only paths took no part in scope. |
| `legacy_scope_inferred` | warn | Legacy dispatch resolved policy-bearing scope with no declaration. |
| `legacy_scope_empty` | warn | Legacy dispatch inferred no policy-bearing path at all. |
| `intent_version_unsupported` | refuse | `intent.version` names a version this build does not speak. |
| `intent_malformed` | refuse | Not a normalized intent for a reason other than its version. |
| `intent_write_roots_contradiction` | refuse | Legacy `writeRoots` and `intent.write_roots` name different trees. |
| `intent_outputs_outside_write_roots` | refuse | A declared output lies outside every declared write root. |
| `intent_write_without_authority` | refuse | Write roots declared on a read-only request. |
| `intent_scope_widening` | refuse | A narrowed intent reaches outside the intent it narrows. |
| `intent_path_absolute` | refuse | A declared path is absolute rather than repository-relative. |
| `intent_path_escapes_root` | refuse | A declared path escapes the repository root. |
| `intent_path_malformed` | refuse | A declared path fails the boundary grammar. |
| `intent_path_over_cap` | refuse | A list exceeds 32 entries or an entry exceeds 512 bytes. |
| `verification_malformed` | refuse | A verification entry is not `{check, timeout_ms?}`. |
| `verification_over_cap` | refuse | More than 8 verification entries. |
| `verification_check_undeclared` | refuse | A `check` id is not declared by any catalog source. |
| `gate_and_intent_verification_conflict` | refuse | `gate` combined with `intent.verification`. |
| `legacy_scope_path_absolute` | refuse | Prose inference met an absolute path token. |
| `legacy_scope_path_malformed` | refuse | Prose inference met a malformed path token. |

---

## 6. Examples

Typed intent is the default for every example below. A call that omits it still
works; it just resolves its scope from weaker evidence.

### 6.1 Main-agent call, single writer

```jsonc
{
  "agent": "coder",
  "task": "Add the compatibility classifier and wire it into job-spec validation.",
  "intent": {
    "read_roots":     ["src/domains/dispatch/"],
    "write_roots":    ["src/domains/dispatch/", "tests/contracts/"],
    "expected_outputs": ["src/domains/dispatch/intent-compatibility.ts"],
    "verification":   [{ "check": "typecheck" }, { "check": "lint" }]
  }
}
```

The `expected_outputs` entry sits under a declared write root, so it is
producible. `verification` ids resolve before approval, and the orchestrator, not
the worker, runs them.

### 6.2 Batch with a shared ceiling and per-task narrowing

```jsonc
{
  "agent": "coder",
  "intent": { "read_roots": ["src/"], "write_roots": ["src/domains/"] },
  "tasks": [
    { "task": "Refactor the ledger hub.",  "intent": { "write_roots": ["src/domains/dispatch/"] } },
    { "task": "Refactor rule selection.",  "intent": { "write_roots": ["src/domains/context/"] } }
  ]
}
```

Per-task intent shallow-merges over the top-level default and is then checked
against it as a ceiling. `"write_roots": ["docs/"]` on a task would be refused
with `intent_scope_widening`; the top-level declaration is the maximum.

### 6.3 Read-only fan-out

```jsonc
{
  "agent": "scout",
  "tasks": [
    { "task": "Map every reader of the fleet config and cite file paths.",
      "intent": { "read_roots": ["src/domains/agents/", "src/cli/"] } }
  ]
}
```

Declaring `read_roots` on a read-only dispatch does not grant anything. It
selects the project rules that apply to those trees and pins the worker's
context, which is what stops an applicable rule from being missed because the
task text happened not to spell a path.

### 6.4 Fleet contract

A fleet contract declares scope in its own artifact; no `intent` key is written
by hand.

```yaml
version: 5
name: refactor-dispatch
steps:
  - id: implement
    kind: agent
    agent: coder
    scope: workspace
    writes: ["src/domains/dispatch/", "tests/contracts/"]
```

`writes:` is compiled into the step's typed intent as `relevant_paths`, so the
contract's declaration selects project rules and compiles worker context. The
declaration keeps being *enforced* by the fleet write-boundary enforcer after
the step, which is why it is not restated as `write_roots`: that would mint a
second grant, enforced at the per-tool worker seam, which refuses outright on
the subprocess and ACP runtimes a fleet may legitimately route a step to.

### 6.5 Extension-authored request

An extension holding repository-relative paths builds intent through the domain
rather than assembling the normalized object by hand:

```ts
import { declaredScopeIntent } from "../domains/dispatch/index.js";

const built = declaredScopeIntent({ readRoots: ["src/"], writeRoots: ["src/generated/"] });
if (!built.ok) throw new Error(`${built.reason}: ${built.message}`);
await dispatch.dispatch({ agentId: "coder", executionRole: "builder", task, intent: built.intent });
```

`declaredScopeIntent` runs the same normalization, caps, and provenance
construction the dispatch tool uses, so an extension cannot mint an intent shape
the tool could not. It deliberately does not accept `verification`: a declared
check id means nothing until it is resolved against the workspace catalog, and
that resolution belongs to the admission controller that owns the catalog.

### 6.6 ACP delegation

Typed intent is accepted on a delegation request and is rendered into the
approval artifact, so an operator sees the declared scope before an external
agent starts. It grants nothing on that transport: the external agent runs its
own tool surface, Clio mediates no per-tool call, and any resolved `writeRoots`
is refused outright rather than accepted and left unenforced.

---

## 7. Retirement Criterion for Legacy Inference

Removing the inference fallback requires a later explicit issue. This is the
gate that issue has to clear, and it is measured rather than argued.

`pathScope.mode` is sealed on every receipt, so the share of dispatches still
resolving policy-bearing scope from prose is a fact in the evidence store.
`dispatchIntentAdoption()` in `src/domains/dispatch/intent-compatibility.ts`
computes it, reading nothing but that mode field so the aggregate is safe to
report from receipts whose prose must not be quoted.

The criterion is met when, over a window of receipts:

- at least `DISPATCH_INTENT_RETIREMENT_MIN_SAMPLE` (200) receipts carry a
  resolved `pathScope`, and
- at most `DISPATCH_INTENT_RETIREMENT_MAX_LEGACY_SHARE` (2%) of them have
  `mode: "legacy-inferred"`.

A window with no measured receipts reports `legacyShare: null` and is never
ready, so an empty evidence store cannot read as full adoption. The producer
rows in section 3 marked **None today** are the concrete work that has to land
before the share can fall: each is a producer that cannot currently declare, so
each one contributes to the legacy count no matter how the model behaves.
