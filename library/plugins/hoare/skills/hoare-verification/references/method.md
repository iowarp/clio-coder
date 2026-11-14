# Method: rules, obligations, invariants and counterexamples

Notation. `{P} S {Q}` means: if `P` holds before `S` and `S` terminates, `Q` holds
after (partial correctness). `[P] S [Q]` adds that `S` terminates (total
correctness). Say which one each report claims. `old(x)` is the value of `x` on
entry. `def(e)` is the condition under which evaluating `e` is defined in the
target language: no out-of-bounds index, no division by zero, no overflow where
overflow is undefined, no null dereference. The language references list what
`def` includes.

## Proof rules

| Rule | Form |
| --- | --- |
| Skip | `{P} skip {P}` |
| Assignment | `{def(e) ∧ Q[e/x]} x := e {Q}`, for `e` without side effects |
| Array update | `{def(i) ∧ def(e) ∧ inBounds(a, i) ∧ Q[a⟨i:=e⟩/a]} a[i] := e {Q}` |
| Sequence | from `{P} S1 {R}` and `{R} S2 {Q}`, conclude `{P} S1; S2 {Q}` |
| Conditional | from `{P ∧ b} S1 {Q}` and `{P ∧ ¬b} S2 {Q}`, with `P ⇒ def(b)`, conclude `{P} if b then S1 else S2 {Q}` |
| While (partial) | from `{I ∧ b} S {I}`, with `I ⇒ def(b)`, conclude `{I} while b do S {I ∧ ¬b}` |
| While (total) | also `I ∧ b ⇒ V ≥ 0` and `[I ∧ b ∧ V = v₀] S [V < v₀]` for an integer variant `V` |
| Consequence | from `P ⇒ P'`, `{P'} S {Q'}` and `Q' ⇒ Q`, conclude `{P} S {Q}` |
| Call | callee contract `{Pf} f(x̄) {Qf}` modifying only `M`: obligation `P ⇒ Pf[ā/x̄]` at the call; afterwards assume `Qf[ā/x̄]` and that every location outside `M` is unchanged |

The array value `a⟨i:=e⟩` is `a` with index `i` replaced, so `a⟨i:=e⟩[j]` is `e`
when `j = i` and `a[j]` otherwise. Reason about arrays as functions from indices to
values. Every read `a[j]` adds `inBounds(a, j)` to `def`.

Statements that leave a block early each need their own postcondition:

- `return e` must establish `Q[e/result]` from the current state.
- `break` must establish the loop's exit assertion, not `I ∧ ¬b`.
- `continue` must re-establish `I` and decrease `V`.
- A raised exception or error return must establish the exceptional postcondition
  `Qexc`. When the specification gives none, the obligation is that it cannot
  happen under `P`.

## Weakest preconditions

Compute obligations backwards from the postcondition:

| Statement | `wp(S, Q)` |
| --- | --- |
| `x := e` | `def(e) ∧ Q[e/x]` |
| `S1; S2` | `wp(S1, wp(S2, Q))` |
| `if b then S1 else S2` | `def(b) ∧ (b ⇒ wp(S1, Q)) ∧ (¬b ⇒ wp(S2, Q))` |
| annotated loop | the invariant `I`, plus the loop's own obligations below |

A loop has no closed-form weakest precondition. Its invariant stands in for one,
and the loop contributes these obligations. Number them in the report.

| Id | Obligation | Formula |
| --- | --- | --- |
| `init` | invariant holds on entry | `R ⇒ I`, where `R` holds just before the loop |
| `preserve` | one iteration keeps it | `I ∧ b ⇒ wp(S, I)` |
| `exit` | exit establishes what follows | `I ∧ ¬b ⇒ Q'` |
| `guard` | the guard is defined | `I ⇒ def(b)` |
| `bound` | the variant is bounded | `I ∧ b ⇒ V ≥ 0` |
| `decrease` | the variant strictly decreases | `I ∧ b ∧ V = v₀ ⇒ wp(S, V < v₀)` |

