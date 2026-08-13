---
name: coding-standards
description: "Use when writing or refactoring TypeScript and the project has not pinned its own conflicting standards — new modules, error-handling design, schema parsing, module boundaries — or when another skill needs a TypeScript standards reference. Correct-by-construction rules: errors as values, parse don't validate, illegal states unrepresentable, deep modules, functional core / imperative shell."
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/coding-standards
  audit: pass
  provenance: adapted
  origin: https://github.com/dmmulroy/skills/tree/main/coding-standards
  eval-status: untested
  model-size: any
  provisional: true
  agents:
    - main
    - coder
---

# Coding Standards (TypeScript, correct-by-construction)

Reference, not a workflow. Apply to new and refactored code. When rules
pull in different directions: correctness and debuggability first, then
these standards, then compatible project conventions; contain incompatible
existing patterns at the nearest boundary instead of copying them into new
code, and never rewrite unrelated old code without an explicit migration
request. **The host project's own documented standards always win over
this file.**

## Errors

- Expected failures are values in the return type, as custom tagged
  errors; callers handle or return them upward, and the outermost boundary
  translates them (HTTP response, exit code, retry decision). Use the
  repo's established result mechanism; absent one, a small local tagged
  union `{_tag: "ok"|"err", ...}` suffices.
- Promise rejection is throwing. Catch unclassified third-party rejections
  inside the owning adapter and translate before they cross its boundary.
- Throw only for defects: violated invariants, impossible branches,
  not-yet-implemented paths. A missing config value is an expected startup
  failure, not a defect.
- Custom errors carry: a stable `_tag` (`as const`), a useful message,
  structured context fields, optional `cause: unknown`. Keep error unions
  precise at module boundaries; broad `AppError` types belong only near
  entrypoints and rendering.

## Parse, don't validate

- Boundary code turns `unknown` input into domain types before it enters
  inner code; inner code never re-checks what a parser proved.
- `parseX(input): Result<X, ParseXError>` for untrusted input; `makeX` for
  smart construction from typed pieces; `isX` for predicates. A function
  returning a refined value is a parser — do not name it `validateX`.
- Schema libraries are boundary parsers, not validators sprinkled through
  core logic; use the repo's established one. Never pass a schema-inferred
  transport shape through the application.
- Brand types where a mix-up is realistic: IDs (`UserId` vs `OrgId`),
  parsed strings (`EmailAddress`), units (`Milliseconds`, `Bytes`).
  Construct branded values only through their parser.

## Illegal states unrepresentable

- Lifecycle states are tagged unions, not boolean fields:
  `{_tag:"Draft"|...}` beats `{isSent, isPaid, sentAt?, paidAt?}`.
- No behavior-controlling boolean parameters: `createUser(input,
  {emailVerification:"skip"})`, never `createUser(input, true)`.
- Push optionality outward: branch or parse before calling, not
  `undefined` checks inside every callee. `Partial<T>` is not an
  application input unless partiality is the domain concept.

## Modules

- Three responsibilities, not three mandatory layers: **domain** (meaning,
  invariants, pure transitions — no I/O, no ambient time or randomness),
  **application service** (policy and effect ordering through narrow,
  application-owned ports), **adapter** (one boundary's technology and
  translation; raw external types never leak out of it). Wire concrete
  adapters to ports at the composition root only.
- Deep modules: substantial behavior behind a low-burden interface.
  Deletion test: removing a module that makes complexity disappear was
  pass-through waste; removing one that spreads complexity across callers
  was earning its keep.
- Audit existing adapters/services before creating one: reuse as-is,
  extend if cohesive, create new only when reuse would couple wrongly.

## Testing

- Prefer, in order: end-to-end through real public entrypoints;
  integration through real seams; property tests for pure domain modules;
  unit tests of meaningful behavior.
- Never module-mock (`vi.mock`/`jest.mock`). Real seams: injected
  interfaces, local DB substitutes, in-memory or fake adapters.
- Assert observable outcomes (returned value, persisted state, emitted
  event), not call sequences. Tests never bypass parsers or invariants.

## Style and safety

- Strict compiler settings (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). Immutable by default (`readonly`,
  `ReadonlyArray`); mutation stays localized behind precise interfaces.
- No `any`, no `!`, no `as` casts (`as const` is fine). The rare
  justified cast carries a `// SAFETY:` comment explaining why the
  invariant holds and why the type system cannot express it.
- Direct imports from owning files; no barrel layers by default. Precise
  file names (`email-address.ts`), never `utils.ts`/`helpers.ts`.
- Parse env/config at startup into typed config; no `process.env` reads
  scattered through the app; no import-time side effects outside true
  entrypoints. Secrets live in `Redacted`-style wrappers, unwrapped only
  at the adapter that needs the raw value, and never appear in errors,
  logs, or traces.
