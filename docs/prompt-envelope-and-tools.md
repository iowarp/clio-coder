# Prompt Envelope and Tools

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/tools_blueprint.html](html/tools_blueprint.html) (Version: 0.2.7).

Clio Coder keeps the model-facing envelope stable and moves enforcement into the runtime registry and safety policy.

Source of truth: `src/core/tool-names.ts`, `src/tools/bootstrap.ts`, `src/tools/policy.ts`, `src/tools/observation.ts`, `src/tools/ignore-policy.ts`, and the per-tool modules under `src/tools/**`.

## One system prompt per session

The chat loop compiles one provider-facing system prompt for a session. The compile key is `target|model|autonomy|sessionId|workingContextPaths`, with the working-context paths sorted before hashing into the key.

The compiled prompt is reused byte-for-byte on ordinary submits. It recompiles only when that key changes or when config hot-reload invalidates the prompt cache. Path-scoped project rules can therefore recompile the prompt when a matching file enters working context. When recompilation changes the text, the session ledger records a `promptRecompiled` entry with the previous hash, new hash, and token estimate.

Prompt extensions can add dynamic fragments for project rules, the operator profile, and Clio source-tree awareness. Pending skill requests and middleware reminders are visible text in the user message, not hidden prompt machinery.

The Tool Contract section of the prompt renders three fixed base lines plus one optional guidance sentence per tool, sourced from the tool registry (`ToolMetadata.promptHint` in `src/tools/registry.ts`, assigned in `src/tools/bootstrap.ts`). The chat loop derives the hint list once from the session's frozen tool surface at compile time, and the compiler renders the hints sorted by tool name, so the compiled text depends only on which hinted tools are on the surface. Today four tools carry hints: `ask_user`, `code_nav`, `context`, and `dispatch`. Removing a tool from the surface removes its hint with no compiler change; adding a hint to a tool is a deliberate prompt-text change that must land with updated prompt contract tests and a CHANGELOG note.

## One tool surface per session

For tool-capable providers, Clio sends the full registry as the session tool surface. The list is deterministic and sorted through the worker-tool resolver, so the serialized schemas stay byte-identical on every submit.

Tool visibility is not a per-turn hinting system. Pending-skill policy, ask-user policy, Bash policy, path policy, protected artifacts, dispatch admission, middleware, and the autonomy mapping are enforced when a tool is invoked. The `autonomy` level is applied at registry admission after the safety net passes a call; the safety prompt fragment mirrors that enforced matrix as guidance to the model. Prompt text and provider schemas do not bypass the registry.

Providers that cannot call tools receive no schemas, and the prompt tells the model to proceed without tool calls.

## Seven planes, eighteen tools

The builtin surface is 18 registered tools organized in seven planes. Each plane is one policy unit: its tools share an action class, a size posture, a details schema, and a concurrency rule. `src/tools/policy.ts` asserts these invariants at bootstrap, so drift between the plane design, the safety classifier, and the registered specs fails loudly instead of shipping a surface that behaves differently from what the policy engine assumes.

| Plane | Tools | Action class | Concurrency |
| --- | --- | --- | --- |
| OBSERVE | `read`, `grep`, `find`, `ls`, `code_nav`, `context`, `credential_present` | read | parallel |
| MUTATE | `write`, `edit` | write | sequential |
| EXECUTE | `bash`, `verify` | execute | sequential |
| EXECUTE | `git` | read | parallel |
| ORCHESTRATE | `dispatch`, `steer` | dispatch | sequential |
| ORCHESTRATE | `monitor` | read | parallel |
| RETRIEVE | `web_fetch` | read | parallel |
| INTERACT | `ask_user` | read | sequential |
| ARTIFACT | `artifact` | write | sequential |

Two tools sit in a plane for containment rather than class. `git` is read-only inspection (op=status/diff/log) that runs on the safe-exec spine, so it lives in the EXECUTE plane with read-class safety disposition. `monitor` never mutates a run, so it stays read class and parallel inside the ORCHESTRATE plane.

Registration is conditional on wiring: `context` gains its workspace scope only when a session contract is bound, `dispatch`/`monitor`/`steer` register only with a dispatch contract, and `ask_user` registers only when an interactive handler exists. Dispatch tool profiles narrow the surface for workers: `minimal-local` is `read`, `grep`, `find`, `ls`, `git`, `context`, `code_nav`; `science-local` adds `verify`; `full-agent` keeps everything.

### Consolidated call shapes

Several tools absorb what used to be separate tools:

