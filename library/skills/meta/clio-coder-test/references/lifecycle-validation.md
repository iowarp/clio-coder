# Validating lifecycle changes

Use the cases relevant to the changed contract. Build fixtures at production
seams; a parallel test-only state machine does not prove runtime behavior.

| Contract | Discriminating cases |
| --- | --- |
| Session/branch authority | Switch session, fork, choose sibling, and reset while a response is pending; late content cannot apply to the new authority |
| Cancellation | Before invocation, during inference/tool execution, after response but before commit; aborted work cannot silently restart |
| Persistence | Append failure, accepted append plus flush failure, crash before/after checkpoint, archive and reload; retry same identities without duplicate publication |
| Tool batching | Whole batch preflight, complete call/result pairs, in-flight tool settlement, detached worker completion after a checkpoint |
| Compaction | Repeated cumulative summaries, protected operator/skill context, no useful cut, incomplete output, retained suffix, exact historical recall |
| Budget | Small/changing/unknown window, provider underestimation, output reserve, pending input, note/reminder/schema cost, one huge result |
| Memory | Wrong scope, unapproved/regressed records, external edits, stale background results, successful versus failed reduction, duplicate restoration |
| Usage | Failed/partial/late calls remain attributed once to their original session and route, with unknown values kept unknown |

Existing files to inspect with `rg --files tests` include `compaction-controls`,
`compaction-projection`, `compaction-summary-format`, `compaction-skill-checkpoint`,
`live-context-anchor`, `memory-session-isolation`, `memory-scope`,
`no-edit-memory`, `session-durability`, `working-set-core`, and `engine-lifecycle`.
Locate each file; do not infer its lane from its name.

For context/memory speed, compare complete trajectories at equal task/model/window
settings, including summary and background work. Record correctness separately
from token savings, boundary overhead, pause time, and time to the next useful
action. Provider cache measurements differ from cache-affecting events.

Use monotonic timing for process-local spans and injected clocks for timing
contracts. Follow `docs/architecture/time-conventions.md`; avoid tight wall-clock
assertions that depend on host scheduling or shared model latency.
