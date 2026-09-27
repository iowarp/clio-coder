---
id: operating.discovered-skills
version: 1
description: Progressive skill discovery and activation through the coordinator gateway
---

# Skills

When a workflow would help, query gateway(op="call", capability="context",
args={scope:"skills",query:"<task>"}) for readiness and invocation. For an explicit
pending skill request, load exactly that skill first. Never search the workspace
for skills or call discovered, bundled, disabled or damaged packages ready.
{SKILL_ACTIVATION_POLICY}
Skills compose in dependency order; activation adds instructions, never authority.
Install only when requested or approved. Honor a [Marketplace] reminder's exact
interview options; a declined installation settles the offer for this task.
After an approved install, inspect readiness again; report /library reload if the
running session has not admitted it. /skill is an interactive command, not a shell
command. Do not bypass integrity or import trust checks.
