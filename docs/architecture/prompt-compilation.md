# Prompt Compilation

Clio Coder compiles every system prompt from typed inputs and disk fragments. The pure compiler is [compiler.ts](../../src/domains/prompts/compiler.ts). The prompts domain in [extension.ts](../../src/domains/prompts/extension.ts) owns the per-session source snapshots and the dynamic sections that surround the compiled fragments. The fragment files live under `src/domains/prompts/fragments/`. No natural-language parser decides what renders: every condition is a typed input, a registered tool name or a host-supplied turn constraint.

This page owns which fragments each prompt carries and how they are selected. The cache identity, section order and tool delivery around the compiled text are in [Prompt Envelope and Tools](prompt-envelope-and-tools.md).

## Three compilation tiers

| Tier | Who gets it | Entry point | Selected by |
| --- | --- | --- | --- |
| Attended main | The TUI, the GUI and ACP sessions | `compile` | `headless` is unset in the session inputs |
| Headless main | `clio-coder run` without `--agent` | `compile` | `headless: true` in the session inputs |
| Worker | Every dispatched worker, including `clio-coder run --agent` and `clio-coder fleet` steps | `compileWorker` | A separate entry point with its own inputs |

The orchestrator derives `headless` from whether the process was started as a headless run (`src/entry/orchestrator.ts`). The GUI and ACP are attended for the compiler. They differ from the TUI in two inputs: ACP and GUI sessions get no demo guidance, and they get the `ask_user` turn-ending contract only when the ACP client enables interviews in its handshake (see [ACP](acp.md)).

Operator-facing text has no reader in a run without an operator and would be resent on every request. The attended-only fragments below carry that text, so the shared fragments stay small and a headless prompt omits the rest.

## Fragment authoring rules

Fragments are Markdown files under `src/domains/prompts/fragments/`, loaded by `loadFragments` in [fragment-loader.ts](../../src/domains/prompts/fragment-loader.ts).

- The frontmatter `id` is a dotted namespace matching `^[a-z0-9-]+(\.[a-z0-9-]+)+$` and is unique across the tree. A duplicate id fails the load with both paths named.
- `version` must be exactly `1`.
- `description` must be a non-empty string.
- `dynamic` is optional and must be a boolean when present. It sets the `dynamic` flag recorded in the manifest.
- A file name does not have to match its id. `identity/clio-worker.md` carries `identity.clio-coder-worker`.
- A missing or malformed frontmatter block fails the whole load with a path-qualified error, so the compiler never sees a partial table. If the first load fails, the domain starts with an empty table and every compile throws `prompts: no fragments loaded`; the chat reports `prompt compile failed; using fallback identity`.
- Fragments are read at runtime from the package's own `src/` directory, resolved through `resolvePackageRoot`. The npm package ships `src/**` for this reason, and fragment text is not bundled into `dist/`.
- `contentHash` is the SHA-256 of the raw file text, frontmatter included. It feeds the fragment manifest.
- The table reloads on a plugin reload and when a config hot-reload diff names a path containing `prompt` or `fragment`. Each reload advances the fragment epoch inside `inputEpoch()`.
- A fragment that teaches a tool renders only when that tool is reachable. Guidance for an operator belongs in an attended-only fragment, never in a shared one.

## Fragment inventory by tier

There are 24 fragments. Sections that are not fragments (`tool-contract`, `retrieval-hints`, `runtime`, `project-context`, `memory`, `turn-scope`, and the one-line header of the safety section) are rendered inline from typed inputs.

