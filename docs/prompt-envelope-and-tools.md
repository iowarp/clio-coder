# Prompt Envelope and Tools

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/tools_blueprint.html](html/tools_blueprint.html) (Version: 0.3.2).

Clio Coder keeps the model-facing envelope stable and moves enforcement into the runtime registry and safety policy.

Source of truth: `src/core/tool-names.ts`, `src/tools/agent-tools.ts`, `src/tools/bootstrap.ts`, `src/tools/policy.ts`, `src/tools/observation.ts`, `src/tools/ignore-policy.ts`, and the per-tool modules under `src/tools/**`.

## One system prompt per session

The chat loop compiles one provider-facing system prompt for a session. The compile key is `target|model|autonomy|sessionId|workingContextPaths`, with the working-context paths sorted before hashing into the key.

The compiled prompt is reused byte-for-byte on ordinary submits. It recompiles only when that key changes or when config hot-reload invalidates the prompt cache. Path-scoped project rules can therefore recompile the prompt when a matching file enters working context. When recompilation changes the text, the session ledger records a `promptRecompiled` entry with the previous hash, new hash, and token estimate.

The disk fragments under `src/domains/prompts/fragments/` are layered by who reads them. `identity.clio` and `operating.contract` are constitutional: they render for every reader, name no tool, and state what is always true about Clio and her harness. `operating.delegation` (fleet coordination, receipts, spot-checks, shared `[worker result]` notes) renders only when `dispatch` is on the session's tool surface, and `operating.skills` (skill-shaped tasks, `/skill <name>` suggestions) only when `context` is; a fragment that teaches a tool is absent when the tool is, the same rule the Fleet block follows. `identity.docs-routing`, the directive to call `context(scope="docs")` before answering a question about Clio herself, follows the `context` gate too, while `identity.self-awareness` (installed paths, code outranks docs, configuration locations) names no tool and is unconditional. `operating.worker` (the assigned-task contract) renders only for dispatched workers, which never see the coordinator fragments. `safety.<level>` states what runs, what is approval-required, and what is blocked at the effective autonomy, in the safety net's action-class vocabulary (read, write, command, `system_modify`, `git_destructive`) and never by tool name, so the same body is true on every surface; the session and every worker read that one body, and what "approval-required" resolves to is the only role text (one operator confirmation for the session, the worker's `onPermission` routing for a worker).

Prompt extensions can add dynamic fragments for project rules, the operator profile, and Clio source-tree awareness. Pending skill requests and middleware reminders are visible text in the user message, not hidden prompt machinery.

## Prompt template expansion

Prompt templates expand into the operator's user message before submission. They do not alter the compiled system prompt or bypass the trust check on project-scope compatibility roots. The prompt-root locations, frontmatter fields, and trust rules are documented in [extensions-and-sharing.md](extensions-and-sharing.md#prompt-templates).

Arguments after `/template-name` use pi-agent-core's shell-style `parseCommandArgs` parser. Single or double quotes keep spaces inside one argument. The template body may use `$1` through `$9` for positional arguments and `$ARGUMENTS` for every parsed argument joined with spaces. A positional placeholder with no matching argument expands to an empty string. Clio routes both parsing and substitution through pi-agent-core's `parseCommandArgs` and `substituteArgs` exports so the command grammar follows the installed Pi SDK.

`wiki.page` and `wiki.plan` (`src/domains/prompts/fragments/wiki/*.md`) load through this same loader, with the same id/version/content-hash contract as every other fragment, but they are consumed differently: `context/wiki/prompts.ts` reads them by id, substitutes per-dispatch `{{token}}` placeholders (a page's path, title, and relative path; the plan file's path), and sends the result as a wiki-generation dispatch's `task`, never as a compiled system prompt. `{{token}}` substitution has no home in the fragment loader itself, the same division `identity.self-awareness`'s `{TOKEN}` placeholders use in `compiler.ts`: the loader hands back a raw body, and the one caller that needs live values fills them in. Both files' bodies open and close on a standalone `---` line that predates their frontmatter and was kept unchanged as body text so the substituted prompt stays byte-identical to what the old hand-rolled `readFileSync` produced.

The Tool Contract section of the prompt renders a fixed set of base lines plus one optional guidance sentence per tool, sourced from the tool registry (`ToolMetadata.promptHint` in `src/tools/registry.ts`, assigned in `src/tools/bootstrap.ts`). The base lines cover the complete-surface rule, the harness model (direct tools, fleet workers, skills as distinct capability sets), the capability-inventory rule, tool-free answering, the narrow-orientation tool list, validation before final claims, and failure recovery through `context(scope="docs")` instead of blind retries. Delegation, the tasks board, and skill listing are not restated here: `operating.delegation`, the `tasks` hint, and `operating.skills` each say their rule once and render exactly when their tool is on the surface. The one fleet-routing sentence (`FLEET_ROUTING_GUIDANCE`) renders when `dispatch` carries a hint and says only that the `agent` id is pinned from the Fleet section and `agent:"auto"` is a fallback. The chat loop derives the hint list once from the session's frozen tool surface at compile time, and the compiler renders the hints sorted by tool name, so the compiled text depends only on which hinted tools are on the surface. Today five tools carry hints: `ask_user`, `code_nav`, `context`, `dispatch`, and `tasks`. Removing a tool from the surface removes its hint with no compiler change; adding a hint to a tool is a deliberate prompt-text change that must land with updated prompt contract tests and a CHANGELOG note.

## One tool surface per session

For tool-capable providers, Clio sends the full registry as the session tool surface. The list is deterministic and sorted through the worker-tool resolver (`resolveAgentTools` in `src/tools/agent-tools.ts`), so the serialized schemas stay byte-identical on every submit. `src/tools/agent-tools.ts` is the single agent-tool adapter across the codebase. Both the orchestrator session and worker subprocesses resolve their tool set through the same `effectiveToolNames` narrowing function, ensuring that the attested signature and runtime surface cannot diverge.

Tools are keyed strictly by the canonical `ToolName` union defined in `src/core/tool-names.ts` with no alias table. Pure and idempotent `prepareArguments` normalizers defined on `ToolSpec` serve as the sole leniency layer for coercing legacy or weak-model parameter formats.

Tool visibility is not a per-turn hinting system. Pending-skill policy, ask-user policy, Bash policy, path policy, protected artifacts, dispatch admission, middleware, and the autonomy mapping are enforced when a tool is invoked. The `autonomy` level is applied at registry admission after the safety net passes a call; the safety prompt fragment mirrors that enforced matrix as guidance to the model. Prompt text and provider schemas do not bypass the registry.

Providers that cannot call tools receive no schemas, and the prompt tells the model to proceed without tool calls.

## Canonical worker harness

Native and mediated dispatch workers use a separate prompts-domain compiler over the same loaded fragment table. Its stable system prompt has five fixed sections plus one optional trailing one: identity-lite, the constitutional operating contract plus the `operating.worker` assigned-task contract, a tool contract sliced to the final canonical toolkit, the same `safety.<level>` fragment the session reads for the single effective autonomy under a worker one-liner that carries the run's permission routing, one final persona, and the operator-editable layer when either of its parts renders non-empty: active project rules scoped to this run's inferred working context, and the operator profile. A request persona override replaces only the recipe body; eligible bound-skill instructions are composed inside that same final persona and never widen tools.

The operator-editable layer reaches a worker through `additionalFragments`, the same channel `compile()` uses for the session, so nothing splices into an existing section. The operator profile renders unconditionally, capped, the same as it does for the session: it governs how the worker should do the task (validation preference, commit-message style, local-only paths), not only how the orchestrator talks to the operator. Project rules are scoped to the worker's working context rather than shipped wholesale. That context is `writeRoots`, when the caller sets them, plus path-like tokens recalled from the task and briefing text, since the model-facing dispatch tool has no structured path field. A missed path token means a rule can go unseen; it can never fabricate one, because `selectActiveRules` still requires a real glob match.

The compiler runs after target capability and tool-profile admission. Its canonical tool names are the same names transported in `WorkerSpec.allowedTools` and attached as schemas; routine non-Scout work removes `code_nav`, narrow profiles remove their excluded schemas and guidance, tool-incapable targets get an explicit no-tools contract, and Claude SDK aliases are filtered from the same canonical set. ACP's external inventory is unknown, so ACP bounded-role admission continues to validate the unchanged raw persona rather than fabricating a complete native schema list.

Project context, memory, bounded dispatch briefing, pipeline input, the assigned task, and the per-run safety-posture reminder remain dynamic user messages. A briefing is a separately delimited message labeled as untrusted task context/data; it is never concatenated into the task or stable system prompt. Dynamic ordering is project, safety, memory, briefing, then pipeline input, with pipeline input last. These messages do not affect the stable composition hash. Persona, effective autonomy, target tool capability, or final toolkit changes do affect it.

## Seven planes, twenty tools

The builtin surface is 20 registered tools organized in seven planes. Each plane is one policy unit: its tools share an action class, a size posture, a details schema, and a concurrency rule. `src/tools/policy.ts` asserts these invariants at bootstrap, so drift between the plane design, the safety classifier, and the registered specs fails loudly instead of shipping a surface that behaves differently from what the policy engine assumes.

| Plane | Tools | Action class | Concurrency |
| --- | --- | --- | --- |
| OBSERVE | `read`, `grep`, `find`, `ls`, `code_nav`, `context`, `credential_present` | read | parallel |
| MUTATE | `write`, `edit` | write | sequential |
| EXECUTE | `bash`, `verify` | execute | sequential |
| EXECUTE | `git` | read | parallel |
| ORCHESTRATE | `dispatch`, `steer` | dispatch | sequential |
| ORCHESTRATE | `monitor` | read | parallel |
| ORCHESTRATE | `tasks` | read | sequential |
| ORCHESTRATE | `ledger` | read | sequential |
| RETRIEVE | `web_fetch` | read | parallel |
| INTERACT | `ask_user` | read | sequential |
| ARTIFACT | `artifact` | write | sequential |

Three tools sit in a plane for containment rather than class. `git` is read-only inspection (op=status/diff/log) that runs on the safe-exec spine, so it lives in the EXECUTE plane with read-class safety disposition. `monitor` never mutates a run, so it stays read class and parallel inside the ORCHESTRATE plane. `tasks` orchestrates the agent's own work rather than workers: it mutates only the session's task ledger, never the workspace, so it keeps read class (never gated behind a confirmation) but runs sequential so two board mutations in one batch cannot interleave. `ledger` is the agent ledger, the coordination board concurrent dispatch workers share: a post reaches a one-way control lane and a read answers from a local mirror, so it touches no workspace and stays read class, and reviewers and judges are pinned to read-only autonomy where a write class would block the peer review the board exists for.

Registration is conditional on wiring: `context` gains its workspace scope only when a session contract is bound, `dispatch`/`monitor`/`steer` register only with a dispatch contract, and `ask_user` registers only when an interactive handler exists. Dispatch tool profiles narrow the surface for workers: `minimal-local` is `read`, `grep`, `find`, `ls`, `git`, `context`, `code_nav`; `science-local` adds `verify`; `full-agent` keeps everything.

### Consolidated call shapes

Several tools absorb what used to be separate tools:

- `find(pattern, path?, order?, limit?, include_ignored?)` locates paths by glob pattern (`*`, `**`, `?`, `[abc]`), default limit 500. `order="path"` (default) returns fd's native order; `order="mtime"` returns newest first from a bounded candidate set instead of statting the whole tree, and reports `details.candidates` when the candidate cap made the ordering approximate.
- `grep(pattern, path?, mode?, glob?, ignore_case?, literal?, context?, limit?, include_ignored?)` searches file contents with ripgrep, degrading to a bounded pure-Node search when rg is absent. `mode=content` (default) returns line-referenced matches, `mode=files` returns matching paths, `mode=count` returns per-file counts. Context lines are consumed from rg's `--json` stream.
- `context(scope="workspace"|"docs"|"skills")` is the one OBSERVE entry point for material about the working environment: the session workspace snapshot, retrieval over Clio's bundled documentation (`query` required), and skill listing or loading (`name` optional, `include_tree` for the skill's resource files).
- `verify(check?, path?, args?, browser?, cwd?, timeout_ms?)` runs declared verification. `verify()` with no arguments lists declared checks grouped by source (package.json verification scripts today), `verify(check="<script>")` runs one through the safe-exec spine with no shell, and `verify(check="frontend", path=...)` validates an HTML/CSS/JS artifact without granting shell access.
- `artifact(kind="plan"|"review"|"report", content, ...)` writes named artifacts behind one surface: Markdown documents (default `.clio-coder/artifacts/PLAN.md`/`REVIEW.md`/`REPORT.md`; `path` may override inside the workspace) that terminate the turn, because writing the artifact is the answer. Skills are not artifacts; a `SKILL.md` is written with the ordinary write tool and validated by the skills loader.
- `dispatch(task?, tasks?, mode?, ...)` supports a first-class singular assignment (`task`) and a batch (`tasks`), never both. `task` is worker instructions; `briefing` is optional bounded parent context/data and cannot replace it. Briefing stays a separate dynamic message and receipt provenance, never part of the receipt task. A shared top-level briefing applies to strings and objects without an override; an object-level briefing wins. Blank values are omitted, the cap is 12,000 UTF-8 bytes, and approval pins the exact canonical value. Ordinary handles enter one registered event consumer immediately. Synchronous calls auto-wait for stream-and-receipt completion; `detach:true` returns ids after durable batch registration while the same consumer continues. Review and compete retain gate-sensitive direct drains. Task objects may include `persona` and `tool_profile`. Pipeline output is threaded as bounded data. A successful native or ACP run requires a nonempty receipt-sealed final output; exit zero without one fails as `worker_final_output_missing`, with unfinished text retained only as partial diagnostics. `dispatch(list=true)` renders the catalog.
- `monitor(run_id?, mode?)` is read-only visibility into known synchronous and detached runs: `list` enumerates, `status` reports one, `peek` returns the in-process event tail, `receipt` exposes the stored evidence, and `wait` observes one run without collecting or canceling it. `collect` is the authoritative terminal batch operation over a detached batch or run-id list; collect before final synthesis. Completed output reports receipt integrity, evidence verification, briefing provenance, and bounded project-context provenance as different fields.
- `steer(run_id, action, message?)` controls a running worker: `guide` writes a canonical trimmed steering message to an HTTP or SDK worker and `cancel` terminates it. Successfully written steers gain ordered byte/hash/timestamp provenance; after the runtime accepts the guidance, `clio_steer_received` acknowledges the exact matching sequence, and prose is never stored in ledger or receipt. Single-shot subprocess runtimes and ACP remain non-steerable. Interactive operators can steer synchronous live-input runs; parent-model steering requires detached ids because model tools are sequential.

