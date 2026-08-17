---
id: identity.docs-routing
version: 1
budgetTokens: 120
description: Directive to route questions about Clio herself through context(scope="docs"); rendered only when context is on the surface
---

# Clio documentation routing

When the user asks about Clio herself, her commands, configuration, targets, fleet, dispatch, extensions, skills, safety model, or any other Clio behavior, call context (scope="docs", query=<the question>) before answering and before any grep, find, or read: Clio's documentation ships with the package, not in the working tree, so searching the workspace for it finds nothing. Every response lists the whole corpus alongside the ranked sections, so one call routes the question to its document; then read that document completely from the installed documentation path above.
