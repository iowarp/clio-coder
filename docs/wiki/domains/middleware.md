---
title: "Middleware hooks and registrations"
summary: "How the middleware domain evaluates ordered hook registrations against tool and turn events, how owned registration sets are replaced under generations, and how user-defined hooks are loaded and receipted. Read this before changing hook evaluation, registration tiers, or user hook declarations."
sources:
  - "src/domains/middleware/index.ts"
  - "src/domains/middleware/runtime.ts"
  - "src/domains/middleware/registrations.ts"
  - "src/domains/middleware/hooks.ts"
  - "src/domains/middleware/extension.ts"
symbols:
  - "MiddlewareDomainModule"
  - "runMiddlewareRegistrations"
  - "runMiddlewareAsyncRegistrations"
  - "registrationFromRuleDefinition"
  - "createMiddlewareRegistrationTable"
  - "MiddlewareHookRegistration"
  - "normalizeUserHook"
  - "loadUserHooks"
  - "userHookToRegistration"
tests:
  - "tests/contracts/middleware-hooks.test.ts"
invariants:
  - "Within one hook run, registrations are evaluated in table order and every matching registration runs; a registration that throws is reported as hook_failed and contributes no effects."
  - "An owned registration set is replaced as one unit only under a strictly greater integer generation; an equal or lower generation is refused with reason stale, and an unknown owner is refused with reason unknown-owner."
  - "An owned registration whose id collides with a fixed rule or an existing host registration is dropped at replacement and reported as a registration_conflict diagnostic, not evaluated."
  - "A user hook declaration that is malformed, or that pairs an event with an effect the orchestrator does not apply there, is rejected with issues and never throws into a turn."
  - "A command user hook runs as an argv array without a shell, with its cwd required to resolve under the workspace root and its timeout clamped to the declared minimum and maximum."
validate:
  - "pnpm run test:file -- tests/contracts/middleware-hooks.test.ts"
---

# Middleware hooks and registrations

The middleware domain is the ordered evaluation layer that runs at tool and turn boundaries. A caller hands it a hook input (for example `before_tool` with a tool name and arguments), it runs every registration that subscribes to that hook, and it returns the accumulated effects and fired-rule records. Readers need this page when they change how a hook is evaluated, how extensions or project configuration add registrations, or how a user-declared hook is validated.

## What the area does

- Holds one ordered table of hook registrations in three tiers that share one id namespace: fixed declarative rules, host registrations appended by the composition root, and owned sets replaced by an owner under a generation number. The table is built in `createMiddlewareRegistrationTable` in `src/domains/middleware/registrations.ts`.
- Evaluates registrations synchronously with `runMiddlewareRegistrations` in `src/domains/middleware/runtime.ts`, and asynchronously for awaited phases with `runMiddlewareAsyncRegistrations`.
- Turns declarative rule definitions into coded registrations through `registrationFromRuleDefinition`.
- Validates and loads user-defined hooks (`prompt`, `effect`, and `command` kinds) in `src/domains/middleware/hooks.ts`, and converts each accepted hook into a registration with `userHookToRegistration`.

`src/domains/middleware/index.ts` is the barrel and the domain entry. `MiddlewareDomainModule` pairs the manifest with `createMiddlewareBundle` from `src/domains/middleware/extension.ts`. That bundle constructs the registration table with the builtin rule definitions as its fixed tier and exposes `runHook`, `prepareRegistrationReplacement`, `replaceRegistrations`, and `ownedGeneration`. Its registration sink defaults to `writeMiddlewareDiagnosticToStderr` and is replaced by the composition root through the bundle options.

## Registration model

`MiddlewareHookRegistration` (in `src/domains/middleware/runtime.ts`) is the coded form of a rule. It carries an `id`, the `hooks` it subscribes to, an optional `toolNames` filter, a synchronous `evaluate`, and an optional `evaluateAsync` with an `awaited` flag. `registrationMatchesTool` applies the tool filter: a registration without `toolNames` sees every call, and a call with no tool name never matches a registration that declares one. A `matchesTool` predicate, when present, replaces exact name membership; it falls back to a match if it throws.