### One ignore policy for path walkers

`grep`, `find`, and their pure-Node fallbacks answer "which parts of the tree are visible" from one shared policy in `src/tools/ignore-policy.ts`. Three layers apply: `.clio-coder`, `.fallow`, and `.git` are always excluded; `.gitignore` is honored natively by rg/fd; and one generated-dirs list (`node_modules`, `dist`, `build`, `coverage`, `.venv`, and similar) is force-excluded even when a project forgot to gitignore it. `include_ignored: true` lifts the gitignore and generated-dirs layers together. The clio-internal layer always stands, except that pointing a tool directly at one of those directories means the caller wants those paths.

## The observation envelope

The six content-returning OBSERVE tools (`read`, `grep`, `find`, `ls`, `code_nav`, `context`) close every result through one shared envelope in `src/tools/observation.ts`. `credential_present` sits in the OBSERVE plane but returns a typed boolean and carries no envelope cap. The envelope owns four guarantees.

**One notice line, one format.** A truncated text result appends exactly one notice:

```text
[<tool>: <shown>/<total> <unit> shown (<shownSize> of <totalSize>) | full: <offloadPath> | next: <exact-call>]
```

Unknown segments are omitted. `<total>` renders as `N+` when the search was killed early at its limit, meaning matches beyond it exist but were never counted. `next` is always an exact continuation call fragment such as `limit=200` or `offset=451`, never prose. Untruncated results get no notice. Empty results are standardized: `grep` returns `No matches found`, `find` returns `No files found matching pattern`, `ls` returns `(empty directory)`, and the JSON-format tools return valid JSON with empty arrays and `next` populated.

