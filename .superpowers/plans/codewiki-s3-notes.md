Codewiki S3 notes.
Decision: schema v4 stores per-file hash, raw unique imports, and restored first doc summary on source files.
Decision: incremental updates rebuild changed file records only, then rebuild edges from merged stored imports.
Decision: the reader seam is optional options on build/update internals; existing call forms remain unchanged.
Backfill: codewikiNeedsBackfill marks loaded source files with empty hash stale for tool/session rebuilds.
Measurement: worktree v4 index has 777 files, 8,639 symbols, 4,246 edges, 1,812,609 bytes.
Baseline: S2 had 777 files, 8,624 symbols, 4,245 edges, 1.55 MB.
Growth: +15 symbols, +1 edge, +0 files, +0.26 MB decimal size, about +17%.
Incrementality evidence: read-count contract updates 1 changed file in a 6-file fixture and reads exactly that file once.
Files outside allowed implementation/test list: none; this required notes file is the only extra artifact.
Forced compile fixes elsewhere: none.
Questions for architect: none.
