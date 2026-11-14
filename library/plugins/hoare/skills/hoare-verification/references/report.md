# Correctness report

## Enforced assurance

The selected recipe fixes the result policy; prompt text cannot change it.

| Recipe / assurance | Statuses that pass |
| --- | --- |
| `hoare-verifier` / `argued` | `mechanized`, `modeled`, `argued` |
| `hoare-modeled-verifier` / `modeled` | `mechanized`, `modeled` |
| `hoare-mechanized-verifier` / `mechanized` | `mechanized` |

`assumed`, `refuted` and `unknown` never pass. Ambient assumptions must be explicit
in the precondition and evidence. An outstanding assumed goal is not a proof.
CLIO checks the mapping and verdict, not the mathematical validity of prose.

## Worker result

Return only one JSON object. Every check is an obligation:

```json
{"verdict":"fail","assurance":"argued","checks":[
  {"name":"mean.L11.int.signed-overflow","passed":false,
   "evidence":"C, total correctness; post from docs L8, input bounds inferred. a={INT_MAX,1}, n=2 reaches s=INT_MAX+1 at L11, which is UB. No prover ran. Assumes no concurrent writes.",
   "obligation":{"target":"src/stats.c:mean","kind":"int.signed-overflow",
     "pre":"n > 0 and a[0..n-1] readable, no concurrent writes",
     "post":"result is the arithmetic mean",
     "formula":"INT_MIN <= s + a[i] <= INT_MAX",
     "hazard":"int.signed-overflow","status":"refuted"}}
]}
```

Required obligation fields: `target` (`path:function`), `kind`, `pre`, `post`,
`formula`, `status`. Optional: `invariant`, `hazard`, `check`. Each `name` is a
unique goal ID, conventionally `<function>.L<line>.<kind>`. IDs are ASCII letters,
digits, dot, underscore, colon or hyphen, start alphanumeric, at most 128
characters. Reports contain 1..128 obligations and at most 32 KiB of UTF-8.
Formulas and pre/postconditions are nonempty strings, at most 4096 characters.
Evidence carries specification sources, arguments, assumptions and traces.

`mechanized` and `modeled` require an exact `check` ID and identical declared goal
fields. The harness must have observed that native command succeed in this run,
with matching declared proof status and unchanged catalog/input fingerprints.
Listings, tags, substring matches, shell output and another worker's checks do
not count. Include `check` for machine-observed refutations too. A failed prover
is `unknown`, not `refuted`; omit `check` when reporting missing evidence and
describe the attempted check in evidence. Manual refutations need a concrete
written trace and omit `check`.

The verdict is `pass` exactly when all checks pass under the fixed assurance.
Scope and limitations belong in evidence and preconditions, not automatic passing
sentinel checks. Missing targets or specification create an `unknown` obligation
(use `scope:unspecified` when no target exists). Do not drop unknown or failed
goals to fit the bound; narrow the review explicitly and fail uncovered scope.

Unsupported machine claims are rejected and the existing terminal repair rounds
request an explicit unknown/fail report. The final sealed report is never silently
rewritten. Failed obligation objects and assurance travel intact into revise-loop
repair findings. A conformant failing report makes headless `run` exit nonzero.

## Interactive Markdown

Render the sealed result without changing its claims:

1. Targets, language/version, partial or total correctness, assurance, verdict.
2. Specification clauses with sources (`task`, `contract`, `docs` with lines,
   `tests`, or `inferred`). An inferred main claim must be prominent.
3. Loop invariants, variants and frame conditions tied to source lines.
4. An obligation table with ID, target, formula, status, evidence and check ID.
5. Arguments and counterexamples, limitations, semantic gaps and assumptions.
6. Proposed annotations and checks, clearly distinct from the reviewed source.

TUI rows show status and the footer shows assurance. Headless JSON, ACP and GUI
retain the typed report through existing output, contract and seal surfaces.
