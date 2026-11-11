# Fortran hazard obligations

The Fortran standard leaves many errors to the processor. A program that breaks a
rule has no guaranteed behavior, and compilers do not check most rules by default.
Treat each item below like C's undefined behavior: an obligation to discharge, not
a runtime error to rely on. Name each one with its hazard id.

## Integers (`int`)

- `int.overflow`: integer overflow is not defined by the standard. Each operation
  needs its result within the range of its kind (`huge(x)`), and so does each
  intermediate value in an expression.
- `int.division`: integer division truncates toward zero. `mod(a, p)` takes the
  sign of `a`, and `modulo(a, p)` takes the sign of `p`. Division by zero is not
  defined.
- `int.implicit`: without `implicit none`, undeclared names starting with `i`
  through `n` are default integers and the rest are default reals. Check the
  declared type of every variable the proof uses.
- `int.kind`: mixed-kind arithmetic converts to the larger kind. Assigning to a
  smaller kind that cannot represent the value is not defined.

## Arrays (`arr`)

- `arr.bounds`: lower bounds default to 1 but may be any value (`a(0:n)`,
  `a(-k:k)`). Out-of-bounds access is not checked unless the build enables it, for
  example with gfortran's `-fcheck=bounds`. State the bounds in the precondition.
  Assumed-shape dummies (`a(:)`) take lower bound 1 in the callee whatever the
  actual argument's bounds.
- `arr.assignment`: an array assignment such as `a(2:n) = a(1:n-1)` behaves as if
  the whole right-hand side were evaluated before any element is stored. The
  equivalent `do` loop does not, and it overwrites values it still needs. Do not
  treat the two as interchangeable.
- `arr.allocatable`: using an unallocated allocatable or a disassociated pointer is
  not defined. Allocation status is an obligation, and so is `present()` for each
  `optional` argument before use.
- `arr.contiguity`: pointer and assumed-shape arrays may be non-contiguous. Passing
  one to an explicit-shape or C-interoperable dummy can make a copy, so writes go
  to the copy, not the original.

## Arguments and state (`arg`)

- `arg.alias`: the standard forbids a procedure from changing a dummy argument
  when the same storage is also reachable through another dummy or a global, unless
  `pointer` or `target` attributes allow it. Inside the callee, assume no harmful
  aliasing. At every call site, it is an obligation on the caller, such as
  `call update(x, x)`.
- `arg.intent`: `intent(in)` gives a frame condition: the callee cannot change that
  argument. An `intent(out)` dummy is undefined on entry, so reading it before
  assigning it is an error, and an allocatable `intent(out)` is deallocated on
  entry.
- `arg.save`: initializing a local in its declaration (`integer :: count = 0`)
  implies `save`. The value persists across calls and is set only once, not on each
  call. That is hidden state and belongs in the precondition. Module variables and
  `common` blocks are globals and belong in the frame.
- `arg.pure`: `pure` and `elemental` procedures cannot have side effects on
  non-local state. That gives a frame for free, so use it.

## Expressions and control flow (`flow`)

- `flow.no-short-circuit`: the standard does not require short-circuit
  evaluation. `i <= n .and. a(i) > 0` may evaluate `a(i)` when `i > n`. Guard
  with nested `if`s instead, and treat the combined form as a `arr.bounds`
  obligation for every operand.
- `flow.function-eval`: a processor need not evaluate a function reference whose
  value is not needed for the result. A function with side effects inside an
  expression gives no guarantee they happen.
- `flow.do`: `do i = m1, m2, m3` computes its iteration count once on entry as
  `max((m2 - m1 + m3) / m3, 0)`, then runs the body that many times, adding `m3` to
  `i` after each pass. The body may not change `i`. Changing `m2` inside the body
  does not change the count. After normal completion,
  `i = m1 + count * m3`, which is one step past the last executed value. Use this
  desugaring for `init`, `exit` and the variant (`count` minus the passes done).
- `flow.exit`: `exit` leaves the loop and needs its own exit assertion. `cycle`
  must re-establish the invariant.

## Floating point

Compilers may reorder floating-point expressions in ways that are mathematically
equivalent but not equivalent in floating point, unless parentheses or options
forbid it. Fused multiply-add contraction is common. Arguments based on the
standard model in method.md must say which build options they assume.

## Out of scope

MPI, coarrays, OpenMP, `do concurrent` (its iteration independence is a
programmer assertion, not a proved property), I/O statements, `equivalence`, and
calls through `bind(c)` interfaces are out of scope. Report each one as `assumed`
with the exact construct and line named.

## Mechanizing

No mature deductive verifier for modern Fortran is assumed here. Translate the
function to Dafny or Why3 and report it as `modeled`. List every gap: the bounds,
the `do` desugaring, integer kinds, argument association and evaluation order.
CamFort checks units-of-measure and stencil specifications on Fortran source. Use
it for those properties if the project declares it, and check that its release
covers the dialect. Runtime checking (`-fcheck=all`) and tests can refute an
obligation, but cannot establish one.
