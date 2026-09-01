# Clio Coder Agent Fleet

Clio Coder dispatches focused fleet agents from Markdown recipes. Recipes are data files, not hidden code plugins: YAML frontmatter declares identity, tool requirements, skill bindings, audience, capability and latency classes, budget, and result contract; the Markdown body is the agent instruction text.

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard for the agent registry and dispatch admission check gates is located at [docs/html/agents_blueprint.html](html/agents_blueprint.html) (Version: 0.4.1).

The source of truth is `src/domains/agents/**`. Clio's agent dispatch engine and execution boundaries are built upon the [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) library.

---

## Agent Architecture Semantics

Clio's agent architecture distinguishes between authoring configurations and runtime policies:

*   **Recipe**: An authored Markdown file containing frontmatter configuration and an instruction body.
*   **AgentSpec**: The normalized runtime and catalog policy object derived from a recipe.
*   **audience**: Determines visibility and routing (`base` | `shadow` | `custom` | `internal`).
*   **source**: Origin of the recipe (`builtin` | `user` | `project`).

### Discovery, Overrides, and Precedence
At startup, Clio loads recipes from three roots:

| Source | Root | Notes |
| --- | --- | --- |
| **Built-in** | `src/domains/agents/builtins/*.md` in the installed package | Shipped defaults. |
| **User** | `<configDir>/agents/*.md` | Per-user recipes. `<configDir>` follows Clio's XDG/platform config directory. |
| **Project** | `.clio-coder/agents/*.md` under the current repo | Repository-local overrides and additions (custom/domain agents). |

Recipe IDs are derived from filenames (e.g., `architect.md` -> `architect`). Recipes must live directly under their respective directories.

*   **Customization**: User-level agents can override/customize shipped base agents.
*   **Shadow Protection**: User or project agents can **never** override shadow or internal agents.
*   **Built-in Protection**: Project agents cannot override any shipped built-ins; they are strictly treated as custom/domain agents.
*   **Reserved IDs**: The IDs `worker` and `delegate` are strictly reserved for custom/internal contexts and cannot be registered as custom agent IDs.
*   **Local Ignored Custom Examples**: Local examples (e.g., `benchmark-runner`, `clio-dev`, `implementer`, `scientific-validator`) may exist under `.clio-coder/agents` for documentation or test purposes, but are ignored if they collide with reserved/built-in rules.
*   **Fleet Contracts**: Shipped builtin fleet contracts (`build-test`, `build-review`, `sdlc`) live under `src/domains/agents/fleets/*.md`. Library-installed contracts live at `<configDir>/fleets/<name>.md`. Project contracts at `.clio-coder/fleets/<name>.md` take highest precedence. Deterministic code steps reference commands declared in `.clio-coder/fleets/commands.yaml`. Contract v4 requires per-step write boundaries (`writes`).

---

## Built-in catalog

Current built-ins under `src/domains/agents/builtins/`:

### Shipped Base Agents
User-facing agents visible in `clio-coder agents` and `/agents`.

| Agent ID | Primary tools | Purpose | Capability | Latency |
| --- | --- | --- | --- | --- |
| `architect` | read, grep, find, ls, code_nav, git, artifact, context, ledger | Designs changes across boundaries, contracts, migrations, and validation gates. | `artifact-write` | `deep` |
| `coder` | read, write, edit, grep, find, ls, web_fetch, git, bash, verify, code_nav, ledger | Implements bounded code changes and behavior-preserving refactors. | `workspace-edit` | `balanced` |
| `debugger` | read, grep, find, ls, git, verify, code_nav, ledger | Diagnoses failing code, tests, or receipts without making edits. | `verification` | `balanced` |
| `documenter` | read, write, edit, grep, find, ls, git, verify, code_nav, context, ledger | Updates developer-facing docs, examples, and operational runbooks. | `workspace-edit` | `balanced` |
| `git-master` | read, write, edit, context, git, bash, grep, find, ls, code_nav, ledger | Executes bounded git operations: history, commits, worktrees, and PR prep. | `workspace-edit` | `balanced` |
| `tester` | read, write, edit, grep, find, ls, git, verify, code_nav, ledger | Adds focused deterministic tests for regressions and missing coverage. | `workspace-edit` | `balanced` |
| `verifier` | read, grep, find, ls, git, verify, code_nav, ledger | Independently runs and reports test, lint, build, review, and release gates. | `verification` | `fast` |
| `wiki-writer` | read, write, edit, grep, find, ls, code_nav, context, ledger | Plans one repository wiki, or researches and writes one wiki page. | `workspace-edit` | `balanced` |

