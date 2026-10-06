# Clio Coder Agent Fleet

Clio Coder dispatches focused fleet agents from Markdown recipes. Recipes are data files, not hidden code plugins: YAML frontmatter declares identity, tool requirements, skill bindings, audience, capability and latency classes, budget, result contract, and optional permissions, and the Markdown body is the agent instruction text.

The source of truth is `src/domains/agents/**`. Clio Coder's agent dispatch engine and execution boundaries are built upon the [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) library.

---

## Agent Architecture Semantics

Clio Coder's agent architecture distinguishes between authoring configurations and runtime policies:

*   **Recipe**: An authored Markdown file containing frontmatter configuration and an instruction body.
*   **AgentSpec**: The normalized runtime and catalog policy object derived from a recipe.
*   **audience**: Determines visibility and routing (`base` | `shadow` | `custom` | `internal`).
*   **source**: Origin of the recipe (`builtin` | `plugin` | `user` | `project`).

### Discovery, Overrides, and Precedence
At startup, Clio loads recipes in four precedence tiers:

| Source | Root | Notes |
| --- | --- | --- |
| **Built-in** | `src/domains/agents/builtins/*.md` in the installed package | Shipped defaults. A defect in a shipped recipe aborts discovery. |
| **Plugin** | Each enabled plugin's `agents` resource root | Loaded in stable plugin-source order. A plugin recipe may bind only skills from the same plugin's skill root. |
| **User** | `<configDir>/agents/*.md` | Per-user recipes. `<configDir>` follows Clio Coder's XDG/platform config directory. |
| **Project** | `.clio-coder/agents/*.md` under the working directory | Repository-local additions (custom/domain agents). |

Recipe IDs are derived from filenames (e.g., `architect.md` -> `architect`). Only `.md` files directly under a root are read; subdirectories are not scanned.

*   **Precedence**: Tiers merge in the order above. When two non-builtin recipes share an id, the later tier wins and the earlier one is recorded as `overridden`.
*   **Customization**: A user recipe may replace a shipped base agent such as `coder`. Like every non-shipped recipe it must declare `audience: custom`, so the replacement is a custom agent.
*   **Plugin Protection**: Plugin recipes cannot override any shipped builtin. They are ignored with reason `reserved-builtin`.
*   **Built-in Protection**: Project agents cannot override any shipped built-in. They are ignored with reason `reserved-builtin` and are otherwise custom/domain agents.
*   **Shadow Protection**: User or project agents can **never** override shadow or internal agents (`reserved-shadow` for a user recipe).
*   **Reserved IDs**: The IDs `worker`, `delegate`, and `auto` cannot be registered outside the builtin tier (`reserved-agent-id`).
*   **Namespace**: Native recipes and ACP delegation agents share one id namespace. A delegation entry in `integrations.externalAgents.entries` whose id equals a native recipe id fails agent startup.
*   **Quarantine and diagnostics**: A plugin, user, or project recipe that fails parsing or policy validation is quarantined, not loaded. Discovery records at most 256 diagnostics of kind `quarantine`, `ignored`, or `overridden`, each with the file path and reason.
*   **Timing**: Recipes are discovered when the agents domain starts and again when a plugin resource reload commits a changed plugin generation.
*   **Playbooks**: The fleet runs playbooks. Shipped builtin playbooks (`build-test`, `build-review`, `sdlc`) ship inside the package. Enabled-plugin playbooks load next, user playbooks at `<configDir>/playbooks/<name>.md` load after them, and project playbooks at `.clio-coder/playbooks/<name>.md` take highest precedence. Clio reads no `fleets/` directory; `clio-coder upgrade` converts an older one once. The parser accepts playbook versions 1 through 5. Version 4 introduces enforced per-step `writes` boundaries; version 5 adds plan and gate steps, per-step target or profile routes, and the `writers: 1` single-writer declaration. Deterministic code steps reference commands declared in `.clio-coder/playbooks/commands.yaml`.

---

## Built-in catalog

The catalog equals the files under `src/domains/agents/builtins/`: fourteen recipes. Every recipe declares `synthesis: true`. Budgets read `toolCalls/readReserve`. Tools are shown as the recipe declares them: `anyOf` groups mean at least one must be admitted, and every other required tool must be present on the target.

### Shipped Base Agents
User-facing agents visible in `clio-coder agents`. All declare `projectContextTier: bounded`.

