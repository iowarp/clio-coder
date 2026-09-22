# Prompt Envelope and Tools

Clio Coder keeps the model-facing envelope stable and moves enforcement into the runtime registry and safety policy.

Source of truth: `src/core/tool-names.ts`, `src/tools/agent-tools.ts`, `src/tools/bootstrap.ts`, `src/tools/policy.ts`, `src/tools/observation.ts`, `src/tools/ignore-policy.ts`, and the per-tool modules under `src/tools/**`.

## Typed composition and cache identity

The chat loop compiles a provider-facing system prompt from typed inputs. The
version-2 compile identity hashes the target id, runtime id, wire model id,
autonomy, session id, working directory, sorted working-context paths, context
window source, prompt-input epoch, resolved session inputs, and the exact
attached tool-schema bytes. `mainPromptCacheIdentity` in
`src/interactive/prompt-cache-identity.ts` owns that list.

The compiled prompt is reused byte-for-byte when the complete identity is unchanged. Host-supplied turn constraints and ready-skill counts are part of the resolved session inputs, so changing them recompiles the appropriate conditional sections. Handbook source bytes and prompt inputs are captured per session, so ordinary recompilation does not silently reload edited files. Init, refresh, and reset invalidate the session snapshot and prompt cache, including partial-write failure paths; config hot-reload also invalidates inputs. Path-scoped rules can recompile when a matching file enters working context. When recompilation changes the text, the ledger records `promptRecompiled` with previous hash, new hash, and token estimate. The bounded handbook preload retains exact safe prefixes; captured-source hashes belong to its accounting/manifest metadata. Model-facing omission notices identify source paths and line ranges, and later filesystem retrieval reads current bytes.

## Section order: stable prefix first

The immutable prefix contains identity and the constitutional operating contract. Its `stablePrefix` metadata records the exact UTF-8 byte count and SHA-256, including the following section separator. Machine paths and tool-dependent documentation routing live in a separate harness-awareness section after project context, so changing gateway access or installation paths cannot disturb the constitution. Worker prompts expose the same measurement for their own identity and shared/assigned-task contracts.

The remaining layers contain conditional role guidance, safety, the factual tool inventory and admitted hints, fleet information, retrieval hints, captured project context, harness-awareness, memory, runtime, and customization fragments. Current task scope renders last. Memory and effective-context-window changes preserve the preceding bytes. A changed tool surface or conditional role layer invalidates from its first changed byte; a stable-prefix hash is a reuse candidate, not a claim that the backend actually reused KV state.

`TurnConstraints` comes from `src/core/turn-constraints.ts`; the compiler shares `turnAllowsTool` with admission. `mode` is an explicit host workflow switch (`answer`, `proposal`, or `change`), never inferred from English and never an authorization grant. Answers omit delegation/fleet workflows and validation pressure. Proposals omit implementation validation and task-board hints and state that implementation remains blocked. Tool allowlists suppress forbidden capability guidance, including secondary gateway calls; the Direct tools line still describes the actual attached schemas. No-delegation and disabled skills remove their associated instructions. Unknown inputs retain the ordinary policy. This is a typed compiler, with a few fragment substitutions, not a general template language.

The composition root snapshots the ready-skill count by workspace, prompt-source epoch, trust/discovery settings, and explicit skill paths, sharing it with the reminder rather than rescanning files on each compile check. Ready-skill count zero omits activation instructions. The once-per-session skills reminder requires a ready model-visible skill; marketplace entries alone do not arm it. Answer/proposal modes, disabled skills, and tool restrictions suppress both the reminder and its suggestion-wait continuation. When enabled, discovery is conditional on a useful workflow rather than a mandatory first step. Explicit skill requests continue through the existing activation/admission channel.

Native Pi 0.87.1 transcript semantics remain unchanged. Warming and actual requests must compare their effective prompt and ordered schema identities after public transforms and payload hooks. A boot warm cannot predict a future task's narrower surface: such a change is an expected prefix disturbance, not proof of cache failure.

`Context window: N` is the window Clio budgets this turn against. It is a
resolved figure, not proof of backend capacity: `contextWindowSource`
(`src/domains/providers/runtime-resolution.ts`) records which layer answered, and
the answer may be `loaded`, `probe`, `target-override`, `catalog`, `model-hint`,
`descriptor-default`, or `unknown`. Only the first two rest on anything observed.

