# C and C++ hazard obligations

In C and C++, a precondition is not enough: the code must also avoid undefined
behavior (UB). Under UB the program has no meaning, so a proof that ignores it
proves nothing. Every item below adds conjuncts to `def(e)` or adds a separate
obligation. Name each one in the report with its hazard id.

## Integers (`int`)

- `int.signed-overflow`: signed overflow in `+ - * ++ --` and unary `-` is UB. Each
  signed operation needs `INT_MIN ≤ result ≤ INT_MAX`, or the bounds of its type.
- `int.unsigned-wrap`: unsigned arithmetic is defined modulo 2ᴺ. That is rarely the
  intent. `n - 1` with `n == 0u` wraps to the maximum, and
  `for (size_t i = n - 1; i >= 0; --i)` never terminates. State wraparound as an
  explicit obligation, or show it cannot happen.
- `int.promotion`: operands narrower than `int` are promoted to `int`. Mixing signed
  and unsigned converts the signed operand, so `-1 < 1u` is false. Reason about the
  converted values.
- `int.division`: division truncates toward zero, and `a % b` takes the sign of `a`.
  `b == 0` is UB, and so are `INT_MIN / -1` and `INT_MIN % -1`.
- `int.shift`: shifting by a negative amount or by at least the operand's width is
  UB, and so is left-shifting a negative signed value. Right-shifting a negative
  value is implementation-defined in C and arithmetic since C++20.
- `int.conversion`: a floating value converted to an integer type that cannot
  represent it is UB. Converting an out-of-range integer to a signed type is
  implementation-defined in C and modular since C++20.

## Memory (`mem`)

- `mem.bounds`: each access `p[i]` or `*(p + i)` needs `p` valid for `i`.
  Pointer arithmetic may reach one past the end but never dereference it. Write the
  precondition as a validity range, such as ACSL's `\valid(a + (0 .. n-1))`.
- `mem.null`: each dereference needs a non-null pointer. A parameter that may be
  null needs a branch, and each branch needs its own postcondition.
- `mem.init`: reading an uninitialized automatic variable or `malloc`ed memory
  yields an indeterminate value. Initialization is an obligation.
- `mem.lifetime`: no use after `free`, no pointer to a local returned or stored past
  its scope, and no use of a pointer after `realloc` moved the block.
- `mem.alias`: two pointer parameters may refer to overlapping memory. A frame
  argument such as "`dst` changes and `src` does not" needs either a separation
  precondition (ACSL `\separated(dst + (0..n-1), src + (0..n-1))`) or a proof that
  covers the overlapping case. `restrict` makes separation the caller's duty, so
  aliased calls are UB. `memcpy` on overlapping regions is UB.
- `mem.string`: string functions need a NUL terminator within the valid range.
- `mem.strict-alias`: accessing an object through an lvalue of an incompatible type
  is UB. `char` access and `memcpy` are the exceptions.

## Evaluation (`eval`)

- `eval.unsequenced`: two unsequenced modifications of one object, or a
  modification and a read, are UB (`i = i++ + 1`). The evaluation order of function
  arguments is unspecified, so a proof must hold for every order.
- `eval.macro`: expand macros before reasoning. A macro argument can be evaluated
  more than once.
- `eval.for`: `for (init; cond; step) body` desugars to
  `init; while (cond) { body; step; }`. `continue` jumps to `step`. `cond` is
  re-evaluated on every iteration, so a bound the body changes changes the loop.

## C++ (`cxx`)

- `cxx.exception`: any call that is not `noexcept` may throw. Each one needs either
  an exceptional postcondition, including what state the objects are left in, or an
  argument that it cannot throw under `P`. Destructors run during unwinding and
  belong to the frame.
- `cxx.class-invariant`: a class invariant must hold on entry to and exit from each
  public member function. It may be broken only between those points, and throwing
  is one such exit.
- `cxx.iterator`: `push_back`, `insert`, `erase` and `reserve` can invalidate
  iterators, references and pointers into a container. Using one afterwards is UB.
- `cxx.dispatch`: a virtual call or overloaded operator needs a contract that
  every override satisfies. Otherwise, mark it `assumed` and name the overrides
  you did not check.
- `cxx.template`: a template is verified per instantiation, or under stated
  requirements on its type parameters.
- `cxx.library`: library calls are `assumed` under their documented contracts.
  Check that the preconditions hold at the call site. For example, `std::sort`
  needs a strict weak ordering, and a `<` comparator over doubles that may be NaN
  violates it. `vector::operator[]` is unchecked, so `mem.bounds` applies.

## Out of scope

Data races are UB, and threads, OpenMP, CUDA and MPI fall outside sequential Hoare
logic. Report these as `assumed: no concurrent access to <locations>`, and never
argue them. Inline assembly, `volatile`, signal handlers and `setjmp`/`longjmp` are
out of scope too.

`-ffast-math` lets the compiler assume there are no NaNs or infinities, so it can
remove an `isnan` check. When the build flags are visible, state whether they
include it.

## Mechanizing

Frama-C/WP proves ACSL contracts on real C source. Its `-wp-rte` option generates
the UB obligations above as goals. CBMC and Kani-style bounded checkers can refute.
They can establish an obligation only when their unwinding assertions also pass.
For C++, no comparably mature deductive tool exists, so translate the function to
Dafny or Why3 and report the result as `modeled`. See provers.md for the declared
check.

Example of the contract shape to propose:

```c
/*@ requires n > 0 && \valid_read(a + (0 .. n-1));
    assigns \nothing;
    ensures \forall integer k; 0 <= k < n ==> \result >= a[k];
    ensures \exists integer k; 0 <= k < n && \result == a[k];
*/
int max_array(const int *a, int n) {
  int m = a[0];
  /*@ loop invariant 1 <= i <= n;
      loop invariant \forall integer k; 0 <= k < i ==> m >= a[k];
      loop invariant \exists integer k; 0 <= k < i && m == a[k];
      loop assigns i, m;
      loop variant n - i;
  */
  for (int i = 1; i < n; i++)
    if (a[i] > m) m = a[i];
  return m;
}
```