### Shipped Shadow and Internal Agents
Internal orchestration helpers and internal process agents. They are hidden from default displays (but visible via `clio-coder agents --all` and in a separate section of the prompt catalog).

| Agent ID | Primary tools | Purpose | Capability | Latency |
| --- | --- | --- | --- | --- |
| `scout` | read, grep, find, ls, context, code_nav, git, ledger | Broad repository reconnaissance, codebase orientation, structure and entry-point mapping, and multi-file symbol hunting. | `read-only` | `fast` |
| `researcher` | read, web_fetch, context, ledger | Shadow docs and external-source researcher for coding decisions. | `read-only` | `deep` |
| `provenance` | read, grep, find, ls, git, ledger | Shadow evidence, receipt, diff, and telemetry reader for handoffs. | `read-only` | `balanced` |
| `oracle` | read, grep, find, ls, code_nav, context, ledger | Shadow advisor behind `/oracle` that protects consistency with prior decisions and returns the strongest challenge to a question. | `read-only` | `deep` |
| `context-bootstrap` | read, grep, find, ls, context, code_nav, ledger | Internal agent behind `clio-coder context init` that parses repository and returns CLIO-CODER.md payload. | `read-only` | `balanced` |

The builtin `architect` also serves as the default author for a version 5 fleet `plan` step. In that role it returns the coordinator-owned `delegation-plan` result shape instead of writing its ordinary plan artifact. It may name only agents from the contract roster. The coordinator supplies the plan step's target or profile to every admitted task.

`scout` is bound by a live-grounding contract: its whole final response is one `scout-report` object whose every finding carries the `claim` it observed and the `path:line` that grounds it, a lead it could not confirm live is simply left out, and wiki or index content is orientation only, never citable as evidence. It has an 18-call exploration phase followed by a tool-free synthesis phase; wide parallel batches cannot consume the synthesis backstop as separate violations. Dispatch labels its answer `reconnaissance output (advisory leads, not validation evidence):`.

Grounding is checked against the run's own reads, not just against the file. The worker records the exact line span every successful read returned, and a cited line must fall inside one. A line that exists in the file but was never read fails, which is what stops an approximated or inferred line number from passing as observation. `grep` and `code_nav` hits are leads: read the file before citing what they point at.

`oracle` is the only shadow agent an operator reaches directly, and only through
`/oracle <question>`. It never receives a forked transcript. `/oracle` packs a
bounded digest instead and sends it as dispatch briefing data: the settled
decisions from the session decision board, the open tasks from the task board,
the last compaction summary when one exists, and the question. The digest is
capped at 12 KiB total, with per-section caps of 5120 bytes and 24 rows for
decisions, 3072 bytes and 24 rows for open tasks, 2048 bytes for the compaction
summary, and 1536 bytes for the question. Every cap that cuts content appends a
`[truncated]` marker, so an advisor always knows it is reading a tail-less
record. Entries are filtered to the active branch before the fold, so a `/tree`
switch never briefs the advisor on decisions the operator walked away from.

The run is an ordinary singular dispatch with `requestOrigin: "internal"` and
`autonomy: "read-only"`, so admission, receipts, and the Fleet Runs island apply
to it exactly as they apply to `/run`. Its `oracle-report` contract carries the
answer shape: a verdict line, the strongest challenge the advisor can mount, the
evidence that would change its mind, and the decisions it cited. The rendered
answer reaches the main agent the way `/share` puts a worker result there, as an
operator-authored note on the ordinary user-turn path. `/oracle` during an
in-flight turn is refused rather than queued.

