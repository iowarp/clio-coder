# Prompt Envelope and Tools

Clio Coder keeps the model-facing envelope stable and moves enforcement into the runtime registry and safety policy.

Main sessions attach a small coordinator surface (read, bash, edit, write,
verify, ask_user, gateway and dispatch) and discover other tools, recipes, and
workflows progressively through the gateway. Workers keep their recipe execution surfaces. The compiler receives registered
builtin presence separately from attached schemas so it can teach reachable
gateway capabilities without claiming those tools are attached. Lazy MCP tool
registration does not change this builtin presence input or the stable prefix.

Which fragments each prompt tier carries, and how they are selected, is in [Prompt Compilation](prompt-compilation.md). This page covers the envelope around the compiled text: cache identity, section order, tool delivery and bounded results.

Source of truth: [tool-names.ts](../../src/core/tool-names.ts), [agent-tools.ts](../../src/tools/agent-tools.ts), [bootstrap.ts](../../src/tools/bootstrap.ts), [policy.ts](../../src/tools/policy.ts), [observation.ts](../../src/tools/observation.ts), [ignore-policy.ts](../../src/tools/ignore-policy.ts), and the per-tool modules under `src/tools/**`.

## Typed composition and cache identity

The chat loop compiles a provider-facing system prompt from typed inputs. The
version-2 compile identity hashes the target id, runtime id, wire model id,
autonomy, session id, working directory, sorted working-context paths, context
window source, prompt-input epoch, resolved session inputs, and the exact
attached tool-schema bytes. `mainPromptCacheIdentity` in
[prompt-cache-identity.ts](../../src/session-control/prompt-cache-identity.ts) owns that list.

The compiled prompt is reused byte-for-byte when the complete identity is unchanged. Host-supplied turn constraints and ready-skill counts are part of the resolved session inputs, so changing them recompiles the appropriate conditional sections. Handbook source bytes and prompt inputs are captured per session, so ordinary recompilation does not silently reload edited files. Init, refresh, and reset invalidate the session snapshot and prompt cache, including partial-write failure paths; config hot-reload also invalidates inputs. Path-scoped rules can recompile when a matching file enters working context. When recompilation changes the text, the ledger records `promptRecompiled` with previous hash, new hash, and token estimate. The bounded handbook preload retains exact safe prefixes; captured-source hashes belong to its accounting/manifest metadata. Model-facing omission notices identify source paths and line ranges, and later filesystem retrieval reads current bytes.

## Section order: stable prefix first

The immutable prefix contains identity and the constitutional operating contract. Its `stablePrefix` metadata records the exact UTF-8 byte count and SHA-256, including the following section separator. Machine paths and tool-dependent documentation routing live in a separate harness-awareness section that precedes captured project context, so changing gateway access or installation paths cannot disturb the constitution. Worker prompts expose the same measurement for their own identity and shared/assigned-task contracts.

The remaining layers follow `SESSION_PROMPT_SECTION_ORDER` in [compiler.ts](../../src/domains/prompts/compiler.ts): delegation, skills, safety, tool contract, retrieval hints, harness-awareness, project context, memory, and runtime. Additional fragments and the current task scope render last. Everything through harness-awareness depends only on the install, autonomy and tool surface. Memory and effective-context-window changes preserve the preceding bytes. A changed tool surface or conditional role layer invalidates from its first changed byte; a stable-prefix hash is a reuse candidate, not a claim that the backend actually reused KV state.

`TurnConstraints` comes from [turn-constraints.ts](../../src/core/turn-constraints.ts); the compiler shares `turnAllowsTool` with admission. `mode` is an explicit host workflow switch (`answer`, `proposal`, or `change`), never inferred from English and never an authorization grant. Answers omit delegation/fleet workflows and validation pressure. Proposals omit implementation validation and task-board hints and state that implementation remains blocked. Tool allowlists suppress forbidden capability guidance, including secondary gateway calls; the Direct tools line still describes the actual attached schemas. No-delegation and disabled skills remove their associated instructions. Unknown inputs retain the ordinary policy. This is a typed compiler, with a few fragment substitutions, not a general template language.

