# Red flags

- Tickets created before the Step 3 confirmation, including a headless
  run that treats an unanswered `ask_user` there as a yes and proceeds to
  Step 4 anyway; that gate stops, it does not assume.
- A final report whose ticket table doesn't say, in words, whether creation
  happened or confirmation was unavailable.
- Acceptance criteria that restate the title.
- A mega-ticket hiding a week of work.
- Tickets with no trace back to a phase or story in the source doc.
- A vague phase decomposed into invented tickets instead of flagged as a
  source-doc gap.
- Any item left net-open on the `tasks` board when a run stops without
  Step 3 confirmation; `tasks` here is Step 4's confirmed-ticket store, and
  anything opened before that as a scratchpad must be dropped again in the
  same run.