Every contract-bearing agent gets bounded in-worker repair. When the terminal result misses its contract, the worker replays the validator's own reason, the exact accepted shape, and the `path:line` locations this run actually read, then asks for the result again. Two repair rounds is the whole allowance; after that the run fails with `result_contract_exhausted`. This is what keeps a small local model that gathered the right evidence from being failed for a shape mistake nobody told it about.

Two rounds only help when the reason is actionable, so a validator reason names the mistake and shows the value that would have passed. A `mutation-report` with `"validations":[]` is told the array was empty and is given one entry shaped like `{"name":"npm test","passed":true,"evidence":"exit 0"}`, and a report whose entries are malformed is told which keys each entry carries. Naming the requirement alone left a small model re-emitting the same empty array through both rounds.

---

## Frontmatter schema

`src/domains/agents/registry.ts` parses frontmatter fields from recipe markdown:

```yaml
---
version: 1                            # recipe schema version
name: Coder                           # string; defaults to recipe id when absent
description: Bounded code changes     # string; defaults to empty string
tools:                                # required/optional tool mapping, not a flat list
  required: [read, {anyOf: [write, edit]}, context]   # anyOf: at least one must admit
  optional: [grep, git, verify, bash, ledger]         # attached when the target carries them
skills: [fix-issue, ship]             # knowledge attachments; require the context tool, never expand tool authority
audience: base                        # base | shadow | internal
category: implement                   # explore | plan | research | implement | quality | science | evolution | operations | internal
capabilityClass: workspace-edit       # read-only | artifact-write | workspace-edit | verification | orchestration | internal
latencyClass: balanced                # fast | balanced | deep
projectContextTier: bounded           # how much project context the worker is briefed with
tags: [implementation, repair]        # short lowercase routing hints for catalog display
budget:                               # optional strict worker-loop phase policy
  toolCalls: 50                       # admitted calls before final response handling
  readReserve: 5                      # final admitted slots reserved for canonical read
  synthesis: true                     # true: text-only final round; false: stop immediately
  # maximum: {toolCalls: 150, readReserve: 16}   # optional hard ceiling (architect ships one)
resultContract: {kind: mutation-report}  # typed result shape the worker must return
---
```

The closed key set is defined in `src/domains/agents/recipe-schema.ts`; an
optional `product` key also exists for product-scoped recipes. There are no
`model`, `target`, `thinkingLevel`, or `output` frontmatter keys — target and
model selection belong to dispatch, not the recipe.

A custom source recipe may omit `budget`; admission then materializes a concrete WorkerSpec v3 budget from the operator's current `guardrails.workerToolCallCap`. Built-in recipes declare the field and fail startup if their strict frontmatter is malformed. When a source recipe includes `budget`, it must be a non-null YAML object containing `toolCalls`, `readReserve`, and `synthesis` (plus an optional `maximum` ceiling object, e.g. architect's `maximum: {toolCalls: 150, readReserve: 16}`): the numeric fields must be safe integers, `toolCalls > 0`, and `0 <= readReserve < toolCalls`; `synthesis` must be a boolean. Unknown, missing, quoted-numeric, floating-point, null, and relationally invalid values reject the recipe with its source path and property. Scout declares `18/4/true`; Coder declares `50/5/true`. The model-visible catalog shows declared policy or `operator-default`, never a mutable effective cap.

The operator cap is independent and cannot be widened by a recipe. Dispatch clamps `toolCalls` to that cap and clamps `readReserve` to zero when canonical `read` is absent after tool admission. Reserve slots admit only `read`, not every read-class tool. Blocked non-read attempts do not consume admitted reserve slots, but they still count toward the operator attempt ceiling.

