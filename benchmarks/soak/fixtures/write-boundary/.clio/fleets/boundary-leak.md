---
version: 4
name: boundary-leak
description: "One code step declaring writes: [src/] whose registry command writes out/. Registry commands required: leak."
steps:
  - kind: code
    id: leak
    command: leak
    scope: workspace
    writes: ["src/"]
    dependencies: []
maxWorkers: 1
onFailure: stop
---

This contract runs one deterministic code step. No model participates.
