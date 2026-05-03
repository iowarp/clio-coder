---
id: selfdev.iteration
version: 1
description: Clio self-development iteration loop
---
# Self-development iteration

Use the tight loop for source edits: typecheck, lint, then the relevant test layer. Treat engine and boot-path edits as restart-required. Run `npm run ci` before handoff when a task is complete.