`bound` and `decrease` are needed only for total correctness. A `for` loop is a
`while` loop after desugaring, but each language desugars it differently: what the
counter holds after the loop, whether the bounds are evaluated once, whether the
body may change the counter. Use the desugaring in the language reference, not a
generic one.

## Building an invariant

1. Generalize the postcondition by replacing a constant with the loop counter. For
   `Q: s = Σ_{k<n} a[k]`, try `I: 0 ≤ i ≤ n ∧ s = Σ_{k<i} a[k]`.
2. Always include the counter's range (`lo ≤ i ≤ hi`). It is the most commonly
   missing conjunct, and the `exit` and in-bounds obligations need it.
3. Include the frame: the inputs and variables the loop does not change, such as
   `n = old(n)` or `∀k. a[k] = old(a)[k]` for a read-only array.
4. In a nested loop, the inner invariant must repeat whatever the outer invariant
   needs. The inner loop has no memory of the outer loop's facts.
5. Check a candidate on concrete traces of zero, one and two iterations before you
   try to prove it. A candidate that fails a trace is wrong. Fix it before arguing.
6. When `preserve` fails, the failing case tells you the missing conjunct.
   Strengthen `I`, then re-check `init`, because a stronger invariant can fail on
   entry.

For quantified invariants such as `∀k. 0 ≤ k < i ⇒ p(k)`, prove `preserve` by
splitting the range of the next state into `k < i` (from `I` and the frame) and
`k = i` (from the body).

Typical variants are `n - i` for a counting loop, `hi - lo` for a search that
narrows an interval, and a lexicographic pair `(outer, inner)` for nested loops.
For `hi - lo`, show the decrease in both branches: a midpoint update such as
`lo = mid` on `hi = lo + 1` is the classic non-terminating case.

## Arithmetic and floating point

State each arithmetic fact you rely on as a separate step, such as
`(lo + hi) / 2 < hi when lo < hi`. Integer division, remainder, overflow and
conversion differ between languages. Take them from the language reference.

For floating-point code, these facts may be used in an `argued` step:

- Comparisons with NaN are false, and `x != x` holds exactly when `x` is NaN.
- Integers of magnitude up to 2⁵³ are exact in IEEE double, and so are sums and
  products of them that stay within that range.
- Scaling by a power of two is exact unless it overflows or underflows.
- Rounding is monotonic: `a ≤ b` implies `fl(a) ≤ fl(b)`.
- The standard model is `fl(a op b) = (a op b)(1 + δ)` with `|δ| ≤ u`, where
  `u = 2⁻⁵³` for double under round-to-nearest, absent overflow and underflow.

A claim about the real-valued result of floating-point code, such as "returns the
mean", should be stated over the reals and recorded as an `assumed: real
arithmetic` limitation. An error bound derived from the standard model may be
`argued`. It is reported separately from the logical obligations. Compiler options
that reassociate or contract operations (`-ffast-math`, FMA contraction) invalidate
such arguments. Say whether the build uses them, or that you could not tell.

## Searching for a counterexample

Search before marking an obligation `unknown`. A counterexample turns it into
`refuted` and is the most valuable thing a report can contain.

1. From the failing formula, write down a state that satisfies its hypotheses and
   violates its conclusion.
2. Try the boundary inputs: empty, size one, maximum and minimum values, zero,
   negative values, duplicates, aliased arguments, and NaN or infinity for
   floating-point inputs.
3. Choose concrete inputs that satisfy `P` and trace the code step by step to the
   failing point. Show the trace in the evidence.
4. If the trace reaches the violation, the obligation is `refuted`. If the state
   from step 1 is unreachable from any input satisfying `P`, the invariant is too
   weak, not the code. Strengthen it and retry.

A declared bounded checker may perform steps 2 and 3. Its counterexample counts as
a refutation, and its silence counts for nothing.

## Writing an argued obligation

An `argued` obligation lists its hypotheses and then numbered steps. Each step is a
rule application, a substitution, a stated arithmetic fact, or a fact from a named
earlier step or contract. Phrases like "clearly", "obviously" or "by inspection"
are not steps. If a step cannot be written without one of them, the obligation is
`unknown`.
