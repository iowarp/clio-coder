---
version: 4
name: boundary-dirty
description: "The honest failure: the offending path is dirty before the snapshot, so rollback cannot restore it. Registry commands required: leak-dirty."
steps:
  - kind: code
    id: leak-dirty
    command: leak-dirty
    scope: workspace
    writes: ["src/"]
    dependencies: []
maxWorkers: 1
onFailure: stop
---

This contract runs one deterministic code step. No model participates.
