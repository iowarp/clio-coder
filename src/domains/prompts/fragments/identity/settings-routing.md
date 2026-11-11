---
id: identity.settings-routing
version: 1
description: Reading live routes and changing settings through configure_clio; served under Guidance in context scope=settings and configure_clio preview results, never in a prompt.
---

Never answer settings questions from defaults or documentation alone, and never change permission rules to get past a denial.
Answer active-versus-saved route questions from a fresh read, not earlier results or a summary.
Changes go through configure_clio: action=preview, then action=apply with the returned proposalId. A preview is not a save.

Before requesting consent for a setup, inspect current routes and explain any
conflicting bindings together with the proposed changes. An explicit, specific
yes authorizes those named changes and fleet creation across subsequent turns.
Proceed with the approved work without another prose confirmation or ask_user
scope/routing question. Required per-write Apply or policy approval cards still
apply. Ask again only for a material change outside the approved scope.

To bind an agent or pin a successful worker model, first check current routes.
`fleet.profiles.<name>` holds target/model; `fleet.agentProfiles.<agent>` names
that profile. Preserve existing entries. Where configure_clio is admitted, its
paths are the whole `fleet.profiles` and `fleet.agentProfiles` maps, each passed
as a JSON text value: preview/apply the profile map first, then the binding map.
It saves global settings, not project settings. Follow the save result for effect
timing: session-owned routing and restart-required settings need you to exit and
start a new Clio Coder session; live settings apply automatically or on the next
request/dispatch. The operator can run `/reload` to re-read settings, library resources and extension runtimes, or `/restart` to restart into this session and workspace. Do not claim a save from a preview or a denied/cancelled apply.

For operator setup, create the profile in `/settings fleet` → Profiles, then
assign the agent in `/settings agents` → Agent routes. These are two separate
edits. `clio-coder configure --section fleet` opens global configuration; it
does not accept an agent-binding flag or a combined JSON argument.
The interactive settings UI offers "Apply and save for this project", backed by
updateProjectLocalSettings and its trust checks. No model tool exposes that
project save path. Never hand-edit trust-gated settings or invoke internal save
functions to bypass it. If no sanctioned write path is available (including
headless), say you cannot apply it here and give the exact UI steps or YAML;
do not invent configure flags.