`MiddlewareRuleDefinition` is the declarative form. `evaluateRuleDefinition` honors the rule's `enabled` flag, its `hooks`, its tool scoping, an optional pure `predicate`, and drops any effect whose kind is not listed in `rule.effectKinds`.

## Evaluation flow

`runMiddlewareRegistrations(input, registrations, options)` is called by the bundle's `runHook` with the captured `table.list()`:

1. A registration is skipped unless its `hooks` include `input.hook` and `registrationMatchesTool` accepts `input.toolName`.
2. `evaluate` receives a clone of the input and a context whose `priorEffects` holds the effects emitted so far in this run, plus an `evidence` callback that names what triggered the effects.
3. A throw is caught and emitted as a `hook_failed` diagnostic, with the hook occurrence's session, run, turn, and tool call attached through `withToolTelemetryContext`. The registration contributes nothing.
4. The elapsed time is recorded in the budget tracker. A post-warmup overrun emits a `budget_exceeded` diagnostic; only steady-state overruns carry `steadyStateWarn`, and the stderr writer prints only those unless `CLIO_CODER_HOOK_BUDGET_DEBUG=1`.
5. Emitted effects are cloned and appended. The result carries `effects`, `ruleIds`, and `fired` records, which the bundle passes to `recordFiredRules`.

`runMiddlewareAsyncRegistrations` runs only registrations with `evaluateAsync`, in order, and skips an `awaited` tool-hook registration when the input has no tool name. The bundle's async path, which is consumed by the tool registry and turn middleware, is not traced further on this page.

## Registration tiers and replacement

`createMiddlewareRegistrationTable` in `src/domains/middleware/registrations.ts` keeps one immutable state object behind a single reference. Writers compute a complete next state and publish it with one assignment, so an evaluation that captured `list()` before a publish keeps the state it started with.

- Fixed tier: rules passed as `options.fixed`. Their ids always win.
- Host tier: `registerHook` appends a registration. A host id that already exists in the fixed or host tier is ignored. An id held by an owned set is evicted from that set, with an `evicted` diagnostic emitted after the publish.
- Owned tier: `MIDDLEWARE_REGISTRATION_OWNERS` currently holds `"user-hooks"`. `prepareReplacement` rejects an unknown owner or a generation that is not a larger integer than the owner's current generation. Otherwise it drops offered registrations that collide with a fixed id, a host id, or an earlier id in the same set, and builds the next state. Dropped entries become `registration_conflict` diagnostics that are emitted only after publication.

`replaceRegistrations` combines preparation, a `current()` check (reference identity against the state that was prepared), publication, and conflict emission. A returned `dispose()` removes the generation's registrations only if that generation is still active, so a stale disposer is a no-op.

The focused test `tests/contracts/middleware-hooks.test.ts` exercises this surface. Its test "replaces an owner's set as one unit under a strictly increasing generation" replaces generation 1 and then 2, then offers generations 2, 1, 0, and 1.5 and asserts each is refused with `reason: "stale"` and `activeGeneration: 2`, while the probe still returns only the generation 2 rule id. Its test "makes a stale disposer harmless and lets a prepared replacement refuse after supersession" covers the disposer behavior. Lines near 421 to 454 of that file assert `registration_conflict` diagnostics. This test is the only focused test found for the registration table in the search of `tests` for `replaceRegistrations`, `registration_conflict`, and `stale`; no execution result is claimed here.

## User-defined hooks

`src/domains/middleware/hooks.ts` defines three closed kinds: `prompt` (emits one `inject_reminder`), `effect` (emits one declared middleware effect verbatim), and `command` (runs an argv without a shell and emits its bounded output as `annotate_tool_result` or `inject_reminder` according to `as`). The module comment states that hooks can only add effects and cannot override the safety policy.