| Agent ID | Required tools | Optional tools | Purpose | Capability | Latency | Budget | Result contract |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `architect` | artifact, context | read, grep, find, ls, code_nav, git, ledger, limitation | Designs changes across domain boundaries, including contracts, migrations, and validation gates, and cuts an existing plan into a dependency-ordered sprint through the bound `sprint-plan` skill. | `artifact-write` | `deep` | 32/5, maximum 150/16 | `architect-plan` at `.clio-coder/artifacts/PLAN.md` |
| `coder` | read, any of write or edit, context | grep, find, ls, web_fetch, git, verify, code_nav, bash, ledger, limitation | Implements bounded code changes, repairs, and refactors, behavior-preserving by default. | `workspace-edit` | `balanced` | 50/5 | `mutation-report` |
| `debugger` | verify | read, grep, find, ls, git, code_nav, ledger | Diagnoses failing code, tests, or runs without editing, reading receipts, logs, and runtime behavior. | `verification` | `balanced` | 24/4 | `debugger-report` |
| `documenter` | read, any of write or edit | grep, find, ls, git, verify, code_nav, context, ledger, limitation | Writes docs and examples from source. It has no shell, and verification uses declared checks. | `workspace-edit` | `balanced` | 120/8 | `mutation-report` |
| `git-master` | read, any of write or edit, context, git | bash, grep, find, ls, code_nav, ledger, limitation | Runs bounded git operations end to end: history, commits, worktrees, integration merges with per-merge validation, and pull-request preparation. | `workspace-edit` | `balanced` | 40/5 | `mutation-report` |
| `tester` | read, any of write or edit | grep, find, ls, git, verify, code_nav, ledger, limitation | Adds focused deterministic regression and coverage tests. | `workspace-edit` | `balanced` | 40/5 | `mutation-report` |
| `verifier` | verify | evidence, read, grep, find, ls, git, code_nav, ledger | Runs test, lint, build, review, and release gates and reports each independently. It is the default `review.reviewer` and the default compete `judge.agent`, never the builder's own agent. | `verification` | `fast` | 20/3 | `verifier-report` |
| `wiki-writer` | read, any of write or edit | grep, find, ls, code_nav, context, ledger, limitation | Plans a repository wiki or writes one wiki page against a supplied plan. | `workspace-edit` | `balanced` | 40/6 | `artifact-report` |

Bound skills: `architect` binds `sprint-plan`; `coder` binds `fix-issue` and `ship`; `git-master` binds `fix-issue`, `ship`, `worktree-create`, and `worktree-merge`. The skill bodies live under `library/skills/`. The `coder`, `documenter`, `git-master`, and `tester` recipes declare `permissions: {git: worktree}`, which lets a worker commit inside the host-owned task worktree. `wiki-writer` declares `product: orientation`.

### Shipped Shadow and Internal Agents
Internal orchestration helpers and internal process agents. They are hidden from default displays but visible via `clio-coder agents --all`. The full on-demand catalog has a separate shadow section and omits internal recipes; the compact session prompt lists base, custom, and shadow recipes and omits internal ones. All declare `projectContextTier: none`, so they receive no CLIO-CODER.md context, and all have `capabilityClass: read-only`.

