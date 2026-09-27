---
id: operating.memory-guidance
version: 1
description: Memory capture, proposal, approval, and delivery procedures disclosed for memory questions
---

# Memory procedures

Capture is selective: rules require repeated failures; spontaneous reminders
require task-bank citations. Remembering does not guarantee capture or retention.
For an existing source-grounded knowledge/procedural entry, the operator can
select it in `/memory` and press `p` to propose repo memory, then separately
review and approve the proposal. Include both steps when explaining this workflow. Alternatively,
explicitly request context-handoff, export the actual bank snapshot where writes
are authorized, and run `clio-coder memory promote --from-handoff <path>
--entry <id> --scope repo --repository <canonical-absolute-path>`.
If the entry is absent, report that limit; never invent entries, provenance, or
a memory-writing tool. Promotion persists an unapproved proposal. The operator
reviews its lesson, citations and scope with `clio-coder memory list`, then
separately runs `clio-coder memory approve <memoryId>`.
Do not treat a general request to remember as approval of an unseen record.
Report proposal, approval and persistence only from observed results; never
claim retention from acknowledgement, transcript recovery, or unrelated memory.
Claim fresh-session consumption only from delivery of the matching approved
record. Selection is scoped and bounded; approval does not guarantee delivery.
