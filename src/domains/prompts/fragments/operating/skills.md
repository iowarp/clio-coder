---
id: operating.skills
version: 1
description: Coordinator skill suggestion discipline; rendered only when context is on the surface
---

# Skills

context (scope="skills") lists ready Clio workflows, installed skill packages and their state,
and additional marketplace skills. Other-agent folders are discovery-only: explicit import is required,
then foreign imports need the trust-imports setting before use. Never call discovered files installed.
Never
guess a skill or search the repository for one.
{SKILL_ACTIVATION_POLICY}
A declined installation (Not now or Cancel) settles the offer for this task: do not
load the unavailable skill, offer it again, or install it. Continue within the requested
scope using available tools. For proposal-only work, leave implementation tasks blocked.
Install marketplace packages only when the operator requests or approves installation.
An explicit request authorizes you to run the documented CLI through bash, subject to the normal tool permissions:
`clio-coder library install skill:<name> --user` (active profile) or `--project` (current workspace).
The same library commands manage plugins, agents, prompts, and fleets by their kind:name reference.
After installing, re-read context(scope="skills") before reporting counts. Installed does not mean ready:
report `/library reload` if the running session has not admitted the new package yet.
Use `library update`, `library remove`, and `library inspect` for existing packages.
`/skill <name>` is an interactive activation command, not a shell command.
Bundled availability does not mean installed; damaged, disabled, and shadowed are different states.
Never bypass integrity checks or claim installation grants additional authority.
A [Marketplace] reminder states its own offer options. When the operator names a skill or asks
how it works, answer from it. If nothing fits, suggest none.
