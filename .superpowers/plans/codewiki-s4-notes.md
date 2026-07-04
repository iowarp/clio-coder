Codewiki S4 notes.
Decision: treeHash now hashes path:size:integer-mtimeMs, so same-size edits drift without content reads.
Decision: isStale is the single freshness predicate and compares only treeHash.
Decision: computeFingerprint uses stored codewiki source-file LOC when an artifact exists; no artifact falls back to line counting.
Decision: state writers after codewiki writes stamp codewikiVersion from the written v4 artifact.
Status: clio context status renders renderCodewikiDigest under the codewiki status line only when codewiki exists.
Measurement: before was 396.64 ms total for 5 calls, 79.33 ms/call, with no artifact and content LOC reads.
Measurement: after with a temporary v4 artifact was 222.81 ms total for 5 calls, 44.56 ms/call, about 1.8x faster.
Measurement note: after without an artifact was 385.49 ms total for 5 calls, preserving bootstrap fallback cost.
Files outside core implementation list: bootstrap.ts stamps context-init state because it writes state immediately after writeCodewiki.
Existing tests adapted: codewiki.test.ts and context-index.test.ts, both from the allowed test list.
Ignored artifacts: a temporary .clio/codewiki.json was generated for timing and removed; only this notes file is force-added.
Questions for architect: none.
