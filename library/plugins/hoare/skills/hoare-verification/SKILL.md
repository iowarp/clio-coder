---
name: hoare-verification
description: Reviews named functions for correctness with Hoare logic. States each precondition and postcondition with its source, adds loop invariants, variants and frame conditions, derives the verification conditions with the language's hazard obligations, and discharges each one by a declared prover check or a written argument. Reports every obligation with an honest status. Use for C, C++, Python or Fortran functions that have a statable contract. Not for whole programs, concurrency proofs or floating-point error analysis; those are reported as limitations.
version: 0.1.0
license: Apache-2.0
triggers:
  - hoare logic
  - prove this function correct
  - loop invariant
  - correctness report
  - verify preconditions and postconditions
  - formal correctness review
allowed-tools:
  - read
  - grep
  - find
  - ls
  - verify
clio-coder:
  registry-id: hoare-verification
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/plugins/hoare
  agents:
    - main
    - hoare-verifier
---

# Hoare-logic correctness review

Produce a correctness report for a small, named set of functions. The report is a
list of proof obligations. Each obligation states what must hold, why it holds or
fails, and how strongly that was established.

A proof you write in prose is an argument, not a machine-checked proof. Keep that
difference visible in every obligation. Never upgrade a status to make the report
read better. A report that says `unknown` is useful. A report that says `argued`
when the argument has a gap is a false correctness signal.

Read the linked references when needed. Resolve links from this skill directory.

- [method.md](references/method.md): the proof rules, verification-condition
  generation, invariant and variant construction, and counterexample search.
- [lang-c-cpp.md](references/lang-c-cpp.md), [lang-python.md](references/lang-python.md),
  [lang-fortran.md](references/lang-fortran.md): the hazard obligations each
  language adds to the textbook rules.
- [provers.md](references/provers.md): which tools can mechanize an obligation and
  how a project declares one as a `verify` check.
- [report.md](references/report.md): the report layout and the `verifier-report`
  mapping a worker returns.
- [example-report.md](references/example-report.md): a complete worked report for
  a C binary search with a refuted overflow obligation. Read it once before your
  first report to calibrate depth and tone.

## Status vocabulary

| Status | Meaning | Counts as established |
| --- | --- | --- |
| `mechanized` | A declared prover check, run through `verify` in this run, proved the obligation on the real source. | yes |
| `modeled` | A prover proved it on a translation (Dafny, Why3) of the source. Every place the translation differs from the language's semantics is listed. | yes, with the listed gaps |
| `argued` | A complete written argument: every step is a rule application or a stated arithmetic fact. | yes, weakest |
| `assumed` | Taken as given and named: a callee or library contract, an out-of-scope hazard, or a caller's documented duty. | yes, as an assumption only |
| `refuted` | A concrete input that satisfies the precondition and violates the obligation, traced step by step. | no: a defect |
| `unknown` | Not established either way: no invariant found, a gap in the argument, or the budget ran out. | no |

A bounded tool (CBMC without unwinding assertions, CrossHair, Hypothesis, a test
run) can produce `refuted`. It cannot produce `mechanized`, because finding no
counterexample within a bound is not a proof.

## Procedure

1. **Fix the scope.** Name each target as `path:function`. Identify the language
   and read its hazard reference. For a language without a reference, say so in the
   report's limitations and apply only the general rules in method.md. Prefer
   `code_nav` or `grep` to find the callees each target depends on.
2. **State the specification.** For each target, write the precondition `P` and
   the postcondition `Q` as logical formulas over the inputs, the outputs, and the
   pre-state (`old(x)`). Record the source of each clause:
   - `task`: the task or operator request
   - `contract`: a validation contract, ACSL or other annotations, `assert`s, or type declarations
   - `docs`: a docstring, comment or design document, cited by line
   - `tests`: what existing tests require (weak: it shows intent, not completeness)
   - `inferred`: your own reading of the function's name and role

   Never take the postcondition from the implementation itself. "Returns what the
   loop computes" is circular and proves nothing. If an `inferred` clause carries the
   main claim, say so at the top of the report. The verdict is only as strong as the
   specification.
3. **Annotate.** For each loop, write an invariant `I`, and for total correctness a
   variant `V` that is bounded below and strictly decreases. For each call, state
   the callee's contract or mark it `assumed`. Write the frame: what the function may
   modify, and that everything else is unchanged.
4. **Generate the obligations.** Follow method.md: invariant initialization,
   preservation, exit-implies-postcondition, the variant's decrease and bound, each
   callee's precondition at its call site, and each exit path (return, exception,
   early exit) against its own postcondition. Then add the hazard obligations from
   the language reference, such as no overflow, indices in bounds, no undefined
   behavior, and separation of aliased arguments.
5. **Discharge each obligation.** Call `verify()` once to list the declared checks.
   When a declared prover check covers the target, run it by its exact ID and record
   the outcome. Otherwise write the argument. For each obligation you cannot
   establish, search for a counterexample by method.md's procedure before you mark it
   `unknown`.
6. **Report.** Write the report as report.md describes. List the obligations
   first, then the limitations: hazards out of scope, assumed contracts, unanalyzed
   callees, inferred specification clauses.

## Running as a worker or interactively

As the `hoare-verifier` worker, you are read-only. Return the `verifier-report`
mapping in report.md and nothing else. Do not edit source, add annotations to
files, or create a verifier catalog entry. Put any proposed annotations or catalog
entries in the report's evidence text.

In an interactive session, write the Markdown report to a path the operator names.
When no path is named, give the report in the conversation instead. Add annotations
to source files only when the operator asks for them.

## Scope limits

This method fits functions and small modules whose callees have contracts. Report
these as limitations instead of arguing them away:

- concurrency of any kind (threads, OpenMP, MPI, coarrays, GPU kernels, async)
- floating-point accuracy beyond the simple facts in method.md
- I/O, the environment, FFI and dynamically loaded code
- dynamic code (`eval`, monkey-patching, reflection)
- performance and memory bounds