| Agent ID | Audience | Required tools | Optional tools | Purpose | Latency | Budget | Result contract |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scout` | shadow | read | grep, find, ls, context, code_nav, git, ledger | Broad repository reconnaissance with cited findings: orientation, structure and entry-point mapping, multi-file symbol hunting. | `fast` | 18/4 | `scout-report` |
| `researcher` | shadow | read | web_fetch, context, ledger, git | Extracts and compares concrete supplied URLs, standards, release notes, and papers through Clio Coder-observed reads and URL retrieval. | `deep` | 24/4 | `research-report` |
| `world-knowledge` | shadow | none | web_fetch, read, context, ledger | Current open-world discovery, ecosystem comparison, broad external context, and an advisory second opinion; reports when discovery is unavailable. | `deep` | 20/3 | `world-knowledge-report` |
| `provenance` | shadow | evidence | read, grep, find, ls, git, ledger | Reads receipts, diffs, and telemetry for evidence-backed handoffs. | `balanced` | 16/4 | `provenance-report` |
| `oracle` | shadow | read | grep, find, ls, code_nav, context, ledger | Shadow advisor behind `/oracle` that protects consistency with prior decisions and returns the strongest challenge to a question. | `deep` | 14/3 | `oracle-report` |
| `context-bootstrap` | internal | read | grep, find, ls, context, code_nav | Internal agent behind `clio-coder context init` that parses a repository and returns the CLIO-CODER.md handbook payload as JSON. | `balanced` | 40/8 | `context-handbook` |

`scout` declares `product: orientation`, which makes `code_nav` a delivery tool for its reserve window.

The builtin `architect` also serves as the default author for a version 5 playbook `plan` step. In that role it returns the coordinator-owned `delegation-plan` result shape instead of writing its ordinary plan artifact. It may name only agents from the playbook's roster. The coordinator supplies the plan step's target or profile to every admitted task.

`scout` is bound by a live-grounding contract: its whole final response is one `scout-report` object whose findings each carry the `claim` it observed and the `path:line` that grounds it, and wiki or index content is orientation only, never citable as evidence. A finding that omits `path` and `line` is accepted as an ungrounded lead and never as evidence. The recipe budget of 18 calls, 4 of them reserved for citation reads, is an advisory plan stated in the persona. A native scout run is read-only research, which enters a tool-free synthesis phase after at most 36 observed calls (see [Budget semantics](#budget-semantics)). Tool calls issued together in one model round count as one round against the synthesis backstop, so a wide parallel batch cannot consume it as separate violations. Dispatch labels its answer `reconnaissance output (advisory leads, not validation evidence):`.

Grounding is checked against the run's own reads, not just against the file. The worker records the exact line span every successful read returned, and a cited line must fall inside one. A line that exists in the file but was never read fails, which is what stops an approximated or inferred line number from passing as observation. A citation of a directory needs only that the directory exists, because a survey lists a directory rather than reading it. `grep` and `code_nav` hits are leads: read the file before citing what they point at. When a run ends on a bound with a degraded result, a citation that does not ground is dropped and its claim kept as an ungrounded lead instead of failing the run.

The three discovery roles are deliberately non-overlapping. `scout` is
repository-only reconnaissance with live `path:line` grounding and never browses
external sources. `researcher` starts from concrete URLs or documents and uses
Clio Coder-observed `read`/`web_fetch` calls to extract and compare them; `web_fetch` is
URL retrieval, not search. `world-knowledge` is for current open-world discovery,
ecosystem comparison, broad context, and an independent advisory opinion. Its
tools are all optional so it can run on a native Clio Coder target or an opaque external
worker. A native target without discovery must use caller-supplied sources or say
discovery was unavailable. Its `world-knowledge-report` separates supported
facts and supplied source identifiers from synthesis, uncertainty, and follow-up
verification; it never fabricates citations. The capability class remains
`read-only`, and every run of a `read-only` recipe receives the read-only dispatch
restriction regardless of the main agent's level.

`oracle` is the only shadow agent an operator reaches directly, and only through
`/oracle <question>`. It never receives a forked transcript. `/oracle` packs a
bounded digest instead and sends it as dispatch briefing data: the settled
decisions from the session decision board, the open tasks from the task board,
the last compaction summary when one exists, and the question. The digest is
capped at 12 KiB total, with per-section caps of 5120 bytes and 24 rows for
decisions, 3072 bytes and 24 rows for open tasks, 2048 bytes for the compaction
summary, and 1536 bytes for the question. Every cap that cuts content appends a
`[truncated]` marker, so the advisor receives an explicit indication that the
record is truncated. Entries are filtered to the active branch before the fold, so a `/tree`
switch never briefs the advisor on decisions the operator walked away from.

The run is an ordinary singular dispatch with `requestOrigin: "internal"` and
`readOnly: true`, so admission, receipts, and the Fleet Runs island apply
to it exactly as they apply to `/run`. Its `oracle-report` contract carries the
answer shape: a verdict line, the strongest challenge the advisor can mount, the
evidence that would change its verdict, and the decisions it cited. The rendered
answer reaches the main agent the way `/share` puts a worker result there, as an
operator-authored note on the ordinary user-turn path. `/oracle` during an
in-flight turn is refused rather than queued.

Every contract-bearing agent gets bounded in-worker repair. When the terminal result misses its contract, the worker replays the validator's own reason, the exact accepted shape, and the `path:line` locations this run actually read, then asks for the result again. Two repair rounds is the whole allowance; after that the run fails with `result_contract_exhausted`. This is what keeps a small local model that gathered the right evidence from being failed for a shape mistake nobody told it about.

Two rounds only help when the reason is actionable, so a validator reason names the mistake and shows the value that would have passed. A `mutation-report` with `"validations":[]` is told the array was empty and is given one entry shaped like `{"name":"npm test","passed":true,"evidence":"exit 0"}`, and a report whose entries are malformed is told which keys each entry carries. Naming the requirement alone left a small model re-emitting the same empty array through both rounds.

### Unattended finishing rule

The `coder` persona ([coder.md](../../src/domains/agents/builtins/coder.md)) carries the unattended finishing rule. It restates the task as separate clauses, including performance and robustness clauses, and checks first whether existing tests cover each clause. It writes a new reproduction test only for a clause no existing test covers, only when the task and the project instructions allow tests, following the neighboring tests and making the test fail on untouched code before the fix. Before finishing, it maps each clause to evidence in its diff or a check it ran, and it names any clause without evidence as not done in `summary`.

When a check it needs cannot run, `coder` traces every assertion of each test it added or changed through the changed source by hand and fixes any disagreement before finishing. The trace is not a validation. The check still counts as not run: `validations` lists only checks the worker executed, and the optional `declaredChecks` array of the `mutation-report` names checks not run and why the host must run them.

Only the `coder` recipe carries this rule among the shipped personas. `tester`, `debugger`, `documenter`, and the other recipes do not. The same rule is in the `operating.contract-headless` prompt fragment, which only a headless main agent (`clio-coder run`) renders. Attended sessions do not carry it. The install rule in `operating/contract.md` is separate and applies to every prompt tier: a check blocked only by dependencies that were never installed is setup, so the worker installs and reruns, while a failure confined to files the change does not touch is reported and neither repaired nor installed for. See [Worker prompt compilation](../architecture/worker-dispatch-mechanics.md#worker-prompt-compilation).

---

## Frontmatter schema

[registry.ts](../../src/domains/agents/registry.ts) parses frontmatter fields from recipe markdown:

```yaml
---
version: 1                            # recipe schema version
name: Coder                           # required non-empty string
description: Bounded code changes     # required non-empty string
tools:                                # required/optional tool mapping, not a flat list
  required: [read, {anyOf: [write, edit]}, context]   # anyOf: at least one must admit
  optional: [grep, git, verify, bash, ledger]         # attached when the target carries them
