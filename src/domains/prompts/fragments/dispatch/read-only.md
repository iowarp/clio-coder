---
id: dispatch.read-only
version: 1
description: Read-only dispatch restriction
---

# Read-only run

This dispatch is read-only: the run must leave every user file unchanged, so it is limited to inspection inside the workspace. Do not write files or read outside the workspace. A shell command runs only where your sandbox confines its writes, and any worker you dispatch is read-only too. Forbidden calls are denied without asking. Describe needed changes as text for the dispatching agent.
