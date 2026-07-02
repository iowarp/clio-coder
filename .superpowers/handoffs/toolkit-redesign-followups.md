# Toolkit v2 redesign: follow-ups for test/docs/validation sessions

Branch `toolkit-v2`, commits from `feat(tools): observation envelope, ignore
policy, spawn hygiene` through `chore(sprint): toolkit v2 handoff notes`.
Source of truth for the design: `.superpowers/prompts/fable/exec-toolkit-redesign-sprint.md`.

Verification state at handoff: `npm run typecheck` clean for `src/**` (tests
fail, see section 2), `npm run check:boundaries` green, `npm run build` green,
headless smoke green (read/grep/find envelope notices confirmed via
`clio run --json` against a live target; see section 7).

One deliberate deviation from the brief's "exactly 17 names": the surface is
17 planned tools PLUS `credential_present`, which landed after the research
freeze (commit 269116d) and was preserved. It sits in the OBSERVE plane
(read class, parallel, typed boolean result, no envelope cap).

## 1. Surface change table (old name -> new call shape)

| Old call | New call |
| --- | --- |
| `glob(pattern, path?, limit?)` | `find(pattern, path?, order="mtime", limit?)` for recency; `find(pattern, ...)` for plain matching. glob's dialect (`*`, `**`, `?`, `[abc]`) is find's dialect. |
| `find(pattern, path?, limit?)` | `find(pattern, path?, order?, limit?, include_ignored?)`; default limit is now 500 (was 1000), `order` defaults to `"path"` (fd native). |
| `grep(pattern, path?, glob?, ignoreCase?, literal?, context?, limit?)` | `grep(pattern, path?, mode?, glob?, ignore_case?, literal?, context?, limit?, include_ignored?)`. `ignoreCase` renamed `ignore_case`. `mode`: `content` (default) / `files` (rg `-l`) / `count` (rg `-c`). Context now consumed from rg's `--json` stream natively. |
| `workspace_context()` | `context(scope="workspace")` |
| `docs_search(query, limit?, file?)` | `context(scope="docs", query, limit?)`. The `file` filter was dropped (surface simplification); note this in docs. |
| `read_skill(name?, include_tree?)` | `context(scope="skills", name?, include_tree?)`. Listing with no `name`; pending-skill policy, activation details contract, and drift warnings unchanged. |
| `run_task(task, args?, cwd?, timeout_ms?)` | `verify(check=<script>, args?, cwd?, timeout_ms?)`. `verify()` with no args lists declared checks (grouped by source; only package.json today). |
| `validate_frontend(path, browser?, timeout_ms?)` | `verify(check="frontend", path, browser?, timeout_ms?)` |
| `write_plan(content)` | `artifact(kind="plan", content, title?, path?)`; still terminal (`terminate: true`), default path PLAN.md, path override allowed inside the workspace. |
| `write_review(content)` | `artifact(kind="review", content, ...)`; REVIEW.md. NEW: `artifact(kind="report", ...)` writing REPORT.md, also terminal. |
| `create_skill(name, description, body, scope?, overwrite?, allowed_tools?, requires?)` | `artifact(kind="skill", title=<name>, description, content=<body>, scope?, overwrite?, allowed_tools?, requires?)`; NOT terminal. `requires` normalization (`skill:<name>`) preserved. |
| `dispatch(task, agent_id?, ...)` | `dispatch(tasks, mode?, list?, agent?, target?, model?, thinking_level?, cwd?, timeout_ms?, max_output_bytes?)`. `tasks` is an array of strings or `{agent, task, ...}` objects; `prepareArguments` wraps a single object/string and parses JSON-string arrays, and maps a bare top-level `task` into `tasks`. `agent_id` accepted as an alias for `agent` inside items. |
| `dispatch_batch(tasks, ...)` | `dispatch(tasks, mode="parallel")` (default). `mode="sequential"` runs items one at a time. Output is one per-run receipt summary per task (batch shape) even for a single task. |
| (new) | `monitor(run_id?, mode?)` — `list` / `status` (default with run_id) / `peek` (in-process rolling event tail) / `receipt` (stored receipt JSON, 14KB cap). Read class, parallel. |
| (new) | `steer(run_id, action, message?)` — `guide` (dispatch contract's stdin steer; native workers only) / `cancel` (abort; receipt records outcome=canceled). Dispatch class, sequential. |

Details payload changes (consumers: UI, session turns, observers):

- All six OBSERVE tools (read, grep, find, ls, code_nav, context) return
  `details.observation` (`src/tools/observation.ts` `Observation` interface):
  `{tool, unit, shownCount, totalCount|null, shownBytes, totalBytes,
  truncated, format, next?, offloadPath?, budget?}`. The old per-tool shapes
  (`details.truncation`, `details.resultSize` on OBSERVE tools,
  `matchLimitReached`, `entryLimitReached`, `resultLimitReached`,
  `observationBudget`) are gone.
- `find(order="mtime")` additionally returns `details.candidates =
  {cap, collected, capHit, note?}`.
- edit: `details = {diff, firstChangedLine, paths}`; write: `details = {paths}`.
- git and verify script checks: `details = {command, cwd, exitCode,
  durationMs, timedOut, outputCapped}` (the old `{action, command: string[],
  signal, aborted}` fields are gone; `command` is now a joined string).
- verify frontend: `details = {action: "verify", check: "frontend", path,
  browserMode, status, checks}`.
- dispatch: `details = {mode, runIds, receiptCount, failedCount, runs[]}`
  (replaces both the single-run receipt details and the batch `batchId`
  shape; `batchId` is no longer surfaced).
- artifact: `details = {kind, paths}` (plan/review/report) or
  `{kind: "skill", name, scope, path, gitignored, paths}`.
- Envelope no-match outputs standardized: grep `No matches found`, find
  `No files found matching pattern`, ls `(empty directory)`,
  code_nav/context(docs) valid JSON with empty arrays and `next` populated.
- Notice format (all OBSERVE tools, text format):
  `[<tool>: <shown>/<total> <unit> shown (<shownSize> of <totalSize>) | full: <offloadPath> | next: <exact-call>]`
  with unknown segments omitted; `<total>` renders `N+` when the search was
  killed early at the limit. JSON-format tools never get an appended notice;
  oversize JSON is replaced whole by the parseable stub
  `{"error":"result exceeded <cap>","offloadPath":"...","next":"..."}`.
- Turn budget: one pool per `sessionId:turnId` across all six OBSERVE tools,
  default 192KB, env `CLIO_OBSERVATION_TURN_BUDGET_BYTES`. The old
  `CLIO_READ_TURN_OBSERVATION_BUDGET_BYTES` env is deleted.
- Persisted `resultSummary` (chat-loop tool_result turns) gained
  `offloadPath` and the whole `observation` record.

Profiles: minimal-local = read, grep, find, ls, git, context, code_nav;
science-local = minimal-local + verify; full-agent unchanged (everything).

Builtin agent recipes were rewired (glob->find, run_task/validate_frontend->
verify, read_skill/workspace_context->context, write_plan->artifact).

## 2. Broken/obsolete test files

Suite status at handoff: 914 tests, 898 pass, 16 fail (`npm test`). Files
that no longer typecheck (imports of deleted modules/names):

- `tests/contracts/tools.test.ts` — imports deleted `src/tools/glob.js`, the
  removed `READ_TURN_OBSERVATION_BUDGET_ENV`, and `ToolNames.WorkspaceContext`;
  every OBSERVE assertion must move to the envelope shapes.
- `tests/contracts/tool-hardening.test.ts` — imports deleted glob.js and
  `excludeGlobsFor` (replaced by `src/tools/ignore-policy.ts` `rgIgnoreArgs`/
  `fdIgnoreArgs`); `buildFdArgs` signature changed (maxResults +
  includeIgnored params).
- `tests/contracts/docs-search.test.ts` — module moved to
  `src/tools/context/docs-engine.ts`; tool surface is `context(scope="docs")`;
  `file` filter deleted.
- `tests/contracts/skills.test.ts` — `createReadSkillTool` deleted (read half
  lives in `createContextTool`, create half in `createArtifactTool`).
- `tests/contracts/skill-tool-surface.test.ts` — same import;
  `SKILL_SURFACE_EXEMPT_TOOLS` is now `context`/`ask_user`.
- `tests/contracts/chat-loop.test.ts` — imports `createReadSkillTool`.
- `tests/contracts/registry-observers.test.ts` — `ToolNames.ReadSkill` gone;
  the skill-activation observer now filters on `ToolNames.Context`.
- `tests/contracts/prompts.test.ts` — imports deleted
  `src/tools/workspace-context.js`.
- `tests/contracts/slash-spec.test.ts` — command registry snapshot missing
  the new `/export` entry.

Runtime failures in suites that still typecheck (exact failing tests from
the handoff `npm test` run):

- `tests/contracts/agents.test.ts` — "loads recipe metadata into normalized
  agent specs", "requires read_skill when a recipe declares agent-bound
  skills" (rule is now "requires context"), "rejects recipe tools that
  contradict declared capability class" (error string is now "can only
  write terminal artifacts").
- `tests/contracts/dispatch.test.ts` — "contracts/dispatch", "dispatch tool
  activity honesty", "dispatch tool summary surfaces the zero-tool note to
  the calling model", "records validation evidence for a dispatched worker
  that validates after mutating": single-task output is now the per-run
  receipt summary shape (`dispatch (parallel) total=1 failed=0`), args moved
  to `tasks`, `dispatch_batch` is gone, evidence summaries key on
  `verify`/`check`.
- `tests/contracts/safety.test.ts` — "recognizes run_task
  verification-family scripts as finish-contract evidence": the typed
  summary is now `verify`/`check`-based.
- `tests/contracts/registry-observers.test.ts` — "after_tool observer
  registrations", "reports successful read_skill activations with turn
  metadata": observer filters on `ToolNames.Context`.
- `tests/contracts/slash-spec.test.ts` — "locks the v0.2.3 post-sprint
  command registry" and "keeps docs/commands-and-modes.md command table
  aligned with commandReference": the new `/export` entry must land in both
  the snapshot and the docs table.
- Any test asserting old notice strings ("matches limit reached",
  "[Showing lines ...]") needs the envelope notice format above.

## 3. Docs needing rewrites

- `docs/prompt-envelope-and-tools.md` — full rewrite: seven planes, the 18
  registered tools, envelope semantics (notice line, offload, JSON stub,
  turn budget), description tiering, gateway reservation.
- `docs/safety-model.md` — tool/action-class table (verify, artifact,
  context, monitor, steer; removed names), plane invariants in
  `src/tools/policy.ts`.
- `docs/built-in-agents.md` — recipe tool lists changed.
- `docs/extensions-and-sharing.md`, `docs/context-engine.md`,
  `docs/commands-and-modes.md` (mentions /export now; old tool names),
  `docs/evolution.md`, `docs/documentation-guide.md` — mention old names;
  sweep with `grep -rn 'run_task|read_skill|write_plan|write_review|create_skill|docs_search|workspace_context|dispatch_batch|validate_frontend|glob' docs`.
- Bundled skills reference old tool names in their bodies/frontmatter
  allowed-tools: skills/README.md, context-handoff, context-prime, cut-it,
  design-council (+evals), experiment-protocol, grill-me, prd,
  scientific-debugging, workflow-distiller (+evals), credentials. Skills that
  declare `allowed-tools: [read_skill, ...]` will hard-block their own
  workflows until updated (skill narrowing exempts only context/ask_user).
- NEW deep per-tool usage docs to author for `context(scope="docs")`
  retrieval: one section per hot tool (read, edit, write, bash, grep, find,
  ls, dispatch) plus verify/context/code_nav/monitor/steer/artifact recipes.
  Rich usage guidance was deliberately removed from non-hot tool
  descriptions (one sentence each); the docs corpus is its new home.

## 4. CHANGELOG entries to write

- Toolkit v2: seven planes, 17+1 tools; consolidations (find<-glob,
  context<-workspace_context+docs_search+read_skill, verify<-run_task+
  validate_frontend, artifact<-write_plan+write_review+create_skill,
  dispatch<-dispatch_batch); new monitor and steer tools.
- Observation envelope: uniform truncation notice with exact continuation,
  offload-on-truncation to the session scratch dir (closes the offload dead
  zone), always-valid JSON from code_nav/context (closes the mid-document
  truncation corruption), shared 192KB per-turn OBSERVE budget
  (`CLIO_OBSERVATION_TURN_BUDGET_BYTES` replaces
  `CLIO_READ_TURN_OBSERVATION_BUDGET_BYTES`).
- Ignore coherence: grep/find share one policy (.gitignore native, .clio/
  .fallow/.git always excluded, one generated-dirs list, `include_ignored`).
- Spawn hygiene: rg/fd run with allowlisted env, pinned cwd, 30s wall-clock
  timeout, SIGTERM-then-SIGKILL teardown.
- Perf: glob's full-tree sync lstat walk removed; find(order=mtime) stats a
  bounded candidate set; grep context lines come from rg's --json stream.
- TUI: collapsed tool ledger lines (signature, outcome counts, bytes,
  duration, offload path), compact resource reads (SKILL.md/CLIO.md/
  AGENTS.md/docs), live elapsed on running tools, `/export [path]`.
- BREAKING (unreleased, no compat shims): all renames above; details
  payload changes in section 1.

## 5. Benchmarks/evals referencing old tool names

- `benchmarks/clio-model-suite.mjs` — references old tool names in prompts/
  scoring.
- `benchmarks/live/live-turns.mjs` — same.
- `benchmarks/battletest/targets.json` — check task strings.
- `skills/*/evals.md` (design-council, workflow-distiller) — eval scripts
  reference create_skill/read_skill flows; update to artifact/context.

## 6. Deferred items (with rationale)

- **gateway tool**: DESIGN-RESERVED only. Name + contract sketch live as a
  comment in `src/core/tool-names.ts`. Not implemented per the sprint brief
  (schemas never in prompt; find/describe/call results only).
- **steer guide action**: LANDED (not deferred) — the dispatch contract
  already had a stdin steer channel (`DispatchContract.steer`); the tool
  wraps it. Guide only reaches native workers; other runtimes get the
  contract's structured "no input channel" error, which the tool surfaces
  verbatim.
- **monitor peek scope**: the event tail is an in-process ring buffer
  (`src/tools/dispatch.ts` `runEventTail`, 100 events/run, 64 runs) fed by
  the dispatch tool's own event consumption. Runs dispatched by other
  processes (or before this process started) have no tail; monitor says so
  and points at mode=receipt. A durable per-run event log was out of scope
  (dispatch domain architecture kept).
- **read dedup**: deferred entirely per the brief.
- **automatic tier escalation**: rejected consciously; the model escalates
  via `next` hints.
- **docs file filter**: `docs_search`'s `file` argument was dropped in the
  context consolidation; re-add only if docs retrieval shows it is missed.
- **read offload**: read does not offload on truncation (the source file is
  directly re-addressable via `next: offset=N`); grep/find/ls/context offload
  only when the byte cap cut collected content, since a bare item-limit
  continuation is fully covered by `next` and the offload would duplicate
  the body.
- **prepareArguments shims**: landed for edit (pre-existing), dispatch,
  verify, artifact. grep/find/context/monitor/steer have no array/object
  args that need one.

## 7. Live-harness validation checklist (Opus session)

Manual checks mirroring the sprint acceptance criteria, to run in a real
interactive session:

1. Force grep past its cap (`grep pattern="e" path="src" limit=3000`):
   notice ends with `| full: <scratch path> | next: limit=6000`; the scratch
   file exists and holds ALL matches; `read` of that path succeeds.
   (Verified headless at handoff; re-verify interactively.)
2. `code_nav(mode=path, query="zzz")` and `context(scope="docs",
   query="qqq zzz")`: outputs JSON.parse cleanly, empty arrays, `next`
   populated. Repeat with real queries.
3. grep/find agreement: in a repo with a gitignored file, dist/, and
   node_modules/, `grep mode=files` and `find` return the same visibility;
   `include_ignored=true` reveals the same extra paths in both.
4. `find(order="mtime", limit=1)` on a large tree returns quickly;
   `details.candidates` shows the cap; no full-tree stall.
5. Spend >192KB of OBSERVE output in one turn (several 50KB reads): later
   calls shrink, then return the `[observation budget exhausted ...]`
   notice; the notice names the tool and the used/limit sizes.
6. Collapsed ledger line for a finished grep shows signature, match count,
   bytes, duration; truncated calls append `full: <path>`. Toggle expand
   (Ctrl+O) and confirm the full block renders; `/resume` the session and
   confirm the replayed ledger line matches the live one.
7. Compact resource reads: `read` of a SKILL.md / CLIO.md / AGENTS.md /
   docs/ path stays collapsed to one labeled line even when it is the first
   tool of a turn; expand key reveals the body.
8. Running tools show live elapsed (`· 3s`) ticking about once per second
   on a slow bash/dispatch call.
9. `/export` writes `.clio/exports/<sessionId>-<date>.md` with all tool
   segments expanded and no ANSI escapes; `/export /tmp/x.md` honors the
   path.
10. `dispatch(tasks=[...2 items], mode="parallel")` returns per-run receipt
    summaries; `monitor(mode="list")` shows the runs; `monitor(run_id=...,
    mode="receipt")` returns the receipt; `steer(run_id, action="cancel")`
    on a running worker finalizes it with outcome=canceled;
    `steer(action="guide")` on a native worker is acked
    (`clio_steer_received`) and reaches the transcript at the next turn
    boundary.
11. 18 tools registered (`/audit` or worker registry listing); policy drift
    assertion does not fire at boot; `verify()` lists checks;
    `verify(check="typecheck")` runs; `artifact(kind="plan")` terminates
    the turn.
12. Skill flow end-to-end: `/skill:<name>` -> harness nudge names
    `context scope="skills"` -> body loads -> activation recorded in the
    session ledger (observer now keyed on context) -> allowed-tools
    narrowing still blocks out-of-surface calls with the context/ask_user
    exemption message.
