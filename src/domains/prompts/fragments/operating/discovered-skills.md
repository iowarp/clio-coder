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