**Offload on truncation.** When a byte cap cuts collected content, the tool spills its full rendering to the per-session scratch file (`<stateDir>/scratch/<sessionId>/<toolCallId>.txt`) and reports the path in the notice, so no collected match, path, or line is ever unrecoverable. Two deliberate exceptions exist: `read` never offloads because the source file is directly re-addressable via `next: offset=N`, and a bare item-limit truncation without a byte cut continues via `next` alone, since an offload would only duplicate the body.

**Always-valid JSON.** `code_nav` and the JSON scopes of `context` declare `format: "json"`. A JSON payload must parse or be replaced whole; it is never cut mid-document. An oversize payload is offloaded and the body is replaced by the parseable stub:

```json
{"error":"result exceeded <cap>","offloadPath":"...","next":"..."}
```

**One turn budget.** All six envelope tools draw from a single per-turn pool keyed `sessionId:turnId`, default 192KB, overridable with `CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES`. Each call reserves the minimum of its self cap and the remaining budget before doing the work. An exhausted pool short-circuits with an `[observation budget exhausted ...]` notice naming the tool, the subject, and the used/limit sizes, instead of paying for a search whose output could not be returned. A call whose cap was reduced by the pool appends a budget note telling the model to narrow its arguments or continue in a follow-up turn.

