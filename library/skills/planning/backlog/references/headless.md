# Headless runs

There is no operator in a headless run: `ask_user` is not registered, so
any call is refused as an unregistered tool rather than answered; that is
not a stall, and calling it again will not produce a different result. **This skill treats headless
degradation differently at each step below, because Step 3 gates an
outward, not-cleanly-reversible action (real tickets, GitHub issues or
persisted local tasks), not a document write:**

- **Step 1 (platform).** The default rule (`gh` when a remote and the `gh`
  binary are both present; the `tasks` fallback otherwise) is a fact to
  detect, not a judgment call, and runs the same whether or not anyone is
  watching; no confirmation needed either way. It is genuinely ambiguous
  only when the user names a platform with no available integration; if
  that `ask_user` call goes unanswered, do not guess a fallback and do not
  silently substitute `gh` or `tasks` for the platform actually requested.
  State plainly that the named platform is unavailable and confirmation of
  what to use instead was not obtainable, then stop exactly as Step 3 does.
- **Step 2 (decompose).** Always run to completion, headless or not.
  Decomposition itself creates nothing yet, and every source-doc gap still
  needs surfacing whether or not a human is present to read it.
- **Step 3 (confirm before creating).** An unanswered `ask_user` here is
  never a yes, and this gate does not get the assumed-confirm-and-proceed
  treatment the other planning skills use for their document gates. Finish
  Step 2, print the full proposed ticket list and target platform exactly
  as Step 3 already requires, then stop: say explicitly that confirmation
  is required before any ticket is created, that it was not obtainable in
  this run, and that Step 4 did not execute. This is the one gate in the
  planning category's headless story that ends in a stop rather than an
  assumed yes: filing unrequested public GitHub issues, or persisting
  local tickets nobody confirmed, on a guess is worse than an incomplete
  run; the full decomposed list is still delivered as the answer.

## The task board when Step 3 stops

What actually
matters when Step 3 stops without confirmation: the board must end this
run holding zero net-open items. `tasks` calls here are Step 4's (one
entry per ticket *already confirmed at Step 3*), and Step 4 never runs
before that yes. If you do reach for `tasks` before confirmation (to
stage the proposal, or to check the board is clean), any item you opened
with `plan`/`add` must be `drop`ped again before you finish, in the same
run. An item left open on the board is exactly "created without
confirmation," whether or not you called it that. A read-only
`tasks(action="list")` changes nothing and is always fine.

## The final message when Step 3 stops

Stopped-before-confirmation run: one self-contained final
message (never split across turns and never "see above") that repeats
the full proposed ticket list with title *and* acceptance criteria per
ticket (a status column of "proposed" is not a substitute for the
criteria themselves), plus one explicit line stating that confirmation was
required and unavailable and no ticket was created. A reader who sees only
this last message must get the complete list and the complete status;
never let the table alone imply creation happened, and never make the
stop notice depend on an earlier turn still being visible.
