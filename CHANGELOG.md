# Changelog

All notable changes to Clio Coder are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow Semantic Versioning; pre-1.0 minor releases may include incompatible changes.

## 0.3.8 - unreleased

### Changed
- Receipt integrity moves from v19 to v20, covering the new `pathProvenance` field on dispatch intent (#159). Receipts sealed by 0.3.7 fail verification under 0.3.8 and are never read as evidence; they are not migrated, on the same terms as every prior integrity bump.
- Legacy path inference is retained with explicit provenance and confidence, and inferred scope is visible before a supervised dispatch runs (#159). #158 made declared intent authoritative and left the inference path unlabelled, so a receipt recorded which project rules applied but never the path set that selected them: the effect was sealed and the cause was discarded. Dispatch intent moves to version 2 and gains `pathProvenance`, one integrity-sealed entry per policy-bearing path carrying its source, whether the value was declared, derived, or inferred, and a confidence with a deterministic ordering. Receipt integrity moves to v20 to cover it. A receipt records that a path was inferred and from which field, never the sentence it was inferred from, so briefing prose stays out of durable evidence. Declared values always outrank inferred ones and inference never widens a scope a declaration closed; an ambiguous or contradictory inference returns a typed refusal rather than passing as though it had been declared. The approval artifact renders inferred policy-bearing scope in full beside the verification argv it already showed, instead of the bare `intent_sha256` hash.
- Typed dispatch intent is authoritative for policy-bearing scope, and one path grammar governs every containment check (#158). `readRoots`, `relevantPaths`, and `expectedOutputs` shipped in 0.3.7 with no consumer at all: they were normalized, hashed, and sealed into the receipt, and nothing read them back. Worker rule selection ran on a regular expression over the task and briefing prose, authority admission never saw declared write scope so every writer was admitted against the whole working directory, and five separate containment predicates used three incompatible grammars, under which the entry `src/` meant a subtree to the fleet write boundary and an opaque literal to intent normalization. One owner now defines the grammar, repository-relative POSIX paths where a trailing slash means a subtree and its absence means an exact file, and admission, project-rule selection, worker enforcement, delegation-plan validation, and boundary verification all ask it. The grammar is the fleet write boundary's existing one, so a contract valid before this release means exactly what it meant before. When a request carries `intent`, the declared set replaces prose inference for rule selection and authority rather than joining it, and a path the inference would have contributed that the declaration does not carry is reported to the operator as a transcript notice naming the omitted paths and stating that they selected no project rules and expanded no worker authority. A request without `intent` keeps prose inference unchanged. Batch intent now merges field by field, and a `tasks[]` entry that would widen the top-level declaration is refused rather than silently replacing it.
- The fleet write boundary stays post-run by design, and the two request constructors say so (#158). Wiring a fleet step's declared `writes` into `spec.writeRoots` would reach the policy engine's blanket refusal of `bash`, `verify`, and `dispatch` under an active write root, which every fleet step running a command depends on. That refusal is honest because the target check can only prove containment when it is handed a concrete write path; narrowing it to admit a fleet-declared command would claim confinement with no mechanism able to enforce it. Pre-emptive fleet confinement needs a command sandbox and is tracked separately.

### Fixed
- `/council --synthesis vote` asks its members for the verdict it tallies, and produces a real tally (#230). The vote is a strict majority over the final round's structured `verdict` fields, and nothing ever asked a member for one. A council that names no agent seats the builtin `researcher`, whose `research-report` contract accepts `source` and `findings` and nothing else, so a member that emitted a verdict failed its own postcondition and a member that obeyed it emitted no verdict. Every unnamed council's vote resolved to `no_verdict_field` with an empty tally, on every input; the 0.3.7 release test observed exactly this and read it as the specified deterministic behaviour. A vote council now carries a bounded ballot directive on each member's task and seals a new `council-ballot` postcondition, `{"verdict":"...","text":"..."}`, as a per-request override in place of the seated recipe's contract, the same way `reviewer`, the compete `judge`, and the council synthesis already answer the gate that dispatched them rather than their recipe. The seat, the persona, the `shadow` audience, the read-only autonomy, and the `council-read-only` tool profile are all unchanged, and no agent recipe may declare the kind, so a council still runs the agent the operator seated and any recipe can now be voted with. The verdict is bounded to a single line of 64 bytes and lower-cased at the one place a verdict is read, because a tally groups by the exact string and a verdict that is a sentence can only ever tie with itself. A member that seals no conforming ballot spends its ordinary repair rounds and then fails its own run, so a missing verdict is reported as a failed member instead of vanishing from the count. Plan admission composes the same task suffix as the runner, so the approval artifact the plan hash binds shows the ask the member receives. Two things on the override path had to be corrected for it to work at all. A `resultContractOverride` now reaches the worker whether or not the seated recipe declares a contract of its own, matching the resolution the seal has always used; previously the override was sealed but never sent, so the worker spent no repair round on a shape it was never told about. And the worker re-parses its own `WorkerSpec.resultContract` before its first model call through what was the agent-recipe frontmatter parser, which refuses any kind a recipe may not declare, so the first live vote council died with `[worker] fatal: agent recipe: WorkerSpec.resultContract: resultContract.kind is unsupported`; the wire parser is now its own entry point that admits the recipe kinds plus the ones the coordinator authors, and the frontmatter parser stays exactly as strict as it was.
- A fleet's `assignments.json` row reports the fleet's own verdict instead of whichever step settled last (#225). Every step of a fleet dispatches under the same `lineage.rootRunId`, so all of them share one durable assignment row, and `settleStoredAssignment` had no once-only guard where the in-memory registry has one. Each agent step overwrote the status in turn, so a run that aborted at step 2 of 7 and a run whose final code step exited 1 were both recorded `succeeded`. The receipt was not lying: a write-boundary verdict is applied by the scheduler after the receipt seals, so the assignment path never saw it. A fleet run now claims its row at open, files every settled step as an attempt including code steps, and settles the row once from its own whole-run verdict on both the normal and the throwing path; an attempt-path settle against a claimed row records its attempt and cannot write the status. Orphan reconciliation no longer resolves a claimed record to `succeeded` on the strength of one green attempt, which would have turned a crashed fleet into a successful one on the next startup.
- The test harness refuses a `.git` at the system temp root and names whoever tried to make one (#205). A stray empty `/tmp/.git` makes `isInsideGitRepo` report every `mkdtemp` scratch as sitting inside a git repository, which drops `--no-require-git` and fails the ignore-policy contracts from whichever lane happens to run them. The creating test was not identified across 28 full suite runs, live `node:fs` and `node:child_process` instrumentation, and a static sweep, so the guard is the fix instead: an in-process write to `<systemTmp>/.git` or `<runRoot>/.git` throws before the entry exists with the test file and line in the stack, a synchronous spawn that creates one throws with its argv and cwd, an asynchronous one is reported at process exit, and `scripts/shard-tests.mjs` backstops the whole run for a creator outside every lane. The guard never deletes, because a `.git` under the system temp root can belong to somebody else. The run root is guarded alongside the system temp root because the same parent walk passes through it.
- `/council --synthesis judge` runs, seals, and shares as a council (#221). Three defects sat on the default path. Admission refused the whole council before its first member ran, because the persona-override guard counted any non-empty system prompt and the judge carries the coordinator's own `COUNCIL_JUDGE_PROMPT`, while every unnamed council seats the builtin `researcher`, a `shadow` recipe; the ACP delegation path already exempted a bounded gate-role prompt and the two ordinary paths had drifted from it, so all three now share one predicate that stays pinned to one exact prompt text under one gate role and read-only autonomy. The synthesis slot then kept the seated recipe's result contract, so a correct judge answer of `{verdict, text}` sealed a contract failure against `research-report` and burned the configured retries reproducing it; `synthesis` now joins `reviewer` and `judge` as a gate role that answers the coordinator rather than its recipe. And the whole-council-report seal was guarded to vote and none, so `/share <judge synthesis runId>` rendered the bare judge payload with no member answers or roster labels, the exact state the 0.3.7 release test called unusable; judge now seals on the same terms, and the shared block carries every final member's labelled answer plus `[synthesis judge] verdict … · judge run …`.
- The write boundary no longer rolls back a file the step never wrote, and no longer certifies a window it could not observe (#219). Enforcement derived violations from the working-tree diff over a step's window alone, so a file an operator edited in their own editor while a fleet ran was attributed to the step and restored from the baseline commit. A change is now blamed on a window only when it intersects what that window's runs recorded writing, drawn from the same tool-call fold that grounds a sealed mutation report; anything else is reported as an unattributed concurrent change and left exactly as it is. The record is treated as closed only when it can be: a run that made a successful call to a tool whose arguments cannot name what it writes (`bash`, `verify`, `dispatch`, `steer`, or any unregistered or MCP name, derived from the action classifier rather than a hand-written list) files no usable record, and its window keeps the previous behavior of blaming the whole diff. A blocked or failed call leaves the record closed, because it never reached the filesystem. The verdict gains `unattributed` and `attributionComplete` so it says which of the two it did. Separately, a declared write path that git ignores is now refused at `fleet validate`, at `fleet run` preflight, in the `/fleet run` preview, and when a delegation plan splices a step in, naming the path and the ignoring rule: `git status` cannot report an ignored path, so such a boundary could only ever certify an unobserved window as clean. The existing refusal to touch a path that was already dirty when the window opened is unchanged.
- `configure` refuses a model the target does not advertise, and health distinguishes reachable from serving (#220). The command already fetched the server's model list to populate `wireModels`, but validated `--model` against the static provider catalog, which is empty for `lmstudio` and every runtime like it, so `src/cli/validate-model.ts` passed any string and the target saved as `ok`. It now checks the live list where there is one, refuses an unadvertised id while naming the ids the server does list, and takes `--force` to save one anyway. A runtime with neither a catalog nor a live list warns that the id could not be verified rather than implying it was. A loaded LM Studio model is accepted under either its instance id or its model key, since the request path resolves both. `targets --probe` gains a `degraded` health state for a target that answers but cannot serve its own `defaultModel`, judged only from a live list on a runtime with no static catalog so a cloud target can never be misread, and the row prints the reason beside the model. `doctor` reports a configured `defaultModel`, `orchestrator.model`, or `workers.default.model` that the target does not advertise. ACP treats `degraded` as reachable, because a client naming its own model can still use the target. The `README.md` quickstart and the two docs copies stop instructing readers to pass `your-model-id`, which produced a target that saved cleanly and failed on its first turn.
- A version 5 `kind: gate` step that also declares `writes` is refused by name (#217). The gate derives its whole write boundary from `path`, and the refusal now reads `gate step '<id>' must not declare 'writes'; its write boundary is derived from 'path'` instead of `/steps/0: must have required properties scope`, which named a property the author never touched. The check runs before schema validation, alongside the existing version-gate assertions, so `fleet validate`, `fleet run`, and the `/fleet run` approval preview all print it.
- Settings Center number editors report a refused value instead of dropping it (#218). Every number row now resolves its bound from one shared rule table (`budget.sessionCeilingUsd`, `watchdog.cadenceToolCalls`, and the three `delegation.defaults.*Ms` rows), and the editor and the apply path read the same rule, so a value the editor forwards is never dropped later. A refused submission keeps the editor open and prints the reason under the input in the words the config validator would use for the same key (`Not applied: expected an integer >= 1, got 0.`); Esc still leaves without applying, and a corrected value clears the reason and continues to the scope prompt. Three previously silent drops on that path become named refusals: a blank on the three timeout rows used to parse as zero and be discarded, a blank on `budget.sessionCeilingUsd` used to set the ceiling to zero, and a fractional `watchdog.cadenceToolCalls` used to be floored. A contract test pins the row set, so a sixth number row added without a rule fails it.

## 0.3.7 - 2026-08-24

### Added
- Typed dispatch intent and host-run verification (#155). The singular request and every `tasks[]` item accept one `intent` object (`read_roots`, `write_roots`, `relevant_paths`, `expected_outputs`, `verification: [{check, timeout_ms?}]`); `gate: "<check>"` is the one shorthand for a single verification entry. Paths are normalized to sorted, duplicate-free repository-relative POSIX paths with entry and byte caps, and absolute, escaping, or malformed entries fail before approval. A `check` is a declared id resolved through the verify tool's `DeclaredCheck` projection (package scripts and `.clio-coder/verifiers.yaml`) at admission, so model text never becomes argv; the resolved argv, cwd, and timeout are frozen into the execution snapshot and the plan hash, and the approval artifact renders them. After a successful worker attempt the orchestrator runs each check through the code-step runner with no shell and the closed environment allowlist, memoizes successful evidence on the workspace fingerprint plus argv, cwd, and allowlisted environment values, and seals `hostVerification` (`verified`, `rejected`, or `skipped` with per-check argv, exit code, duration, bounded output tail, memo provenance, and artifact path) into the receipt. A rejected check turns the run into `host_verification_rejected`, which suppresses automatic retry. Review and compete accept the intent paths but refuse verification entries, as does the Claude Code subprocess runtime, each with a named reason. The receipt seals `intent` on the native worker path and the Claude Code and ACP delegation paths alike. Receipt integrity moves to v16 and covers `intent` and `hostVerification`; the existing `verification` evidence object keeps its name. Dispatch output, `monitor`, and the Fleet Runs card render `host_verification=<status>` beside `evidence_verification`.
- `/btw <question>` asks one side question beside the session (refs #41). The round sends the compiled message history as read-only input under a short fixed instruction with no tools, streams the answer into an overlay, and appends nothing to the session JSONL, the transcript, the context ledger, or the task board, so a fleet run's workers are never briefed from it. Esc cancels a streaming round; a `/btw` during an in-flight turn is refused rather than queued. The round's usage is counted in `/cost` under a `side questions` row and is excluded from the turn count.
- Opt-in desktop notifications (#204). `terminal.notify: true` emits one content-free terminal notification when a turn ends, when a detached batch settles, and when a worker permission or `ask_user` request parks. The title is fixed, the body comes from a closed vocabulary, control characters are stripped, and the body is bounded to 128 bytes. OSC 777 is the default and OSC 9 is used on iTerm2, Windows Terminal, and ConEmu, never both for one event. Headless, ACP, and non-TTY runs never emit one.
- Single-writer token, checkout writer lease, and worktree-per-task (#207). `writers: 1` on a parallel dispatch or an ExecutionPlan admits at most one write-scope step at a time in declared order while read-scope steps stay concurrent; the agent ledger's claims remain advisory. The first checkout writer takes a lease under the state dir keyed by the canonical checkout path and carrying pid, process birth token, and acquisition time; a live sibling process is refused with `checkout_writer_lease_held` naming the holder pid, and a dead owner is reclaimed. `worktree: true` with `apply: "merge"` (default) or `"preserve"` runs a writer task on `clio/task/<runId>` under `.clio-coder/worktrees/<runId>/`, maps the worker cwd, write roots, and protected artifacts into it, and runs declared host verification there before merging; a conflict fails closed as `worktree_merge_conflict` and preserves the branch, and a protected-path change fails closed. The receipt gains `worktree: {path, branch, diffHash, apply, applied, reason?}`, receipt integrity moves to v17, and the approval artifact renders worktree, apply, and the frozen merge destination. Non-git checkouts, read-only agents, compete mode, and a cwd outside the checkout are refused with named reasons.
- Fleet authoring CLI (#209). `clio-coder fleet new <name> --from <builtin>` copies `build-review`, `build-test`, or `sdlc` into `.clio-coder/fleets/` and refuses an existing destination, an unsafe stem, or an unknown builtin. `fleet validate <name> [--json]` runs the same preflight `fleet run` performs (parse, graph, command bindings, agent resolution, plan compile, write-boundary preflight) with no state-dir write, ledger row, reservation, or worker. `fleet graph <name> [--json]` prints the compiled waves with each step's kind, agent or command, scope, dependencies, and write boundary, and expands loop check and repair nodes. `fleet commands init` discovers package scripts, justfile recipes, Makefile targets, and pyproject script and tool entries through the verifier discovery and writes a fully commented `commands.yaml` draft; uncommenting confirms an entry and an existing registry is never replaced. `fleet run <name> --resume <runId>` replays the successful, integrity-valid prefix recorded in a durable fleet-run record under the state dir, reports replayed steps with their original receipt references, refuses a changed plan hash with a per-step diff, and refuses differing `--var` values. The existing `fleet resume` admission-control subcommand is unchanged.
- `/fleet run <name> [--var k=v ...]` previews a fleet contract before anything dispatches (#208). The route preflight sends each step's compiled task, so a contract that validates from the CLI previews from the TUI, and a `--var` value may be quoted to carry spaces (`--var task="add a pow function"`). The approval overlay lists the steps by wave with kind, agent and resolved target (or command id and the exact argv from `commands.yaml`), scope, and declared write boundary, then the budget ceiling the run is admitted under; a contract that fails preflight opens the same overlay with its diagnostics and no accept key. Enter dispatches through one shared fleet-run path in the dispatch domain (`executeFleetRun`) so admission, autonomy, receipts, gate decisions, write-boundary enforcement, and the durable ledger are identical to `clio-coder fleet run`; Esc dispatches nothing and writes nothing. `clio-coder fleet run` runs through that same path and both surfaces write the durable fleet-run record, so a run started from the TUI can be resumed with `fleet run --resume`. The Fleet Runs board gains a phase column (`w<n> <stepId>`) on rows a fleet plan dispatched, empty on every other row; the compact island keeps its fixed width and shows the column only when the agent label still fits. `/fleet` alone still opens Settings → Fleet, and `/fleet run` during an in-flight turn is refused rather than queued.
- `/handoff <goal>` carries a session's working state into a fresh session (#206). The goal is required and gated: under 12 characters, or a non-goal such as "continue" or "resume", is refused with the rule named. One out-of-turn model round with no tools extracts decisions, facts, files, commands, and open questions as JSON against a fixed schema; every list and string is bounded, and over-bound output is truncated with a visible marker rather than refused. Every file path is checked against the session's own read ledger (folded through the active `/tree` path) and never against the filesystem, so a path the session never touched is dropped and listed under `dropped (not in this session's read ledger)`. Extracted decisions merge with the settled decision board, which wins. The document opens for review with `e` for `$EDITOR`; Esc cancels with nothing written. On accept Clio mints a session, seeds it with the reviewed document as data labelled by its origin session, replays the old session's skill activations, and leaves the old session untouched apart from one terminal note naming the target. A handoff never writes a memory promotion candidate and never calls the task-memory bank. Its usage is counted in `/cost` under a `handoffs` row and excluded from the turn count.
- `/oracle <question>` and the `oracle` shadow advisor (#210). The recipe is read-only, unreachable from `/run`, and never receives a forked transcript: `/oracle` packs a bounded digest as dispatch briefing data (settled decisions from the decision board, open tasks from the task board, the last compaction summary when one exists, and the question), capped at 12 KiB with per-section caps and a truncation marker and filtered to the active `/tree` branch. The run is a singular read-only internal dispatch through the ordinary path, so admission, receipts, and the Fleet Runs island apply; its `oracle-report` contract carries a verdict, the strongest challenge, what would change its mind, and the decisions it cited, and the rendered answer reaches the main agent as an operator note the way `/share` does. `/oracle` during an in-flight turn is refused rather than queued.
- Opt-in turn-end watchdog (#210). `watchdog: {enabled: false, target?, cadenceToolCalls?}` is hot reloaded. With `enabled: true`, a turn that changed the tree is reviewed by one read-only `verifier` dispatch briefed with the turn's coalesced diff (per-path last-write-wins, bounded to 12 KiB) and the task board's current scope; its failed checks become one transcript notice naming the count and the first three, a passing report emits nothing, and a turn with no file mutations never fires. `watchdog.target` routes the run at a cheap local model; `cadenceToolCalls: N` also fires it every N tool calls inside a turn. At most one watchdog run is in flight at a time and an overlapping trigger is dropped and counted. It never auto-follows, never queues a turn, and never mutates. Headless and ACP runs never fire it.
- Durable out-of-turn usage and Settings Center rows for notifications and the watchdog (#211, refs #41, #204, #206, #210). A `/btw` side question or a `/handoff` extraction round appends nothing to the session JSONL by contract, so the spend now goes to its own store at `<stateDir>/usage/out-of-turn.jsonl`: one JSON line per priced call carrying the label, session id, the repo identity the session ledger is filed under, timestamp, target, attributed model id, and provider usage, written with one append per row and kept as a bounded ring of 1000 rows rewritten atomically under the state-file lock. `clio-coder usage report` folds that store beside the session ledgers into the window's tokens, cost, and per-model totals, and prints `turns`, `side questions`, and `handoffs` counts on both the text and `--json` surfaces, subtracting labelled calls from the turn count exactly as `/cost` does; an archive with no labelled call renders byte-identical to before. `terminal.notify` gains a boolean row under EXPERIENCE › Terminal, and `watchdog.enabled`, `watchdog.target`, and `watchdog.cadenceToolCalls` gain rows under a new EXPERIENCE › Watchdog section. The two optional keys render their absence as `(session target)` and `(turn end only)` while their editors open on the stored value or empty, never on that prose; submitting an empty value removes the key from `settings.yaml` rather than storing a blank, and a cadence below one is refused with the bound named, matching the config validator. Settings Center wording is pinned word for word to the settings template where it overlaps.
- `mode: "council"`, the read-only sibling of compete (#212). Two to five members run the same singular task concurrently on local and HTTP targets with no mutation. Members come from a configured `workers.rosters.<name>.members[]` roster (`{label, target, model?, thinking?, color?}`, validated at config load for two to five members, unique labels matching `[a-z][a-z0-9_-]{0,31}`, theme color tokens or six-digit hex, no unknown keys, hot reloaded) or from inline `members`; exactly one of `roster` or `members` is accepted. `synthesis: none | judge | vote` (default `none`), `rounds: 1..3` (default `1`), and `judge` only with judge synthesis. Refusals are typed: `council_roster_unknown`, `council_members_out_of_range`, `council_member_label_duplicate`, `council_member_target_unknown`, `council_member_remote_node` (a route that resolves to an SSH fleet node is refused before approval), `council_synthesis_requires_judge_settings`, and `council_verification_unsupported`. A council request that names no `agent` seats the builtin `researcher` rather than the dispatch default `coder`, whose write requirement the council profile cannot satisfy. Admission pins every member and the judge to `read-only` autonomy and an internal `council-read-only` tool profile holding exactly `read`, `grep`, `find`, `ls`, `code_nav`, and `context`, enforced through ordinary worker admission rather than prompt text. The resolved plan expands every member in every round plus the judge, so the approval artifact lists each member's label, target, model, thinking, node, color, round, and synthesis, and the plan hash binds all of it. Round one gives every member the same task and briefing; each later round gives a member the other members' prior answers as labelled untrusted briefing data (never its own), bounded to 8 KiB with a truncation marker, with a failed peer marked rather than quoted. `vote` computes a deterministic strict majority over the final round's structured `verdict` fields with no model call and reports `no_verdict_field` or `no_majority` when it cannot; `judge` runs one read-only judge under a fixed prompt with every final answer as labelled briefing. The dispatch result carries one section per member and one synthesis section, `details.council` holds the typed `council-report` (`{members: [{label, runId, round, answer, verdict?, failed?}], synthesis: {kind, text?, verdict?, tally?, judgeRunId?}}`), and the result is an error only when a final-round member or the judge failed. Every member run seals its own receipt; `none` and `vote` seal one coordinator-only zero-token synthesis receipt that carries no member provenance and publish its enqueued and completed lifecycle events so the Fleet Runs board and `/share` see it, and the judge receipt is the synthesis receipt in judge mode, each pointing backward at every final member run through gate provenance. `monitor` reports the council role and group, the Fleet Runs board projection carries `council: {group, label, color?, round}` for a later grid, and receipt integrity moves to v18 with the `council` field. The grid and `/council` are a separate change.
- Council rendering and `/council` (#213). The `Alt+W` Fleet Runs board folds a council group into one card in the position of its first row: a side-by-side grid with one column per member while every column keeps at least 34 cells, otherwise the whole group stacks, because a grid where only some columns are readable is worse than none. Each column shows the member label in its roster color (a theme token paints as that token, `#rrggbb` paints literally through the xterm cube without truecolor, anything else takes the accent), the target and model, the round and status, and up to four rows of the run's bounded answer tail; a council that ran several rounds keeps one column per member at its newest round, and the synthesis run renders full width under the members. The compact island shows one card per council naming the group, member count, and round. `/council [--roster <name>] [--rounds <n>] [--synthesis judge|vote|none] <task>` owns no dispatch path of its own: it builds dispatch-tool arguments spelled exactly as the tool declares them and admits them through the tool registry, so supervised autonomy parks the same approval overlay a model-asked council would. `--roster` falls back to `workers.rosters.default`; with neither the command refuses and names the setting rather than guessing from the only roster present. Rounds and synthesis bounds are enforced where the operator typed them, and a `/council` during an in-flight turn is refused rather than queued. `/share <synthesis runId>` brings every final-round member's labelled answer and the synthesis line (mode, verdict, tally, judge run) into the main context as one bounded prose block, never the raw payload; `/share <member runId>` labels that member's answer with its roster label; a synthesis whose sealed text does not parse is shared verbatim.
- Fleet contract v5: `kind: plan`, `kind: gate`, per-step target or profile, and top-level `writers` (#214). Version literal `5` joins the contract; readers of 1 to 4 refuse `plan`, `gate`, `target`, `profile`, and `writers` by name, exactly as they refuse `writes` below 4, and ExecutionPlan versioning is unchanged. An agent step, a loop check agent, or a loop repair agent may declare `target: <targetId>` or `profile: <workers.profiles key>` (never both); resolution shares the `/run --target` and `/run --agent-profile` request fields, and an unknown id refuses at preflight naming it, in `fleet validate`, `fleet run`, and the `/fleet run` preview, which now reports a route the process cannot resolve as a named diagnostic instead of rendering `route unresolved`. A `kind: gate` step names a validator agent, one repository-relative `path` that becomes its whole derived write boundary (a separate `writes` is refused), and a `run` command whose argv carries the gate path as the single whole-token `{{path}}` substitution; after the author settles, the coordinator runs the command with no shell against the untouched tree and requires red, a green baseline fails the step as `gate_not_discriminating`, the receipt seals `fleetGate: {path, pathHash}`, and a loop may use `check: {kind: gate, gate: <id>}`, in which case only verbatim `FAIL` lines from the check reach the repair agent. A `kind: plan` step (agent defaults to the builtin `architect`) declares `roster`, `maxTasks: 1..16`, optional `proposals: true`, its own scope and `writes`, and an optional route default; the architect returns a `delegation-plan` result contract (`{tasks: [{id, agent, description, depends_on, writes, mode?}]}`) that a pure validator checks for roster membership, task count, unique ids, resolvable acyclic dependencies, and writes inside the plan step's boundary, each failure a named `delegation_plan_*` reason that fails the step and splices nothing. `delegation-plan` is an admitted worker result contract, so the architect step reaches the model. On success the coordinator records the deterministic plan hash on the durable fleet run record and the scheduler splices the tasks into the live plan after the wave settles: every spliced task passes the same preflight, reservation, admission group, writer-token grouping, post-step write-boundary enforcement, and durable settlement record as a static step, depends on the plan step plus its declared dependencies, inherits the plan step's target or profile, and seals lineage to the plan step's run. `proposals: true` first runs every roster member read-only with the same task and hands the architect their `PROPOSAL <agent>` sections as briefing bounded to 12,000 bytes. `fleet graph` names a gate or plan step by its contract kind with the gate path and run command or the roster and `maxTasks`, and a step whose receipt succeeded but whose gate baseline or delegation plan failed settles as failed with `reason=<name>` in `fleet run` output and the `/fleet run` notice. The approval artifact renders target or profile, gate path, run command, and baseline command, and plan roster, maxTasks, and proposals; `fleet run --resume` replays the static prefix up to the first plan step and reruns it rather than reconstructing prior dynamic tasks. Receipt integrity moves to v19 with the `fleetGate` field.
- Resource library (#215). The marketplace index machinery that carries skills now carries agent recipes, prompt templates, and fleet contracts. Every index entry accepts `kind: skill | agent | prompt | fleet` (default `skill`, so every existing index parses unchanged) and optional typed `requires: [skill:x, agent:y, prompt:p, fleet:z]`, resolved recursively across the selected catalog and the private catalog; a missing, malformed, or cyclic requirement refuses the entry with `library_requirement_missing`, `library_requirement_malformed`, or `library_requirement_cycle` naming the chain. `clio-coder library list|search [--kind k] [--json]`, `library add <ref> [--from <catalog|path>] [--with-requirements] [--yes]`, `library use <kind> <name>`, `library sync`, `library push`, and `library remote confirm <url>` land as one literal dynamic import. `add` resolves requirements against the pin store and the destination path, lists satisfied ones separately, refuses on unsatisfied ones unless `--with-requirements` installs them first in dependency order, prints every destination and SHA-256 before writing, and writes nothing without `--yes`. An agent installs to `<configDir>/agents/<name>.md` after the recipe schema and policy checks, a prompt to `<configDir>/prompts/<name>.md` after the prompt loader, a fleet to a new user fleet root `<configDir>/fleets/<name>.md` after `parseFleetContract` (precedence is builtin, then user, then project), and a skill through the existing installer; every install is pinned by typed ref and hash in `<configDir>/library-pins.yaml` through the safe resource write. A private catalog at `library.catalog` (default `<configDir>/library.yaml`) overlays same-ref marketplace entries and resolves relative sources beside itself. Git-backed sync is opt-in: `library.sync: false` (the default) refuses `sync` and `push` with `library_sync_disabled` before any process spawns; with it on, the repository's remote must be named `library` and match a confirmed URL (`library remote confirm`, which refuses `library_remote_mismatch` when it differs from `library.remote`), `sync` runs `git fetch library` then `git merge --ff-only FETCH_HEAD`, and `push` runs `git push library`, each an argv vector with no shell. Share archives gain `agent` and `fleet` entry types (`share export --agents --fleets`, included in `--all`), imported into the user roots after the same validation. The Skills Hub keeps rendering skills only; its kind tabs are a separate change.
- Skills Hub kind tabs and `/library` (#216). The hub carries one tab per resource library kind (Skills, Agents, Prompts, Fleets), switched with `←`/`→`, the key vocabulary the Settings Center already uses to move between sections; the frame title names the active tab and the footer states its row count. The Skills tab is unchanged. The other three list their kind from the same `discoverLibrary()` the CLI's `library list --kind` reads, with origin, version, installed or available, the short pin hash, and the names of any unresolved requirements in the warning token; a catalog entry the library refuses appears as a diagnostic row rather than being omitted. `i` installs through the same classify, plan, and write sequence `library add` runs, behind a framed confirmation that states every destination and SHA-256 and writes nothing on Esc; an entry with unresolved requirements is refused by name on the first `i`, and a second `i` opens the install-with-requirements confirmation naming every entry it would write in dependency order. `Enter` on an installed row inserts `/run <agent> ` for an agent, the `/<id> ` invocation for a prompt, `/skill <name> ` for a skill, and for a fleet closes the hub and opens the `/fleet run` approval preview; a row that is not installed says so and points at `i`. `/library [kind]` opens the hub on that tab and `/library` alone on Skills, where `/skill` still opens. Tab support lives in the shared list overlay, so untabbed overlays are unchanged.
### Changed
- `clio-coder fleet run` now executes through the same `executeFleetRun` path as `/fleet run`, so admission, autonomy, receipts, gate decisions, write-boundary enforcement, and the durable fleet-run record under `<stateDir>/fleet-runs/<runId>.json` are identical from both surfaces, and a run started from either can be resumed with `fleet run --resume` (#208, #209). The `fleet resume` admission-control subcommand is unchanged.
- Fleet contracts resolve from three roots with fixed precedence: builtin, then the new user root `<configDir>/fleets/`, then the project's `.clio-coder/fleets/` (#215). A project contract still shadows a user one of the same name.
- `share export --all` now includes agent recipes and fleet contracts beside the existing entry types, and `share import` validates them through the recipe schema and `parseFleetContract` before writing (#215). Archives without those entry types import unchanged.
- The `/fleet run` approval preview reports a step route the process cannot resolve as a named preflight diagnostic instead of rendering `route unresolved` (#214).
- `clio-coder usage report` prints `turns`, `side questions`, and `handoffs` counts on the text and `--json` surfaces (#211). An archive with no labelled out-of-turn call reports zero side questions and handoffs and the same tokens, cost, and per-model totals as before.
- Receipt integrity moves from v15 to v19 across this release: v16 adds `intent` and `hostVerification` (#155), v17 adds `worktree` (#207), v18 adds `council` (#212), and v19 adds `fleetGate` (#214). Receipts sealed by 0.3.6 fail verification under 0.3.7 and are never read as evidence; they are not migrated.
- `clio-coder --help` lists `library` beside `skills`.
- The `/fleet run` approval, `/handoff` review, and Skills Hub install confirmation overlays match Enter, Esc, and the arrows by key name rather than raw bytes, so they answer under the kitty keyboard protocol, where Esc arrives as `CSI 27 u`, and ignore key-release events.

## 0.3.6 - 2026-08-23

0.3.5 was published by mistake and withdrawn; its content ships here.

### Added
- `docs/middleware-and-components.md` documents every built-in middleware registration: id, hooks, trigger, and what does not trigger it.
- Permission and `ask_user` dialogs now derive closed consequence tiers from typed request, scope, reversibility, origin, exposure, and authority facts (#169). Conversational answers, workspace authority, outward consequences, safety-net confirmations, system changes, and worker escalations receive distinct titles and semantic tokens, while caller prose cannot lower a tier or alter the underlying decision protocol.
- Typed invocation-level dispatch budget envelopes (#175). Recipes keep an exact default unless they author a maximum, dispatch can request a phase and preauthorize a retry, result-contract revision, or review revision ceiling inside both recipe and operator policy, and immutable policy, request, effective, clamp, and escalation facts are sealed into receipts and shown by monitor, fleet status, and the live fleet card. Architect retains its 32-call default and now permits explicitly admitted runs up to its authored maximum.
- The `Alt+W` Fleet Runs board shows live worker progress on operator request (#168). `Enter` opens the selected run's detail: the phase, the running call as `<tool> <verb> <object>`, and the bounded tail of the worker's own prose with a `/view dispatch:<runId>` link to the rest. The default list stays compact, so a fan-out of scouts costs one card each until an operator opens one.
- Reviewed task-memory promotion in `/memory` and `clio-coder memory promote` (#176). Selected knowledge and procedural entries can become unapproved durable proposals with explicit validated repo, global, runtime, or agent scope. Promotion redacts before persistence, preserves session and evidence provenance, and keeps private status excluded.

### Changed
- Python and Cargo project metadata, bootstrap guidance, and verifier discovery now parse TOML through one shared `smol-toml` boundary with an operation-scoped file cache (#153). Parsed structure replaces table-header scanning, and malformed documents fail closed.
- The Fleet Runs board and the transcript's worker block now read one bounded projection of the dispatch event stream instead of folding it separately, so the two surfaces cannot disagree about what a worker is saying or touching. The projection keeps 40 lines and 4096 bytes of answer tail, 8 distinct tool names, and 4 recent actions, and accepts 16 KB of streamed bytes per 250 ms; what the bounds refuse is counted and named rather than dropped silently.
- Worker tool activity now carries a redacted action descriptor beside the tool name. The descriptor is composed where the arguments are trusted (the tool registry's admission path, the Claude tool mapper, and the ACP update mapper) from a fixed verb vocabulary and a fixed argument-field allowlist, with credentials scrubbed, escape sequences stripped, and the result bounded to 64 characters. Raw argument objects still never cross the worker stdout seam, and reasoning content is still never displayed.

### Fixed
- Approval overlays now derive call targets from a per-tool field allowlist. Unlisted arguments are shown only by field name, type, and size, so an unexpected credential or pasted document cannot be copied into the rendered frame (#200).
- Worker tool starts and finishes now share a call id when their producer has one. The transcript and Fleet Runs pair concurrent calls by that id, while older streams without ids continue to match by tool name (#201).
- Proactive task memory now reuses deterministic tool-result disposition digests with explicit source provenance (#173). Operation fingerprints remain separate for loop and repeated-failure identity, while redaction and byte caps apply before diagnostics reach the task bank or background policy.
- The llama.cpp router's `sleeping` state now reads as not resident (#192), and `clio-coder targets` reports `resident: none` while preserving the reported context-slot metadata.
- Response model-id presence is now an explicit `responseModelIdObservation` state (#193, #202). The short-lived `servedModel` and `servedCalls` names are replaced by requested and attributed model ids plus counts named for each observation state. Pre-#193 ledgers remain readable under the labeled `legacy-difference-only` state, and providers outside the stream tap retain the `responseModel` fallback without implying that presence was observed.
- The selected live model's capability probe now starts at boot (#195), so the first `/context` view and footer show the probed context window before any model turn.
- The permission dialog now anchors above the composer (#194) and recomputes that placement when the terminal resizes.
- Permission dialog clearance now comes from the live editor and footer render heights on every frame instead of a fixed five-row margin. Empty and multiline composers remain unobscured in both terminal modes, including after a resize (#194).
- Tool-result offload scratch files older than fourteen days are now swept at boot (#196). A resumed transcript now says when the retention sweep removed the file instead of presenting its stale path as a live full-output pointer (#203).
- A skill suggestion no longer costs the first turn on local models (#184). Every surface that teaches the protocol (the first-turn reminder, the `context(scope="skills")` listing footer, and the operator-gate denial) now says to open with the `Suggested skill:` line and continue the task in the same turn; none instructs the model to wait. A turn that makes the suggestion and stops with only listing calls behind it is continued once with a reminder that only the operator loads a skill.
- Three envelope noise sources on local targets are gone (#191). An always-on reasoning model printed the thinking clamp three ways (`thinking medium resolved to forced`, `medium was ignored because thinking is always on`, and the combined line); only the combined line prints now, once per target, model, and level change. A workspace with no `CLIO-CODER.md` states `<handbook>none …</handbook>` where the handbook would have been injected, so the model stops spending its first tool call on a read that returns ENOENT. `clio-coder --resume` and `--continue` still fail closed, and the error now says that sessions are resumed from the `/resume` picker inside the app.
- A turn is attributed to the reported response model id under LM Link peer routing (#185, #202). The response's `model` field is recorded as `responseModel` when it differs from the request. The footer, `/cost`, `clio-coder usage report`, and dispatch receipts use the shared requested model id, attributed model id, and response model id observation vocabulary. The LM Link peer warning is emitted once per distinct fact instead of once per turn.
- The `/resume` picker previews the operator's first prompt (#188). The first user entry of a session is the composed prompt, with the `<system-reminder>` block and any `[Skill request]` preamble ahead of the operator's words, so every row read `<system-reminder> [Skills] 9 installed…` and the filter matched them all. The preview is now the persisted `operatorText`, the scaffolding-stripped text for older sessions, the next turn when the first carries no operator words, and the first assistant text when none does.
- The context ledger is populated right after `/resume` (#189). Before the first new turn of a process, `/context` and the footer meter now read the window from the live target resolution (falling back to the window the resumed session recorded) and the token facts from the session's last persisted snapshot, which measured the same messages; the selected model's live capability probe runs at resume so the window is the probed one. `context window unknown · 0 tokens` is reserved for a session with no target and no history.
- `/context` names the configured working-set policy instead of the last applied one (#190). A fresh session at the shipped default reads `policy structural-v1 · no events yet` rather than `policy none`; `context.workingSet.enabled: false` reads `disabled`; a policy changed after an event shows `(last event by <policy>)`. The eviction trigger stays at `compaction.threshold`: the replay tables price each event by the cold prefix it re-prefills, and batching from the threshold down to the target is what keeps the event count down.
- A llama.cpp context window is the per-request share, not the server total (#187). `--ctx-size` is split evenly across `--parallel` slots unless `--kv-unified`, so a router started with `--ctx-size 786432 --parallel 4 --no-kv-unified` now resolves to a 196,608-token window instead of 786,432, which is where autocompact was armed at a size the server would never admit. The probe reads the long and short flag spellings and the last kv flag given, `/context` prints `196,608 (786,432 / 4 slots)` with `probed window`, and `clio-coder targets` names the split in its `ctx` note and a probe note.
- A parked permission request always offers allow, deny, and stop (#186). The composer rail switches to `CONFIRM` and carries the dialog's keys while a prompt owns the keyboard, so the `Enter send` hint can no longer contradict a dialog that sits forty rows away on a tall terminal. `Enter` allows only from an empty composer: with a draft present the habitual send key is inert, both surfaces read `[Backspace] clear draft` in its place, and only deletion keys reach the editor. `Esc` is labeled `deny`, which is what it does. A request that parks while another overlay holds the screen is re-presented as soon as that overlay closes.

## 0.3.4 - 2026-08-22

### Added
- A typed project verifier catalog at `.clio-coder/verifiers.yaml` (#170). Each check declares a stable id, description, exact argv vector, repository-relative cwd, bounded timeout, and tags. `verify()` lists package scripts and catalog checks through one `DeclaredCheck` projection, and `verify(check=<id>)` runs the admitted argv through safe-exec with no shell, no model-text interpolation, and no widening of workspace authority. Shell strings, escaping cwds, duplicate ids, unknown fields, unsupported versions, and over-cap values fail closed with diagnostics that name the field and the cap.
- Guided verifier authoring through `clio-coder verifiers discover|author|validate|dry-run|add|edit|rename|remove` (#174). Discovery recognizes package scripts, Cargo manifests, CMake presets, declared Python runners, Go modules, and existing validation-contract commands with source provenance, and proposes argv vectors labeled project-declared or toolchain-defined. Every preview shows path, cwd, timeout, tags, and effective execution authority; nothing is written or executed before `--yes`, validation uses the production catalog parser, and dry runs use the production verify path. Projects with no declared command get an explicit manual-entry path instead of a guessed command.
- One canonical tool-result disposition contract with independent presentation and model-context axes (#165). A tool declares how the operator sees a result and, separately, whether the model receives full content, a bounded excerpt, a deterministic code-produced summary, or metadata only. Typed result metadata records captured, displayed, and context byte counts, the requested versus applied mode, truncation, the offload path, and summary provenance. Exit status, error state, safety facts, and retrieval instructions survive every context mode.
- Canonical Bash output dispositions with a tail-biased bounded default, deterministic redacted diagnostic summaries, metadata-only retrieval, budget-admitted full context, and explicit byte and termination facts (#172). `output_policy` is optional on the Bash tool; omitting it preserves the previous tail behavior.
- A six-axis canonical trust status for runs (#154): artifact integrity, validation grounding, independent review, context provenance, autonomy enforcement, and completion evidence, each with explicit `absent`, `unknown`, and `not_applicable` states and a named source and authority. Composition never promotes one axis from another; the no-promotion rules are enforced at the adapters and the evidence composition boundary. Evidence bundles gain `trust-status.json`.
- Non-destructive working-set eviction. When context pressure crosses `compaction.threshold`, Clio now records which tool-result bodies and closed-turn thinking blocks leave the model's working set instead of rewriting them out of the session. The bodies stay in the ledger, the transcript keeps showing them, and each one is replaced in model replay by a one-line marker naming the ref, the reason, the size, and the exact call that brings it back.
- Exact recall by ref. The model reads an evicted body back with `context(scope="recall", ref="<turnId>")`; the operator reads one into the transcript with `/context recall <ref>`, which never enters model context. A recall does not un-evict: the marker stays byte-identical so the provider prefix cache is untouched, and repeated recalls of one ref are the churn signal.
- Two eviction policies. `structural-v1` is the default: it selects by what the session did since (`stale_after_mutation`, `superseded_read`, `failure_resolved`, `listing_consumed`, `thinking_turn_closed`) and falls back to age only under pressure. `age-horizon` reproduces the previous age-based selection, minus results whose body is below `context.workingSet.minEvictableTokens`. Replayed over the seeded procedural corpora with the summary stage modeled, `structural-v1` cuts the number of lossy summary compactions per 300-turn science trace from 21.5 to 8.8 at a 64k budget and from 8.9 to 3.1 at 128k, retains at or above `age-horizon` at every budget, and beats random eviction on precision by 2.3x or more.
- `/context` reports the working set: policy, evicted items, evicted tokens, events, recalls, and churn. Evicted tool rows carry a dim `evicted · <reason>` tag in the transcript.
- Cache-honesty attribution for eviction. An applied event stamps `working_set_evict` on the next assistant entry's `promptCache.expectedColdReasons`, and `/context` reports `last cold turn: working-set eviction (expected)` instead of warning about a cold backend it caused itself.
- `clio-coder context replay --sessions <path>...` replays Clio ledgers, and `--synthetic <ids>` replays seeded procedural science-coding corpora (`science-long`, `refactor`, `exploration`), through the live eviction code with `none`, `random`, and `oracle` controls and reports retention, precision, tokens evicted, recall tokens, cold prefix tokens, saturation, turns to first summary, and summaries per trace under a modeled summary stage; `clio-coder context working-set --session <id|path>` prints one session's working-set fold and path index. The procedural corpora replace the private Claude Code transcripts the first tables were built on; generated replay tables are local artifacts rather than versioned benchmark results.
- New guide: `docs/context-working-set.md`.

### Changed
- Tool offload files are content-addressed: `<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt` instead of the tool call id or a timestamp, so identical captures share one file and the `retrieve=` header, the eviction marker, and the resume transcript carry the same bytes every time.
- Editing an existing `.clio-coder/verifiers.yaml` through `clio-coder verifiers add|edit|rename|remove` now mutates the operator's file in place: comments and on-disk order survive, only changed fields move, and a revision that changes nothing writes the file back byte for byte.
- Evidence rows, the latest gate decision and finish contract, and the verifier catalog order by code point instead of locale collation, so two machines rebuild the same bundle in the same order.
- Receipt inspection, evidence bundles, monitor output, and worker evidence derive their trust facts from one canonical derivation (#157). The public `evidence_verification=<state>/<basis>` token is unchanged. An integrity-failed receipt now renders `receipt_integrity=FAILED reason=…` and labels its claims `worker claims (unverified prose)` in both dispatch and monitor output.
- Session format version 4. The bump is additive: it adds the `contextEviction` and `contextRecall` records and changes no existing entry, so a version 3 session migrates to 4 in place on open with nothing rewritten. Only a session written by a newer build is refused. The bump is one-way for the operator, and a 0.3.3 binary cannot open a session this release wrote.
- New settings under `context.workingSet`: `enabled` (default `true`), `policy` (default `structural-v1`), `target` (default `0.6`), `protectLastTurns` (default `6`), and `minEvictableTokens` (default `200`). `compaction.excludeLastTurns` now governs only the legacy mask path.
- Compaction reports a `working_set` stage on `ContextPruned`, and the middleware `on_compaction` hook gains the `working_set_evict` and `working_set_recall` stages.

### Removed
- The Claude Code transcript loader for `context replay` and its `--format` flag. Replay inputs are Clio ledgers and the seeded procedural corpora.
- `TRUST_STATUS_NO_PROMOTION_RULES`, `adaptEvidenceFindingsValidationStatus`, and `adaptEvidenceLinkContextStatus` from the evidence barrel. The no-promotion rules are enforced at the adapters and the composition boundary and are written out in `docs/evidence-and-memory.md`; the two adapters were reachable from no builder.

### Security
- A project-catalog `verify(check=<id>)` no longer sits in the no-prompt set. The policy engine resolves the check against `.clio-coder/verifiers.yaml`, scans the declared argv with the damage-control rules and the zero-access read guard, and tags it unrecognized, so `auto-edit` confirms it once with the argv shown and `full-auto` runs it. Package-script checks and `verify(check="frontend")` are unchanged. `.clio-coder/verifiers.yaml` and `.clio-coder/safety.yaml` are read-only to the model's `write`, `edit`, and bash redirect paths by default: before this, a model at the default `auto-edit` level could write the catalog and run any argv through `verify` without a prompt.

### Fixed
- A completed conversational offer such as "point me at it and I'll get moving" no longer triggers an automatic continuation or the "turn still has open work" footer warning (#178). The stalled-turn detector now requires an announced concrete action: it recognizes inflected verbs ("I'll be running the tests"), announced paths and commands ("Let me open src/cli/index.ts", "I'll npm run build"), and keeps conditional offers, "let me know" phrasing, questions, and wait statements ("I'll wait for your go-ahead before I touch index.ts") suppressed. The one-continuation cap for genuine stalls is unchanged.
- A completion-contract audit row can no longer ground validation. The row is the run's own self-report and feeds completion evidence only; validation grounding is filled by executions the session ledger observed. A run whose receipt fails integrity contributes no verified field, its completion self-report downgrades to `unknown`, and the `no-validation` warning is restored. A blank or whitespace-only identifier in one audit row no longer aborts the whole evidence build.
- Tool-result summaries are honest about omission. Head and tail slices are disjoint, a scratch offload is written only when the model projection actually omits content, whitespace-only output is complete rather than truncated, NUL bytes are removed from model context while presentation and the offload keep the captured bytes, the head-tail strategy honors `redact`, and a throwing disposition resolver fails closed to metadata-only with the cause recorded in the result metadata, the model header, and the transcript row.
- `clio-coder verifiers … --yes` no longer prints "no file has been written" immediately before writing the catalog; the confirmed preview is rendered after authorization.
- Auto-compaction no longer destroys observations. The stale-observation mask rewrote persisted bodies through `session.replaceEntries`, so masked content was gone from `/resume`, `/tree`, `/fork`, and the HTML export as well as from the model. `CLIO_CODER_LEGACY_MASK=1` restores that stage for one release as a compatibility escape hatch; it is removed in the next release.

## 0.3.3 - 2026-08-21

### Changed
- Unified transcript detail under `/output minimal|default|verbose`, with consistent per-block and all-block tool/thinking overrides that reset when the output level is reapplied.
- Folded Bash execution bodies by default while retaining concise command, outcome, timing, size, and bounded failure evidence on the transcript row (#166, #177).
- Rendered reasoning as stream-ordered thinking segments and made interview prompts true fullscreen workspaces (#171).

### Fixed
- Preserved live, interrupted, and replayed reasoning order and token provenance, including provider-reported zero-output turns.
- Preserved complete replay bodies for HTML export and aggregated multi-call replay receipts.
- Kept failure excerpts and mutation diffs inside narrow terminal frames, including at 40 columns.
- Replaced internal tool-call labels such as `bash(...)` with operator-facing action descriptions in live, replayed, blocked, and exported transcript rows.
- Refreshed the footer immediately after `/output` changes and kept explicit fold choices scoped to the intended tool or thinking stretch.
- Rechecked commit-attribution repository state and repaired missing or damaged cached hook wrappers before reuse.

## 0.3.2 - 2026-08-20

### Added
- Evidence-aware Git commit attribution, with an Advanced setting to disable it without changing commit messages.
- Fullscreen terminal mode, terminal-native Mermaid and LaTex rendering, smooth-streaming controls, instant-shell startup, prompt-history navigation, and improved model, settings, resume, task, decision, and workspace-output views.
- HTML transcript export (with Markdown export retained), live tool-progress and numbered edit/write diffs, and richer tool lifecycle details.
- Directory-scoped `CLIO-CODER.override.md` instructions, project-rule propagation to workers, an installed-skills marketplace, and source/codewiki assets in published packages.
- Compile-cache support for interactive, run, ACP, and worker boot paths; codewiki indexing and several tool implementations now load on demand.
- A Pi SDK boundary/upgrade checklist and declaration-surface checks; Pi SDK libraries are updated to 0.84.0.

### Changed
- Consolidated slash-command spelling and prompt-template argument handling; retired aliases now fail closed while preserving the editor draft.
- Replaced the LM Studio SDK path with an HTTP adapter. `lmstudio` is canonical; `lmstudio-native` remains a compatibility alias for persisted settings.
- Improved local-model selection, residency, context sizing, reasoning controls, retries, OpenAI-compatible streaming, and token accounting.
- Strengthened ACP v1 session, workspace, permission, output-bound, and error contracts for external clients.
- Improved terminal rendering, transcript streaming, timing, export, and session replay behavior.
- `docs/html` is no longer included in npm packages; Markdown guides remain available.

### Fixed
- Preserved prompt submission order during instant-shell startup and restored transcript rendering in fullscreen mode.
- Kept rejected slash-command drafts editable and aligned footer, receipt, and ledger usage for completed or cancelled turns.
- Prevented session switches during streaming from creating phantom entries; fixed task-board branch selection and persisted `/tree` pins.
- Prevented concurrent dispatch processes from overwriting run-ledger rows (#118), and hardened worker compile-cache isolation (#148).
- Fixed LM Studio duplicate-load behavior (#113), llama.cpp residency failures (#127, #134), runtime alias handling (#119), and probed context-window precedence (#129).
- Restored documented headless JSON/event output and CLI exit-code behavior (#122, #123); corrected thinking-level resolution (#128), stalled-stream reporting (#131), and reasoning-token estimates (#132).
- Isolated tests from user configuration (#110, #111), and corrected documentation claims (#117).

### Security
- Hardened worker and session safety-policy consistency, OAuth cancellation, workspace output reads, and ACP permission/cancellation handling.
- Added publish-time version-coherence checks (#124) and removed unsafe or misleading default behaviors in credentials migration and package serving.

## 0.3.1 - 2026-08-16

### Added
- Live worker transcript blocks, receipts, sharing, folding, and durable replay for `/run` and `/delegate`.
- Interoperability discovery and opt-in configuration for compatible coding agents, with protected foreign-agent directories and prompt roots.
- An agent-ledger surface for coordinated worker findings and a transactional Settings Center for routing, runtime, and experience settings.
- Stream-stall retries, authoritative timing/timezone handling, packaged source/code maps, improved trace viewing, and clearer upgrade notices.

### Changed
- Reworked the TUI around adaptive launch, composer, transcript, footer, permission, and narrow-terminal layouts.
- Improved fleet admission, result contracts, benchmark adapters, local-model residency, artifacts, and release packaging.
- Renamed remaining user-facing runtime identifiers to `clio-coder`; legacy settings and environment spellings remain readable where noted.

### Fixed
- Restored TUI prompt-template invocation and implemented documented ACP `--cwd` and `--permission-timeout` options.
- Preserved synthesis-locked worker answers, prevented unsafe llama.cpp model overrides, and corrected tool durations (#82).
- Fixed handbook grounding, reachability diagnostics, JSON result parsing, pasted slash commands, and resumed/forked prompt display.
- Fixed cancelled-turn replay/accounting, credentials corruption safeguards, doctor diagnostics, configuration layout, and missing-artifact errors.

### Security
- Remembered identical per-run escalation decisions without widening different requests.
- Added outward-exposure confirmation, safer artifact defaults, protected foreign-agent paths, and stricter credential, URL-opening, and permission behavior.

## 0.3.0 - 2026-08-14

### Added
- The first npm-published `clio-coder` command and namespace: binary, XDG roots, project directory, handbook, environment variables, and extension manifests use `clio-coder` naming.
- Agent ledgers, intentional compete stances, durable dispatch capacity leases, deterministic execution plans, typed worker contracts, and transactional worker attempts.
- Soak and invariant evaluation suites, receipt-derived accounting, per-step write-boundary checks, bounded check/repair loops, deterministic fleet code steps, and headless session continuation.
- Improved context bootstrap/refresh and generated-wiki workflows, hardened skill discovery/install/evaluation, and updated Pi engine dependencies to 0.83.0.

### Changed
- `clio-coder --help` now emphasizes the human-facing command surface; `--help --all` retains the full scripting and harness surface.
- Reorganized TUI internals without changing its public command surface, and made context budgeting favor target-reported limits.
- Unknown slash commands now fail closed; use a leading backslash for command-shaped prose.

### Fixed
- Preserved active session branches across compaction and replay, made startup option parsing strict, and bounded ACP deadlines.
- Stopped automatic retries after potentially state-changing tool calls.
- Fixed JSON transcript duplication, evaluation threshold enforcement, cancellation recovery, usage totals, uninstall/reset reporting, and narrow-terminal configuration output.
- Corrected provider URL launching, damage-control matching, credentials handling, doctor reporting, and trace help behavior.

### Security
- Replaced shell interpolation when opening provider URLs on macOS/Linux with argument-safe process spawning.
- Made dispatch plans immutable and receipt-backed, enforced worker attestation and write-boundary recovery, and fail-closed on malformed durable contracts, unknown skills, and unsafe retries.

## 0.2.9 - 2026-08-05

### Added
- Deterministic fleet code steps, bounded check/repair loops, shipped SDLC fleets, and a durable trace store with read-only trace commands and viewer.
- Per-step write-boundary verification, typed worker result contracts, strict worker attestation, and process-safe capacity/routing leases.
- One compiled worker harness with explicit tool/budget profiles, model-facing dispatch/collect provenance, and transactional editing attempts.

### Changed
- Added first-class singular dispatch while retaining batch dispatch, and unified synchronous and detached run monitoring.
- Updated Pi engine dependencies to 0.80.6 and advanced receipt, route, plan, and policy formats to their strict current versions.
- Broadened model-authored repository exploration while retaining bounded Scout guidance and Fleet Runs visibility.

### Fixed
- Made successful native and ACP delegation require receipt-sealed final output, and made protected-artifact recovery durable across restart and worktrees.
- Improved compaction, context provenance, routing, external-agent cancellation, and generated-wiki grounding.

### Security
- Enforced immutable approved dispatch plans, strict external-agent policy checks, bounded worker protocol frames, and fail-closed handling of older or partial durable formats.

## 0.2.8 - 2026-07-07

### Added
- A consolidated seven-plane tool surface, task tracking, richer dispatch monitoring/steering, codewiki v4, exports, and improved interactive command hubs.
- Multi-model local residency management and native shadow-agent fleet routing.

### Changed
- Improved local-model prompting, TUI pressure handling, accounting, worker IPC, deadlines, model catalog metadata, and documentation.

### Fixed
- Corrected approval, symlink, loop-guard, worker-profile, reasoning, session-branch, and timeout edge cases.

### Removed
- Legacy tools including `glob`, `workspace_context`, `docs_search`, `run_task`, `validate_frontend`, `write_plan`, `write_review`, `create_skill`, and `dispatch_batch`; use the consolidated tool surface.

## 0.2.7 - 2026-07-02

### Added
- Reviewed marketplace skills, executable skill evaluations, enforced skill tool surfaces, and registry integrity pins.
- Credential damage control, usage reports, headless receipts, dispatch evidence bundles, and high-rigor validation support.

### Changed
- Reduced package size and refreshed release and documentation workflows.

### Fixed
- Improved dispatch, lifecycle, skill, and loop-guard reliability.

### Security
- Added zero-access credential storage and secret redaction in evidence bundles.

## 0.2.6 - 2026-06-24

### Added
- VRAM-aware local-model residency, layered settings, path-scoped rules, operator profiles, hooks, configuration inspection, docs search/viewing, and SciCode benchmark support.

### Fixed
- Prevented dispatched Ollama work from leaving models resident and overflowing VRAM.

## 0.2.5 - 2026-06-23

### Added
- The `alcf` runtime for Argonne ALCF Sophia/Metis targets, including Globus OAuth, discovery, metadata, and gateway documentation.

### Fixed
- Enforced strict OpenAI-compatible reasoning payloads for ALCF targets.

## 0.2.4 - 2026-06-23

### Added
- Fleet management with agent/profile bindings, fault-tolerant dispatch, and a `/fleet` overlay.

### Changed
- Refreshed Pi, Claude, Anthropic, Biome, TypeBox, Undici, UUID, and TSX dependencies.

### Fixed
- Isolated dispatch tests and made receipt digests deterministic across hosts.

## 0.2.3 - 2026-06-17

### Added
- Declarative slash commands and full-screen hubs; enforced autonomy and safety notices; additional subscription/delegation runtimes; codewiki indexing, middleware, live steering, and richer receipts.

### Changed
- Reworked on-disk roots, settings ownership, lifecycle commands, model-target vocabulary, and observability.

### Removed
- Retired legacy slash commands; their workflows moved to `/skill`, `/targets`, `/help`, `/view`, and related hubs.

## 0.2.2 - 2026-06-11

### Added
- Context engine, compaction, bounded tool results, prompt-cache telemetry, ACP support, a curated skills marketplace, and local install/uninstall scripts.
- A richer `CLIO.md` project rulebook and source-tree awareness.

### Changed
- Replaced built-in CLI-subprocess runtimes with direct HTTP/native/Pi targets and ACP delegation.

### Fixed
- Improved prompt-prefix stability, ledger appends, permission overlays, and release verification.

## 0.2.1 - 2026-06-05

### Added
- Live token-throughput telemetry, prompt-envelope hashes, and `clio run --json` prompt diagnostics.

### Changed
- Reduced context pressure through narrower tool exposure and bounded output; improved the footer for smaller terminals.

### Fixed
- Corrected headless run arguments, unknown-agent handling, dashboard layout, and prompt-diagnostic visibility.

## 0.2.0 - 2026-06-03

### Added
- First community alpha for source-checkout users, with JIT skills, stronger compaction, project-instruction adoption, runtime resolution, diagnostics, durable sessions, and expanded documentation.

### Fixed
- Hardened path policy, headless runs, prompt-cache boundaries, overlays, session replay, and TUI startup.

## 0.1.9 - 2026-05-17

### Added
- First-class fleet `dispatch`, frontend artifact validation, typed finish evidence, and local-model capability improvements.

### Fixed
- Corrected reasoning replay, Harmony parsing, Codex file-tool aliases, lifecycle metadata repair, and model-capability duplication.

## 0.1.8 - 2026-05-11

### Added
- Extensions, share archives, associated CLI/TUI workflows, a redesigned welcome dashboard, configure validation, and a Claude Code SDK safety bridge.

### Fixed
- Corrected Gemini CLI token accounting and expanded extension, sharing, configuration, and supervised-SDK coverage.

## 0.1.7 - 2026-05-11

### Added
- A shared safety-policy engine, strict project command policies, typed execution tools, and receipt safety summaries.

### Changed
- Default Bash now denies ordinary execution unless allowed by curated commands or project policy.

### Fixed
- Hardened dispatch scope, external-runtime permissions, audit rows, and worker safety parity.

## 0.1.6 - 2026-05-04

### Added
- `clio --print` / `clio -p` for one non-interactive turn, with stdin/argv composition and stdout safeguards.

### Changed
- Reserved future JSON/RPC modes behind explicit errors.

## 0.1.5 - 2026-05-03

### Added
- Public alpha for source-install developers and research-software teams: interactive TUI, target-first configuration, coding agents, sessions, project context, receipts, audits, evidence, evaluations, memory, and safety modes.
- `clio init`, CLIO.md parsing, codewiki indexing, improved cost/model UI, and documented alpha operating limits.

## 0.1.4 - 2026-04-30

### Added
- Evolution tooling for inventories, change manifests, evidence, evaluations, memory, middleware, protected artifacts, finish checks, workspace orientation, specialist recipes, and scientific validation.

### Changed
- Unified llama.cpp handling and improved TUI, compaction, context accounting, and protected-artifact behavior.

## 0.1.3 - 2026-04-27

### Added
- Live tool output, Bash echo, thinking expansion, and a Git-branch footer slot.

### Changed
- Made `CLIO.md` the canonical project instruction file and improved LM Studio/Ollama detection.

### Fixed
- Corrected Debian/Ubuntu slash autocomplete, doctor/targets JSON envelopes, and partial tool-output rendering.

## 0.1.2 - 2026-04-25

### Added
- Visible retries for transient provider and stream failures.

### Changed
- Improved interactive tool, Bash, dashboard, hotkey, resume, prompt, receipt, compaction, audit, and abort behavior.

### Fixed
- Corrected retry duplication, cancellation races, oversized Bash output, active-run session operations, provider hot-swaps, and local OpenAI-compatible reasoning/tool schemas.

## 0.1.1 - 2026-04-24

### Added
- Deterministic loading of project context files from the working directory upward.

### Fixed
- Corrected rich session replay, subprocess dispatch, out-of-tree SDK rehydration, receipt verification, dispatch heartbeats, and boundary-check documentation.

## 0.1.0-exp - 2026-04-24

### Added
- Initial experimental public release with interactive TUI, lifecycle CLI, target-first configuration, runtime support, built-in agents, dispatch workers, receipts, audit logs, safety modes, and XDG-aware state.

### Security
- Windows support was best effort; remote fan-out and MCP surfaces were scaffolded but not admitted by dispatch.