Per-call self caps: `read` 50KB (`CLIO_CODER_READ_MAX_BYTES`), `grep` 16KB for `mode=content` and 8KB for `files`/`count`, `find` 8KB, `ls` 8KB, `code_nav` 16KB, `context` 16KB for docs and 50KB for skills/workspace. The registry backstop cap for each envelope tool is its self cap plus 2KB slack, so a tool's own notice with its exact continuation call survives shaping instead of being cut again and replaced by a generic hint; the bootstrap policy assertion fails loudly if a cap ever drops below that.

Every envelope result carries `details.observation` (`{tool, unit, shownCount, totalCount, shownBytes, totalBytes, truncated, format, next?, offloadPath?, budget?}`) for the TUI ledger, session turns, and observers.

## Description tiering

Tool descriptions are tiered by how much a wrong call costs. The hot tools the model calls constantly (`read`, `grep`, `find`, `dispatch`) embed their operational contract in the description: caps, modes, ignore semantics, and how truncated results continue. Every other tool carries a one-to-two-sentence statement of what it does, and deep usage guidance lives in the bundled docs corpus ([tool-usage.md](tool-usage.md)) rather than the prompt prefix, retrievable on demand through `context(scope="docs")`. This keeps the serialized schema block small and byte-stable while still giving the model a path to depth when it needs one.