skills: [fix-issue, ship]             # knowledge attachments; require the context tool, never expand tool authority
audience: base                        # base | shadow | custom | internal
category: implement                   # explore | plan | research | implement | quality | science | evolution | operations | internal
capabilityClass: workspace-edit       # read-only | artifact-write | workspace-edit | verification | orchestration | internal
latencyClass: balanced                # fast | balanced | deep
projectContextTier: bounded           # none | bounded: whether the worker is briefed with project context
tags: [implementation, repair]        # short lowercase routing hints for catalog display
budget:                               # required worker-loop phase policy
  toolCalls: 50                       # estimate, and the boundary of enforced phases
  readReserve: 5                      # tail of the estimate reserved for reads and delivery tools
  synthesis: true                     # true: text-only final round; false: stop immediately
  # maximum: {toolCalls: 150, readReserve: 16}   # optional ceiling (architect ships one)
resultContract: {kind: mutation-report}  # typed result shape the worker must return
permissions: {git: worktree}          # optional standing allowance: git inspect|worktree, asks deny|fail|main
product: orientation                  # optional: orientation makes code_nav a delivery tool
---
```

The closed key set is defined in [recipe-schema.ts](../../src/domains/agents/recipe-schema.ts): thirteen required keys (`version`, `name`, `description`, `tools`, `skills`, `audience`, `category`, `capabilityClass`, `latencyClass`, `projectContextTier`, `budget`, `resultContract`, `tags`) and two optional keys, `product` and `permissions`. An unknown key rejects the recipe. There are no
`model`, `target`, `thinkingLevel`, or `output` frontmatter keys. Target and
model selection belong to dispatch, not the recipe.

Every recipe must declare `name`, `description`, `budget`, and every other key in the required set; no display defaults are synthesized. `budget` must be a non-null YAML object containing `toolCalls`, `readReserve`, and `synthesis`, plus an optional `maximum` ceiling object such as architect's `maximum: {toolCalls: 150, readReserve: 16}`. The numeric fields must be safe integers, `toolCalls > 0`, and `0 <= readReserve < toolCalls`; `synthesis` must be a boolean; `maximum` must not be smaller than the default phase. Unknown, missing, quoted-numeric, floating-point, null, and relationally invalid values reject the recipe with its source path and property. Scout declares `18/4/true`; the `coder` recipe declares `50/5/true`. The model-visible catalog shows the declared policy, never a mutable effective cap.

Only shipped recipes may declare the `base`, `shadow`, or `internal` audience, and a shipped recipe may not declare `custom`. Plugin, user, and project recipes must declare `audience: custom`; the discovery root determines that provenance and the parser refuses a conflicting claim.

`permissions` is a strict map with optional `git` (`inspect` or `worktree`) and `asks` (`deny`, `fail`, or `main`) keys; an unknown key or value rejects the recipe. `git: worktree` requires `capabilityClass: workspace-edit`. Absent `permissions` keeps git inspection and the fleet-wide ask route from `fleet.permissions.mode`.

A recipe must also pass the capability policy before it enters any catalog. A `workspace-edit` recipe must require `read` and `write` or `edit`. A `verification` recipe must require `verify`, may not request write, dispatch, or system-modifying tools, and may not use `bash`. An `artifact-write` recipe must require `artifact` and may not request execute or dispatch tools. A `read-only` recipe may request only read-class tools. No recipe may expose `ask_user`, and `dispatch` is reserved for `orchestration` recipes.

### Budget semantics

`budget` is the recipe's default worker-loop phase policy. A native worker applies it in one of two modes.

*   **Advisory estimate (default).** `toolCalls` and `readReserve` plan the run and are not a cutoff. When the call count reaches `toolCalls`, the next tool result carries a one-time notice to reassess and finish, and tools stay available. The hard ceiling is the recipe's `maximum.toolCalls`, or `toolCalls` when the recipe declares no `maximum`. Dispatch clamps the ceiling to `fleet.limits.toolCallsPerRun` (default `150`), and it never falls below an estimate or result-contract revision the request was admitted with. A dispatch can supply its own `budget` estimate (`toolCalls`, `readReserve`, optional `retryRevision`) for one run. What happens at the ceiling depends on the worker; see [Reporting workers and the finishing rule](../architecture/worker-dispatch-mechanics.md#reporting-workers-and-the-finishing-rule).
*   **Enforced research phases.** Native runs of `scout`, `provenance`, and `context-bootstrap` are read-only research, so their budget is enforced. After at most 36 observed tool calls (`READ_ONLY_RESEARCH_SYNTHESIS_TOOL_CALLS`; fewer when `fleet.limits.toolCallsPerRun` is smaller, and for `context-bootstrap` when its recipe or request budget is smaller) the runtime removes the tools and runs one text-only synthesis round. The last `readReserve` calls of the phase admit only `read` and the recipe's delivery tools: `write` and `edit`, plus `code_nav` for `product: orientation`.

`readReserve` is clamped to zero when canonical `read` is absent after tool admission, and to at most one less than `toolCalls`. The operator cap cannot be widened by a recipe. The admitted envelope (recipe policy, request, effective budget, and each clamp reason) is sealed in the run ledger and receipt. The Claude SDK runtime enforces a budget only in the enforced mode.

### Skills
Skills are knowledge attachments declared under `skills: [...]` in the YAML frontmatter.
*   They are injected compactly into the prompt/catalog. A shipped recipe resolves each bound skill from the package's `library/skills/` tree. A user or project recipe resolves bound skills only from the operator's discovered skill roots, and a plugin recipe only from its own plugin's skill root. A skill name that does not resolve to a trusted skill rejects the recipe.
*   They require the `context` tool to be accessible; a recipe that declares skills without requiring `context` fails spec validation. `context(scope=skills)` admits exactly the skills the recipe binds.
*   They **never** expand the agent's tool authority; they act purely as static knowledge context. A dispatch with `noSkills` omits the skill block.

---

## Dispatching agents

*   **Visibility**: Normal `clio-coder agents` lists user-visible (base/custom) agents, including configured ACP delegation agents. The command `clio-coder agents --all` includes shadow/internal specs reserved for Clio Coder orchestration, and `--json` prints the specs without their persona bodies. The `/agents` slash command opens the Library overlay on its Agents tab.
*   **Invocation limits**: User-origin `/run` and `clio-coder run --agent` **cannot** invoke shadow/internal agents. The refusal names the stand-in: for the same read-only work use `coder` with `--read-only`. Harness-origin dispatch, such as the orientation scout, accepts only recipes whose capability class is `read-only`.
*   **Orchestrator dispatch**: Internal main-agent dispatch can invoke shadow agents through the `dispatch` tool. The operating contract and Scout's catalog description steer the model to dispatch Scout for broad repository reconnaissance, while narrow file or symbol inspection remains local to the main agent. If a turn reaches 9 or more manual read-only exploration calls without completing Scout dispatch, a threshold nudge advises delegation once, as a transcript notice. It never carries the turn onward into another model round.
*   **TUI rendering and control**: Shadow and internal runs show the `↳` sub-process glyph in a subordinate tone instead of a name prefix, and a hollow `◇` or filled `◆` marks whether the operator or the model started a run. The Fleet Runs island and board show the bounded task, run ID, live tools, tokens, priced cost, retry state, and terminal outcome. Select an HTTP/SDK run to steer it or cancel any active worker/retry timer.
*   **ACP Delegation**: The `/delegate` command is reserved for ACP delegation only, which is separate from Clio Coder fleet subagents.

### Measured agent automation

An assignment may request `agent: auto`, but agent choice is advisory by default and is independent of target/model/runtime/node route activation. The coordinator first removes recipes that fail audience, capability-class, execution-role, tool-surface, result-contract, target, or policy constraints. Those are hard constraints and never become score weights. The remaining recipes are ranked deterministically with measured evidence and bounded cold-start priors.

Active agent selection requires an exact `{agentId, executionRole}` entry in `fleet.adaptiveRouting.agentRoles` and a passing readiness report for that same agent and role. Empty activation settings are the default. If no eligible agent is ready, active automation fails closed instead of falling back to the fixed requested recipe.

Scout is the bounded escalation path for broad reconnaissance, not an authority shortcut. Its strict `scout-report` may return grounded findings or a split recommendation with typed subtasks. The coordinator validates the transition, assigns fresh authority and an absolute deadline to each child, and records the decision. A recovery attempt uses the dedicated recovery role and may not silently inherit broader builder authority.

### ACP Delegation Agents as First-Class Workers

ACP delegation agents (registered under `integrations.externalAgents.entries` in `settings.yaml`) are integrated as first-class workers:
- **Automatic Routing:** When a task is dispatched to an agent ID matching a configured ACP delegation agent, the dispatch engine automatically routes the execution to that delegation agent.
- **Dynamic Spec Discovery:** The agent registry synthesizes an AgentSpec for each configured ACP delegation agent. The spec has audience `custom`, capability class `orchestration`, category `explore`, latency class `deep`, no declared tools, project context tier `none`, result contract `external-delegation`, and a 1/0 budget without synthesis. Specs are visible via `clio-coder agents`. A delegation agent receives project context only when its entry sets `projectContext: "bounded"`.

### Restricted Shadow Agent Delegation

To ensure security and proper boundary isolation, shadow and internal agents are restricted from being delegated:
- **shadow/internal Restriction:** The dispatch engine rejects any attempt to run a shadow or internal agent on an external ACP delegation worker, throwing a validation error.

### Subscription Worker Runtimes

In addition to standard HTTP targets and [Agent Client Protocol (ACP)](https://agentclientprotocol.com) delegation agents, Clio dispatches subagents to supported subscription worker runtimes:
- **`claude-sdk` (Claude Agent SDK):** Serves as a main worker runtime for driving fleet agents. It integrates with [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) alongside Clio Coder's native subagent workers (like a local [llama.cpp](https://github.com/ggerganov/llama.cpp), [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), [vLLM](https://github.com/vllm-project/vllm), or [SGLang](https://github.com/sgl-project/sglang) fleet) to execute tasks under a Claude subscription. Every tool call is mediated by Clio Coder (`canUseTool` plus a `PreToolUse` hook): the safety net and autonomy matrix apply, and the run's admitted tool surface, which is narrowed by any `tool_profile`, is enforced authoritatively. Consequently, an out-of-profile tool (for example `bash` under `minimal-local`) is denied even though the underlying preset offers it. The narrowed surface is also translated into the SDK's `disallowedTools` option as defense in depth. Because it routes tool calls through Clio Coder safety, it behaves as a native worker. The SDK package is not part of the default install. The first dispatch to `claude-sdk` asks the operator once to install it into Clio Coder's own package root, and without an operator the error prints the package-manager command.
- **`claude-code` (Claude Subprocess):** Runs `claude -p` as a subprocess worker with `--permission-mode acceptEdits`, or with `plan` and a read-only `--tools` list for a read-only dispatch. It is a black box: tool calls run inside the `claude` process and are not routed through Clio Coder's per-tool mediation, so Clio cannot enforce a per-tool profile on it. Dispatching a narrowing `tool_profile` (`minimal-local` or `science-local`) to this runtime is refused; use `full-agent` (or a native / `claude-sdk` worker) instead.
- **`antigravity-code` (Antigravity CLI, experimental local delegation):** Runs the operator-installed and authenticated official `agy` command as a local external delegation worker. It is useful for a `world-knowledge` pass, a second opinion, or another bounded one-shot subtask; it is never an orchestrator or Gemini chat backend. Clio Coder consumes agy's structured stream and live model catalog but cannot mediate individual tools, so a narrowing `tool_profile` is refused rather than silently ignored. The `world-knowledge` binding is permanently read-only.

Agent budgets follow the same mediation boundary. Native workers and `claude-sdk` mediate every tool call, so the budget policy in [Budget semantics](#budget-semantics) applies to them. An opaque external loop instead receives an `external-one-shot` enforcement classification: Clio enforces one subprocess launch, its deadline, output cap, cancellation, and result-contract validation, while recording recipe per-tool numbers as `unobserved-not-enforced`. Receipts and status never label those internal per-tool limits enforced, and Clio never automatically retries a generating external-agent run. Claude vendor aliases never appear in recipes or prompt authority and cannot reintroduce a canonical tool removed by admission.

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

Dispatch admission checks, among others:

1. The recipe passes the capability policy, and a `tool_profile` only narrows the declared tools.
2. After the target and runtime narrow the tool surface, every required tool is still present. Otherwise admission fails with the missing tools named.
3. Every action class the admitted tools request is allowed by the worker scope.
4. The worker scope is a subset of the orchestrator's active scope.
5. A user-origin request does not name a shadow or internal agent, and a read-only recipe is not pointed at a task that must change the workspace.

### Ad-hoc specialists

The dispatch tool can compose an ephemeral specialist for one task object with
`persona` and `tool_profile`. `persona` replaces the recipe body inside the
same stable worker shell used for recipe runs; it does not replace Clio Coder's task
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
system prompt. The stable system prompt is fixed per recipe and tool surface, plus
the operator-editable rule fragments selected by the request's path scope. The
messages, in the order a worker reads them, each present only when it applies:

- **Inherited context** (`context.mode` of `fork` or `splice`): a fixed preamble for a fork, whose history is seeded separately, or the splice packet text. See [worker context](../architecture/worker-context.md).
- **Workspace**: the worker's working root and its top-level entries, capped at 600 characters.
- **Project orientation** (recipes with `projectContextTier: bounded`): the codemap, orientation, and wiki discovery fragments, up to 2,400 characters, even when no handbook exists.
- **Project context** (recipes with `projectContextTier: bounded`): the
  `CLIO-CODER.md` rules routed to this worker's role and dispatch paths, within
  6,000 characters, with every unselected section named. Handbook prose without
  routable sections keeps a verbatim prefix of at most 1,500 characters, and a project with no
  handbook file contributes its structured name, conventions, and invariants within the same
  limit, plus verification expectations for a verification-class recipe. Recipes with
  tier `none` get none. See
  [worker routing](../architecture/context-engine.md).
- **Safety posture** (every run, including ACP delegation). A native worker reads that the permit in its instructions applies, the worker permission routing (`deny`, `fail`, or `escalate`), and a sandbox line. An ACP delegation reads one line naming the run's effective autonomy level with the same directive text the session prompt's safety section uses.
- **Read-only notice** for a read-only dispatch.
- **Declared result requirements**: the `expected_outputs` and `verification` entries of a typed dispatch intent, labeled as requirements and never as evidence.
- **Compete stance** for a compete candidate.
- **Memory** (when the request carries an approved memory section).
- **Agent ledger** (when the dispatch unit has more than one concurrent peer): the shared board of path claims, findings, and reviews, capped at 4,000 characters and labeled as untrusted peer data.
- **Briefing**: the dispatching agent's briefing, inside `<<<DISPATCH-BRIEFING ... DISPATCH-BRIEFING>>>` and labeled as untrusted context data.
- **Predecessor handoffs** (playbook steps with declared dependencies): each predecessor's output inside `<<<PREDECESSOR ... >>>` markers, labeled as data.
- **Pipeline input** (`pipeline`-mode steps after the first): the previous
  step's final assistant output, threaded as data inside a fixed
  `<<<PIPELINE-INPUT ... PIPELINE-INPUT>>>` delimiter and labeled as input,
  not instructions. It is ordered last, adjacent to the task,
  and capped at 12000 characters; the receiving run's receipt records
  `pipeline` provenance (source run, step position, input bytes, whether the
  cap truncated it). Step 1 and every non-pipeline run get none. The `pipeline`
  and `personaOverride` field shapes and their stability labels are documented
  in the [receipt provenance schema](../architecture/observability.md).

---

## Fleet Management and Fault Tolerance

Clio Coder manages running subagent tasks, tracks token costs, and handles task failures. It operates under specific safety, concurrency, and retry limits. The classification, exclusion, and delay rules are specified in [Failure classification and retries](../architecture/worker-dispatch-mechanics.md#51-failure-classification-and-retries).

### 1. In-Memory Retry Queue
Subagent runs that terminate with retryable outcomes are placed in an in-memory retry queue. The queue does not survive process restarts. The retryable outcomes are:
- `failed`: The subagent process exited non-zero or returned an error receipt.
- `timed_out`: The run or delegation turn exceeded its timeout limit.
- `stalled`: The run exceeded the event-inactivity window without progress or stopped responding to heartbeats.
- `spawn_failed`: The runtime failed to spawn the subprocess or establish connection. The spawn error's own text, such as `spawn <path> ENOENT`, is sealed in the receipt's `outcomeDetail` and `failureMessage`.

### 2. Retry limits
`fleet.retry.maxRetries` (default `2`) bounds the retries per assignment. Deterministic failures are never retried, for example `information_flow_blocked`, `result_contract_exhausted`, `worker_tool_call_cap_exhausted`, `worker_context_exhausted`, `host_verification_rejected`, `worker_no_work`, `merge_withheld`, and `worker_removed_tests`. A provider 4xx answer other than 401, 403, 408, and 429 is deterministic as well. A retry is also suppressed when the failed attempt may have changed the workspace: a successful mutating tool call, or incomplete tool telemetry that cannot prove the workspace is unchanged. An `information_flow_blocked` refusal ends the worker run without retry or failover. One-shot external agent loops are never retried automatically.

### 3. Backoff and Cooldown
Scheduled retries use exponential backoff that starts at 500 ms, doubles, and caps at 60 seconds; a rate-limit failure waits at least 1 second. A failed target also enters a route cooldown (`fleet.retry.routeCooldownMs`, default 15000 ms), but the cooldown gates new dispatches only. It does not delay retries of an in-flight assignment, which `fleet.retry.maxRetries` and the backoff bound. Retries are brand-new runs that must re-pass all admission checks. If target policies or budgets deny a retry, the task chain terminates as denied.

### 4. Concurrency Limits
The setting `fleet.concurrency` restricts the number of concurrent subagent tasks. `auto` sizes the local node from usable CPUs, available memory, and any cgroup memory limit, up to eight workers; see [Fleet dispatch](fleet-dispatch.md) and [Capacity and scheduling](../architecture/capacity-and-scheduling.md).

### 5. Heartbeats and Reconciler
For native subprocess workers, Clio uses a heartbeat mechanism. The reconciler monitors the time since the last frame from the worker. A worker silent for more than 15 seconds is terminated automatically and its run finalizes as `stalled`; the thresholds are in [Heartbeats and the Watchdog](../architecture/worker-dispatch-mechanics.md#3-heartbeats-and-the-watchdog).

### 6. Worker Permission Postures
A dispatched worker has no operator by default, so a tool call that requires interactive permission must resolve within bounded time. The `fleet.permissions.mode` setting picks the posture:

- `deny` (default): the parked call becomes a structured tool denial and the run continues. The denial of an execute call names the command and the rule ([format](../architecture/worker-dispatch-mechanics.md#worker-denial-format)), and the third refused execute call ends the run with exit `3` and outcome `permission_required` ([refusal limit](../architecture/worker-dispatch-mechanics.md#worker-refusal-limit)). The Claude SDK runtime ends at its first execute refusal.
- `fail`: the run finalizes at the first refusal with outcome `failed`/`permission_required`.
- `escalate`: the parked call is handed up to the interactive operator. The worker emits a `clio_coder_permission_escalated` event over its stdout; the dispatch domain republishes it on the bus as a permission request tagged with the run id; the operator resolves it in the TUI permission overlay; and the decision travels back down the worker's stdin as a `permission_decision` line (the same pipe steers use). Under `escalate` only the operator can approve.
- `main`: the parked call goes to the main agent, which decides it with `steer`. The main agent can grant an ordinary autonomy ask only when it runs at `yolo`, the call is inside the worker's permit and the operator's delegation ceiling for the turn, and the same call would be admitted as the main agent's own at `yolo`; the worker still re-admits the call under its unchanged permit before it runs. Below `yolo` with an operator attached, the main agent's approval becomes an ask to the operator; headless below `yolo`, the ask is denied at once. Operator-authority asks, hard blocks, gateway-wrapped calls and calls too large to evaluate are never main-grantable. Only native local workers can take main-agent grants.

Escalate is only meaningful with an interactive operator attached. Headless sessions have no subscriber, so the escalation resolves by the timeout fallback. The bounds are `fleet.permissions.escalation` (`{ timeoutMs, fallback }`, defaults 120000 ms and `deny`): a parked ask that no operator answers within `timeoutMs` applies the fallback deny/fail, so an escalate-posture run can never hang forever. The heartbeat timer runs independently of the parked call, so an escalated worker keeps reporting alive while it waits. Each escalation and its resolution (operator or timeout) is tallied on the receipt's `safety.decisions` escalation counters, documented with their stability labels in the [receipt provenance schema](../architecture/observability.md#receipt-fields-for-dispatch-provenance); a timed-out or denied escalation also raises an `escalation` finding in the evidence bundle. ACP delegations are out of scope: they resolve permissions through their own mediator and have no worker stdin channel.

---


## Adding a project agent

Create `.clio-coder/agents/my-agent.md`:

```md
---
version: 1
name: My Agent
description: Focused local review helper.
tools:
  required: [read, artifact]
  optional: [grep, find, ls, git]
skills: []
audience: custom
category: quality
capabilityClass: artifact-write
latencyClass: balanced
projectContextTier: bounded
budget: {toolCalls: 20, readReserve: 4, synthesis: true}
resultContract: {kind: artifact-report}
tags: [review]
---

You are My Agent. Inspect only the requested area. Never edit files. End by writing a concise review artifact (`artifact` kind="review") with risks, evidence, and follow-up tests.
```

Then run:

```bash
clio-coder agents
clio-coder run --agent my-agent "Review the parser change."
```
