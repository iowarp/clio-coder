# Plan Interview Red Flags

- Asking multiple questions in one `ask_user` round.
- Asking about facts discoverable from the repo.
- Ending with a summary paragraph instead of the decision log.
- Re-calling `ask_user` for a later phase after an earlier round already came
  back refused. The answer will not be different; that budget is wasted.
- Ending a turn on "Answer 1/2/3", "let me know which you prefer", or any
  other wording that expects a reply in a headless run; there is no next
  turn for a reply to land in. This is the single most common failure mode
  of this skill and the one to watch hardest for: asking one question, then
  stopping, instead of running the assumed-confirm monologue through every
  remaining phase to the decision log in the same turn.
- Opening a `tasks` list for the phase map; `tasks` is refused.
- Treating a headless `ask_user` refusal as the user's stop signal (Step 4)
  instead of the absence-of-operator cue it actually is.
- Letting `ask_user` hit the round limit without completing the interview.
