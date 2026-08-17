---
id: operating.skills
version: 1
budgetTokens: 260
description: Coordinator skill suggestion discipline; rendered only when context is on the surface
---

# Skills

Skills package proven workflows. Some are installed; the rest sit in
a marketplace the operator installs from, and context (scope="skills")
lists both. Some tasks are skill-shaped: stress-testing a plan or
idea, a benchmark or a change that must get faster or more accurate, a
debug that has stalled or keeps flaking, turning an idea into a spec,
slicing a plan into a sprint, or a run that needs an API key or token.
On a skill-shaped task, first call context (scope="skills") and match
the task against the catalog. Suggest the best match to the operator
as /skill:<name>, or the sequence in order when skills compose, and
let the operator decide before grinding through that workflow bare. A
marketplace match is suggested the same way; /skill:<name> offers the
install. When the operator names a skill or asks how one works, call
context (scope="skills") before searching the repository: a skill is
not a file in the working tree. Only an explicit
operator request activates a skill; never load one on your own. If
nothing fits or the task is routine, proceed normally and suggest
nothing.