The composition root snapshots the ready-skill count by workspace, prompt-source epoch, trust/discovery settings, and explicit skill paths, sharing it with the reminder rather than rescanning files on each compile check. Ready-skill count zero omits activation instructions. The once-per-session skills reminder requires a ready model-visible skill; marketplace entries alone do not arm it. Answer/proposal modes, disabled skills, and tool restrictions suppress both the reminder and its suggestion-wait continuation. A headless run registers no reminder and gets its skills rule from the system prompt alone; see [Prompt Compilation](prompt-compilation.md#headless-main-prompt). When enabled, discovery is conditional on a useful workflow rather than a mandatory first step. Explicit skill requests continue through the existing activation/admission channel.

Warming and actual requests must compare their effective prompt and ordered schema identities after public transforms and payload hooks. A boot warm cannot predict a future task's narrower surface: such a change is an expected prefix disturbance, not proof of cache failure.

`Context window: N` is the window Clio budgets this turn against. It is a
resolved figure, not proof of backend capacity: `contextWindowSource`
([runtime-resolution.ts](../../src/domains/providers/runtime-resolution.ts)) records which layer answered, and
the answer may be `loaded`, `probe`, `target-override`, `catalog`, `model-hint`,
`descriptor-default`, or `unknown`. Only the first two rest on anything observed.

The resolver combines requested, configured, observed, and saved limits rather
than treating them as interchangeable. See [the context engine](context-engine.md) for the precedence and
capacity safeguards of context window resolution.

Each prompt-manifest record carries that window and the layer that answered it
(`contextWindow`, `contextWindowSource`) alongside a `version` for the prompt
layout itself, so a recompile whose only cause was the window moving is explained
by the record rather than inferred.

`PROMPT_MANIFEST_VERSION` ([prompt-manifest.ts](../../src/domains/session/prompt-manifest.ts)) is `3` for the typed layer layout and separate harness-awareness section. The field is additive: a record with no `version` reads back as version 1, so an older `prompt-manifest.jsonl` still parses. The field tracks the layout rather than the inputs. Bump it when the compiled text moves for a reason other than a changed fragment, a changed tool surface, or a changed setting, so that a resumed session has the version in hand to explain the single `promptRecompiled` entry its first compile writes.

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
reads them: shared, attended-only, headless-only and worker-only. [Prompt Compilation](prompt-compilation.md) lists every fragment with its tier and render condition. The governing rule is that a fragment which teaches a tool is absent
when the tool is, the same rule the Fleet block follows.

`identity.docs-routing` does not depend on `context`, and tool hints cannot
establish tool availability. The Tool Contract independently describes agent,
prompt, fleet, and package discovery through `clio_library` when `gateway` and
that capability are admitted and the scope permits workflow discovery, so
disabling skill discovery alone does not hide the rest of the library. Catalog
reads activate and install nothing.

The prompts extension adds dynamic fragments for the workspace root, project rules, the operator profile, catalogs and Clio source-tree awareness; see [dynamic sections](prompt-compilation.md#dynamic-sections). Pending skill requests and middleware reminders are visible text in the user message, not hidden prompt machinery.

## Prompt template expansion

Ordinary prompt templates expand into the operator's user message before submission. They do not alter the compiled system prompt or bypass the trust check on project-scope compatibility roots. As an explicit exception, display-only templates (`display-only: true`) render directly to the transcript as local operator cards without consuming tokens or being sent to the model. The prompt-root locations, frontmatter fields, and trust rules are documented in [extensions-and-sharing.md](../guide/extensions-and-sharing.md).

The first whitespace character after `/template-name` is the command delimiter; CRLF counts as one delimiter. Leading whitespace before the slash is also command framing. Every byte after that delimiter is the argument payload, including leading or trailing whitespace, repeated spaces, tabs, quotes, and line breaks.

Argument parsing and substitution follow pi-coding-agent 1.0 semantics ([prompt-templates.ts](../../src/engine/prompt-templates.ts)). Unquoted whitespace of any kind, including newlines, separates arguments. Single or double quotes preserve whitespace inside an argument and are removed from it. There are no escape sequences, an unterminated quote runs to the end of the payload, and an empty quoted argument is dropped. Joining parsed arguments therefore loses unquoted line breaks; use `$ARGUMENTS` to preserve the full payload.

| Placeholder | Expands to |
| --- | --- |
| `$ARGUMENTS` | The raw payload, byte-for-byte. |
| `$1`, `$2`, and other digits | The parsed argument at that one-based position, or an empty string when absent. |
| `$@` | All parsed arguments joined with single spaces. |
| `${N:-default}` | Argument `N`, or `default` when it is missing or empty. |
| `${@:-default}` | All parsed arguments joined, or `default` when that is empty. |
| `${ARGUMENTS:-default}` | The raw payload when at least one parsed argument exists, otherwise `default`. A whitespace-only payload has no parsed arguments. |
| `${@:N}` | Parsed arguments from position `N` onward, joined with single spaces. A position below 1 counts as 1. |
| `${@:N:L}` | `L` parsed arguments starting at position `N`, joined with single spaces. |

A default is the literal text up to the next `}`. Substitution is one pass over the template, so inserted text that looks like a placeholder, such as `$1` inside an argument, stays data. Braced forms are scanned only up to the last `}` in the template, because no braced placeholder can start after it; the tail takes the unbraced forms alone. That keeps scanning linear in template size, so a template of unterminated `${N:-` openers does not trigger repeated rescans. Template names that collide with a built-in slash command are ignored with a collision diagnostic.

## Directory-scoped handbook overrides

In addition to project root `CLIO-CODER.md` handbooks, Clio supports directory-scoped `CLIO-CODER.override.md` files:
- An override handbook replaces inherited project instructions for its containing directory and all descendants.
- Sibling directories outside the subtree continue to inherit from the root handbook or their own local overrides.
- Deeper subtrees within the directory may add further localized guidance.
- Prompt blocks preserve explicit source paths for attribution and debugging.
- Empty or unreadable selected overrides fail closed. Ordinary authored Markdown is accepted without a structured project identity, and context resets never delete override files.

## Tool Contract rendering

The coordinator Tool Contract names the actual attached schemas on a `Direct tools` line and teaches
task-shaped discovery. It carries four parts, each rendered only for what the surface reaches:

- A capability map that lists every reachable builtin by name with its registry objective, grouped Inspect, Change, Run, Coordinate and Operator by plane. A builtin behind the gateway is marked `(gateway)` and carries its required arguments; a direct one may carry a starter example. Argument cues and examples share a 1,400-byte budget across the map.
- A finding passage that teaches `describe`, `find`, chaining and, when `clio_library` is admitted, catalog lookup.
- The turn-ending contract, only where an operator can answer an `ask_user` interview.
- Usage notes: the registry's one-sentence discovery hints for mapped builtins.

The fleet roster is not preloaded. `dispatch(list=true)` and describe deliver per-recipe and per-capability detail at their step, and the SSH node inventory appears only as a dynamic fragment when nodes are configured. A headless prompt leaves seven operator-facing capabilities out of the map and notes; see [Prompt Compilation](prompt-compilation.md#headless-main-prompt).

Worker prompts render the Tool Contract as base lines plus one optional guidance sentence per admitted tool, sourced from the tool registry (`ToolMetadata.promptHint` in [registry.ts](../../src/tools/registry.ts), assigned in [builtin-tool-catalog.ts](../../src/tools/builtin-tool-catalog.ts) and [core-bootstrap.ts](../../src/tools/core-bootstrap.ts)). The base lines state that the attached schemas are the worker's complete tool surface, list the admitted canonical tools, and say that persona and bound-skill instructions never add tools. A hint carries only a decision-local call shape that the tool's own description cannot. Hints are deduplicated, sorted, and render only for tools on the admitted surface, so a hint can never manufacture a tool. Removing a tool from the surface removes its hint with no compiler change. Adding a hint is a deliberate prompt-text change.

## One tool surface per session

For tool-capable providers, Clio attaches only the admitted direct registry projection as the session tool surface. Gateway capabilities remain registered but carry schemas only in discovery results. The list is deterministic and sorted through the worker-tool resolver (`resolveAgentTools` in [agent-tools.ts](../../src/tools/agent-tools.ts)), so the serialized schemas stay byte-identical on every submit. The schema handed to the agent loop is `wireParameterSchema(spec.modelParameters ?? spec.parameters)`: a copy with every `~`-prefixed key removed, because TypeBox 1.x stamps string-keyed markers such as `~unsafe` and `~optional` on the schemas it builds and, unlike the older symbol keys, those survive JSON serialization and reach the model as properties. Validation is unaffected (`Value.Check` answers identically with and without them) and the registry keeps the original object. `src/tools/agent-tools.ts` is the single agent-tool adapter across the codebase. Both the orchestrator session and worker subprocesses resolve their tool set through the same `effectiveToolNames` narrowing function, ensuring that the attested signature and runtime surface cannot diverge.

Tools are keyed strictly by the canonical `ToolName` union defined in [tool-names.ts](../../src/core/tool-names.ts) with no alias table. Pure and idempotent `prepareArguments` normalizers defined on `ToolSpec` serve as the sole leniency layer for coercing legacy or weak-model parameter formats.

Tool visibility is not a per-turn hinting system. Pending-skill policy, ask-user policy, Bash policy, path policy, protected artifacts, dispatch admission, middleware, and the autonomy mapping are enforced when a tool is invoked. The `autonomy` level is applied at registry admission after the safety net passes a call; the safety prompt fragment mirrors that enforced matrix as guidance to the model. Prompt text and provider schemas do not bypass the registry.

Providers that cannot call tools receive no schemas, and the prompt tells the model to proceed without tool calls.

## Canonical worker harness

Native and mediated dispatch workers use a separate prompts-domain compiler over the shared fragment table. The stable system prompt contains identity-lite, the constitutional operating and assigned-task contracts, steering guidance unless the worker has no steer channel, the final toolkit contract, effective safety and permission routing, one final persona, and any scoped project rules and operator profile. The exact order is in [Prompt Compilation](prompt-compilation.md#worker-prompt). A request persona replaces the recipe body; eligible bound-skill instructions remain inside the final persona without widening tools. Authored handbook context travels separately in a bounded dynamic message, not in this stable system prompt.

The operator-editable system layer uses `additionalFragments`. The operator profile renders unconditionally within its cap, while project rules are selected through real glob matches against the run's working-context paths: the declared intent paths (`read_roots`, `write_roots`, `relevant_paths`), or, for a request without typed intent, the legacy `writeRoots` and path-like tokens in the task and briefing. The separate handbook message follows the effective project-context tier: native defaults depend on capability class and recipe, with Coder and verification workers bounded and Scout none; ACP defaults to none and requires `projectContext: "bounded"` in its configuration. A bounded run compiles the captured authored Markdown into rule units and receives the invariants, the units scoped to its dispatch paths and its role's unscoped units within 6,000 UTF-16 units (`selectWorkerHandbook` in `src/domains/context/handbook-units.ts`). A handbook with no H2 rule sections keeps the shared exact-prefix selector within 1,500 UTF-16 units including source wrappers and omission notices. The raw authored branch does not inject a second structured projection of conventions, invariants, or verification. Legacy structured-only callers still receive project name, conventions, and invariants; their derived verification supplement is limited to verification-class workers.

The worker compiler runs after target capability and tool-profile admission. Canonical names match `WorkerSpec.allowedTools` and attached schemas: routine non-Scout work removes `code_nav`, narrow profiles remove excluded schemas and guidance, and tool-incapable native targets receive a no-tools contract. Claude SDK aliases are filtered from the same set. For omitted handbook text, native workers without admitted read capability are told retrieval is unavailable; unknown native capability makes the read instruction conditional. ACP and subprocess runtimes have unknown external tool inventories, so their notices refer conditionally to their own file-reading tools without promising a native Clio read schema. ACP bounded-role admission continues to validate its raw persona rather than claiming a complete native toolkit. Retrieval reads current filesystem content, which may differ from the captured source identified by accounting/manifest hashes.

Project context, memory, bounded dispatch briefing, pipeline input, the assigned task, and the per-run safety-posture reminder remain dynamic user messages. A briefing is a separately delimited message labeled as untrusted task context/data; it is never concatenated into the task or stable system prompt. Dynamic ordering is project, safety, memory, briefing, then pipeline input, with pipeline input last. These messages do not affect the stable composition hash. Persona, effective autonomy, target tool capability, or final toolkit changes do affect it.

## Eight planes, thirty-five builtin tools

The canonical builtin catalog contains 35 tools organized in eight planes. A
particular session or worker receives the subset whose dependencies and policy
allow it to register. The policy table records each tool's plane, action class, size posture, and concurrency rule; tools within a plane can differ.
[policy.ts](../../src/tools/policy.ts) asserts these invariants at bootstrap, so drift between
the plane design, the safety classifier, and the registered specs fails loudly
instead of shipping a surface that behaves differently from what the policy
engine assumes.

Every builtin also names the contract tests that exercise it, in the
`TOOL_CONTRACT_TESTS` map in [check-hygiene.ts](../../scripts/check-hygiene.ts). The map is keyed by
the builtin name type, so a new tool fails typecheck until its test is named.
`pnpm run lint` then fails when a named file is missing, lives outside
`tests/contracts` (the only test directory CI runs besides three smoke files),
or never reaches the tool in code by importing its registered module or naming
it on a registry the test builds.

| Plane | Tools | Action class | Concurrency |
| --- | --- | --- | --- |
| OBSERVE | `read`, `grep`, `find`, `ls`, `code_nav`, `context`, `credential_present`, `clio_docs`, `clio_library`, `data`, `vision` | read | parallel |
| OBSERVE | `evidence` | read | sequential |
| MUTATE | `write`, `edit` | write | sequential |
| EXECUTE | `bash`, `verify`, `run_script` | execute | sequential |
| EXECUTE | `git` | read | sequential |
| ORCHESTRATE | `dispatch`, `steer` | dispatch | sequential |
| ORCHESTRATE | `monitor` | read | parallel |
| ORCHESTRATE | `tasks` | read | sequential |
| ORCHESTRATE | `ledger` | read | sequential |
| ORCHESTRATE | `panes` | read | sequential |
| ORCHESTRATE | `music` | read | sequential |
| ORCHESTRATE | `limitation`, `consult` | read | parallel |
| ORCHESTRATE | `decide` | read | sequential |
| ORCHESTRATE | `self_compact` | read | sequential |
| RETRIEVE | `web_read`, `web_fetch` | read | parallel |
| INTERACT | `ask_user`, `configure_clio` | read, write | sequential |
| ARTIFACT | `artifact` | write | sequential |
| GATEWAY | `gateway` | read (inner call retains its class) | sequential |

Several tools sit in a plane for containment rather than class:

| Tool | Placement | Why |
| --- | --- | --- |
| `git` | EXECUTE plane, read class, sequential | Fixed-argv git on the safe-exec spine. The inspection ops (`status`, `diff`, `log`, `show`) are reads. `add` and `commit` project their exact argv to a bash effect, so the safety net and the Git classifier judge them as mutations. Sequential so two calls never race the index. |
| `monitor` | ORCHESTRATE plane, read class, parallel | It never mutates a run. |
| `tasks` | Read class, sequential | It orchestrates the agent's own work rather than workers. Sequential so two board mutations in one batch cannot interleave. |
| `ledger` | Read class | A post reaches a one-way control lane and a read answers from a local mirror, so it touches no workspace. Reviewers and judges have a read-only dispatch restriction, where a write class would block the peer review the board exists for. |
| `panes` | Read class, sequential | It controls only Clio-owned terminal panes through the live mux. Sequential so two operations cannot race the same pane registry. |
| `music` | Read class, sequential | It drives only Clio's own cliamp player in Clio's own dock and touches no workspace. Sequential so opening, revealing and closing never race the dock slot. |
| `evidence` | OBSERVE plane, sequential | It only reads canonical evidence, trust status, gate decisions, and findings, but `run` mode may materialize a bundle under Clio's data directory. |
| `limitation` | ORCHESTRATE plane, read class, parallel | It appends one typed receipt to the session ledger and touches nothing else. The call is pure. |
| `decide` | ORCHESTRATE plane, read class, sequential | It appends one decision-board entry and touches nothing else. Sequential so two decisions in one batch cannot race the supersede lookup. |
| `consult` | ORCHESTRATE plane, read class, parallel, gateway | It sends the main agent's typed question, a small state and up to eight workspace files (read under the read tool's containment and redacted) to the System One engine bound to the `consult` site, and returns the distribution as a hint, never a chosen option. It changes nothing. Only the session registers it, and only when that site is bound at startup, so an unbound session's registry, gateway listing and prompt are unchanged, and dispatch never admits it for a worker. |
| `self_compact` | ORCHESTRATE plane, read class, sequential | It saves the agent's handoff note and asks the host to compact the agent's own context, touching no workspace. Only the native interactive host supplies the continuity port it needs, so bootstrap never requires it and an external agent loop never receives it. |

For `tasks`, board mutations append session task-ledger snapshots, and calls can
reconcile the project-local `.clio-coder/user-tasks.json` inbox while `pick` and
linked `done` update its durable correlation. These Clio-owned bookkeeping
effects retain read class without granting source-workspace mutation authority.

Registration is conditional on wiring: `context` gains its workspace scope only
when a session contract is bound, `dispatch`/`monitor`/`steer` register only
with a dispatch contract, `ask_user` and `configure_clio` register only when an
interactive handler exists, `ledger` registers for a worker that bound its
dispatch's agent-ledger port and for a session that has a dispatch contract
(there it is gateway-placed and adds no startup prompt entry), `panes` registers
only when a pane host answered detection and the mux is live, and `music`
registers only when `integrations.music.enabled` and `integrations.music.agentControl` are on, cliamp
resolves and the mux is live. `web_read` and `web_fetch` are omitted when
`CLIO_CODER_DISABLE_RETRIEVE_TOOLS=1`. Dispatch tool profiles narrow the surface for workers:
`minimal-local` is `read`, `grep`, `find`, `ls`, `git`, `context`, `code_nav`,
and `ledger`; `science-local` adds `verify`; `council-read-only` is `read`, `grep`, `find`, `ls`, `git`, `code_nav` and `context`; `full-agent` keeps everything that
the runtime registered and the recipe allows.

The session prompt's turn-ending section tells the model that an explicit, specific operator instruction is its own consent and is carried out without an `ask_user` re-confirmation, because the approval cards gate the risky commands. It asks only when the target is ambiguous or lies outside the workspace.

`ask_user` keeps its typed `exposure: local | outward` admission fact separate from caller prose. The registry uses exposure only in the enforced autonomy mapping. After admission, the host carries the normalized fact into the shared decision-presentation classifier; question text, headers, options, summaries, and requested color or severity words cannot select a consequence tier. The resulting presentation object contains no admission disposition and cannot grant authority.

### Consolidated call shapes

Several tools cover a family of operations through one schema:

- `find(pattern, path?, order?, limit?, include_ignored?)` locates paths by glob pattern (`*`, `**`, `?`, `[abc]`), default limit 500. `order="path"` (default) returns fd's native order; `order="mtime"` returns newest first from a bounded candidate set instead of statting the whole tree, and reports `details.candidates` when the candidate cap made the ordering approximate.
- `grep(pattern, path?, mode?, glob?, ignore_case?, literal?, context?, limit?, include_ignored?)` searches file contents with ripgrep, degrading to a bounded pure-Node search when rg is absent. `mode=content` (default) returns line-referenced matches, `mode=files` returns matching paths, `mode=count` returns per-file counts. Context lines are consumed from rg's `--json` stream.
- `context(scope="workspace"|"settings"|"skills"|"recall"|"budget")` observes the session workspace snapshot, explains effective settings through an allowlisted read-only projection, activates installed skills, retrieves persisted historical results, or reports the live request budget of the native main session. Settings reads use the session settings getter, support query/limit/offset pages, omit credentials and arbitrary command configuration, and return an unavailable error when no authoritative getter is bound. Recall accepts `ref` for exact retrieval or `query`, `limit`, and `offset` for discovery. Bundled docs and recipe browsing use gateway capabilities `clio_docs` and `clio_library`.
- `verify(check?, path?, args?, browser?, cwd?, timeout_ms?)` runs declared verification. `verify()` lists package.json verification scripts and strict version-1 or version-2 `.clio-coder/verifiers.yaml` entries through the same `{id, description, command, cwd, timeoutMs, tags, source}` projection. Version 1 supports command checks; version 2 also supports `numeric-compare` and `perf-budget` judgements. New catalogs use version 2; see the [project verifier contract](../guide/tool-usage.md#project-verifier-catalog). `verify(check="<id>")` runs a package script, the catalog's exact argv/cwd/timeout, or a check derived from the repository's Python, Cargo, Go, CMake, Makefile, justfile or CI files through safe-exec with no shell ([derived checks](../guide/tool-usage.md#derived-checks)). Model `args`, cwd, timeout, output-cap, and environment fields cannot mutate a project entry. `verify(check="frontend", path=...)` validates an HTML/CSS/JS artifact without granting shell access.
- `gateway(op="call", capability="artifact", args={kind: "plan"|"review"|"report", content: ...})` writes named artifacts: Markdown documents (default `.clio-coder/artifacts/PLAN.md`/`REVIEW.md`/`REPORT.md`; `path` may override inside the workspace) that terminate the turn, because writing the artifact is the answer. Skills are not artifacts; a `SKILL.md` is authored outside protected active skill roots with the ordinary write tool and validated by the library validator before operator installation.
- `dispatch(task?, tasks?, mode?, ...)` supports a first-class singular assignment (`task`) and a batch (`tasks`), never both. `task` is worker instructions; `briefing` is optional bounded parent context/data and cannot replace it. Briefing stays a separate dynamic message and receipt provenance, never part of the receipt task. A shared top-level briefing applies to strings and objects without an override; an object-level briefing wins. Blank values are omitted, the cap is 12,000 UTF-8 bytes, and approval pins the exact canonical value. Ordinary handles enter one registered event consumer immediately. Synchronous calls auto-wait for stream-and-receipt completion; `detach:true` returns ids after durable batch registration while the same consumer continues. Review and compete retain gate-sensitive direct drains. Task objects may include `persona`, `tool_profile`, and a typed `budget: {toolCalls, readReserve, retryRevision?}`. The budget must fit the recipe's authored range and the operator lifetime cap. `retryRevision` is the only authority for a later retry, result-contract revision, or review revision to grow its phase. Pipeline output is threaded as bounded data. A successful native or ACP run requires a nonempty receipt-sealed final output; exit zero without one fails as `worker_final_output_missing`, with unfinished text retained only as partial diagnostics. `dispatch(list=true)` renders the catalog. The main session attaches a compact schema and `gateway(op="describe", capability="dispatch")` returns the canonical one; see [dispatch](../guide/tool-usage.md#dispatch-run-bounded-tasks-on-fleet-agents).
- `monitor(run_id?, mode?)` is read-only visibility into known synchronous and detached runs: `list` enumerates, `status` reports one, `peek` returns the in-process event tail, `receipt` exposes the stored evidence, `tools` lists the tool calls a run made, and `wait` observes one run without collecting or canceling it. `collect` is the authoritative terminal batch operation over a detached batch or run-id list; it blocks while its runs are in flight, up to its timeout, and is required before final synthesis. Completed output retains receipt integrity, evidence verification, briefing provenance, and bounded project-context provenance as distinct detail fields. Successful typed internal-helper results use compact text and `details.runs[].helperResult`; full receipts remain available on demand. The coordinator uses grounded helper results for navigation without routinely repeating their investigation.
- `steer(run_id, action, message?, request_id?)` controls a running worker: `guide` writes a canonical trimmed steering message to an HTTP or SDK worker, `cancel` terminates it, and `approve` or `deny` answers one worker permission request raised to the main agent. Successfully written steers gain ordered byte/hash/timestamp provenance; after the runtime accepts the guidance, `clio_coder_steer_received` acknowledges the exact matching sequence, and prose is never stored in ledger or receipt. Single-shot subprocess runtimes and ACP remain non-steerable. Interactive operators can steer synchronous live-input runs; parent-model steering requires detached ids because model tools are sequential.

### One ignore policy for path walkers

`grep`, `find`, and their pure-Node fallbacks answer "which parts of the tree are visible" from one shared policy in [ignore-policy.ts](../../src/tools/ignore-policy.ts). Three layers apply: `.clio-coder`, `.fallow`, and `.git` are always excluded; `.gitignore` is honored natively by rg/fd; and one generated-dirs list (`node_modules`, `dist`, `build`, `coverage`, `.venv`, and similar) is force-excluded even when a project forgot to gitignore it. `include_ignored: true` lifts the gitignore and generated-dirs layers together. Fallbacks do not parse `.gitignore`; they disclose their generated-directory-only ignore behavior. The clio-internal layer always stands, except that pointing a tool directly at one of those directories means the caller wants those paths.

## The observation envelope

The content-returning OBSERVE tools (`read`, `grep`, `find`, `ls`, `code_nav`, `context`, `clio_docs`, `clio_library`, `data`) and gateway find listings close every result through one shared envelope in [observation.ts](../../src/tools/observation.ts). `credential_present` sits in the OBSERVE plane but returns a typed boolean and carries no envelope cap, and `evidence` returns bounded JSON under its own 16KB summary policy. The envelope owns four guarantees.

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

**One turn budget.** All envelope tools draw from a single per-turn pool keyed `sessionId:turnId` and configured by `safety.limits.observationBytesPerTurn`. At the default of 192KB the pool scales with the effective context window at 1.5 bytes per window token, with 192KB as the floor and 1MB as the ceiling (`src/tools/observation.ts`); any other configured value applies exactly. Each call reserves the minimum of its self cap and the remaining budget before doing the work. An exhausted pool short-circuits with an `[observation budget exhausted ...]` notice naming the tool, the subject, and the used/limit sizes, instead of paying for a search whose output could not be returned. A fourth consecutive exhausted call in one turn fails as an error instead of returning another notice. A call whose cap was reduced by the pool appends a budget note telling the model to narrow its arguments or continue in a follow-up turn.

Per-call self caps: `read` 50KB (`safety.limits.readBytesPerCall`), `grep` 16KB for `mode=content` and 8KB for `files`/`count`, `find` 8KB, `ls` 8KB, `code_nav` 16KB, `context` 50KB for skills/workspace, `clio_docs`/`clio_library` 16KB, `data` 32KiB, and gateway find 32KiB. The registry backstop cap for each envelope tool is its self cap plus 2KB slack, so a tool's own notice with its exact continuation call survives shaping instead of being cut again and replaced by a generic hint; the bootstrap policy assertion fails loudly if a cap ever drops below that.

Every envelope result carries `details.observation` (`{tool, unit, shownCount, totalCount, shownBytes, totalBytes, truncated, format, next?, offloadPath?, budget?}`) for the TUI ledger, session turns, and observers.

## Description tiering

Tool descriptions are tiered by how much a wrong call costs. The hot tools the model calls constantly (`read`, `grep`, `find`, `dispatch`) embed their operational contract in the description: caps, modes, ignore semantics, and how truncated results continue. Every other tool carries a one-to-two-sentence statement of what it does, and deep usage guidance lives in the bundled docs corpus ([tool-usage.md](../guide/tool-usage.md)) rather than the prompt prefix, retrievable on demand through `gateway(op="call", capability="clio_docs", args={query: ...})`. This keeps the serialized schema block small and byte-stable while still giving the model a path to depth when it needs one.

## Direct placement and the capability gateway

[surface.ts](../../src/tools/surface.ts) owns placement independently of policy planes. A registered spec's explicit `placement` declaration wins. Otherwise a surface rule applies: `find` and `ls` are gateway-placed on any surface that admits `bash` (`SHELL_COVERED_TOOLS`), because bash already runs them as recognized commands on workspace paths and their schemas would cost every request; a surface without `bash` keeps them attached. Otherwise `TOOL_PLACEMENT` decides.

`TOOL_PLACEMENT` makes these builtins direct: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `context`, `code_nav`, `self_compact`, `verify`, `run_script`, `gateway`, `dispatch`, `monitor`, `steer`, `tasks`, `ledger`, `panes`, `music`, `limitation`, `decide` and `ask_user`, each when its dependencies are bound. Gateway capabilities are `artifact`, `web_read`, `web_fetch`, `git`, `evidence`, `credential_present`, `clio_docs`, `clio_library`, `data`, `consult`, `vision`, `configure_clio`, extension commands (`extension_<id>__<name>`), and trusted local MCP tools (`mcp_<id>__<tool>`).

The main session registry overrides that table: `registerAllTools` in [bootstrap.ts](../../src/tools/bootstrap.ts) applies `coordinatorToolPlacement` to every spec, so only `COORDINATOR_DIRECT_TOOLS` carry an attached schema: `read`, `bash`, `edit`, `write`, `gateway`, `dispatch`, `verify` and `ask_user`. Everything else, `grep`, `find` and `ls` included, is reached through the gateway. Workers keep the table placement plus the shell rule on their admitted surface. The permanent context schema retains workspace, settings, skills, recall and budget.

`gateway(op="find"|"describe"|"call", capability?, query?, args?)` is read class and sequential. Its inner call runs through canonical registry admission with the capability's own class, skill restrictions, approvals, and cancellation. Nested accounting counts the model call once. `effectiveToolCall` restores capability identity for artifact folding, mutation observers, path indexing, exported evidence, and transcripts. Terminal artifact results, images, and details survive routing. Gateway placement changes schema attachment, not authority or evidence.

Native worker recipes continue to name capabilities such as `git`; `effectiveToolNames` adds `gateway` to the attached and attested direct projection while preserving the admitted capability allowlist for inner calls. Find and describe use that allowlist too. MCP sources are session-owned and are not installed into worker registries.

## Context protection

Clio uses two context-protection mechanisms.

1. Tool results are capped at the source and again at the registry boundary. The effective registry cap is the smaller of the tool's own policy and `context.toolResultMaxBytes` (default 65536, minimum 4096). A tool with no policy uses that 64KB default. OBSERVE tools use the envelope caps above. Exact mutation tools (`write`, `edit`, `artifact`) use 8KB, as do `tasks`, `panes` and `configure_clio`; `steer`, `credential_present`, `limitation`, `decide` and `consult` use 4KB; `self_compact` and `music` use 2KB; `ledger` uses 16KB; `run_script` and `vision` use 32KB; and `ask_user` has a 20KB policy. Summary-kind tools (`bash`, `git`, `verify`, `dispatch`, `monitor`, `evidence`) use 16KB at the registry boundary. `web_read` and `web_fetch` are bounded at 16KB after shaping and may read more before it: `max_bytes` defaults to 600KB and is hard-capped at 5MB. MCP capability results are bounded to 16KB in model context, offloading larger results to disk artifacts with preview and reference. Bash adds a per-call `output_policy` that selects what returns to model context while the operator display stays a folded, tail-biased 16KB; the dispositions and limits are in [bash](../guide/tool-usage.md#bash-run-a-shell-command). Over-cap results are shown briefly and, when possible, saved under `<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt` with an `offloadPath` detail and a 10MB scratch-file cap (16MiB for bash).
2. Auto-compaction uses one pressure threshold. The default threshold is 0.8. When pressure crosses the threshold, Clio first applies a non-destructive working-set eviction and records the evicted items in the session ledger. If pressure remains above the threshold, it runs the LLM summary compaction path and replays from the compacted session view. The older destructive observation/thinking mask is available only as a compatibility escape hatch when `CLIO_CODER_LEGACY_MASK=1`.

Manual `/context compact`, `CLIO_CODER_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly.

Compaction changes projected model replay while retaining the raw ledger, so the next turn on a local single-slot backend is expected to lose prefix-cache alignment. Clio records `expectedColdReasons` and shows one dim notice for that turn.

## Inspecting a session

Timing and cache behavior are persisted per API call, so a finished session can be inspected from its stored artifacts alone. Each assistant entry in the session ledger (`current.jsonl`, under the directory reported by `clio-coder paths`) carries `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }`, and the run's first persisted call also carries `expectedColdReasons`. Cache verdicts are `hot`, `partial`, `cold`, or `small`.

Native session timing uses a monotonic clock from each stream invocation, before the provider's response-header wait, to its first observed output (`ttftMs`) and completion (`apiMs`). A tool-loop continuation starts a new clock; no output leaves TTFT null, and a genuine rounded zero remains zero. Historical values are not rewritten and may omit the pre-header wait. A reader that times calls from the event stream instead starts at the provider's `message_start` event, which can arrive after headers, so such spans are not complete request latency and must not be compared with these durable records.

For aggregate cost and token facts across sessions, use `clio-coder usage report --days <n>`. Inside the TUI, `/usage` shows session totals and `/context` opens the context-window ledger overlay.

## Self-documentation retrieval

`gateway(op="call", capability="clio_docs", args={query: ...})` retrieves Clio’s bundled Markdown reference for agents. Human readers can open the installed `docs/` files in an editor or read public user guides at <https://coder.iowarp.ai/docs.html>. The capability indexes the shipped corpus: every Markdown file under `docs/` except `docs/html/`, plus `README.md`, `CHANGELOG.md` and `CLIO-CODER.md` from the package root when present. It is deterministic and offline: no embeddings service, network call, or filesystem write is needed.

The search index splits Markdown into heading-delimited sections, records heading breadcrumbs and line ranges, and ranks results with light stemming, controlled Clio vocabulary aliases, phrase boosts, and BM25-style body scoring. `limit` defaults to 5 sections and caps at 12. A hit carries a ready-to-use `read` call for exactly its cited section, and the result carries retrieval guidance such as `operating.support-guidance`. The field list is in [clio_docs](../guide/tool-usage.md#cliodocs-retrieve-bundled-documentation-through-the-gateway). Even an empty result is valid JSON with empty arrays and a populated `next` continuation. Narrow a search with more specific query terms; there is no per-file filter.

A `read` of a bundled `docs/*.md` file with no `offset`, `limit` or `tail` returns an 80-line head plus a section index of start and end lines, so a narrow question reads one section instead of a whole guide. An explicit `offset=1` without `limit` reads the file within the ordinary per-call caps.

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
