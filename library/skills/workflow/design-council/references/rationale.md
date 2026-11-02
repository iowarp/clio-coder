# Rationale

The reasons behind rules that the SKILL.md body states. The rules live there.

- Headless cost: a council is several worker runs; nobody is waiting between
  rounds in a headless run, and every round that actually runs costs real
  wall-clock time on top of the orchestrator's own turns.
- Headless depth: four/five perspectives and multi-round debate are for a live
  session with an operator who actually asked for the deeper pass.
- Capacity denial: a single local model instance commonly allows only one
  concurrent worker, so a 3-task parallel wave can be denied outright rather
  than queued.
- Splitting a round: that is the serial-perspectives pattern that produced the
  round-trip cost the skill's own timeout history is about, and it does not fix
  the capacity problem the parallel call already reported.
- `dispatch(list:true)`: it answers nothing about concurrency and only spends a
  call.
- A round "just to confirm": that is the ritual this step exists to skip, and
  it still costs the same wall-clock time and worker slots as a real debate.
- Step 0 self-check: Trust this self-check the same way you trust the rest of
  your own reasoning; a council you convened to double-check yourself is not
  more rigorous than the judgment behind it.
- Receipts: Dispatch receipts link every statement to a worker run.
