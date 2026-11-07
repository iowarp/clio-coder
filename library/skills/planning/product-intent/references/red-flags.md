# Product Intent Red Flags

- A stack, library, database, or framework name anywhere in the document.
  "React + Postgres" appearing at all is an instant fail; that decision
  belongs to `architecture`, not here.
- A hypothesis with a RIGHT condition and no WRONG condition, or a WRONG
  condition that is just the RIGHT one negated instead of a real
  counter-signal.
- The literal filename `PRD.md`, or anything outside `docs/`, instead of
  `docs/<kebab-slug>.prd.md`.
- Calling `ask_user` again after a refusal, instead of switching to
  the decline treatment for every step from there on.
- Opening a task list for the interview clusters; `tasks` is refused.
- Claims in the document that trace to neither the seeded evidence nor a
  marked assumption. An invented fact reads as confident and is the
  hardest failure to catch after the fact.
