# Hoare pack

A correctness review for individual functions, based on Hoare logic. The
reviewer states each function's precondition and postcondition and where they came
from. It adds loop invariants, variants and frame conditions, and derives the
verification conditions together with the hazards of the function's language. It
then discharges each obligation by a declared prover check or by a written
argument.

```bash
clio-coder library install plugin:hoare --project
```

| Component | Kind | Use |
| --- | --- | --- |
| `hoare-verification` | skill | The method, hazard profiles for C/C++, Python and Fortran, prover guidance and the report layout |
| `hoare-verifier` | agent | Read-only reviewer that returns a `verifier-report`, one check per obligation |
| `/hoare:review` | prompt | Dispatches the reviewer and renders a Markdown correctness report |
| `hoare-build-review` | playbook | Coder, then the Hoare reviewer as the check in a bounded revise loop |

## What a report claims

Each obligation carries one status, and the report never merges them:

| Status | Established by |
| --- | --- |
| `mechanized` | A prover check declared in `.clio-coder/verifiers.yaml`, run through `verify` on the real source |
| `modeled` | A prover run on a Dafny or Why3 translation, with the translation's semantic gaps listed |
| `argued` | A complete written argument. This is a careful review, not a machine-checked proof. |
| `assumed` | A named assumption: a callee contract, an out-of-scope hazard, or the caller's duty |
| `refuted` | A concrete input satisfying the precondition, traced to the violation |
| `unknown` | Neither established nor refuted |

The requested assurance (`argued` by default, or `modeled` or `mechanized`) decides
which statuses pass. A reviewer working without a prover can report at most
`argued`. A bounded tool such as CBMC without unwinding assertions, CrossHair,
Hypothesis or a sanitizer run can refute an obligation, but cannot establish one.

## Limits

- The verdict is only as strong as the specification. The reviewer never takes a
  postcondition from the implementation, and it marks clauses it inferred from
  names and roles.
- The method fits functions and small modules whose callees have contracts. It is
  not whole-program verification.
- Concurrency (threads, OpenMP, MPI, coarrays, GPU, async), I/O, FFI, dynamic code,
  and floating-point accuracy beyond simple standard-model bounds are reported as
  assumptions, not proved.
- Mechanization depends on the language. C has Frama-C/WP and CBMC, and Python has
  Nagini for a typed subset. C++ and Fortran usually go through a translation and
  report `modeled`.
- Other languages get the general rules only, and the report says that no hazard
  profile was applied.

The pack ships no executable code and runs no prover itself. A project opts into
mechanization by declaring prover checks; see
`skills/hoare-verification/references/provers.md`.
