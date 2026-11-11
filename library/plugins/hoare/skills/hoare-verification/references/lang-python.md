# Python hazard obligations

Python does not have undefined behavior. Instead, operations that cannot proceed
raise exceptions, and many surprising ones silently succeed. So `def(e)` means "does
not raise", and the larger danger is code that runs and does the wrong thing. Name
each obligation with its hazard id.

## Numbers (`num`)

- `num.int`: `int` has arbitrary precision, so it never overflows. NumPy integer
  dtypes are fixed width, and array arithmetic on them wraps without raising. Know
  which one each variable is.
- `num.division`: `//` floors toward negative infinity, and `%` takes the sign of
  the divisor (`-7 // 2 == -4`, `-7 % 2 == 1`). Division by zero raises
  `ZeroDivisionError` for `int` and `float`. NumPy instead returns 0, `inf` or `nan`
  with a warning and no exception.
- `num.true-division`: `/` always returns `float`, even for two `int`s, so
  integers above 2⁵³ lose exactness. `float` is IEEE double; see method.md.
- `num.bool`: `bool` is a subclass of `int`, so `True + True == 2`. A numeric
  postcondition may silently accept booleans.

## Indexing and slicing (`idx`)

- `idx.negative`: `a[i]` is valid for `-len(a) ≤ i < len(a)`. A negative index reads
  from the end without raising, so an off-by-one below zero is a silent wrong
  answer, not an `IndexError`. The in-bounds obligation is usually `0 ≤ i < len(a)`.
- `idx.slice`: slices clamp to the sequence and never raise. `a[5:100]` on a short
  list returns fewer elements, so length postconditions need an argument.
- `idx.mapping`: `d[k]` raises `KeyError` when the key is missing. `d.get(k)`
  returns `None`, which then flows on.

## Aliasing and state (`alias`)

- `alias.args`: names refer to objects. Two parameters, or a parameter and a
  global, can be the same mutable object (`f(xs, xs)`). A frame claim such as "`src`
  is unchanged" needs `src is not dst`, or a proof that covers both.
- `alias.mutation`: mutating an argument is visible to the caller. The frame
  must name every argument the function mutates.
- `alias.default`: a mutable default argument is created once and shared across
  calls. It is hidden state, and it belongs in the precondition.
- `alias.replication`: `[[0] * n] * m` makes `m` references to one row.
- `alias.numpy-view`: basic slicing of a NumPy array returns a view. Writing
  through it mutates the base array. Fancy and boolean indexing return copies.
- `alias.iteration`: mutating a list while iterating over it skips or repeats
  elements without an error. Changing a dict's size during iteration raises
  `RuntimeError`.

## Control flow (`flow`)

- `flow.for`: `for x in it` evaluates `it` once. `range(lo, hi, step)` fixes its
  values at creation. Assigning to `x` in the body does not change the next value.
  After the loop, `x` holds the last value it was bound to. If the loop ran zero
  times, `x` keeps its previous value or stays unbound, and a later use raises
  `NameError` (`UnboundLocalError` in a function).
- `flow.exception`: every `def(e)` failure raises an exception. Each call can
  raise whatever the callee raises. Either show that nothing raises under `P`, or
  give the exception in the exceptional postcondition and show the state it leaves.
  `finally` blocks run on every exit.
- `flow.generator`: generators run lazily and can be consumed only once. A second
  pass sees nothing.
- `flow.closure`: closures capture variables, not values, so loop-created lambdas
  all see the last value.

## Types and dispatch (`type`)

- `type.dynamic`: type hints are not enforced at run time. Each operation's operand
  types are an obligation, either from the precondition or from an argument. `+`
  concatenates lists and strings, and `*` repeats them.
- `type.none`: `None` defaults and `Optional` returns need a branch with its own
  postcondition.
- `type.dunder`: `==`, `<`, `hash`, `[]`, iteration and `len` dispatch to methods a
  class can override. Treat them as callee contracts. Sorting values that include
  `nan` gives an order that is inconsistent but raises nothing.
- `type.numpy-shape`: NumPy broadcasting and dtype promotion are obligations.
  State shapes in the precondition, such as `a.shape == (n, m)`, and show that each
  operation's shapes are compatible.

## Out of scope

`eval`, `exec`, `setattr` on modules, monkey-patching, import side effects, threads,
`asyncio`, multiprocessing and C extensions are out of scope. Report them as
`assumed` with the exact construct named.

## Mechanizing

Nagini proves contracts on a statically typed subset of Python, with contracts
written in its own library. Check which Python versions and constructs the
installed release supports. CrossHair checks contracts symbolically up to a bound,
and Hypothesis tests properties on random inputs. Both can refute, and neither can
establish an obligation. Otherwise, translate the function to Dafny and report the
result as `modeled`, listing every semantic gap: arbitrary-precision versus bounded
integers, negative indexing, slicing and exceptions.