| Fragment | Attended main | Headless main | Worker | Renders when |
| --- | --- | --- | --- | --- |
| `identity.clio` | yes | yes | no | Always for a main prompt. The prompts domain passes this identity. |
| `identity.clio-attended` | yes | no | no | Attended and the identity is `identity.clio`. |
| `identity.clio-coder-worker` | no | no | yes | Always. |
| `identity.self-awareness` | yes | yes | no | The identity is `identity.clio`. Rendered inside the harness-awareness section. |
| `identity.self-awareness-attended` | yes | no | no | Attended and `identity.self-awareness` rendered. |
| `identity.docs-routing` | yes | no | no | See [Attended-only fragments](#attended-only-fragments). |
| `identity.settings-routing` | yes | no | no | See [Attended-only fragments](#attended-only-fragments). |
| `operating.memory-guidance`, `operating.support-guidance` | yes, inline in the identity section | no | no | Attended, identity `identity.clio`, and `identity.docs-routing` did not render. |
| `operating.contract` | yes | yes | yes | Always. |
| `operating.contract-attended` | yes | no | no | Attended. |
| `operating.contract-headless` | no | yes | no | Headless main only. |
| `operating.user-control` | yes | no | no | Attended. |
| `operating.steering` | yes | only with a steer channel | yes | `liveSteering` is not `false`. |
| `operating.coordinator` | yes | yes | no | The provider does not lack tool support, `dispatch` is on the attached surface and admitted by the turn constraints, and the turn mode is not `answer`. |
| `operating.fleet` | yes | yes | no | The coordinator fragment rendered and the session has SSH nodes in `fleet.nodes`. |
| `operating.discovered-skills` | yes | yes | no | Skills are usable: `context` is reachable, skill discovery is on, the turn does not disable skills, the mode is not `answer`, and the ready-skill count is not zero. |
| `operating.skill-installs` | yes | no | no | Attended and `operating.discovered-skills` rendered. |
| `operating.worker` | no | no | yes | Always. |
| `dispatch.read-only` | no | no | yes | The dispatch is read-only. |
| `safety.default`, `safety.yolo` | by autonomy | by autonomy | `safety.default` | The main prompt selects `safety.<level>` from the effective autonomy. A worker always reads `safety.default`. |
| `wiki.page`, `wiki.plan` | no | no | no | Never part of a system prompt. See [Wiki generation fragments](#wiki-generation-fragments). |

For a given autonomy level the safety body is shared by all three tiers; only the lines above it differ.

## Attended-only fragments

These seven fragments render only when `headless` is unset. A headless run never carries them.

| Fragment | Section | What it carries | Condition beyond attended |
| --- | --- | --- | --- |
| `identity.clio-attended` | identity | Guidance for replies to the operator: answer first, register matching, the in-chat "Remember: <value>" rule, and the rule that Clio Coder cannot inspect how its replies render. | The identity is `identity.clio`. |
| `identity.self-awareness-attended` | harness-awareness | How Clio answers questions about the software from the bundled docs and source, including `code_nav(source="clio")`. | `identity.self-awareness` rendered. |
| `identity.docs-routing` | harness-awareness | Routes questions about Clio Coder through `gateway(op="call", capability="clio_docs")`, plus the `clio_library` sentence when that capability is admitted. | `identity.self-awareness` rendered, provider tool support is not explicitly false, `gateway` is on the surface, `clio_docs` is a registered builtin, and the turn constraints admit `clio_docs`. |
| `identity.settings-routing` | harness-awareness | Routes questions about Clio Coder's settings to `context(scope="settings")`, written in its gateway call form, and states how a setting change is made. | `identity.self-awareness` rendered and `context` is reachable, directly or through an admitted gateway. |
| `operating.contract-attended` | operating-contract | Asking before acting on a path outside the workspace, and the rule that a repeated operator request after settled dispatches is not a loop block. | None. |
| `operating.user-control` | operating-contract | Operator agency and understanding: state assumptions in time to steer, explain outcomes in proportion, do not present untested results as validated conclusions. | None. |
| `operating.skill-installs` | skills | Skill installation etiquette: install only when requested or approved, honor a marketplace reminder's interview options, do not bypass integrity checks. | `operating.discovered-skills` rendered. |

When `identity.docs-routing` does not render, an attended `identity.clio` prompt inlines `operating.memory-guidance` and `operating.support-guidance` into the identity section instead. When it renders, those two procedures are retrieved on demand: every `clio_docs` result carries `operating.support-guidance` under `guidance`, and `operating.memory-guidance` when the query matches memory vocabulary (`src/domains/prompts/runtime-guidance.ts`).

`identity.docs-routing` needs no `context` access, and `identity.settings-routing` needs no `clio_docs`. Each renders on its own conditions.

Demo guidance is appended to the operating contract only for the TUI, when `interface.demo` is on. ACP, the GUI and headless runs never carry it.

## Shared and role fragments

These fragments are not attended-only. Their tiers are in the inventory above.

- `identity.clio` holds Clio Coder's identity, the rule that claims about the workspace come from files or tools, and the two-state turn ending: done with no closing offer, or waiting on a decision only the operator can make.
- `operating.contract` is the constitutional posture shared by all three tiers: plain prose, honoring no-tools and no-delegation instructions, batching independent reads, treating safety policy as authoritative, and recording consequential design choices before implementing.
- `operating.steering` tells the model that a user message arriving between tool results steers the current run, and that a later message wins over an earlier one.
- `operating.coordinator` routes intent and delegation. An exact operator assignment goes into `task` verbatim without the delegation wording around it. When the operator names a target or model for one dispatch, the coordinator pins it with dispatch's `target` and `model` fields and never edits routing settings for a one-off request. Without an OS sandbox, workers confined by `write_roots` cannot run `bash` or `verify`.
- `operating.fleet` states that workers run locally unless a pin or preference selects an SSH node, and how the model asks once per session for a node.
- `operating.discovered-skills` teaches progressive skill discovery through `context(scope="skills")` and carries `{SKILL_ACTIVATION_POLICY}`.
- `operating.worker` is the assigned-task contract. A task worded as an instruction to dispatch or delegate is the worker's own assignment, and the worker does it itself.
- `dispatch.read-only` restricts a run to inspection inside the workspace.
- `safety.default` and `safety.yolo` describe what runs, what is approval-required and what is blocked, in the safety net's action-class vocabulary. They are the model-facing mirror of the enforced autonomy mapping and grant nothing themselves.

The safety section opens with `Autonomy: <level>.` and a one-line directive, then one approval sentence, then the fragment body. The attended approval sentence says that approval-required calls pause for one operator confirmation. A worker has no autonomy level, so its section opens with a line naming its permit and ends the line with its `onPermission` routing:

| `onPermission` | Sentence in the worker prompt |
| --- | --- |
| `escalate` | Approval-required calls pause for a bounded operator decision before execution. |
| `deny` | Approval-required calls are denied immediately; they are not parked for an operator. |
| `fail` | An approval-required call fails and ends the worker run; it is not parked for an operator. |

## Headless main prompt

A headless main prompt carries `identity.clio`, `identity.self-awareness`, `operating.contract`, `operating.contract-headless`, `operating.steering` only when a steer channel exists, `operating.coordinator` when dispatch is reachable, `operating.fleet` too when the session has SSH nodes, `operating.discovered-skills` without `operating.skill-installs`, and `safety.<level>`.

`operating.contract-headless` is the only fragment that renders for headless main alone. It carries the unattended finishing rule: restate the task as separate clauses, check whether existing tests cover each clause, write a focused reproduction test only when no existing test covers the clause and the task and project instructions allow tests, make the reproduction fail on untouched code first, and map each clause to evidence in the diff or a check that ran before the final report. A clause without evidence is unfinished.

The safety section swaps the attended approval sentence for this one: "No operator is attached to this headless run, so approval-required calls are denied instead of pausing; use recognized commands and typed checks, and report what could not run." A headless run denies every approval ask at both autonomy levels, a yolo damage-control confirmation included (`src/core/headless-permission.ts`), so the prompt never promises a pause.

Other differences from the attended tier:

- The capability map and usage notes leave out `artifact`, `clio_docs`, `clio_library`, `credential_present`, `decide`, `evidence` and `tasks` unless a schema is attached directly. Each stays reachable through `gateway(op="find")`.
- The `ask_user` turn-ending contract never renders, because no operator can answer an interview.
- No `Routes:` line appears in the runtime block, because the orchestrator passes route sources to attended sessions only.
- The orchestrator does not register the first-turn skills reminder, which is a user-message hook. A headless run gets its skills rule from `operating.discovered-skills` alone (`src/entry/orchestrator.ts`).
- On Clio Coder's own repository the self-development note tells the run that `clio-coder-dev` and `clio-coder-test` are not loaded. See [Self-development skills](#self-development-skills).

## Worker prompt

`compileWorker` builds the worker's stable system prompt in this order:

1. `identity.clio-coder-worker`.
2. The operating-contract section: `operating.contract`, `operating.worker`, then a fixed sentence forbidding claims of completions, validations or file changes that no tool call in the run supports.
3. `operating.steering`, unless `liveSteering === false`.
4. The tool contract, rendered inline from the final admitted tool names plus one registry-owned hint per admitted tool.
5. The safety section: a line naming the run's permit, the `onPermission` sentence, then the `safety.default` body.
6. `dispatch.read-only`, when the dispatch is read-only.
7. The persona: the recipe body or a bounded request override, with bound-skill mechanics. The manifest records it as `persona.<recipe id>`.
8. Additional fragments: project rules scoped to the run's working-context paths, then the operator profile.
9. The current task scope, when turn constraints exist.

`compileWorker` throws when the persona is dynamic or empty, when `hasCanonicalContext` disagrees with the final attached tool surface, or when bound skills are requested without canonical `context`.

`liveSteering === false` drops `operating.steering`; an undefined value reads as true. The flag is false when nothing can steer the worker. Dispatch sets it through `workerSteering`, and `workerSteering` is false in the headless orchestrator, in `clio-coder fleet`, and in `clio-coder run --agent` without `--steer-channel`. A headless main run without a steer channel sets `liveSteering: false` for its own prompt as well.

A worker never receives `operating.coordinator`, `operating.fleet`, `operating.discovered-skills`, `operating.user-control`, `operating.contract-attended`, `operating.contract-headless`, any attended-only identity fragment, or the docs and settings routing. Its reply goes to the orchestrator, so conversational and operator-facing guidance has no reader. The constitutional contract and the safety body stay shared. Project context, memory, the briefing, pipeline input and the task are separate dynamic messages; see [Prompt Envelope and Tools](prompt-envelope-and-tools.md).

## Rules that cross tiers

- The install rule lives in `operating/contract.md` and applies to every tier. A check that cannot run because declared dependencies were never installed is setup, so the run installs through the normal approval path and reruns the check. A failure confined to files the change does not touch predates the change, including a missing module imported only there; the run reports it instead of repairing it or installing for it.
- The unattended finishing rule lives only in `operating.contract-headless` and in the coder persona, `src/domains/agents/builtins/coder.md`. Other worker personas and attended sessions do not carry it.
- Neighboring-test guidance for reproduction tests appears in the same two places.
- The completion-claim sentence is added to every worker prompt by the compiler. It is not a fragment.

## Self-development skills

When the session's working directory is inside Clio Coder's own source tree, the prompts extension adds the dynamic fragment `context.clio-repo-awareness` and, when skills are usable and the turn mode is not `proposal`, `context.self-development-skills`.

- Attended sessions are told to load `clio-coder-dev` once they have read the code and are about to make the first edit, and `clio-coder-test` once the change exists and they are choosing validation. Each loads at its step, never both up front, because a loaded skill is resent on every later request.
- Headless runs are told that conventions, test conventions included, come from the code and neighboring tests, and that the two skills are not loaded. They stay discoverable in the catalog.

## Substitutions

The compiler fills these tokens by plain string replacement, one occurrence per token. Fragments carry the raw token text and the compiler owns the values.

| Token | Fragment | Replaced with |
| --- | --- | --- |
| `{CLIO_DOCS_PATH}` | `identity.self-awareness` | `<package root>/docs` |
| `{CLIO_SRC_PATH}` | `identity.self-awareness` | `<package root>/src` |
| `{CLIO_CODEWIKI_PATH}` | `identity.self-awareness` | `<package root>/dist/assets/codemap.json` |
| `{CLIO_SETTINGS_PATH}` | `identity.self-awareness` | `settings.yaml` inside the live config directory, so an isolated `CLIO_CODER_HOME` or config override moves it |
| `{CLIO_STATE_PATH}` | `identity.self-awareness` | The live state directory |
| `{LIBRARY_ROUTING}` | `identity.docs-routing` | The `clio_library` routing sentence when that capability is registered and admitted, otherwise the empty string |
| `{SETTINGS_CHANGE_POLICY}` | `identity.settings-routing` | The `configure_clio` preview and apply instruction where that capability is registered and autonomy is `default` or `yolo`, otherwise a sentence handing the change to `/settings` or `clio-coder configure` |
| `{SKILL_ACTIVATION_POLICY}` | `operating.discovered-skills` | Instructions to load a matching ready skill through the gateway, or to suggest `/skill <name>` when the model may not activate skills |

`wiki.page` and `wiki.plan` use a different placeholder family, double-brace tokens such as `{{pagePath}}`. They are filled by the wiki generator, not the compiler.

## Wiki generation fragments

`wiki.page` and `wiki.plan` load through the same fragment loader and carry the same id, version and content-hash contract. `src/domains/context/wiki/prompts.ts` reads them by id on every call, replaces each `{{token}}` with a per-dispatch value (a page's path, relative path and title; the plan file's path), and sends the result as a wiki-generation dispatch's `task`. They never become a compiled system prompt. The loader hands back the raw body, so the one caller that needs live values fills them in. Both bodies begin and end with a standalone `---` line that is ordinary body text.

## Dynamic sections

The compiled prompt has fixed sections in this order: identity, operating-contract, delegation, skills, safety, tool-contract, retrieval-hints, harness-awareness, project-context, memory, runtime. Additional fragments follow, then the current task scope. Each section belongs to a cache layer in `PROMPT_SECTION_LAYER`:

- Pinned: fixed by the install, the autonomy level and the admitted tool surface. Every session on the install shares these bytes. Covers identity through harness-awareness.
- Session: captured once per session and stable across its turns. Covers project context, runtime and the dynamic fragments below that are marked session.
- Turn: may change between turns. Covers memory, path-scoped project rules and the task scope. An id missing from the table counts as turn.

| Section or fragment id | Content | Layer | Source and caching |
| --- | --- | --- | --- |
| `project-context` | The project handbook text under a `# Project` heading. | session | Captured in the session source snapshot and sized by `selectProjectPreload`. |
| `memory` | The task-scored memory section. | turn | Computed each turn and part of the cache identity. |
| `runtime` | Provider, model, the `Routes:` line, the context window, thinking guidance. | session | Recomputed on every compile. |
| `context.workspace-root` | Absolute workspace root, local OS account, hostname, and session-start facts. | session | Snapshot. |
| `context.fleet` | Observed SSH node readiness and capacity. | turn | Rendered only when `fleet.nodes` is non-empty and `dispatch` is attached. It is absent from the layer table, so it counts as turn, and its hash is part of `inputEpoch()`. |
| `context.clio-repo-awareness` | The note that the workspace is Clio Coder's own source tree. | session | Snapshot. |
| `context.self-development-skills` | The skill-loading note above. | session | Built per compile from session inputs. |
| `context.catalogs` | Installed skills, agents and playbooks by name and a short purpose, plus user-scope MCP server ids. Each list is capped at 60 entries. | session | Snapshot. Grants nothing. |
| `context.project-rules` | Unconditional `.clio-coder/rules` plus path-scoped rules matching the working context. | turn | Rules load into the snapshot. Selection re-runs against the working-context paths. |
| `context.operator-profile` | The capped operator profile. | session | Snapshot. |
| `turn-scope` | Turn mode, delegation, skills and allowed-tool constraints from the host. | turn | Built from the turn constraints. |

### Route provenance

The runtime block carries one line, `Routes: chat <source>, memory <source>, compaction <source>, fleet <source>.`, built by `formatRouteSources` in `src/core/route-provenance.ts`. A source is `session`, `project`, `user` or `built-in`, and `=chat` marks a route that is unset and follows the chat route. A session source means an override that lives in process memory, including a CLI flag. The orchestrator recomputes the sources from live settings state on every compile, so a compaction summary that drops a session route cannot decide what Clio says about it. Only attended sessions pass route sources, and they are part of the session inputs that the cache identity hashes, so a changed source recompiles the prompt.

### Project context

The prompts extension captures the project handbook once per session through the context domain. `selectProjectPreload` renders it in full when it fits 24,000 UTF-16 code units and 220 lines. Otherwise it renders the largest safe prefix of each handbook, nearest handbook first, under a `<project-preload>` notice that lists the included and omitted physical line ranges and how to read the rest. The result is classified as `full`, `partial` or `none` and recorded on the compiled prompt as `projectPreload`. `--no-context-files` (`-nc`) suppresses project context entirely. Handbook selection and discovery are in [Project Context](project-context.md).

### Operator notes

Operator notes are not part of the compiled system prompt. They live in the compaction summary, as an `<operator-notes>` block. It carries the operator sentences that begin with `remember`, `keep in mind` or `don't forget` (the latest 30, each cut at 400 characters) and, verbatim, the text of any `/compact` instruction. A `/compact` instruction also reaches the summarizer through an `<operator-instructions>` block. Compaction mechanics are in [Context Continuity](../guide/context-continuity.md).

## Hashing and caching

- Every compile returns `systemPrompt`, its SHA-256 `systemPromptHash`, a token estimate, a per-section token breakdown, and a `fragmentManifest` of `{id, relPath, contentHash, dynamic}` for each fragment that rendered. Inline dynamic fragments use `relPath` values under `inline/` and `dynamic: true`.
- `stablePrefix` is the byte count and SHA-256 of the trimmed identity section and operating-contract section plus their separators. Workers expose the same measurement over their own identity and contract.
- The chat reuses the compiled prompt byte-for-byte while `mainPromptCacheIdentity` is unchanged. That identity is version 2 and hashes the target, runtime and wire model ids, autonomy, session id, working directory, sorted working-context paths, the context-window source, `inputEpoch()`, the full session inputs (which include route sources, turn constraints, ready-skill count, memory section, `headless` and `liveSteering`), and the exact attached tool-schema bytes.
- `inputEpoch()` joins the fragment epoch, the agent-catalog revision, the session-source epoch and the hash of the fleet inventory.
- The session source snapshot freezes project context, rules, the operator profile, the workspace facts, repo awareness and catalogs. A context operation in the workspace or an ancestor, and a config hot-reload, invalidate it. A new session captures its own. The first prompt of a fresh session compiles before the session exists, under an empty id; that capture is parked and adopted by the session created after it, so turns one and two stay byte-identical.
- A recompile that changes the text appends a `promptRecompiled` ledger entry (previous hash, new hash, token estimate) and a `prompt-manifest.jsonl` record with the section and fragment breakdown.
- `/view system-prompt` and its ACP read show the last compiled main prompt.
- Workers have no snapshot. `compileWorkerPrompt` loads rules and the operator profile for the run's working-context paths on each compile and returns `rulesApplied` and `operatorProfileApplied` for receipt provenance.
