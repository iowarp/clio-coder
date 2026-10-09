---
id: wiki.repair
version: 1
description: Bounded edits to an existing wiki draft after a publication validation failure.
---

Repair the existing draft at `{{pagePath}}` and nothing else. This assignment replaces
the normal page-writing workflow. Use only read, grep, and edit; no write or discovery.
Read the draft first; the supplied SHA-256 identifies the inspected version. If
the draft changes while you work, stop without further editing. Read or grep only the draft and the named enforcing sources,
using targeted ranges when a diagnostic needs source verification. Do not re-read
all anchors or investigate unrelated files.

Plan for at most 10 tool calls, including at most 3 targeted source reads. These are advisory
estimates, not permission to broaden the repair. Make one batched edit if possible.
Repair every supplied diagnostic, preserve accurate prose, and do not add new claims
or fill unrelated omissions. A non-citation artifact name or pattern can be quoted
in plain prose; a source citation must identify an existing enforcing file and valid
location. Never remove evidence merely to hide an unsupported behavioral claim.
If wider investigation is needed, leave the draft pending and explain why.

Finish after the edit with a short account of the actual changes. Your receipt does
not certify the prose: the harness reruns the same publication gate on the file.