The resolver combines requested, configured, observed, and saved limits rather
than treating them as interchangeable. See [context window
resolution](context-engine.md#context-window-resolution) for the precedence and
capacity safeguards.

Each prompt-manifest record carries that window and the layer that answered it
(`contextWindow`, `contextWindowSource`) alongside a `version` for the prompt
layout itself, so a recompile whose only cause was the window moving is explained
by the record rather than inferred.

`PROMPT_MANIFEST_VERSION` (`src/domains/session/prompt-manifest.ts`) is `3` for the typed layer layout and separate harness-awareness section. Version 2 recorded the earlier stable-prefix ordering. The field is additive: a record written by 0.3.8 carries no `version` and reads back as version 1, so a `prompt-manifest.jsonl` from an older session still parses. The rule for the field is that it tracks the layout rather than the inputs. Bump it when the compiled text moves for a reason other than a changed fragment, a changed tool surface, or a changed setting, so that a resumed session has the version in hand to explain the single `promptRecompiled` entry its first compile writes.

### What not to add to the prefix

Keep task-specific and volatile facts out of the immutable identity and
constitutional prefix. Put current state in the appropriate changing layer,
user message, or tool result. The runtime layer precedes customization and the
final task-scope layer.

Stable effective prompt and tool-schema bytes make prefix reuse possible on
backends that support it. They do not guarantee a cache hit: serving policy,
residency, and the backend's cache implementation also matter. Use reported
cache evidence to assess reuse, rather than assuming a fixed latency saving.

Bound tool results with the existing envelope caps. Treat any proposed limit on
model narration as a behavior change to evaluate, not an established quality or
cost improvement.

The disk fragments under `src/domains/prompts/fragments/` are layered by who
reads them. The governing rule is that a fragment which teaches a tool is absent
when the tool is, the same rule the Fleet block follows.

| Fragment | Renders when | Contents |
| --- | --- | --- |
| `identity.clio` | The default main-session identity; the compiler uses the identity selected by its inputs. | Clio’s identity. Workers instead use `identity.clio-coder-worker`. |
| `operating.contract` | The default main-session operating contract and the shared contract in worker prompts. | Constitutional operating rules, preceding conditional capability guidance. |
| `identity.self-awareness` | The selected identity is `identity.clio` and the fragment is present in the table (`compiler.ts:673`). | Installed paths, code outranks docs, configuration locations. Names no tool. |
| `operating.delegation` | `sessionCanDispatch` holds, meaning provider tool support is not explicitly false, `dispatch` is on the surface, and `turnAllowsTool` admits it; and the turn mode is not `answer` (`compiler.ts:244`, `compiler.ts:701`). `proposal` mode still renders it. | The delegation threshold as a count taken before the first edit, the dispatch call shape, receipts, spot-checks, and shared `[worker result]` notes. |
| `operating.skills` | `sessionCanUseSkills` holds: provider tool support is not explicitly false, `context` is on the surface and admitted by `turnAllowsTool`, `skillDiscoveryEnabled` is not false, turn constraints do not disable skills, the mode is not `answer`, and `readySkillCount` is not zero (`compiler.ts:259`). | Skill-shaped tasks and `/skill <name>` suggestions, plus direct `context(scope="skills")` listing and autonomy-aware activation guidance. |
| `identity.docs-routing` | `identity.self-awareness` rendered, provider tool support is not explicitly false, `gateway` is on the surface, and `turnAllowsTool` admits `clio_docs` (`compiler.ts:676`). | Routes questions about Clio herself through `gateway(op="call", capability="clio_docs", args={query: ...})` before answering or searching the workspace. |
| `operating.worker` | The reader is a dispatched worker, which never sees the coordinator fragments. | The assigned-task contract. |
| `safety.<level>` | Always, selected by the effective autonomy level. | What runs, what is approval-required, and what is blocked, in the safety net's action-class vocabulary (read, write, command, `system_modify`, `git_destructive`) and never by tool name. |

`identity.docs-routing` does not depend on `context`, and tool hints cannot
establish tool availability. The Tool Contract independently describes agent,
prompt, fleet, and package discovery through `clio_library` when `gateway` and
that capability are admitted and the scope permits workflow discovery, so
disabling skill discovery alone does not hide the rest of the library. Catalog
reads activate and install nothing.

The `safety.<level>` body is the same on every surface: the session and every
worker read that one body, and the only role-specific text is what
"approval-required" resolves to, meaning one operator confirmation for the
session and the worker's `onPermission` routing for a worker.

Prompt extensions can add dynamic fragments for project rules, the operator profile, and Clio source-tree awareness. Pending skill requests and middleware reminders are visible text in the user message, not hidden prompt machinery.

## Prompt template expansion

Ordinary prompt templates expand into the operator's user message before submission. They do not alter the compiled system prompt or bypass the trust check on project-scope compatibility roots. As an explicit exception, display-only templates (`display-only: true`) render directly to the transcript as local operator cards without consuming tokens or being sent to the model. The prompt-root locations, frontmatter fields, and trust rules are documented in [extensions-and-sharing.md](../guide/extensions-and-sharing.md#prompt-templates).

The first whitespace character after `/template-name` is the command delimiter; CRLF counts as one delimiter. Leading whitespace before the slash is also command framing. Every byte after that delimiter is the argument payload, including leading or trailing whitespace, repeated spaces, tabs, quotes, and line breaks.

The template body may use `$ARGUMENTS` to insert that raw payload byte-for-byte. Raw insertion is not recursively substituted, so placeholder-like text such as `$1` remains data. `$1` through `$9`, `$@`, `${@:N}`, and `${@:N:L}` retain shell-style parsing: single or double quotes group spaces within one argument, `$@` joins all parsed arguments with single spaces, `${@:N}` selects parsed arguments from one-based position `N`, and `${@:N:L}` selects `L` arguments beginning there. A positional placeholder with no matching argument expands to an empty string. Template names that collide with built-in slash commands fail closed with a diagnostic and are excluded from `/prompts`.

## Directory-scoped handbook overrides

In addition to project root `CLIO-CODER.md` handbooks, Clio supports directory-scoped `CLIO-CODER.override.md` files:
- An override handbook replaces inherited project instructions for its containing directory and all descendants.
- Sibling directories outside the subtree continue to inherit from the root handbook or their own local overrides.
- Deeper subtrees within the directory may add further localized guidance.
- Prompt blocks preserve explicit source paths for attribution and debugging.
- Empty or unreadable selected overrides fail closed. Ordinary authored Markdown is accepted without a structured project identity, and context resets never delete override files.

`wiki.page` and `wiki.plan` (`src/domains/prompts/fragments/wiki/*.md`) load through this same loader, with the same id/version/content-hash contract as every other fragment, but they are consumed differently: `context/wiki/prompts.ts` reads them by id, substitutes per-dispatch `{{token}}` placeholders (a page's path, title, and relative path; the plan file's path), and sends the result as a wiki-generation dispatch's `task`, never as a compiled system prompt. `{{token}}` substitution has no home in the fragment loader itself, the same division `identity.self-awareness`'s `{TOKEN}` placeholders use in `compiler.ts`: the loader hands back a raw body, and the one caller that needs live values fills them in. Both files' bodies open and close on a standalone `---` line that predates their frontmatter and was kept unchanged as body text so the substituted prompt stays byte-identical to what the old hand-rolled `readFileSync` produced.

The Tool Contract section of the prompt renders a fixed set of base lines plus
one optional guidance sentence per tool, sourced from the tool registry
(`ToolMetadata.promptHint` in `src/tools/registry.ts`, assigned in
`src/tools/bootstrap.ts`).

The base lines cover the complete-surface rule, the harness model (direct tools,
fleet workers, skills as distinct capability sets), the capability-inventory
rule, tool-free answering, the narrow-orientation tool list, validation for
authorized file changes within scope, and schema correction after argument
errors. Policy denials do not invite another route.

Six tools carry hints today: `ask_user`, `bash`, `code_nav`, `context`, `panes`,
and `tasks`. A hint carries only a decision-local call shape the tool's own
description cannot; policy that applies across tools is said once in its prompt
section, so `dispatch` carries no hint.

<details>
<summary>Why delegation and fleet routing are not restated here</summary>

Delegation, the tasks board, and skill listing are not restated in the Tool
Contract. `operating.delegation`, the `tasks` hint, and `operating.skills` each
say their rule once and render exactly when their tool is on the surface.

Fleet routing, including the sentence that `agent:"auto"` is a fallback rather
than a router, lives in the Fleet block next to the roster ids.

The threshold that says when to delegate at all is the opening of
`operating.delegation` rather than a Fleet line. On the round-2 drive with
Qwen3.8-27B, the bare threshold placed after the tool contract lost to inertia on
every run, while the same count stated up front with the call shape next to it
dispatched both workers on every two-changes run and scout on every
reconnaissance run once the sentence about repository size was in place.

</details>

<details>
<summary>How the hint list is frozen, and what changing it requires</summary>

The chat loop derives the hint list once from the session's frozen tool surface
at compile time, and the compiler renders the hints sorted by tool name, so the
compiled text depends only on which hinted tools are on the surface.

The frozen name list is the surface. A hint renders only for a tool in that list,
and the gates that decide whether the Delegation, Skills, and docs-routing
passages render read the same list, so a stale hint can neither render itself nor
pull in a passage for a tool the model cannot call.

Removing a tool from the surface removes its hint with no compiler change. Adding
a hint to a tool is a deliberate prompt-text change that must land with updated
prompt contract tests and a CHANGELOG note.

</details>

## One tool surface per session

For tool-capable providers, Clio attaches only the admitted direct registry projection as the session tool surface. Gateway capabilities remain registered but carry schemas only in discovery results. The list is deterministic and sorted through the worker-tool resolver (`resolveAgentTools` in `src/tools/agent-tools.ts`), so the serialized schemas stay byte-identical on every submit. The schema handed to the agent loop is `wireParameterSchema(spec.parameters)`: a copy with every `~`-prefixed key removed, because TypeBox 1.x stamps string-keyed markers such as `~unsafe` and `~optional` on the schemas it builds and, unlike the older symbol keys, those survive JSON serialization and reach the model as properties. Validation is unaffected (`Value.Check` answers identically with and without them) and the registry keeps the original object. `src/tools/agent-tools.ts` is the single agent-tool adapter across the codebase. Both the orchestrator session and worker subprocesses resolve their tool set through the same `effectiveToolNames` narrowing function, ensuring that the attested signature and runtime surface cannot diverge.

Tools are keyed strictly by the canonical `ToolName` union defined in `src/core/tool-names.ts` with no alias table. Pure and idempotent `prepareArguments` normalizers defined on `ToolSpec` serve as the sole leniency layer for coercing legacy or weak-model parameter formats.

Tool visibility is not a per-turn hinting system. Pending-skill policy, ask-user policy, Bash policy, path policy, protected artifacts, dispatch admission, middleware, and the autonomy mapping are enforced when a tool is invoked. The `autonomy` level is applied at registry admission after the safety net passes a call; the safety prompt fragment mirrors that enforced matrix as guidance to the model. Prompt text and provider schemas do not bypass the registry.

Providers that cannot call tools receive no schemas, and the prompt tells the model to proceed without tool calls.

## Canonical worker harness

Native and mediated dispatch workers use a separate prompts-domain compiler over the shared fragment table. The stable system prompt contains identity-lite, the constitutional operating and assigned-task contracts, the final toolkit contract, effective safety and permission routing, one final persona, and any scoped project rules and operator profile. A request persona replaces the recipe body; eligible bound-skill instructions remain inside the final persona without widening tools. Authored handbook context travels separately in a bounded dynamic message, not in this stable system prompt.

The operator-editable system layer uses `additionalFragments`. The operator profile renders unconditionally within its cap, while project rules are selected from `writeRoots` and path-like tokens in the task and briefing through real glob matches. The separate handbook message follows the effective project-context tier: native defaults depend on capability class and recipe, with Coder and verification workers bounded and Scout none; ACP defaults to none and requires `projectContext: "bounded"` in its configuration. A bounded run uses captured `ProjectPromptContext` authored Markdown through the shared exact-prefix selector, within 1,500 UTF-16 units including source wrappers and omission notices, and the inherited 220-rendered-line limit. The raw authored branch does not inject a second structured projection of conventions, invariants, or verification. Legacy structured-only callers still receive project name, conventions, and invariants; their derived verification supplement is limited to verification-class workers.

The worker compiler runs after target capability and tool-profile admission. Canonical names match `WorkerSpec.allowedTools` and attached schemas: routine non-Scout work removes `code_nav`, narrow profiles remove excluded schemas and guidance, and tool-incapable native targets receive a no-tools contract. Claude SDK aliases are filtered from the same set. For omitted handbook text, native workers without admitted read capability are told retrieval is unavailable; unknown native capability makes the read instruction conditional. ACP and subprocess runtimes have unknown external tool inventories, so their notices refer conditionally to their own file-reading tools without promising a native Clio read schema. ACP bounded-role admission continues to validate its raw persona rather than claiming a complete native toolkit. Retrieval reads current filesystem content, which may differ from the captured source identified by accounting/manifest hashes.

Project context, memory, bounded dispatch briefing, pipeline input, the assigned task, and the per-run safety-posture reminder remain dynamic user messages. A briefing is a separately delimited message labeled as untrusted task context/data; it is never concatenated into the task or stable system prompt. Dynamic ordering is project, safety, memory, briefing, then pipeline input, with pipeline input last. These messages do not affect the stable composition hash. Persona, effective autonomy, target tool capability, or final toolkit changes do affect it.

## Eight planes, thirty builtin tools

The canonical builtin catalog contains 30 tools organized in eight planes. A
particular session or worker receives the subset whose dependencies and policy
allow it to register. The policy table records each tool's plane, action class, size posture, and concurrency rule; tools within a plane can differ.
`src/tools/policy.ts` asserts these invariants at bootstrap, so drift between
the plane design, the safety classifier, and the registered specs fails loudly
instead of shipping a surface that behaves differently from what the policy
engine assumes.

| Plane | Tools | Action class | Concurrency |
| --- | --- | --- | --- |
| OBSERVE | `read`, `grep`, `find`, `ls`, `code_nav`, `context`, `credential_present`, `clio_docs`, `clio_library`, `data` | read | parallel |
| OBSERVE | `evidence` | read | sequential |
| MUTATE | `write`, `edit` | write | sequential |
| EXECUTE | `bash`, `verify`, `run_script` | execute | sequential |
| EXECUTE | `git` | read | parallel |
| ORCHESTRATE | `dispatch`, `steer` | dispatch | sequential |
| ORCHESTRATE | `monitor` | read | parallel |
| ORCHESTRATE | `tasks` | read | sequential |
| ORCHESTRATE | `ledger` | read | sequential |
| ORCHESTRATE | `panes` | read | sequential |
| ORCHESTRATE | `limitation` | read | parallel |
| ORCHESTRATE | `decide` | read | sequential |
| RETRIEVE | `web_read`, `web_fetch` | read | parallel |
| INTERACT | `ask_user` | read | sequential |
| ARTIFACT | `artifact` | write | sequential |
| GATEWAY | `gateway` | read (inner call retains its class) | sequential |

Several tools sit in a plane for containment rather than class:

| Tool | Placement | Why |
| --- | --- | --- |
| `git` | EXECUTE plane, read class | Read-only inspection (`op=status/diff/log`) that runs on the safe-exec spine. |
| `monitor` | ORCHESTRATE plane, read class, parallel | It never mutates a run. |
| `tasks` | Read class, sequential | It orchestrates the agent's own work rather than workers. Sequential so two board mutations in one batch cannot interleave. |
| `ledger` | Read class | A post reaches a one-way control lane and a read answers from a local mirror, so it touches no workspace. Reviewers and judges are pinned to read-only autonomy, where a write class would block the peer review the board exists for. |
| `panes` | Read class, sequential | It controls only Clio-owned terminal panes through the live mux. Sequential so two operations cannot race the same pane registry. |
| `evidence` | OBSERVE plane, sequential | It only reads canonical evidence, trust status, gate decisions, and findings, but `run` mode may materialize a bundle under Clio's data directory. |
| `limitation` | ORCHESTRATE plane, read class, parallel | It appends one typed receipt to the session ledger and touches nothing else. The call is pure. |
| `decide` | ORCHESTRATE plane, read class, sequential | It appends one decision-board entry and touches nothing else. Sequential so two decisions in one batch cannot race the supersede lookup. |

For `tasks`, board mutations append session task-ledger snapshots, and calls can
reconcile the project-local `.clio-coder/user-tasks.json` inbox while `pick` and
linked `done` update its durable correlation. These Clio-owned bookkeeping
effects retain read class without granting source-workspace mutation authority.

Registration is conditional on wiring: `context` gains its workspace scope only
when a session contract is bound, `dispatch`/`monitor`/`steer` register only
with a dispatch contract, `ask_user` registers only when an interactive handler
exists, `ledger` registers only when a worker bound its dispatch's agent-ledger
port (the session never does, and without a port the tool could only answer
"no ledger"), and `panes` registers only when a pane host answered detection and
the mux is live. Dispatch tool profiles narrow the surface for workers:
`minimal-local` is `read`, `grep`, `find`, `ls`, `git`, `context`, `code_nav`,
and `ledger`; `science-local` adds `verify`; `full-agent` keeps everything that
the runtime registered and the recipe allows.

`ask_user` keeps its typed `exposure: local | outward` admission fact separate from caller prose. The registry uses exposure only in the enforced autonomy mapping. After admission, the host carries the normalized fact into the shared decision-presentation classifier; question text, headers, options, summaries, and requested color or severity words cannot select a consequence tier. The resulting presentation object contains no admission disposition and cannot grant authority.

### Consolidated call shapes

Several tools absorb what used to be separate tools:

- `find(pattern, path?, order?, limit?, include_ignored?)` locates paths by glob pattern (`*`, `**`, `?`, `[abc]`), default limit 500. `order="path"` (default) returns fd's native order; `order="mtime"` returns newest first from a bounded candidate set instead of statting the whole tree, and reports `details.candidates` when the candidate cap made the ordering approximate.
- `grep(pattern, path?, mode?, glob?, ignore_case?, literal?, context?, limit?, include_ignored?)` searches file contents with ripgrep, degrading to a bounded pure-Node search when rg is absent. `mode=content` (default) returns line-referenced matches, `mode=files` returns matching paths, `mode=count` returns per-file counts. Context lines are consumed from rg's `--json` stream.
- `context(scope="workspace"|"settings"|"skills"|"recall")` observes the session workspace snapshot, explains effective settings through an allowlisted read-only projection, activates installed skills, or retrieves persisted historical results. Settings reads use the session settings getter, support query/limit/offset pages, omit credentials and arbitrary command configuration, and return an unavailable error when no authoritative getter is bound. Recall accepts `ref` for exact retrieval or `query`, `limit`, and `offset` for discovery. Bundled docs and recipe browsing use gateway capabilities `clio_docs` and `clio_library`.
- `verify(check?, path?, args?, browser?, cwd?, timeout_ms?)` runs declared verification. `verify()` lists package.json verification scripts and strict version-1 or version-2 `.clio-coder/verifiers.yaml` entries through the same `{id, description, command, cwd, timeoutMs, tags, source}` projection. Version 1 supports command checks; version 2 also supports `numeric-compare` and `perf-budget` judgements. New catalogs use version 2; see the [project verifier contract](../guide/tool-usage.md#project-verifier-catalog). `verify(check="<id>")` runs a package script or the catalog's exact argv/cwd/timeout through safe-exec with no shell. Model `args`, cwd, timeout, output-cap, and environment fields cannot mutate a project entry. `verify(check="frontend", path=...)` validates an HTML/CSS/JS artifact without granting shell access.
- `gateway(op="call", capability="artifact", args={kind: "plan"|"review"|"report", content: ...})` writes named artifacts: Markdown documents (default `.clio-coder/artifacts/PLAN.md`/`REVIEW.md`/`REPORT.md`; `path` may override inside the workspace) that terminate the turn, because writing the artifact is the answer. Skills are not artifacts; a `SKILL.md` is authored outside protected active skill roots with the ordinary write tool and validated by the library validator before operator installation.
- `dispatch(task?, tasks?, mode?, ...)` supports a first-class singular assignment (`task`) and a batch (`tasks`), never both. `task` is worker instructions; `briefing` is optional bounded parent context/data and cannot replace it. Briefing stays a separate dynamic message and receipt provenance, never part of the receipt task. A shared top-level briefing applies to strings and objects without an override; an object-level briefing wins. Blank values are omitted, the cap is 12,000 UTF-8 bytes, and approval pins the exact canonical value. Ordinary handles enter one registered event consumer immediately. Synchronous calls auto-wait for stream-and-receipt completion; `detach:true` returns ids after durable batch registration while the same consumer continues. Review and compete retain gate-sensitive direct drains. Task objects may include `persona`, `tool_profile`, and a typed `budget: {toolCalls, readReserve, retryRevision?}`. The budget must fit the recipe's authored range and the operator lifetime cap. `retryRevision` is the only authority for a later retry, result-contract revision, or review revision to grow its phase. Pipeline output is threaded as bounded data. A successful native or ACP run requires a nonempty receipt-sealed final output; exit zero without one fails as `worker_final_output_missing`, with unfinished text retained only as partial diagnostics. `dispatch(list=true)` renders the catalog.
- `monitor(run_id?, mode?)` is read-only visibility into known synchronous and detached runs: `list` enumerates, `status` reports one, `peek` returns the in-process event tail, `receipt` exposes the stored evidence, and `wait` observes one run without collecting or canceling it. `collect` is the authoritative terminal batch operation over a detached batch or run-id list; collect before final synthesis. Completed output retains receipt integrity, evidence verification, briefing provenance, and bounded project-context provenance as distinct detail fields. Successful typed internal-helper results use compact text and `details.runs[].helperResult`; full receipts remain available on demand. The coordinator uses grounded helper results for navigation without routinely repeating their investigation.
- `steer(run_id, action, message?)` controls a running worker: `guide` writes a canonical trimmed steering message to an HTTP or SDK worker and `cancel` terminates it. Successfully written steers gain ordered byte/hash/timestamp provenance; after the runtime accepts the guidance, `clio_coder_steer_received` acknowledges the exact matching sequence, and prose is never stored in ledger or receipt. Single-shot subprocess runtimes and ACP remain non-steerable. Interactive operators can steer synchronous live-input runs; parent-model steering requires detached ids because model tools are sequential.

### One ignore policy for path walkers

`grep`, `find`, and their pure-Node fallbacks answer "which parts of the tree are visible" from one shared policy in `src/tools/ignore-policy.ts`. Three layers apply: `.clio-coder`, `.fallow`, and `.git` are always excluded; `.gitignore` is honored natively by rg/fd; and one generated-dirs list (`node_modules`, `dist`, `build`, `coverage`, `.venv`, and similar) is force-excluded even when a project forgot to gitignore it. `include_ignored: true` lifts the gitignore and generated-dirs layers together. Fallbacks do not parse `.gitignore`; they disclose their generated-directory-only ignore behavior. The clio-internal layer always stands, except that pointing a tool directly at one of those directories means the caller wants those paths.

## The observation envelope

The content-returning OBSERVE tools (`read`, `grep`, `find`, `ls`, `code_nav`, `context`, `clio_docs`, `clio_library`, `data`) and gateway find listings close every result through one shared envelope in `src/tools/observation.ts`. `credential_present` sits in the OBSERVE plane but returns a typed boolean and carries no envelope cap, and `evidence` returns bounded JSON under its own 16KB summary policy. The envelope owns four guarantees.

**One notice line, one format.** A truncated text result appends exactly one notice:

```text
[<tool>: <shown>/<total> <unit> shown (<shownSize> of <totalSize>) | full: <offloadPath> | next: <exact-call>]
```

Unknown segments are omitted. `<total>` renders as `N+` when the search was killed early at its limit, meaning matches beyond it exist but were never counted. `next` is always an exact continuation call fragment such as `limit=200` or `offset=451`, never prose. Untruncated results get no notice. Empty results are standardized: `grep` returns `No matches found`, `find` returns `No visible files found matching pattern`, `ls` returns `(empty directory)`, and the JSON-format tools return valid JSON with empty arrays and `next` populated.

**Offload on truncation.** When a byte cap cuts collected content, the tool spills its full rendering to the per-session scratch file (`<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt`) and reports the path in the notice, so no collected match, path, or line is ever unrecoverable. Two deliberate exceptions exist: `read` never offloads because the source file is directly re-addressable via `next: offset=N`, and a bare item-limit truncation without a byte cut continues via `next` alone, since an offload would only duplicate the body.

**Always-valid JSON.** `code_nav` and the JSON scopes of `context` declare `format: "json"`. A JSON payload must parse or be replaced whole; it is never cut mid-document. An oversize payload is offloaded and the body is replaced by the parseable stub:

```json
{"error":"result exceeded <cap>","offloadPath":"...","next":"..."}
```

**One turn budget.** All envelope tools draw from a single per-turn pool keyed `sessionId:turnId`, default 192KB and configured by `safety.limits.observationBytesPerTurn`. Each call reserves the minimum of its self cap and the remaining budget before doing the work. An exhausted pool short-circuits with an `[observation budget exhausted ...]` notice naming the tool, the subject, and the used/limit sizes, instead of paying for a search whose output could not be returned. A call whose cap was reduced by the pool appends a budget note telling the model to narrow its arguments or continue in a follow-up turn.

Per-call self caps: `read` 50KB (`safety.limits.readBytesPerCall`), `grep` 16KB for `mode=content` and 8KB for `files`/`count`, `find` 8KB, `ls` 8KB, `code_nav` 16KB, `context` 50KB for skills/workspace, `clio_docs`/`clio_library` 16KB, `data` 32KiB, and gateway find 32KiB. The registry backstop cap for each envelope tool is its self cap plus 2KB slack, so a tool's own notice with its exact continuation call survives shaping instead of being cut again and replaced by a generic hint; the bootstrap policy assertion fails loudly if a cap ever drops below that.

Every envelope result carries `details.observation` (`{tool, unit, shownCount, totalCount, shownBytes, totalBytes, truncated, format, next?, offloadPath?, budget?}`) for the TUI ledger, session turns, and observers.

## Description tiering

Tool descriptions are tiered by how much a wrong call costs. The hot tools the model calls constantly (`read`, `grep`, `find`, `dispatch`) embed their operational contract in the description: caps, modes, ignore semantics, and how truncated results continue. Every other tool carries a one-to-two-sentence statement of what it does, and deep usage guidance lives in the bundled docs corpus ([tool-usage.md](../guide/tool-usage.md)) rather than the prompt prefix, retrievable on demand through `gateway(op="call", capability="clio_docs", args={query: ...})`. This keeps the serialized schema block small and byte-stable while still giving the model a path to depth when it needs one.

## Direct placement and the capability gateway

`src/tools/surface.ts` owns placement independently of policy planes. Direct tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `context`, `code_nav`, `verify`, `run_script`, and `gateway`, plus all ORCHESTRATE and INTERACT members when their dependencies are bound. Gateway capabilities are `artifact`, `web_read`, `web_fetch`, `git`, `evidence`, `credential_present`, `clio_docs`, `clio_library`, `data`, extension commands, and trusted local MCP tools. The permanent context schema retains workspace, settings, skills, and recall.

`gateway(op="find"|"describe"|"call", capability?, query?, args?)` is read class and sequential. Its inner call runs through canonical registry admission with the capability's own class, skill restrictions, approvals, and cancellation. Nested accounting counts the model call once. `effectiveToolCall` restores capability identity for artifact folding, mutation observers, path indexing, exported evidence, and transcripts. Terminal artifact results, images, and details survive routing. Gateway placement changes schema attachment, not authority or evidence.

Native worker recipes continue to name capabilities such as `git`; `effectiveToolNames` adds `gateway` to the attached and attested direct projection while preserving the admitted capability allowlist for inner calls. Find and describe use that allowlist too. MCP sources are session-owned and are not installed into worker registries in this release.

The recorded prompt fixture measured **31,272 bytes across 19 attached tools**, using `wireParameterSchema` and JSON serialization of name, description, and parameters. It excludes optional `ask_user` and `panes`. The historical full-surface figure was a different surface; a post-change full-surface total was derived by adding schemas, not measured. These figures do not establish an overall schema-size reduction. The placement decision and new contracts should be assessed independently of that incomparable total.

## Context protection

Clio uses two context-protection mechanisms.

1. Tool results are capped at the source and again at the registry boundary. OBSERVE tools use the envelope caps above. Exact mutation tools (`write`, `edit`, `artifact`) use 8KB; `steer` and `credential_present` use 4KB; `ledger` uses 16KB; `panes` uses 8KB; `limitation` and `decide` use 4KB; and `ask_user` has a 20KB policy. Summary-kind tools (`bash`, `git`, `verify`, `dispatch`, `monitor`, `evidence`) use 16KB at the registry boundary. MCP capability results are bounded to 16KB in model context, offloading larger results to disk artifacts with preview and reference. Bash also exposes the canonical per-call `output_policy`: omitted/`bounded` keeps its diagnostic tail, `summary` selects stable redacted head/error/tail evidence, `metadata-only` keeps facts and retrieval without stdout/stderr context, and `full` succeeds only inside the same hard result budget or records a typed downgrade. This model-context choice does not change the folded tail-biased operator presentation. `web_fetch` is bounded at 16KB after shaping and may read more before it: its `max_bytes` argument defaults to 600KB and is hard-capped at 5MB. Tools without an explicit result-size policy use an approximately 18KB generic backstop. Over-cap generic results are shown briefly and, when possible, saved under `<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt` with an `offloadPath` detail and a 10MB scratch-file cap.
2. Auto-compaction uses one pressure threshold. The default threshold is 0.8. When pressure crosses the threshold, Clio first applies a non-destructive working-set eviction and records the evicted items in the session ledger. If pressure remains above the threshold, it runs the LLM summary compaction path and replays from the compacted session view. The older destructive observation/thinking mask is available only as a compatibility escape hatch when `CLIO_CODER_LEGACY_MASK=1`.

Manual `/context compact`, `CLIO_CODER_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly.

Compaction changes projected model replay while retaining the raw ledger, so the next turn on a local single-slot backend is expected to lose prefix-cache alignment. Clio records `expectedColdReasons` and shows one dim notice for that turn.

## Inspecting a session

Timing and cache behavior are persisted per API call, so a finished session can be inspected from its stored artifacts alone. Each assistant entry in the session ledger (`current.jsonl`, under the directory reported by `clio-coder paths`) carries `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }`, and the run's first persisted call also carries `expectedColdReasons`. Cache verdicts are `hot`, `partial`, `cold`, or `small`.

Native session timing uses a monotonic clock from each stream invocation, before the provider's response-header wait, to its first observed output (`ttftMs`) and completion (`apiMs`). A tool-loop continuation starts a new clock; no output leaves TTFT null, and a genuine rounded zero remains zero. Historical values are not rewritten and may omit the pre-header wait. A reader that times calls from the event stream instead starts at the provider's `message_start` event, which can arrive after headers, so such spans are not complete request latency and must not be compared with these durable records.

For aggregate cost and token facts across sessions, use `clio-coder usage report --days <n>`. Inside the TUI, `/usage` shows session totals and `/context` opens the context-window ledger overlay.

## Self-documentation retrieval

`gateway(op="call", capability="clio_docs", args={query: ...})` is the model-facing companion to `clio-coder docs`, which opens the human documentation in the unified web app. The app renders the bundled Markdown corpus directly, with generated navigation and heading outlines. The clio_docs capability indexes that same corpus for agents. It is deterministic and offline: no embeddings service, network call, or filesystem write is needed.

The search index splits markdown into heading-delimited sections, records heading breadcrumbs and line ranges, and ranks results with light stemming, controlled Clio vocabulary aliases, phrase boosts, and BM25-style body scoring. The tool returns compact JSON containing corpus metadata, normalized and expanded query terms, and ranked hits with `file`, `heading`, `breadcrumb`, `anchor`, section `lines`, `snippetLines`, a bounded `snippet`, `matchedTerms`, `signals`, `coverage`, and `score`. `limit` defaults to 5 sections and caps at 12. The per-file filter the pre-consolidation docs tool accepted was dropped; narrow with more specific query terms instead. Even an empty result is valid JSON with empty arrays and a populated `next` continuation.

## Edit matching safety

Files over 1 MiB use exact matching only. Mixed or bare-CR endings, NUL bytes, and invalid UTF-8 are refused. Publication is atomic through the shared real-target publisher; file identities do not lock external writers. Diffs are skipped when either version exceeds 1 MiB.

The `edit` tool first attempts exact matching. If the model's old text differs
only by normalized quote, dash, whitespace, or indentation details, Clio maps
the normalized match back to the original line span and splices only the
intended replacement. Unchanged spans keep their original bytes, including
smart punctuation and CRLF line endings. Ambiguous duplicate matches,
overlapping hunks, empty changes, and no-op edits are rejected instead of
guessing.

## Execution-environment awareness

The main session workspace fragment includes the current OS account and machine
hostname alongside the workspace root. These values come from the same local
identity detector used for run receipts, are quoted as data, and are captured in
the session prompt snapshot. They identify the process environment, not a verified
person or the remote inference server. They are sent to the selected model as
prompt context; configure does not persist a new personal profile or machine field.
A new session on another machine captures that machine’s identity.
