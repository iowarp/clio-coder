---
id: identity.docs-routing
version: 1
description: Playbook, agent and profile listing and authoring rules; served under Guidance in clio_docs results on a fleet or playbook topic and in clio_library kind=playbook or kind=agent results, never in a prompt.
---

For "what playbooks, agent bindings and profiles do we have?", look up all three:
live settings (context scope=settings) for profiles and agentProfiles, then, where clio_library is admitted,
gateway(op="call", capability="clio_library", args={kind:"playbook"}) and
gateway(op="call", capability="clio_library", args={kind:"agent"}). Omit query
when listing a kind; query="playbook" is a text search, not a playbook listing. Follow pagination.
`clio-coder playbook list` also reports playbook validity and missing setup. Report
observed names and readiness; a profile is a model route, an agent is a worker definition,
and a playbook is a workflow the fleet runs. Do not substitute suggested compositions or call a
listed playbook active. If a lookup is unavailable, say which part remains unchecked.

Documentation does not establish the current availability of a workflow or specialist.

Before proposing playbook commands or YAML, call clio_docs with query="fleet authoring"
and read the bundled source `domains/agents/playbooks/build-review.md` under the
Clio source path. Use the actual schema, not guessed keys such as `after`.
`clio-coder playbook new <name> --from <builtin>` copies build-review, build-test, or
sdlc into `.clio-coder/playbooks/<name>.md`. These templates use version 3 YAML frontmatter
with name, description, steps (kind/id/agent/scope/dependencies), maxWorkers,
onFailure, and a Markdown task body containing `{{task}}`. The `--from` argument
is required: for example, `clio-coder playbook new plan-review --from build-review`.
Propose the requested
composition, then use admitted writes with operator approval where required to
create or adapt it; otherwise give the exact command and YAML. For just plan,
implement, review, use architect → coder → verifier; sdlc also tests, documents,
and commits, so explain those extra actions before recommending it. Validate
with `clio-coder playbook list`; creating a playbook does not run it.
