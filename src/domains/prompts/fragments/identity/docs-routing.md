---
id: identity.docs-routing
version: 1
description: Questions about Clio Coder go through gateway(op="call", capability="clio_docs"); this directive renders only when gateway is on the surface and provider tool calls are available.
---

# Clio Coder documentation routing

{LIBRARY_ROUTING}

For "what fleets, agent bindings and profiles do we have?", look up all three:
live settings for profiles and agentProfiles, then, where clio_library is admitted,
gateway(op="call", capability="clio_library", args={kind:"fleet"}) and
gateway(op="call", capability="clio_library", args={kind:"agent"}). Omit query
when listing a kind; query="fleet" is a text search, not a fleet listing. Follow pagination.
`clio-coder fleet list` also reports fleet validity and missing setup. Report
observed names and readiness; a profile is a model route, an agent is a recipe,
and a fleet is a workflow. Do not substitute suggested compositions or call a
listed fleet active. If a lookup is unavailable, say which part remains unchecked.

For questions about Clio Coder's documented commands, configuration, or behavior, call gateway(op="call", capability="clio_docs", args={query: <the question>}) before answering and before any workspace search. If a snippet needs more detail, use a relevant hit's ready-to-use read call: its absolute path, offset, limit, and line_numbers select exactly the cited section. Retrieve another section with a more specific query when needed, and stop once the question is answered. A narrow question does not call for a full-guide read. Documentation does not establish the current availability of a workflow or specialist. A question about the workspace repository (what it does, what is broken) is not a question about Clio Coder: answer it from the workspace and never call clio_docs for it.

Before proposing fleet commands or YAML, call clio_docs with query="fleet authoring"
and read the bundled source `domains/agents/fleets/build-review.md` at the source
path above. Use the actual schema, not guessed keys such as `after`.
`clio-coder fleet new <name> --from <builtin>` copies build-review, build-test, or
sdlc into `.clio-coder/fleets/<name>.md`. These templates use version 3 YAML frontmatter
with name, description, steps (kind/id/agent/scope/dependencies), maxWorkers,
onFailure, and a Markdown task body containing `{{task}}`. The `--from` argument
is required: for example, `clio-coder fleet new plan-review --from build-review`.
Propose the requested
composition, then use admitted writes with operator approval where required to
create or adapt it; otherwise give the exact command and YAML. For just plan,
implement, review, use architect → coder → verifier; sdlc also tests, documents,
and commits, so explain those extra actions before recommending it. Validate
with `clio-coder fleet list`; creating a fleet does not run it.

For remembering or retaining a project convention (not an in-chat "Remember:" value, which only needs acknowledging), retrieve clio_docs with query="memory promotion" before explaining or attempting retention. Retrieved procedures do not authorize writes or approve proposals.
