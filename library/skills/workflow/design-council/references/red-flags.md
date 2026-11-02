# Red Flags

- Perspectives named "optimist" and "pessimist" (role menu, not topic).
- Composing four or five perspectives, or running a Responses/Convergence
  round, in a headless run — the enforced default is exactly three and
  exactly one, not a ceiling to raise because the topic looks deep.
- Splitting a round into several single-task `dispatch` calls issued one at a
  time instead of one batched `tasks` call (retried as `mode="sequential"`
  on a capacity denial).
- Calling `dispatch(list:true)` before dispatching the round.
- Pasting an absolute path into a dispatch `task`/`briefing` instead of a
  declared `intent`, or quoting literal shell syntax inside a persona's
  argument.
- Reaching for `bash`/`read` on a receipt file the dispatch call's own result
  already contains.
- Opening a `tasks` list for the round structure; `tasks` is refused.
- A synthesis that averages positions instead of naming the crux.
- Manufactured disagreement on a settled question.
- A worker asked to edit files as part of the debate.
- Synthesis statements that no transcript line supports.
