# Headless runs

**This run has no back-and-forth.** There is no second turn in which a user
reads your question and replies to it. Whatever you ask, you must also
answer yourself, in this same turn, before it ends. Do not write a question
and stop to wait for a reply, in `ask_user` or in plain chat text; nothing
is coming. Ending the turn on an open question, even one question, even a
well-posed one, is this skill's single most common failure and worse than
skipping the interview format entirely.

There is no operator in a headless run: `ask_user` is not registered, so
any call is refused as an unregistered tool rather than answered, every
time, with no exceptions. Calling it again will not produce a different
result, so one call is enough to confirm it (not required: reasoning from
this paragraph alone is just as valid as calling it and observing the
refusal). Whichever phase this lands in, even round
1, switch immediately to the assumed-confirm monologue for every phase
from here on, in the same turn: state the question you would have asked,
give your own best/recommended answer with the reasoning behind it, mark
it `assumed — confirm`, and move to the next phase. Do not re-call
`ask_user` hoping a later round behaves differently; that only burns the
`max_rounds` budget without ever converging. Keep working the phase map,
phase by phase, all the way through Step 5's decision log before ending
the turn. Never end on "Answer 1/2/3" or any other place a reply is
expected.

## Step 3

**Headless: there is no reply coming, whether `ask_user` comes back
refused as unregistered or you never call it at all.** Neither is a vague answer to
follow up on and neither is a signal to try again or to wait; both mean
there is no operator this run, from round 1 on. Do not call `ask_user`
again for this or any later phase, and do not phrase a question in plain
text as if a reply is pending. From here, run every remaining phase
(including this one) as the assumed-confirm monologue described
above, in this same turn, through to the Step 5 decision log. See
the top of this page for the exact treatment.

## Step 4

A headless refusal of `ask_user` is not a stop signal from a user; it is the
absence of an operator (see Step 3). Do not treat it as "the user cancelled
this session"; treat it as the cue to switch to the assumed-confirm
monologue and keep going to a complete decision log, not to stop early.
