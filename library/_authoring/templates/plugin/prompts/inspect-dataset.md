---
description: Prompt to inspect a scientific dataset directory for FAIR compliance and metadata completeness.
argument-hint: "[dataset-path]"
---

Inspect the scientific dataset at: $1

Refer to curation guidelines in ${pluginRoot}/assets/curation-guide.md and use the data-curator agent.

Evaluate:
1. File structure and format consistency.
2. Presence of required metadata, license, and provenance documentation.
3. Missing-value encodings and schema clarity.

Additional instructions: $ARGUMENTS