- `find(pattern, path?, order?, limit?, include_ignored?)` locates paths by glob pattern (`*`, `**`, `?`, `[abc]`), default limit 500. `order="path"` (default) returns fd's native order; `order="mtime"` returns newest first from a bounded candidate set instead of statting the whole tree, and reports `details.candidates` when the candidate cap made the ordering approximate.
- `grep(pattern, path?, mode?, glob?, ignore_case?, literal?, context?, limit?, include_ignored?)` searches file contents with ripgrep, degrading to a bounded pure-Node search when rg is absent. `mode=content` (default) returns line-referenced matches, `mode=files` returns matching paths, `mode=count` returns per-file counts. Context lines are consumed from rg's `--json` stream.
- `context(scope="workspace"|"docs"|"skills")` is the one OBSERVE entry point for material about the working environment: the session workspace snapshot, retrieval over Clio's bundled documentation (`query` required), and skill listing or loading (`name` optional, `include_tree` for the skill's resource files).
- `verify(check?, path?, args?, browser?, cwd?, timeout_ms?)` runs declared verification. `verify()` with no arguments lists declared checks grouped by source (package.json verification scripts today), `verify(check="<script>")` runs one through the safe-exec spine with no shell, and `verify(check="frontend", path=...)` validates an HTML/CSS/JS artifact without granting shell access.
- `artifact(kind="plan"|"review"|"report"|"skill", content, ...)` writes named artifacts behind one surface. The plan, review, and report kinds write Markdown documents (default `PLAN.md`/`REVIEW.md`/`REPORT.md` at the project root; `path` may override inside the workspace) and terminate the turn, because writing the artifact is the answer. `kind="skill"` creates a `SKILL.md` in the project or user skill store and is not terminal.
- `dispatch(tasks, mode?, ...)` takes an array of task strings or `{agent, task, ...}` objects and runs them `parallel` (default), `sequential`, or `pipeline`. In `pipeline` mode tasks run one at a time and each step's final assistant output is threaded to the next step as a delimited dynamic prompt message labeled as data, not instructions; step 1 receives none. The threaded text is capped at 12000 characters, and the receiving run's receipt records `pipeline` provenance (`fromRunId`, `position`, `inputBytes`, `inputTruncated`). A failed step halts the chain and later steps are reported as skipped. The output is one per-run receipt summary per task, even for a single task. `dispatch(list=true)` renders the agent catalog.
- `monitor(run_id?, mode?)` is read-only visibility into dispatched runs: `mode=list` enumerates known runs, `status` (default with a run id) reports state and progress counters, `peek` returns the rolling tail of recent events buffered in this process, and `receipt` returns the stored receipt JSON with a 14KB cap.
- `steer(run_id, action, message?)` controls a running worker: `action=guide` injects a steering message the worker sees as a user message at its next turn boundary (native workers only; other runtimes surface the dispatch contract's structured no-input-channel error), and `action=cancel` terminates the run cleanly, with the receipt recording the cancellation.

### One ignore policy for path walkers

`grep`, `find`, and their pure-Node fallbacks answer "which parts of the tree are visible" from one shared policy in `src/tools/ignore-policy.ts`. Three layers apply: `.clio`, `.fallow`, and `.git` are always excluded; `.gitignore` is honored natively by rg/fd; and one generated-dirs list (`node_modules`, `dist`, `build`, `coverage`, `.venv`, and similar) is force-excluded even when a project forgot to gitignore it. `include_ignored: true` lifts the gitignore and generated-dirs layers together. The clio-internal layer always stands, except that pointing a tool directly at one of those directories means the caller wants those paths.

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

**One turn budget.** All six envelope tools draw from a single per-turn pool keyed `sessionId:turnId`, default 192KB, overridable with `CLIO_OBSERVATION_TURN_BUDGET_BYTES`. Each call reserves the minimum of its self cap and the remaining budget before doing the work. An exhausted pool short-circuits with an `[observation budget exhausted ...]` notice naming the tool, the subject, and the used/limit sizes, instead of paying for a search whose output could not be returned. A call whose cap was reduced by the pool appends a budget note telling the model to narrow its arguments or continue in a follow-up turn.

Per-call self caps: `read` 50KB (`CLIO_READ_MAX_BYTES`), `grep` 16KB for `mode=content` and 8KB for `files`/`count`, `find` 8KB, `ls` 8KB, `code_nav` 16KB, `context` 16KB for docs and 50KB for skills/workspace. The registry backstop cap for each envelope tool is its self cap plus 2KB slack, so a tool's own notice with its exact continuation call survives shaping instead of being cut again and replaced by a generic hint; the bootstrap policy assertion fails loudly if a cap ever drops below that.

Every envelope result carries `details.observation` (`{tool, unit, shownCount, totalCount, shownBytes, totalBytes, truncated, format, next?, offloadPath?, budget?}`) for the TUI ledger, session turns, and observers.

## Description tiering

Tool descriptions are tiered by how much a wrong call costs. The hot tools the model calls constantly (`read`, `grep`, `find`, `dispatch`) embed their operational contract in the description: caps, modes, ignore semantics, and how truncated results continue. Every other tool carries a one-to-two-sentence statement of what it does, and deep usage guidance lives in the bundled docs corpus ([tool-usage.md](tool-usage.md)) rather than the prompt prefix, retrievable on demand through `context(scope="docs")`. This keeps the serialized schema block small and byte-stable while still giving the model a path to depth when it needs one.

## The gateway reservation

`gateway` is a design-reserved name in `src/core/tool-names.ts`, not an implemented tool. The reserved contract sketch is `gateway(op: "find" | "describe" | "call", capability?, args?)`: an MCP/database proxy with one fixed schema, where external capabilities surface through find/describe/call results rather than as per-capability schemas in the prompt prefix. It would carry the network action class and run sequentially. Reserving the name keeps classifiers and profiles from ever assigning `gateway` to a dynamic tool.

## Context protection

Clio uses two context-protection mechanisms.

1. Tool results are capped at the source and again at the registry boundary. OBSERVE tools use the envelope caps above. Exact mutation tools (`write`, `edit`, `artifact`) use 8KB; `steer` and `credential_present` use 4KB; `ask_user` has a 20KB policy. Summary-kind tools (`bash`, `git`, `verify`, `dispatch`, `monitor`) use 16KB at the registry boundary. `web_fetch` is bounded at 16KB after shaping and may read more before it: its `max_bytes` argument defaults to 600KB and is hard-capped at 5MB. Tools without an explicit result-size policy use an approximately 18KB generic backstop. Over-cap generic results are shown briefly and, when possible, saved under `<stateDir>/scratch/<sessionId>/<toolCallId>.txt` with an `offloadPath` detail and a 10MB scratch-file cap.
2. Auto-compaction uses one pressure threshold. The default threshold is 0.8. When pressure crosses the threshold, Clio first masks stale tool observations and stale thinking older than `excludeLastTurns`. If pressure remains above the threshold, it runs the LLM summary compaction path and replays from the compacted session view.

Manual `/compact`, `CLIO_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly.

Compaction rewrites history, so the next turn on a local single-slot backend is expected to lose prefix-cache alignment. Clio records `expectedColdReasons` and shows one dim notice for that turn.

## Inspecting a session

Use the turn report to inspect persisted timing and cache behavior:

```bash
node benchmarks/live/turn-report.mjs --session <id>
```

The report prints per-call `ttft`, `api`, input, cache read, cache write, backend cache verdict, and expected cold reasons. Cache verdicts are `hot`, `partial`, `cold`, or `small`.

## Self-documentation retrieval

`context(scope="docs")` is the model-facing companion to the human `clio docs` server. The server serves bundled `docs/html/**` blueprints for people; the docs scope indexes the bundled markdown corpus for agents. It is deterministic and offline: no embeddings service, network call, or filesystem write is needed.

The search index splits markdown into heading-delimited sections, records heading breadcrumbs and line ranges, and ranks results with light stemming, controlled Clio vocabulary aliases, phrase boosts, and BM25-style body scoring. The tool returns compact JSON containing corpus metadata, normalized and expanded query terms, and ranked hits with `file`, `heading`, `breadcrumb`, `anchor`, section `lines`, `snippetLines`, a bounded `snippet`, `matchedTerms`, `signals`, `coverage`, and `score`. `limit` defaults to 5 sections and caps at 12. The per-file filter the pre-consolidation docs tool accepted was dropped; narrow with more specific query terms instead. Even an empty result is valid JSON with empty arrays and a populated `next` continuation.

## Edit matching safety

The `edit` tool first attempts exact matching. If the model's old text differs
only by normalized quote, dash, whitespace, or indentation details, Clio maps
the normalized match back to the original line span and splices only the
intended replacement. Unchanged spans keep their original bytes, including
smart punctuation and CRLF line endings. Ambiguous duplicate matches,
overlapping hunks, empty changes, and no-op edits are rejected instead of
guessing.