### Skills
Skills are knowledge attachments declared under `skills: [...]` in the YAML frontmatter.
*   They are injected compactly into the prompt/catalog.
*   They require the `context` tool to be accessible; a recipe that declares skills without exposing `context` fails spec validation.
*   They **never** expand the agent's tool authority; they act purely as static knowledge context.

---

## Dispatching agents

*   **Visibility**: Normal `clio-coder agents` lists user-visible (base/custom) agents. The `/agents` slash command shows both Clio fleet agents and ACP delegation agents. The command `clio-coder agents --all` includes shadow/internal specs reserved for Clio orchestration.
*   **Invocation limits**: User-origin `/run` and `clio-coder run --agent` **cannot** invoke shadow/internal agents.
*   **Orchestrator dispatch**: Internal main-agent dispatch can invoke shadow agents through the `dispatch` tool. The operating contract and Scout's catalog description steer the model to dispatch Scout for broad repository reconnaissance, while narrow file or symbol inspection remains local to the main agent. If a turn reaches 9 or more manual read-only exploration calls without completing Scout dispatch, a threshold nudge advises delegation once, as a transcript notice. It never carries the turn onward into another model round.
*   **TUI rendering and control**: Shadow dispatch rows are marked with an `sh:` prefix. The Fleet Runs island and board show the bounded task, run ID, live tools, tokens, priced cost, retry state, and terminal outcome. Select an HTTP/SDK run to steer it or cancel any active worker/retry timer.
*   **ACP Delegation**: The `/delegate` command is reserved for ACP delegation only, which is separate from Clio fleet subagents.

### Measured agent automation

An assignment may request `agent: auto`, but agent choice is advisory by default and is independent of target/model/runtime/node route activation. The coordinator first removes recipes that fail audience, capability-class, execution-role, tool-surface, result-contract, target, or policy constraints. Those are hard constraints and never become score weights. The remaining recipes are ranked deterministically with measured evidence and bounded cold-start priors.

Active agent selection requires an exact `{agentId, executionRole}` entry in `routing.agentAutomation.activeAgentRoles` and a passing readiness report for that same agent and role. Empty activation settings are the default. If no eligible agent is ready, active automation fails closed instead of falling back to the fixed requested recipe.

Scout is the bounded escalation path for broad reconnaissance, not an authority shortcut. Its strict `scout-report` may return grounded findings or a split recommendation with typed subtasks. The coordinator validates the transition, assigns fresh authority and an absolute deadline to each child, and records the decision. A recovery attempt uses the dedicated recovery role and may not silently inherit broader builder authority.

### ACP Delegation Agents as First-Class Workers

ACP delegation agents (registered under `delegation.agents` in `settings.yaml`) are integrated as first-class workers:
- **Automatic Routing:** When a task is dispatched to an agent ID matching a configured ACP delegation agent, the dispatch engine automatically routes the execution to that delegation agent.
- **Dynamic Spec Discovery:** The agent registry automatically synthesizes complete AgentSpecs for configured ACP delegation agents. They are visible via `clio-coder agents` and in slash command menus.

### Restricted Shadow Agent Delegation

To ensure security and proper boundary isolation, shadow and internal agents are restricted from being delegated:
- **shadow/internal Restriction:** The dispatch engine rejects any attempt to run a shadow or internal agent on an external ACP delegation worker, throwing a validation error.

### Subscription Worker Runtimes

