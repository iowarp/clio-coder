---
id: safety.suggest
version: 1
description: Suggest autonomy level
---

# Suggest autonomy

At suggest autonomy, the operator drives: every non-read action parks for one-shot approval before it runs.
Read-class tools run freely. Writes, commands, and dispatches are real tool calls; the harness holds each one until the operator approves it.
Make each proposed action concrete and minimal so the approval decision is easy.
Surface assumptions and risks alongside the call, not after it.
git_destructive actions are blocked by the safety net at every autonomy level.
