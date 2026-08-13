---
name: tech-spec
description: Write a typed call-stack architecture handoff — code-shaped contracts plus execution flows, implementation-ready for another engineer. User-invoked only.
version: 0.1.0
license: Apache-2.0
disable-model-invocation: true
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - context
  - code_nav
  - write
  - ask_user
requires:
  - skill:tdd
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/tech-spec
  audit: pass
  provenance: adapted
  origin: https://github.com/dmmulroy/skills/tree/main/tech-spec
  eval-status: untested
  model-size: large
  provisional: true
  agents:
    - main
---

# Tech Spec

A tech spec is a typed call-stack architecture handoff: contracts as
TypeScript pseudocode plus end-to-end execution flows. Prose explains why;
types and call stacks define what changes. Design only — never implement,
and save a file only when the user asks; otherwise return the spec inline.

## Choose the path

- **Path A — convert context to spec**: the conversation, docs, or codebase
  already describe the change.
- **Path B — interview first**: not enough problem, constraints, or
  acceptance criteria exist. Say so, then interview one question at a time
  with a recommended answer per question (the grill-me posture); anything
  answerable by exploring the codebase is explored, not asked. When context
  suffices, run Path A. Never invent requirements to skip the interview.

## Path A

1. **Load local context.** Inspect existing code and docs for vocabulary,
   module layout, error style, adapters, test conventions. Done when the
   spec introduces no pattern, library, or schema style without checking
   local precedent.
2. **Extract the design problem.** Current state, problem, callers, goals,
   non-goals, constraints, invariants, affected systems, entrypoints,
   risks. Unknowns become open questions, never plausible filler. Done when
   every claimed constraint traces to conversation, code, docs, or an open
   question.
3. **Explore alternatives.** 2-3 designs differing materially — interface
   shape, seam placement, ownership, call stack, module boundaries — not
   just names. Sketch each: domain types, interfaces, failure types, seams,
   entrypoint-to-effect call stack, test strategy, trade-offs. Compare on
   caller burden, module depth, locality of change, seam placement,
   testability through real seams, complexity. Done when the
   recommendation is chosen after the comparison, not before.
4. **Specify the contracts.** For the recommended design, every new,
   changed, or deleted type, signature, interface, error union, adapter,
   DTO, and API gets a concrete sketch — or an explicit reason no new
   contract is needed. Name what each layer may know and what must not
   leak across each seam.
5. **Specify call stacks.** Every affected behavior gets an entrypoint →
   side-effect → response trace with the type/data flow (`raw input →
   parser → domain input → service → adapter → typed result → projection →
   output`), current-vs-proposed when changing behavior, and failure /
   retry / idempotency flow where reachable.
6. **Map files.** Files to add, change, delete; test files; config or
   migration files. Each maps to the contract or call-stack step it owns.
7. **Write the TDD plan.** Vertical red-green slices per the `tdd` skill:
   one failing behavior test, minimal implementation, repeat. Cover happy
   paths, failure paths, parser rejection, invariants, changed seams — or
   state why a path is deliberately untested.

## Spec outline

Use this shape (omit sections that truly do not apply, but never omit
contracts, seams, call stacks, or the test plan for being hard):

```md
# <Title>
## Summary · Context / Current State · Goals · Non-Goals · Invariants ·
## Design Constraints
## Alternatives Considered (Option 1..3)
## Recommendation · Proposed Design
## Domain Model and Types · Types, Interfaces, and APIs
## Seams, Boundaries, Adapters, and Implementations
## Call Stacks and Data Flow (current / proposed / failure / retry)
## Files to Add / Change / Delete
## TDD Test Plan
## Risks and Open Questions
```

## Done when

The spec follows the outline, every boundary has a typed contract or a
stated reason it needs none, every behavior has a call stack, unknowns are
open questions rather than invented design, and nothing was implemented.

## Red flags

- Prose where a type signature would be more precise.
- A recommendation written before the alternatives.
- Speculative seams no invariant, boundary, or test earns.
- The same rule restated in three sections.
- "While I'm here" implementation.