## The gateway reservation

`gateway` is a design-reserved name in `src/core/tool-names.ts`, not an implemented tool. The reserved contract sketch is `gateway(op: "find" | "describe" | "call", capability?, args?)`: an MCP/database proxy with one fixed schema, where external capabilities surface through find/describe/call results rather than as per-capability schemas in the prompt prefix. It would carry the network action class and run sequentially. Reserving the name keeps classifiers and profiles from ever assigning `gateway` to a dynamic tool.

## Context protection

Clio uses two context-protection mechanisms.

1. Tool results are capped at the source and again at the registry boundary. OBSERVE tools use the envelope caps above. Exact mutation tools (`write`, `edit`, `artifact`) use 8KB; `steer` and `credential_present` use 4KB; `ask_user` has a 20KB policy. Summary-kind tools (`bash`, `git`, `verify`, `dispatch`, `monitor`) use 16KB at the registry boundary. `web_fetch` is bounded at 16KB after shaping and may read more before it: its `max_bytes` argument defaults to 600KB and is hard-capped at 5MB. Tools without an explicit result-size policy use an approximately 18KB generic backstop. Over-cap generic results are shown briefly and, when possible, saved under `<stateDir>/scratch/<sessionId>/<toolCallId>.txt` with an `offloadPath` detail and a 10MB scratch-file cap.
2. Auto-compaction uses one pressure threshold. The default threshold is 0.8. When pressure crosses the threshold, Clio first masks stale tool observations and stale thinking older than `excludeLastTurns`. If pressure remains above the threshold, it runs the LLM summary compaction path and replays from the compacted session view.

Manual `/context compact`, `CLIO_CODER_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly.

Compaction rewrites history, so the next turn on a local single-slot backend is expected to lose prefix-cache alignment. Clio records `expectedColdReasons` and shows one dim notice for that turn.

## Inspecting a session

Timing and cache behavior are persisted per API call, so a finished session can be inspected from its stored artifacts alone. Each assistant entry in the session ledger (`current.jsonl`, under the directory reported by `clio-coder paths`) carries `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }`, and the run's first persisted call also carries `expectedColdReasons`. Cache verdicts are `hot`, `partial`, `cold`, or `small`.

For aggregate cost and token facts across sessions, use `clio-coder usage report --days <n>`. Inside the TUI, `/cost` shows session totals and `/context` opens the context-window ledger overlay.

## Self-documentation retrieval

`context(scope="docs")` is the model-facing companion to the human `clio-coder docs` server. The server serves bundled `docs/html/**` blueprints for people; the docs scope indexes the bundled markdown corpus for agents. It is deterministic and offline: no embeddings service, network call, or filesystem write is needed.

The search index splits markdown into heading-delimited sections, records heading breadcrumbs and line ranges, and ranks results with light stemming, controlled Clio vocabulary aliases, phrase boosts, and BM25-style body scoring. The tool returns compact JSON containing corpus metadata, normalized and expanded query terms, and ranked hits with `file`, `heading`, `breadcrumb`, `anchor`, section `lines`, `snippetLines`, a bounded `snippet`, `matchedTerms`, `signals`, `coverage`, and `score`. `limit` defaults to 5 sections and caps at 12. The per-file filter the pre-consolidation docs tool accepted was dropped; narrow with more specific query terms instead. Even an empty result is valid JSON with empty arrays and a populated `next` continuation.

## Edit matching safety

The `edit` tool first attempts exact matching. If the model's old text differs
only by normalized quote, dash, whitespace, or indentation details, Clio maps
the normalized match back to the original line span and splices only the
intended replacement. Unchanged spans keep their original bytes, including
smart punctuation and CRLF line endings. Ambiguous duplicate matches,
overlapping hunks, empty changes, and no-op edits are rejected instead of
guessing.
