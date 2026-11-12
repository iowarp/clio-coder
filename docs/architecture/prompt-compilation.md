# Prompt Compilation

Clio Coder compiles every system prompt from typed inputs and disk fragments. The pure compiler is [compiler.ts](../../src/domains/prompts/compiler.ts). The prompts domain in [extension.ts](../../src/domains/prompts/extension.ts) owns the per-session source snapshots and the dynamic sections that surround the compiled fragments. The fragment files live under `src/domains/prompts/fragments/`. No natural-language parser decides what renders: every condition is a typed input, a registered tool name or a session-standing tool limit.

This page owns which fragments each prompt carries and how they are selected. The cache identity, section order and tool delivery around the compiled text are in [Prompt Envelope and Tools](prompt-envelope-and-tools.md).

## Three compilation tiers

| Tier | Who gets it | Entry point | Selected by |
| --- | --- | --- | --- |
| Attended main | The TUI, the GUI and ACP sessions | `compile` | `headless` is unset in the session inputs |
| Headless main | `clio-coder run` without `--agent` | `compile` | `headless: true` in the session inputs |
| Worker | Every dispatched worker, including `clio-coder run --agent` and `clio-coder fleet` steps | `compileWorker` | A separate entry point with its own inputs |

The orchestrator derives `headless` from whether the process was started as a headless run (`src/entry/orchestrator.ts`). The GUI and ACP are attended for the compiler. They differ from the TUI in three inputs: ACP and GUI sessions get no demo guidance and, under `prompts.profile: v2`, no Mermaid drawing row (the `terminal` fact), and they get the `ask_user` turn-ending contract only when the ACP client enables interviews in its handshake (see [ACP](acp.md)).

Operator-facing text has no reader in a run without an operator and would be resent on every request. The attended-only fragments below carry that text, so the shared fragments stay small and a headless prompt omits the rest.

## Fragment authoring rules

Fragments are Markdown files under `src/domains/prompts/fragments/`, loaded by `loadFragments` in [fragment-loader.ts](../../src/domains/prompts/fragment-loader.ts).

- The frontmatter `id` is a dotted namespace matching `^[a-z0-9-]+(\.[a-z0-9-]+)+$` and is unique across the tree. A duplicate id fails the load with both paths named.
- `version` must be exactly `1`.
- `description` must be a non-empty string.
- `dynamic` is optional and must be a boolean when present. It sets the `dynamic` flag recorded in the manifest.
- `requires`, `surfaces` and `when` are optional preconditions ([preconditions.ts](../../src/domains/prompts/preconditions.ts)). `requires` lists capabilities that must be reachable, directly or through the gateway. `surfaces` lists the tiers the fragment renders on (`attended`, `headless`, `worker`); without it the fragment renders on every tier. `when` takes `sandbox: active|absent` and `autonomy: default|yolo|yolo-unconfined`. An unknown name fails the load. The preconditions that held for a compile are recorded on the fragment's manifest entry.
- A body row can carry its own condition as a `{name}` marker, where the name is a builtin tool, a tier, or one of `sandbox`, `demo`, `terminal` and `peers`. A list item that opens with a marker is kept or dropped whole, and an inline marker keeps or drops the text up to the end of its sentence. A marker with an unknown name fails the load.
- A file name does not have to match its id. `identity/clio-worker.md` carries `identity.clio-coder-worker`.
- A missing or malformed frontmatter block fails the whole load with a path-qualified error, so the compiler never sees a partial table. If the first load fails, the domain starts with an empty table and every compile throws `prompts: no fragments loaded`; the chat reports `prompt compile failed; using fallback identity`.
- Fragments are read at runtime from the package's own `src/` directory, resolved through `resolvePackageRoot`. The npm package ships `src/**` for this reason, and fragment text is not bundled into `dist/`.
- `contentHash` is the SHA-256 of the raw file text, frontmatter included. It feeds the fragment manifest.
- The table reloads on a plugin reload, on `/reload prompts`, and when a config hot-reload diff names a path containing `prompt` or `fragment`. Each reload advances the fragment epoch inside `inputEpoch()`.
- A fragment that teaches a tool renders only when that tool is reachable. Guidance for an operator belongs in an attended-only fragment, never in a shared one.

## Fragment inventory by tier

