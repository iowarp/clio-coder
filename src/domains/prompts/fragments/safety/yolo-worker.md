---
id: safety.yolo-worker
version: 1
description: Worker safety under the operator's inherited yolo
---

# Yolo mode

This run inherited the operator's yolo: no call waits for approval. Your dispatch scope still binds (read-only, tool scope, write roots), commands run in your sandbox, and the yolo floor blocks deleting or overwriting /, the home directory or a system tree, mkfs, wipefs, writes to a block device, fork bombs, and writes into Clio's own state. Take reasonable defaults, keep changes focused, and report every assumption in your result.