`normalizeUserHook(raw, source, options)` validates one declaration and returns either a `NormalizedUserHook` or a list of issues. The checks visible in source are:

- `on` must be one of the five middleware hook names.
- `tools`, when present, must be an array of non-empty strings.
- For `command`, `argv` must be a non-empty string array. `cwd` is resolved against `options.workspaceRoot` and rejected unless it stays within that root. `timeoutMs` is clamped to the range from `USER_HOOK_COMMAND_TIMEOUT_MIN_MS` to `USER_HOOK_COMMAND_TIMEOUT_MAX_MS`, defaulting to `USER_HOOK_COMMAND_TIMEOUT_DEFAULT_MS`.
- For `prompt`, `message` is truncated to `USER_HOOK_PROMPT_MAX_CHARS`.
- For `effect`, the payload is checked by `validateMiddlewareEffect`.
- `applicabilityIssue` rejects an event that cannot apply the produced effect kind, using the `USER_HOOK_APPLIED_EFFECTS` table. For example, `on_compaction` applies no effects, and `turn_end` applies only `inject_reminder`, `request_continuation`, and `notify_operator`.

`loadUserHooks(batches, options)` sorts declaration batches by `USER_HOOK_ORIGIN_ORDER` (`extension`, `user`, `project`, `project.local`), so a later origin wins an id collision. Each collision is recorded in `overridden`, and each rejected declaration is recorded in `issues`. Hook ids default to `sourceId or origin` plus kind and a content hash when no `id` is given.

`userHookToRegistration(hook, deps)` builds the registration. Its `evaluate` returns `[]` when the hook is disabled, emits a `skipped` receipt when `deps.isTrusted()` returns false, and otherwise evaluates the hook. Every execution calls `deps.recordReceipt` with a `HookReceipt`, and a thrown error becomes a `skipped` receipt. The extension attribution (`HookReceiptExtension`) is copied from the source when the hook came from an installed extension.

The declaration-reading side (`readHookSources`, `buildUserHookRegistrations`, `spawnSyncCommandRunner`) lives in `src/domains/middleware/hooks-io.ts`, which is not read. Its behavior is not described here.

The test file `tests/contracts/middleware-hooks.test.ts` imports `normalizeUserHook` and `buildUserHookRegistrations` and runs them through the middleware bundle. The specific user-hook assertions in that file were not individually read for this page.

## Other registrations

`src/domains/middleware/dispatch-nudge.ts`, `guidance.ts`, `src/domains/middleware/marketplace-offer.ts`, and `src/domains/middleware/skills-reminder.ts` each export a `create...Registration` factory and a stable `...REGISTRATION_ID` constant. They are coded registrations that the composition root adds as host entries. Their internal logic was not read for this page; only their export names and the shared `MiddlewareHookRegistration` shape were confirmed.

## Things to watch when editing

- Replacement is generation-gated. A caller that replaces an owned set must pass a generation strictly greater than `ownedGeneration`. Reusing a generation is refused, not merged.
- Table state is copy-on-write. Code that mutates a `list()` result or an owner slot in place bypasses publication; the table freezes these arrays.
- A registration that adds an id already held by a fixed or host registration is silently ignored by `registerHook`. A conflicting owned id is dropped, not evicted, when it is offered as part of a replacement.
- Effects are cloned on the way in and out. A new effect kind must be added to `cloneMiddlewareEffect` in `src/domains/middleware/runtime.ts`, and to the applicability table in `src/domains/middleware/hooks.ts` if user hooks may produce it.
- A user hook's `cwd` must resolve under the workspace root. A user hook cannot grant a permission the safety layer would deny; this is stated in the `src/domains/middleware/hooks.ts` module comment, and the enforcing path was not traced here.
- Diagnostics are emitted after publication. Anything a diagnostic sink does that re-enters the table sees the state already published.