There are 40 fragment files. Five of them (`identity.clio-v2`, `operating.work`, `operating.harness`, `operating.delegating` and `operating.attended`) render only under `prompts.profile: v2`, described under [Prompt profile v2](#prompt-profile-v2); the table below is the default `v1` profile. Sections that are not fragments (`tool-contract`, `retrieval-hints`, `runtime`, `project-context`, `memory`, and the one-line header of the safety section) are rendered inline from typed inputs. The current task scope is not a compiled section at all; it rides in the turn's reminder, as described under [Task scope](#task-scope).

| Fragment | Attended main | Headless main | Worker | Renders when |
| --- | --- | --- | --- | --- |
| `identity.clio` | yes | yes | no | Always for a main prompt. The prompts domain passes this identity. |
| `identity.clio-attended` | yes | no | no | Attended and the identity is `identity.clio`. |
| `identity.clio-coder-worker` | no | no | yes | Always. |
| `identity.self-awareness` | yes | yes | no | The identity is `identity.clio`. Rendered inside the harness-awareness section. |
| `identity.self-awareness-attended` | yes | no | no | Attended, `identity.self-awareness` rendered, and the `clio_docs` routing row did not replace it. See [Attended-only fragments](#attended-only-fragments). |
| `identity.docs-lookup` | no, one routing row stands in | only with `clio_docs` attached directly | no | Headless, `identity.self-awareness` rendered, provider tool support is not explicitly false, `gateway` and `clio_docs` are both attached schemas, `clio_docs` is a registered builtin, and the turn constraints admit `clio_docs`. Rendered inside the harness-awareness section. An attended session that meets the same conditions through the gateway carries one routing row instead. |
| `identity.docs-routing`, `identity.settings-routing` | no | no | no | Never part of a system prompt. Tool results carry them as guidance; see [Attended-only fragments](#attended-only-fragments). |
| `operating.memory-guidance`, `operating.support-guidance` | yes, inline in the identity section | no | no | Attended, identity `identity.clio`, and the `clio_docs` routing row did not render. Otherwise `clio_docs` results carry them as guidance. |
| `operating.contract` | yes | yes | yes | Always. |
| `operating.decisions` | yes | no | when the worker admits `decide` | `decide` is on the session's capability map, or among the worker's admitted tools. Appended to the operating contract. |
| `operating.contract-attended` | yes | no | no | Attended. |
| `operating.contract-headless` | no | yes | no | Headless main only. |
| `operating.report-guidance` | yes | no | no | Attended and `report` is on the session's capability map. |
| `operating.report` | at `yolo` only | yes | no | Headless, or autonomy `yolo`. |
| `operating.user-control` | yes | no | no | Attended. |
| `operating.steering` | yes | only with a steer channel | yes | `liveSteering` is not `false`. |
| `operating.coordinator` | yes | yes | no | The provider does not lack tool support, `dispatch` is on the attached surface and admitted by the session's standing tool limits, and a standing mode is not `answer`. |
| `operating.fleet` | yes | yes | no | The coordinator fragment rendered and the session has SSH nodes in `fleet.nodes`. |
| `operating.discovered-skills` | yes | yes | no | Skills are usable: `context` is reachable, skill discovery is on, the turn does not disable skills, the mode is not `answer`, and the ready-skill count is not zero. |
| `operating.skill-installs` | yes | no | no | Attended and `operating.discovered-skills` rendered. |
| `operating.worker` | no | no | yes | Always. |
| `dispatch.read-only` | no | no | yes | The dispatch is read-only. |
| `safety.default-sandboxed`, `safety.default-unsandboxed`, `safety.yolo`, `safety.yolo-unconfined`, `safety.worker`, `safety.worker-no-shell`, `safety.yolo-worker` | by autonomy | by autonomy | `safety.worker`, `safety.worker-no-shell` or `safety.yolo-worker` | The main prompt selects its safety body from the effective autonomy. `safety.default` names no fragment of its own: at `default` it resolves to `safety.default-sandboxed` when the session's shell runs in the OS sandbox, else `safety.default-unsandboxed`; an unconfined yolo reads `safety.yolo-unconfined`. A worker reads `safety.yolo-worker` when its permit inherited the operator's yolo, else `safety.worker` when it holds `bash`, `run_script` or `verify`, else `safety.worker-no-shell`. |
| `model.anthropic-5-5` | yes, in the runtime section | yes, in the runtime section | no | The provider supports tools and the wire model id names a Claude 5.5 model (`modelGuidanceFragmentId` in `src/domains/prompts/model-guidance.ts`). |
| `wiki.page`, `wiki.plan`, `wiki.repair` | no | no | no | Never part of a system prompt. See [Wiki generation fragments](#wiki-generation-fragments). |

For a given autonomy level and sandbox state the attended and headless tiers read the same safety fragment; the lines above it and the rows its conditions keep differ. A worker reads its own.

## Attended-only fragments

These six fragments render only when `headless` is unset; each declares `surfaces: [attended]` in its frontmatter. A headless run never carries them.

| Fragment | Section | What it carries | Condition beyond attended |
| --- | --- | --- | --- |
| `identity.clio-attended` | identity | Guidance for replies to the operator: answer first, register matching, the in-chat "Remember: <value>" rule, and the rule that Clio Coder cannot inspect how its replies render. | The identity is `identity.clio`. |
| `identity.self-awareness-attended` | harness-awareness | How Clio answers questions about the software from the bundled docs and source, including `code_nav(source="clio")`. | `identity.self-awareness` rendered and the `clio_docs` routing row did not render. |
| `operating.contract-attended` | operating-contract | Asking before acting on a path outside the workspace, the rule that a repeated operator request after settled dispatches is not a loop block, and a one-line reason before a call the model expects to need approval. | None. |
| `operating.report-guidance` | operating-contract | Drafting a report about a problem in Clio Coder itself through `report`, offering one only for Clio Coder's own failures, and never filing an issue with `gh`. | `report` is on the session's capability map. |
| `operating.user-control` | operating-contract | Operator agency and understanding: state assumptions in time to steer, explain outcomes in proportion, do not present untested results as validated conclusions. | None. |
| `operating.skill-installs` | skills | Skill installation etiquette: install only when requested or approved, honor a marketplace reminder's interview options, do not bypass integrity checks. | `operating.discovered-skills` rendered. |

An attended session whose provider supports tools, with `gateway` attached and `clio_docs` registered and admitted, carries one routing row in the harness-awareness section in place of `identity.self-awareness-attended` and `identity.docs-lookup`. The row sends a question about Clio Coder to `clio_docs` first, live values to `context(scope="settings")` and changes to `configure_clio`. The procedures arrive in those tools' results under `Guidance` (`src/domains/prompts/runtime-guidance.ts`):

- Every `clio_docs` result carries `operating.support-guidance`, `operating.memory-guidance` when the query matches memory vocabulary, and `identity.docs-routing` when it names playbooks, fleets, workflows or profiles.
- A `clio_library` read of `kind=playbook` or `kind=agent` carries `identity.docs-routing`.
- A `context(scope="settings")` read and a `configure_clio` preview carry `identity.settings-routing`.

When the routing row does not render, an attended `identity.clio` prompt inlines `operating.memory-guidance` and `operating.support-guidance` into the identity section, keeps `identity.self-awareness-attended`, and adds a one-line settings row when `context` is an attached schema. `identity.docs-routing` and `identity.settings-routing` never enter a compiled prompt.

Demo guidance is appended to the operating contract only for the TUI, when `interface.demo` is on. ACP, the GUI and headless runs never carry it.

## Shared and role fragments

These fragments are not attended-only. Their tiers are in the inventory above.

- `identity.clio` holds Clio Coder's identity, the rule that claims about the workspace come from files or tools, and the two-state turn ending: done with no closing offer, or waiting on a decision only the operator can make.
- `identity.docs-lookup` routes a question about Clio Coder's documented commands, configuration or behavior to `clio_docs` before any workspace search, follows a hit's ready-to-use read call for detail, names the docs pages the answer rests on, and keeps workspace questions away from `clio_docs`.
- `operating.contract` is the constitutional posture shared by all three tiers: plain prose, honoring no-tools and no-delegation instructions, batching independent reads, and treating safety policy as authoritative.
- `operating.decisions` closes the operating contract where `decide` is reachable: record a consequential design choice before implementing it, and check the implementation against active decisions before committing.
- `operating.report` shapes a final reply nobody watched being produced. Its first line says where the task stands against the request (done, partly done or not done) and names any unmet clause.
- `operating.steering` tells the model that a user message arriving between tool results steers the current run, and that a later message wins over an earlier one.
- `operating.coordinator` routes intent and delegation. An exact operator assignment goes into `task` verbatim without the delegation wording around it. A suspicion goes into `task` or `briefing` as a question to test, never as a finding, and the coordinator does not certify two implementations equivalent until every path that changes the compared state is traced in each. When the operator names a target or model for one dispatch, the coordinator pins it with dispatch's `target` and `model` fields and never edits routing settings for a one-off request. Several independent reviews or investigations go out in one parallel dispatch whose tasks name their files, rather than being done in turn or read first. Without an OS sandbox, workers confined by `write_roots` cannot run `bash` or `verify`.
- `operating.fleet` states that workers run locally unless a pin or preference selects an SSH node, and how the model asks once per session for a node.
- `operating.discovered-skills` teaches progressive skill discovery through `context(scope="skills")` and carries `{SKILL_ACTIVATION_POLICY}`.
- `operating.worker` is the assigned-task contract. A task worded as an instruction to dispatch or delegate is the worker's own assignment, and the worker does it itself.
- `dispatch.read-only` tells a read-only worker that it must leave every user file unchanged: inspection inside the workspace, shell commands only inside its sandbox, and read-only workers of its own.
- The `safety.default` bodies (`safety.default-sandboxed`, `safety.default-unsandboxed`) and `safety.yolo` describe what runs, what is approval-required and what is blocked, in the safety net's action-class vocabulary. The default bodies describe containment, workspace snapshots and the safety judge; `safety.yolo` says the operator is away by contract, names the floor, and tells the model to take reasonable defaults and state its assumptions. `safety.yolo-worker` is the worker form of the yolo statement, and `safety.worker` and `safety.worker-no-shell` state what a worker's own commands may do, or that it runs none. They are the model-facing mirror of the enforced admission and grant nothing themselves. Each body describes only the reading session's own situation. Row conditions drop the lines a session cannot use, such as `/rewind` in a headless run, and an attended `yolo` session with `ask_user` attached reads that an operator may be present in place of the sentences saying nobody will answer (`sessionSafetyBody` in `src/domains/prompts/compiler.ts`).

The safety section opens with `Autonomy: <level>.` and a one-line directive, then one approval sentence, then the fragment body. The attended approval sentence says that approval-required calls pause for one operator confirmation. At `yolo` nothing parks, so the section carries no approval sentence. A worker has no autonomy level, so its section opens with a line naming its permit and, unless the permit inherited yolo, ends the line with its `onPermission` routing:

| `onPermission` | Sentence in the worker prompt |
| --- | --- |
| `escalate` | Approval-required calls pause for a bounded operator decision before execution. |
| `deny` | Approval-required calls are denied immediately; they are not parked for an operator. |
| `fail` | An approval-required call fails and ends the worker run; it is not parked for an operator. |

## Headless main prompt

A headless main prompt carries `identity.clio`, `identity.self-awareness`, `identity.docs-lookup` only when `clio_docs` is an attached schema, `operating.contract`, `operating.contract-headless`, `operating.report`, `operating.steering` only when a steer channel exists, `operating.coordinator` when dispatch is reachable, `operating.fleet` too when the session has SSH nodes, `operating.discovered-skills` without `operating.skill-installs`, and `safety.<level>`.

`operating.contract-headless` is the only fragment that renders for headless main alone. It carries the unattended finishing rule: restate the task as separate clauses, check whether existing tests cover each clause, write a focused reproduction test only when no existing test covers the clause and the task and project instructions allow tests, make the reproduction fail on untouched code first, and map each clause to evidence in the diff or a check that ran before the final report. A clause without evidence is unfinished.

The safety section swaps the attended approval sentence for this one: "No operator is attached to this headless run, so approval-required calls are denied instead of pausing; use recognized commands and typed checks, and report what could not run." A headless run denies every approval ask the safety judge does not allow (`src/core/headless-permission.ts`), and at `yolo` nothing asks, so the prompt never promises a pause.

Other differences from the attended tier:

- The capability map and usage notes leave out `artifact`, `clio_docs`, `clio_library`, `credential_present`, `decide`, `evidence`, `job` and `tasks` unless a schema is attached directly (`HEADLESS_UNMAPPED_CAPABILITIES`). A fragment or row that requires one of them does not render either, so `operating.decisions` is absent and `identity.docs-lookup` renders only when `clio_docs` is attached directly: the prompt never names a capability its map leaves out. Each stays reachable through `gateway(op="find")`, and a find that names the capability exactly also returns its schema, so the call needs no `describe` round trip ([gateway/index.ts](../../src/tools/gateway/index.ts)).
- The `ask_user` turn-ending contract never renders, because no operator can answer an interview.
- No `Routes:` line appears in the runtime block, because the orchestrator passes route sources to attended sessions only.
- The orchestrator registers task-ranked skills and capability advice for headless main turns as well as attended turns. The advice rides model-only reminder text in the message tail, alongside the system prompt's conditional skills guidance; it does not alter tool schemas ([skills-reminder.ts](../../src/domains/middleware/skills-reminder.ts)).
- On Clio Coder's own repository the self-development note tells the run to load `clio-coder-dev` before the first edit and `clio-coder-test` before choosing checks. See [Self-development skills](#self-development-skills).

## Worker prompt

`compileWorker` builds the worker's stable system prompt in this order:

1. `identity.clio-coder-worker`.
2. The operating-contract section: `operating.contract`, with `operating.decisions` appended when the worker admits `decide`, then `operating.worker`, then a fixed sentence forbidding claims of completions, validations or file changes that no tool call in the run supports.
3. `operating.steering`, unless `liveSteering === false`.
4. The tool contract, rendered inline from the final admitted tool names, one line naming the admitted capabilities reached through `gateway`, and one registry-owned hint per attached tool.
5. The safety section: a line naming the run's permit, the `onPermission` sentence, then the `safety.worker` body, or `safety.worker-no-shell` for a worker holding none of `bash`, `run_script` and `verify`. When the worker's permit inherited the operator's yolo, the section carries the permit line and the `safety.yolo-worker` body, and no `onPermission` sentence.
6. `dispatch.read-only`, when the dispatch is read-only.
7. The persona: the recipe body or a bounded request override, with bound-skill mechanics. The manifest records it as `persona.<recipe id>`.
8. Additional fragments: the `context.clio-repo-awareness` note when the run's working directory is inside Clio Coder's own source tree, then project rules scoped to the run's working-context paths, then the operator profile.

The turn's scope reaches a worker as a separate `dispatch-turn-scope` task message, so the compiled worker prompt does not vary with it.

`compileWorker` throws when the persona is dynamic or empty, when `hasCanonicalContext` disagrees with the final attached tool surface, or when bound skills are requested without canonical `context`.

`liveSteering === false` drops `operating.steering`; an undefined value reads as true. The flag is false when nothing can steer the worker. Dispatch sets it through `workerSteering`, and `workerSteering` is false in the headless orchestrator, in `clio-coder fleet`, and in `clio-coder run --agent` without `--steer-channel`. A headless main run without a steer channel sets `liveSteering: false` for its own prompt as well.

A worker never receives `operating.coordinator`, `operating.fleet`, `operating.discovered-skills`, `operating.user-control`, `operating.contract-attended`, `operating.contract-headless`, `operating.report`, `operating.report-guidance`, any attended-only identity fragment, or the `clio_docs` routing row. Its reply goes to the orchestrator, so conversational and operator-facing guidance has no reader. The constitutional contract and the safety body stay shared. Project context, memory, the briefing, pipeline input and the task are separate dynamic messages; see [Prompt Envelope and Tools](prompt-envelope-and-tools.md).

## Rules that cross tiers

- The install rule lives in `operating/contract.md` and applies to every tier. A check that cannot run because declared dependencies were never installed is setup, so the run installs through the normal approval path and reruns the check. A failure confined to files the change does not touch predates the change, including a missing module imported only there; the run reports it instead of repairing it or installing for it.
- The unattended finishing rule lives only in `operating.contract-headless` and in the coder persona, `src/domains/agents/builtins/coder.md`. Other worker personas and attended sessions do not carry it.
- Neighboring-test guidance for reproduction tests appears in the same two places.
- The completion-claim sentence is added to every worker prompt by the compiler. It is not a fragment.

## Prompt profile v2

`prompts.profile` selects the main prompt's text: `v1` (the default) or `v2`. `v2` is experimental. The setting is restart-required, because the profile is fixed when a session compiles its prefix. Everything else on this page describes `v1`. Under `v2` the compiler makes these swaps:

- `identity.clio-v2` replaces `identity.clio`, and `operating.work` replaces `operating.contract`. A worker keeps its own identity and gets `operating.work` in place of `operating.contract`; the rest of its prompt is unchanged.
- `operating.harness` renders as its own `harness` section: one row per mechanism (code navigation, skills, `verify`, `tasks`, `dispatch`, `monitor`, `job`, `panes`, peers, memory, `decide`, recall, `clio_docs`), each kept only when its capability is reachable. It replaces `operating.discovered-skills`, `operating.decisions` and the `clio_docs` lookup.
- `operating.delegating` replaces `operating.coordinator` in the delegation section. `operating.fleet` still follows it when the session has SSH nodes.
- `operating.attended` renders as its own `operator` section in attended sessions. It replaces `identity.clio-attended`, `operating.contract-attended`, `operating.user-control`, attended steering guidance, the turn-ending contract and the demo guidance. Its Mermaid row renders only in the terminal UI.
- A headless prompt keeps `operating.contract-headless` and `operating.steering`, and the operating contract states that a call needing approval is denied, so the safety section carries no approval sentence.
- The harness-awareness section is empty. The two lines of `identity.self-awareness` naming the docs and source paths and the settings path move to the runtime section.
- The section order is identity, operating-contract, harness, delegation, tool-contract, safety, operator, harness-awareness, retrieval-hints, project-context and runtime, then additional fragments and memory as in `v1`.
- When the chat model's context window is under 48,000 tokens, the capability map drops its examples.

`PROMPT_BUDGET_CHARS` in `src/domains/prompts/compiler.ts` holds the `v2` size budgets a contract test enforces on a reference fixture: 26,000 characters attended, 25,000 for ACP, 19,000 headless, 21,000 headless at `yolo` and 11,500 for a worker.

## Self-development skills

When the session's working directory is inside Clio Coder's own source tree, the prompts extension adds the dynamic fragment `context.clio-repo-awareness` and, when skills are usable and the turn mode is not `proposal`, `context.self-development-skills`.

- Attended sessions are told to load `clio-coder-dev` once they have read the code and are about to make the first edit, and `clio-coder-test` once the change exists and they are choosing validation. Each loads at its step, never both up front, because a loaded skill is resent on every later request.
- Headless runs are told to load `clio-coder-dev` before the first edit and `clio-coder-test` before choosing checks for a task that changes the repository, and to skip both for a question or a read-only task.

## Substitutions

The compiler fills these tokens by plain string replacement, one occurrence per token. Fragments carry the raw token text and the compiler owns the values.

| Token | Fragment | Replaced with |
| --- | --- | --- |
| `{CLIO_DOCS_PATH}` | `identity.self-awareness` | `<package root>/docs` |
| `{CLIO_SRC_PATH}` | `identity.self-awareness` | `<package root>/src` |
| `{CLIO_SRC_PACKED_NOTE}` | `identity.self-awareness` | In an installed package whose `.ts` source ships in `dist/assets/source.pack`, a sentence saying `read` and `code_nav` open the packed source but `grep`, `find` and `bash` do not see it; in a checkout, the empty string (`sourceIsPacked` in `src/core/source-pack.ts`) |
| `{CLIO_SETTINGS_PATH}` | `identity.self-awareness` | `settings.yaml` inside the live config directory, so an isolated `CLIO_CODER_HOME` or config override moves it |
| `{CLIO_STATE_PATH}` | `identity.self-awareness` | The live state directory |
| `{SKILL_ACTIVATION_POLICY}` | `operating.discovered-skills` | Instructions to load a matching ready skill through the gateway, or to suggest `/skill <name>` when the model may not activate skills |

`wiki.page`, `wiki.plan` and `wiki.repair` use a different placeholder family, double-brace tokens such as `{{pagePath}}`. They are filled by the wiki generator, not the compiler.

## Wiki generation fragments

`wiki.page`, `wiki.plan` and `wiki.repair` load through the same fragment loader and carry the same id, version and content-hash contract. `src/domains/context/wiki/prompts.ts` reads them by id on every call, replaces each `{{token}}` with a per-dispatch value (a page's path, relative path and title; the plan file's path), and sends the result as a wiki-generation dispatch's `task`. `wiki.repair` assigns bounded edits to an existing draft after a publication validation failure. They never become a compiled system prompt. The loader hands back the raw body, so the one caller that needs live values fills them in. The `wiki.page` and `wiki.plan` bodies begin and end with a standalone `---` line that is ordinary body text.

## Dynamic sections

The compiled prompt has fixed sections in this order (`SESSION_PROMPT_SECTION_ORDER`): identity, operating-contract, delegation, skills, safety, tool-contract, harness-awareness, retrieval-hints, project-context, runtime. Additional fragments follow, then a context-operation update that summarizes the operator's recent context operations (initialize, refresh, reset and the like) in this session, then memory. Memory can change between turns, so it renders last and a memory change resends only itself. The compiler records `pinnedPrefix` (a character count and SHA-256) at the end of harness-awareness, so a provider that splits its system prompt for caching can place a breakpoint where the install-wide bytes end. The main thread splits there on Anthropic Messages (a second system block with its own breakpoint) and on `openai-codex` (the rest follows the head as its own item: a second developer item when the prompt travels as developer items, the first input item after `instructions` on SSE; see [Context engine](context-engine.md)). Each section belongs to a cache layer in `PROMPT_SECTION_LAYER`:

- Pinned: fixed by the install, the autonomy level and the admitted tool surface. Every session on the install shares these bytes. Covers identity through harness-awareness.
- Session: captured once per session and stable across its turns. Covers project context, runtime and the dynamic fragments below that are marked session.
- Turn: may change between turns. Covers retrieval hints, memory and path-scoped project rules. An id missing from the table counts as turn.

| Section or fragment id | Content | Layer | Source and caching |
| --- | --- | --- | --- |
| `project-context` | Under a `# Project` heading, a `Declared checks (verify):` line naming up to 12 of the project's declared check ids when `verify` is reachable, then the project handbook text. | session | Captured in the session source snapshot and sized by `selectProjectPreload`. |
| `memory` | The task-scored memory section. | turn | Selected at each prepared turn but frozen into the compiled prompt until a completed compaction, a session switch or a recompile that another input forces. Later changes arrive as a `# Memory update` block in the turn's reminder. See [Memory in the prompt](#memory-in-the-prompt). |
| `runtime` | Provider, model, the `Routes:` line, the context window, thinking guidance, and the `model.anthropic-5-5` notes for a Claude 5.5 model. | session | Rendered on every compile. The `Routes:` line is frozen per route identity. |
| `context.workspace-root` | Absolute workspace root, local OS account and hostname. | session | Snapshot. The workspace facts stay pinned for the session while the process lives, even when another source is recaptured. Per-session facts are not in this fragment; see [Session context](#session-context). |
| `context.fleet` | Observed SSH node readiness and capacity. | turn | Rendered only when `fleet.nodes` is non-empty and `dispatch` is attached. It is absent from the layer table, so it counts as turn, and its hash is part of `inputEpoch()`. |
| `context.clio-repo-awareness` | The note that the workspace is Clio Coder's own source tree, and whether the running build came from that tree or from another one. | session | Snapshot. |
| `context.self-development-skills` | The skill-loading note above. | session | Built per compile from session inputs. |
| `context.catalogs` | Installed skills, agents and playbooks by name and a short purpose, plus user-scope MCP server ids. Each list is capped at 60 entries. A Peers group lists each installed coding agent whose pane handoff is ready (its CLI is on the recorded interop report and the session carries `panes`), with any configured headless target for `dispatch`; it also turns on the harness's peers row. | session | Snapshot. Grants nothing. |
| `context.project-rules` | Unconditional `.clio-coder/rules` plus path-scoped rules matching the working context. | turn | Rules load into the snapshot. Selection re-runs against the working-context paths. |
| `context.operator-profile` | The capped operator profile. | session | Snapshot. |

### Session context

Facts that differ between two sessions on an unchanged tree are not compiled into the system prompt, so two sessions in one workspace share the whole prompt as a cache prefix. The prompts extension renders them as a `<session-context>` block (`renderSessionContext` in `src/domains/prompts/extension.ts`), bounded at 400 characters before the orientation line: git branch and tree state, the last recorded session in this workspace, the last commit, a `Rigor: high` line when the project or `CLIO_CODER_RIGOR` declares it, and the time the project orientation snapshot was recorded. The block rides in the reminder of the session's first user message, beside the task scope. It is sent again only when no message still in context carries it, as after a compaction that summarized the first turn away. It is captured once per session and pinned with the workspace facts.

### Route provenance

The runtime block carries one line, `Routes: chat <source>, memory <source>, compaction <source>, fleet <source>.`, built by `formatRouteSources` in `src/core/route-provenance.ts`. A source is `session`, `project`, `user` or `built-in`, and `=chat` marks a route that is unset and follows the chat route. A session source means an override that lives in process memory, including a CLI flag. The orchestrator reads the sources from live settings state, so a compaction summary that drops a session route cannot decide what Clio says about it. It freezes them per route identity (target, runtime and wire model), so a thinking-only override does not rewrite the line, and it reads them again after a completed compaction or a session switch. Only attended sessions pass route sources, and they are part of the session inputs that the cache identity hashes, so a changed source recompiles the prompt.

### Task scope

The turn's scope (mode, delegation, skills, read-only, allowed tools and delegated tools) renders as a `# Current task scope` block from `turnScopeGuidance` in `src/core/turn-constraints.ts`. It is not part of the compiled system prompt. A main turn carries it in the `<system-reminder>` of that turn's user message, kept verbatim in history and repeated on continuations. A dispatched worker receives it as a task message. Only the session's standing tool limits, such as an operator flag or an ACP ceiling, enter compilation, so a scope change between turns does not recompile the prompt. Admission still enforces the scope.

### Memory in the prompt

The compiled `# Memory` section stays in the prompt until a completed compaction, a session switch or a recompile forced by another input. A record approved or revised later reaches the model in the next turn's reminder as a `# Memory update` block, and a record rejected or deleted since arrives as a withdrawn line. A record that only dropped out of the ranking is not withdrawn. See [Evidence and Memory](evidence-and-memory.md).

### Mid-session autonomy changes

A change of autonomy level during a session does not recompile the prompt. The host appends a durable policy message, built by `renderSessionPostureUpdate`, that supersedes the compiled safety posture and the posture-dependent turn-ending and settings-change guidance. The session ledger records it as a `clio_coder_posture_update` entry under the generation recorded by `clio_coder_posture_generation` (`src/session-control/posture-policy.ts`).

### Project context

The prompts extension captures the project handbook once per session through the context domain. `selectProjectPreload` renders it in full when it fits 24,000 UTF-16 code units and 220 lines. Otherwise it renders the largest safe prefix of each handbook, nearest handbook first, under a `<project-preload>` notice that lists the included and omitted physical line ranges and how to read the rest. The result is classified as `full`, `partial` or `none` and recorded on the compiled prompt as `projectPreload`. The class follows the handbook sources, so with no handbook loaded it is `none` (reason `no-clio-md`) even though the support fragments still put text under `# Project` ([preload.ts](../../src/domains/prompts/preload.ts)). `--no-context-files` (`-nc`) suppresses project context entirely. Handbook selection and discovery are in [Project Context](project-context.md).

### Operator notes

Operator notes are not part of the compiled system prompt. They live in the compaction summary, as an `<operator-notes>` block. It carries the operator sentences that begin with `remember`, `keep in mind` or `don't forget` (the latest 30, each cut at 400 characters) and, verbatim, the text of any `/compact` instruction. A `/compact` instruction also reaches the summarizer through an `<operator-instructions>` block. Compaction mechanics are in [Context Continuity](../guide/context-continuity.md).

## Hashing and caching

- Every compile returns `systemPrompt`, its SHA-256 `systemPromptHash`, a token estimate, a per-section token breakdown, and a `fragmentManifest` of `{id, relPath, contentHash, dynamic}` for each fragment that rendered. Inline dynamic fragments use `relPath` values under `inline/` and `dynamic: true`.
- `stablePrefix` is the byte count and SHA-256 of the trimmed identity section and operating-contract section plus their separators. Workers expose the same measurement over their own identity and contract.
- The chat reuses the compiled prompt byte-for-byte while `mainPromptCacheIdentity` is unchanged. That identity is version 2 and hashes the target, runtime and wire model ids, autonomy, session id, working directory, sorted working-context paths, the context-window source, `inputEpoch()`, the full session inputs (which include route sources, the session's standing tool limits, ready-skill count, the frozen memory section, `headless` and `liveSteering`), and the exact attached tool-schema bytes.
- `inputEpoch()` joins the fragment epoch, the agent-catalog revision, the session-source epoch and the hash of the fleet inventory.
- The session source snapshot freezes project context, rules, the operator profile, the workspace facts, repo awareness and catalogs. A context operation in the workspace or an ancestor, and a config hot-reload, invalidate it, and the next compile captures them again. The workspace root, the session-context block and the capture time are carried over from the invalidated snapshot, so git state that changed mid-session rewrites neither. A new session captures its own. The first prompt of a fresh session compiles before the session exists, under an empty id; that capture is parked and adopted by the session created after it, so turns one and two stay byte-identical.
- A recompile that changes the text appends a `promptRecompiled` ledger entry (previous hash, new hash, token estimate). Each distinct prompt structure is journaled once as a `prompt.compiled` record whose `prompt-structure` object holds the section and fragment breakdown.
- Workers have no snapshot. `compileWorkerPrompt` loads rules and the operator profile for the run's working-context paths on each compile and returns `rulesApplied` and `operatorProfileApplied` for the run's provenance.
