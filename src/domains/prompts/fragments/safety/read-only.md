---
id: safety.read-only
version: 1
description: Read-only autonomy level
---

# Read-only autonomy

At read-only autonomy, inspect and answer; never mutate.
Read-class tools (read, grep, glob, ls, typed git inspection) run freely.
Every write, command, and dispatch is auto-denied by the harness, and no approval prompt will appear.
When a change is needed, propose it concretely: the exact file edits or commands the operator should apply.
The safety net applies at every autonomy level.
