# Correctness report

## Assurance levels

The task may name the assurance it needs. By default, it is `argued`.

| Requested assurance | Obligations that pass |
| --- | --- |
| `argued` (default) | `mechanized`, `modeled`, `argued`, `assumed` |
| `modeled` | `mechanized`, `modeled`, `assumed` |
| `mechanized` | `mechanized`, `assumed` |

`refuted` and `unknown` never pass. `assumed` passes at every level because it is a
named precondition of the result, not a claim about the code. It is always listed
in the limitations.

## Markdown layout

Use this layout for an interactive report, and for the text of a report a caller
renders from the worker result.

```markdown
# Correctness report: <target list>

Verdict: pass | fail. Requested assurance: <level>. Correctness: partial | total.
Language: <language>, hazard profile <reference file or "none">.
Specification strength: <one line; say "rests on inferred clauses" when it does>.

## Specification
| Target | Clause | Formula | Source |
| --- | --- | --- | --- |
| path:function | pre / post / frame / exc | ... | task / contract / docs Lnn / tests / inferred |

## Annotations
Loop invariants, variants and callee contracts, each tied to a line.

## Obligations
| Id | Obligation | Status | How |
| --- | --- | --- | --- |
| max_array.L12.preserve | I ∧ i < n ⇒ wp(body, I) | argued | steps below |
| max_array.L13.int.signed-overflow | ... | mechanized | verify wp:max-array, exit 0, 17/17 goals |

## Arguments and counterexamples
For each argued obligation, give the numbered steps. For each refuted one, give the
input and the trace to the failing point.

## Limitations and assumptions
Out-of-scope hazards, assumed contracts, unanalyzed callees, inferred clauses, and
build options assumed.

## Proposed annotations and checks
Contracts to add to the source, and verifiers.yaml entries that would mechanize
the argued obligations.
```

Name obligation ids `<function>.L<line>.<kind>`. The kind is a loop obligation from
method.md (`init`, `preserve`, `exit`, `guard`, `bound`, `decrease`), `post`,
`call:<callee>`, `exc`, or a hazard id from the language reference.

## Worker result: verifier-report

The `hoare-verifier` worker returns exactly one JSON object, with no prose or code
fence around it:

```json
{"verdict":"fail","checks":[
  {"name":"scope","passed":true,"evidence":"targets src/stats.c:mean (C, lang-c-cpp.md); correctness: total; assurance requested: argued; spec strength: post from docs L8, pre inferred"},
  {"name":"mean.spec","passed":true,"evidence":"pre: n > 0 ∧ valid(a+(0..n-1)) [inferred]; post: result = (Σ_{k<n} a[k]) / n over reals [docs L8]; frame: assigns nothing [contract const]"},
  {"name":"mean.L10.preserve","passed":true,"evidence":"argued | I: 0≤i≤n ∧ s = Σ_{k<i} a[k] | 1) assume I ∧ i<n; 2) wp(s+=a[i]; i++, I) = 0≤i+1≤n ∧ s+a[i] = Σ_{k<i+1} a[k]; 3) from I and i<n ..."},
  {"name":"mean.L11.int.signed-overflow","passed":false,"evidence":"refuted | s is int; a = {INT_MAX, 1}, n = 2: s = INT_MAX + 1 at L11, which is UB | propose long long accumulator or pre bounding Σ"},
  {"name":"limitations","passed":true,"evidence":"assumed: real arithmetic for the final division; no concurrent access to a; build flags not visible, so FMA contraction not excluded"}
]}
```

Rules for the mapping:

- The first check is `scope`. It names each target, its language and reference,
  partial or total correctness, the requested assurance, and how strong the
  specification is. It fails when a requested target was not analyzed.
- Give one `<function>.spec` check per target. It fails only when no
  specification could be stated. Mark each clause with its source.
- Give one check per obligation. Its evidence starts with the status, followed by
  ` | ` and the formula, then ` | ` and the argument steps, the prover check id and
  outcome, or the counterexample trace. `passed` follows the assurance table.
- The last check is `limitations`. It passes unless a limitation removes the basis
  for a stated passing obligation. In that case, fail the obligation instead.
- `verdict` is `pass` exactly when every check passed.
- Keep each evidence string short enough that the whole result stays well under
  32 KiB. When there are too many obligations, group the routine ones by kind and
  say so, rather than dropping any failed or unknown ones.