In addition to standard HTTP targets and [Agent Client Protocol (ACP)](https://agentclientprotocol.com) delegation agents, Clio dispatches subagents to sanctioned subscription worker runtimes:
- **`claude-sdk` (Claude Agent SDK):** Serves as a main worker runtime for driving fleet agents. It integrates with [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) alongside Clio's native subagent workers (like a local [llama.cpp](https://github.com/ggerganov/llama.cpp), [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), [vLLM](https://github.com/vllm-project/vllm), or [SGLang](https://github.com/sgl-project/sglang) fleet) to execute tasks under a Claude subscription. Every tool call is mediated by Clio (`canUseTool` plus a `PreToolUse` hook): the safety net and autonomy matrix apply, and the run's admitted tool surface, which is narrowed by any `tool_profile`, is enforced authoritatively. Consequently, an out-of-profile tool (for example `bash` under `minimal-local`) is denied even though the underlying preset offers it. The narrowed surface is also translated into the SDK's `disallowedTools` option as defense in depth. Because it routes tool calls through Clio safety, it behaves as a native worker.
- **`claude-code` (Claude Subprocess):** Runs `claude -p` as a subprocess worker, mapping autonomy levels to the CLI's permission modes. It is a black box: tool calls run inside the `claude` process and are not routed through Clio's per-tool mediation, so Clio cannot enforce a per-tool profile on it. Dispatching a narrowing `tool_profile` (`minimal-local` or `science-local`) to this runtime is refused; use `full-agent` (or a native / `claude-sdk` worker) instead.
- **`antigravity-code` (Antigravity CLI):** Runs an Antigravity CLI subprocess as a subscription worker target for fleet dispatch. Like `claude-code`, it is a black box with no per-tool mediation and no per-tool allowlist, so a narrowing `tool_profile` is refused rather than silently ignored.

Agent budgets follow the same mediation boundary. Native workers and `claude-sdk` enforce canonical call counting, the canonical-`read` reserve, and the synthesis transition. `claude-code` and `antigravity-code` reject recipes that explicitly declare `budget`, because silently ignoring numeric bounds would be unsafe; a custom source recipe without the field receives the concrete operator-default budget at admission. Claude vendor aliases never appear in recipes or prompt authority and cannot reintroduce a canonical tool removed by admission.

Interactive TUI:

```text
/run coder implement the new command
/run --target local-lmstudio --model your-model-id coder fix the failing unit test
/run --agent-profile cheap --tool-profile minimal-local verifier run the regression tests
```

Headless CLI:

```bash
clio-coder run --agent coder "Refactor the parser."
```

Dispatch admission enforces three gates:

1. The recipe's requested tools must be supported by target capabilities.
2. The requested action classes must be allowed by the agent's scope.
3. The worker scope must be a subset of the orchestrator's active scope.

### Ad-hoc specialists

The dispatch tool can compose an ephemeral specialist for one task object with
`persona` and `tool_profile`. `persona` replaces the recipe body inside the
same stable worker shell used for recipe runs; it does not replace Clio's task
contract or safety scaffolding. `tool_profile` narrows tools through the same
validated profiles as recipe dispatch (`minimal-local`, `science-local`, or
`full-agent`).

Personas are capped at 8000 characters and are rejected for shadow agents and
ACP delegation agents. A composed run legitimately gets its own
`staticCompositionHash`, and its receipt and run ledger carry
`personaOverride.promptHash` so the override is explicit and queryable.
Recipe-based runs omit `personaOverride`.

### Worker context injection

Every dispatched worker receives per-run context through dynamic prompt
messages (user-role messages sent before the task), never through the stable
system prompt, so the static prompt composition hash stays byte-identical run
over run:

- **Project context** (capability classes `workspace-edit`, `verification`,
  and `artifact-write` only): the project name, conventions, and hard
  invariants parsed from `CLIO-CODER.md`, capped at 1500 characters with conventions
  truncated first. Read-only, shadow, and orchestration recipes get none, and
  no message is sent when `CLIO-CODER.md` is absent or malformed.
- **Safety posture** (every run, including ACP delegation): one line naming
  the run's effective autonomy level with the same directive text the session
  prompt's safety section uses.
- **Memory** (when the request carries an approved memory section): unchanged,
  delivered after the two messages above.
- **Pipeline input** (`pipeline`-mode steps after the first): the previous
  step's final assistant output, threaded as data inside a fixed
  `<<<PIPELINE-INPUT ... PIPELINE-INPUT>>>` delimiter and labeled as input,
  not instructions. It is ordered last, after memory and adjacent to the task,
  and capped at 12000 characters; the receiving run's receipt records
  `pipeline` provenance (source run, step position, input bytes, whether the
  cap truncated it). Step 1 and every non-pipeline run get none. The `pipeline`
  and `personaOverride` field shapes and their stability labels are documented
  in the [receipt provenance schema](./observability.md#receipt-fields-for-dispatch-provenance).

---

## Fleet Management and Fault Tolerance

Clio manages running subagent tasks, tracks token costs, and handles task failures. It operates under specific safety, concurrency, and retry limits:

### 1. In-Memory Retry Queue
Subagent runs that terminate with retryable outcomes are placed in an in-memory retry queue. The queue does not survive process restarts. The retryable outcomes are:
- `failed`: The subagent process exited non-zero or returned an error receipt.
- `timed_out`: The run or delegation turn exceeded its timeout limit.
- `stalled`: The run exceeded the event-inactivity window without progress or stopped responding to heartbeats.
- `spawn_failed`: The runtime failed to spawn the subprocess or establish connection.

### 2. Backoff and Cooldown
Scheduled retries use an exponential backoff state to calculate subsequent retry delays. Furthermore, targets that fail are subject to a cooldown period. The retry engine ensures that a retried task waits for the maximum of the exponential backoff delay or the remaining target cooldown duration. Retries are brand-new runs that must re-pass all admission checks. If target policies or budgets deny a retry, the task chain terminates as denied.

### 3. Concurrency Limits
The setting `budget.concurrency` restricts the number of concurrent subagent tasks. Setting it to `auto` determines the concurrency limit dynamically based on system capabilities.

### 4. Heartbeats and Reconciler
For native subprocess workers, Clio uses a heartbeat mechanism. The reconciler monitors the active heartbeat timestamp. If a worker stops responding and updates no heartbeats, the reconciler terminates the stalled subprocess automatically.

### 5. Worker Permission Postures
A dispatched worker has no operator by default, so a tool call that requires interactive permission must resolve within bounded time. The `workers.onPermission` setting picks the posture:

- `deny` (default): the parked call becomes a structured tool denial and the run continues.
- `fail`: the run finalizes immediately with outcome `failed`/`permission_required`.
- `escalate`: the parked call is handed up to the interactive operator. The worker emits a `clio_permission_escalated` event over its stdout; the dispatch domain republishes it on the bus as a permission request tagged with the run id; the operator resolves it in the TUI permission overlay; and the decision travels back down the worker's stdin as a `permission_decision` line (the same pipe steers use). No model can approve a worker permission; resolution is human-only.

Escalate is only meaningful with an interactive operator attached. Headless sessions have no subscriber, so the escalation resolves by the timeout fallback. The bounds are `workers.escalation` (`{ timeoutMs, fallback }`, defaults 120000 ms and `deny`): a parked ask that no operator answers within `timeoutMs` applies the fallback deny/fail, so an escalate-posture run can never hang forever. The heartbeat timer runs independently of the parked call, so an escalated worker keeps reporting alive while it waits. Each escalation and its resolution (operator or timeout) is tallied on the receipt's `safety.decisions` escalation counters, documented with their stability labels in the [receipt provenance schema](./observability.md#receipt-fields-for-dispatch-provenance); a timed-out or denied escalation also raises an `escalation` finding in the evidence bundle. ACP delegations are out of scope: they resolve permissions through their own mediator and have no worker stdin channel.

---


## Adding a project agent

Create `.clio-coder/agents/my-agent.md`:

```md
---
name: My Agent
description: Focused local review helper.
tools: [read, grep, find, ls, git, artifact]
---

You are My Agent. Inspect only the requested area. Never edit files. End by writing a concise review artifact (`artifact` kind="review") with risks, evidence, and follow-up tests.
```

Then run:

```bash
clio-coder agents
clio-coder run --agent my-agent "Review the parser change."
```
