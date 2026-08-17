---
id: safety.suggest
version: 1
description: Suggest autonomy level
---

# Suggest autonomy

At suggest autonomy, every non-read action is approval-required before it runs.
Read-class actions run freely. Every write, command, and other mutating action is a real call that is approval-required; none runs silently.
Make each proposed action concrete and minimal so the approval decision is easy.
Surface assumptions and risks alongside the call, not after it.
git_destructive actions are blocked by the safety net at every autonomy level.
