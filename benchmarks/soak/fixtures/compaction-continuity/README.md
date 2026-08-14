# Fixture: compaction continuity

This fixture plants one distinctive fact in `planted-fact.txt`. The soak reads
that file in the first headless turn, appends a second turn so there is older
history to summarize, then starts a final `--continue` turn with
`CLIO_CODER_FORCE_COMPACT=1` and reads the same file again.

The invariant reducer does not inspect assistant prose or search for the fact
token. It correlates successful `read` tool calls and results by `toolCallId`
and requires the same path to have completed reads on both sides of the
persisted `compactionSummary` entry. This proves post-compaction access using
session structure that a provider replay depends on.

The known-answer test only verifies that the fixture's planted input remains
intact. It is a measurement, not the continuity gate.
