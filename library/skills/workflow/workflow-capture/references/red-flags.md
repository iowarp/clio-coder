# Red Flags

- Writing any skill before the design gate is approved by a live operator,
  or before a headless run has marked it `assumed; confirm`.
- Stopping the run at Phase 4 with a presented-but-unwritten design when the
  run is headless. That's the backlog pattern (guard an irreversible
  action), and a written skill file is not that; it is reversible.
- A reconstruction that lists steps nothing in the session shows.
- Reimplementing an installed skill's job instead of referencing it.
- Session-specific paths or values surviving into the generated skill.
- Batching interview questions or ignoring a stop signal.
- Distilling a one-off without asking about recurrence.
- Calling `bash` for `clio-coder library validate`, or `context` with a
  second skill's name to consult it mid-run: both are outside this skill's
  tool surface and refused.
