# System One

System One is an experimental decision layer. Clio Coder asks a fast decision model calibrated questions at fixed decision sites. The model reads a bounded, redacted state about one object (the operator's request, a proposed tool call, a tool result, a finished turn, a catalog) and returns probabilities, which Clio Coder's policy may turn into hints, a ranking, advice or preparation. System One never answers the operator, never edits anything and never removes friction that Clio Coder's own safety rules impose.

Experimental means that its sites, settings keys and shipped cuts may change between releases. Every surface that shows System One says so: the comment above `systemOne` in the settings file, the `/settings` rows, the GUI's settings group, doctor, the `systemone` CLI help and the approval-card advisory.

It is off until you bind an engine to a site. With nothing bound, Clio Coder's behavior is unchanged. Nothing waits on a decision engine, fitted or not: turn start, tool admission, tool-result delivery, turn settlement and prompt composition never await an answer. Each call runs detached, and its answer is used only if it is already available when a reader looks; otherwise it is only recorded. Every failure of a bound engine (timeout, refusal, unusable reply) leaves the unbound behavior in place. The design contract is in [System One Architecture](../architecture/system-one.md).

## The ladder

Decision engines come in four tiers. No tier turns on the next one.

| Tier | What answers | What it is useful for |
| --- | --- | --- |
| 0. Shipped defaults | Nothing is bound. | Deterministic behavior everywhere. This is the product. |
| 1. Base chat model | An `llm` engine over a chat target you already use. | `/draft` judging, the approval-card advisory and `consult`. These are asked only while an approval card or the `/draft` overlay is open, or when the agent calls `consult`. Every other site costs two requests per question with logprobs, or five without, and an unfitted build never acts on them. |
| 2. Local decision model | A `systemone` engine with a `profile` (Strands Decider, Julia-1, Laya, GLiNER) on a server you run, placed on a processor the chat model does not use: the integrated GPU, the NPU or the CPU. | Advice and recording. The card advisory, `consult` and `/draft` use its answers at once. No local build ships with fitted cuts, so every other site only records what it would have said. |
| 3. Hosted API engine | A `systemone` engine over the `typesafe-jev` runtime. | The shipped cuts for the `jev-1.13.0` build: turn hints and acts when the reading lands in time, and catalog rankings. The redacted state leaves the machine. |

A tier 2 model costs no hosted API fee, but it still uses your hardware, and a detached call can compete with the chat model on a shared server. A decision model is small enough to run on a processor the chat model leaves idle, which is what [Placing engines](#placing-engines) is about.

### Tier 2 placements, measured

These are research measurements of one checkpoint, the Strands Decider 2B (`strands-decider-2B-hobson-v19`), on one Strix Halo laptop (Ryzen AI Max+ PRO 395, Radeon 8060S iGPU, XDNA2 NPU, 128 GB of unified memory) with Gemma-4-26B resident on the iGPU throughout. Decisions made while Gemma was generating were not measured. They come from a research harness outside this repository, and Clio Coder ships none of these servers and no command that reproduces them. The numbers describe that machine and those inputs. They are not a benchmark.

| Placement | Server | Short state p50 | 1,000-token state p50 | Memory |
| --- | --- | --- | --- | --- |
| iGPU | PyTorch 2.9.1 with ROCm 7.2.1, bf16 | 128 to 138 ms | 515 to 523 ms | 4.66 GiB committed GPU memory at peak |
| NPU | The FastFlowLM engine running the merged torso in Q4_K, with the pointer head on the CPU in numpy | 539 to 553 ms | 1,110 to 1,117 ms | 3.73 GiB working set |
| CPU | PyTorch on the CPU cores of the same chip, float32 | 683 to 746 ms | 7.8 to 8.4 s | 7.62 GiB resident after load |

Each row is one question (a yes/no, a three-way choice and a three-level score) after two warm-up calls, 20 samples per cell. The short state is 74 to 86 tokens with its question. On the NPU most of a short call is the engine's fixed prefill cost (prefill p50 467 to 484 ms), and the engine answers one question per prefill, so a request with six questions costs six prefills. Against the CPU PyTorch reference, the Q4_K NPU build picked the same top answer for 32 of 33 questions, with a largest probability difference per question of 0.037 at the median and 0.096 at worst.

Through Clio Coder's `systemone` runtime to the iGPU service, a `turn` request with eight questions took 2,250 ms at p50, and every `turn` sample missed that site's 600 ms deadline, so leave `turn` unbound on these placements. The `consult`, `toolCall`, `toolResult` and `turnEnd` sites finished inside their deadlines on every sample.

Each placement reports its own build (the iGPU service reports `...-pytorch2.9.1-rocm7.2.1-bf16`, the NPU server `...-merged-q4k-flm-xdna2`), and cuts are keyed by build. A cut fitted on one placement therefore never applies to another, which is right: Q4_K weights on the NPU do not produce the bf16 numbers.

## Quick start

Each example is a complete `systemOne` block. Bind only the sites you want.

**Tier 1, the chat model for drafts and approval cards.** Name a chat target you already use:

```yaml
systemOne:
  engines:
    chat:
      kind: llm
      target: my-chat-target
  sites:
    drafts: chat
    toolCall: chat
```

`/draft` then names the candidate to read first, and an open approval card can show one advisory line. A bound `toolCall` site also reads, at autonomy `yolo`, each command the classifier did not recognize, in the background and for the record only; those requests go to the same endpoint.

**Tier 2, a local decision model.** Serve the model behind a server that answers `POST /v1/systemone` (for example the Julia adapter, `laya-serve` or a Strands Decider service), add it as a target on the `systemone` runtime with the window the checkpoint reads, and name its capability profile:

```yaml
targets:
  - id: decider-gpu
    runtime: systemone
    url: http://127.0.0.1:13306/v1   # where your server listens
    capabilities:
      contextWindow: 4096

systemOne:
  engines:
    decider:
      kind: systemone
      target: decider-gpu
      profile: strands-decider
  sites:
    consult: decider
    toolCall: decider
    toolResult: decider
    turnEnd: decider
  record: true
```

The `systemone` runtime assumes a 480-token window, so raise `capabilities.contextWindow` to what the served checkpoint actually reads: 4096 for the Strands Decider, 1024 for Julia-1 at the window its published accuracy used. A call whose state and longest question do not fit is not sent. With `record: true`, each answer and what followed it is kept in the local dataset, from which cuts can be fitted.

**Tier 3, the hosted engine.** The `typesafe-jev` runtime reads `TYPESAFE_API_KEY`:

```yaml
targets:
  - id: jev
    runtime: typesafe-jev
    defaultModel: jev-latest

systemOne:
  engines:
    jev:
      kind: systemone
      target: jev
  sites:
    turn: jev
    toolCall: jev
    relevance: jev
```

Then run `clio-coder doctor` and read the `system one (experimental)` rows, or run `clio-coder systemone status`. A site binding applies from the next turn. Only the `consult` site needs a restart.

## Placing engines

Clio Coder does not schedule a decision engine and has no placement setting. The server you run owns its device; Clio sees a URL, a window, a profile and the build the server reports. Placement is therefore a choice you make when you start each server, and naming each target after its placement (`decider-npu`) is what makes the doctor rows read as a map of the machine.

The rule is to put each model on a processor nothing else is using. A turn makes many closed decisions, each one a forward pass of a small model; the chat model makes the open-ended ones. Running both on one accelerator makes them queue behind each other, while a second accelerator that would otherwise sit idle runs the decisions for free.

### Placing engines on Strix Halo

A Strix Halo machine has three processors on one package: the integrated GPU, the XDNA2 NPU and the CPU cores. All three read the same 128 GB pool, so placing a model moves no weights across a bus, and the budget is the sum of what is resident.

- **iGPU: the chat model.** It needs the bandwidth and the large matrix units. Gemma-4-26B held about 27 GiB of committed GPU memory while the deciders above ran beside it.
- **NPU: the decider.** It is idle while the iGPU generates. It runs the Strands Decider 2B at about half a second per question, so bind it to sites whose deadlines allow that: `toolResult` (1500 ms), `consult` (3000 ms), `turnEnd` and the approval-card advisory (5000 ms). Leave `turn` (600 ms) unbound on it. Two engine processes serialize on the NPU, so run one decision server there. The research server answers one question per prefill, so the six `turnEnd` questions took 3.6 to 5.0 s; nothing waits on `turnEnd`, so give that binding a longer `timeoutMs` rather than let a reading time out at the 5000 ms default.
- **CPU: Julia-1, or nothing.** The CPU suits a small encoder such as Julia-1 (144M parameters, 550 MiB in float32), or the rules-only tier of [Proactive Memory](proactive-memory.md), which makes no model calls. The 2B decider on the CPU took 7.8 to 8.4 s at 1,000 tokens, past every site deadline. Julia-1 reads options of at most 48 tokens. When a `julia-1` engine is bound, Clio downloads Julia-1's tokenizer once from the model's repository (about 34 MB, pinned by revision and hash), stores it in its cache, and uses it to count the option tokens. Until that file is cached, or offline, Clio proves option length by bytes instead and abstains on most sites. With it cached, Julia-1 answers `turn`, `toolCall`, `turnEnd` and `consult`. Clio estimates a state at one token per four characters, so a `toolResult` state beyond roughly 3,400 characters exceeds a 1,024-token window and is skipped before sending. `clio-coder doctor` says which mode an engine is in.
- **When latency matters more than isolation,** the decider on the iGPU is about four times faster than on the NPU for short states and twice as fast at 1,000 tokens, and it stayed resident beside Gemma-4-26B. It then shares the iGPU with the chat model, so a decision and a generation can wait for each other.

One configuration with all three placements:

```yaml
targets:
  - id: decider-gpu            # Strands Decider 2B on the iGPU
    runtime: systemone
    url: http://127.0.0.1:13306/v1
    capabilities:
      contextWindow: 4096
  - id: decider-npu            # Strands Decider 2B on the NPU
    runtime: systemone
    url: http://127.0.0.1:13307/v1
    capabilities:
      contextWindow: 4096
  - id: julia-cpu              # Julia-1 on the CPU cores
    runtime: systemone
    url: http://127.0.0.1:13308/v1
    capabilities:
      contextWindow: 1024

systemOne:
  engines:
    gpu:
      kind: systemone
      target: decider-gpu
      profile: strands-decider
    npu:
      kind: systemone
      target: decider-npu
      profile: strands-decider
    julia:
      kind: systemone
      target: julia-cpu
      profile: julia-1
  sites:
    turn: julia
    consult: julia
    toolCall: gpu
    toolResult: npu
    turnEnd: { engine: npu, timeoutMs: 8000 }
    drafts: npu
```

Bind any site to any engine; a site's `tasks` map can also send one of its tasks to an engine on another processor. An engine that does not answer leaves its sites behaving as if unbound, so a placement can be stopped without editing settings. `clio-coder doctor` shows one row per engine with its profile, window and round trip.

The NPU numbers above come from a research harness that drives the FastFlowLM engine directly and serves `POST /v1/systemone`; it is not a product and no supported NPU server for decision models exists yet. Any server that puts a decision model on an NPU and speaks the wire is configured the same way: a `systemone` target, the window the checkpoint reads and the profile of the model.

### Other machines

The same placement logic applies wherever a machine has an accelerator the chat model leaves idle: Apple's Neural Engine beside the GPU that serves the chat model, or a phone's NPU beside its CPU. Nothing in Clio Coder is specific to AMD; what is missing is a server that runs a decision model on that accelerator and answers `POST /v1/systemone`. Once one exists, it is a target with a URL, a window and a profile like any other.

## What System One is not

- It is not the main model and does not change which model answers you.
- It is not a safety net. The yolo gate and the tool-result classifier only record, and the classifier, damage-control rules and protected paths decide.
- It is not required for any feature. Every consumer keeps its previous behavior when System One is absent, unbound, slow, failed or unfitted.

## The `systemOne` settings block

| Key | Default | When it applies |
| --- | --- | --- |
| `systemOne.engines` | `{}` | next turn |
| `systemOne.sites` | `{}` | next turn; `systemOne.sites.consult` on restart |
| `systemOne.cuts` | `{}` | next turn |
| `systemOne.record` | `false` | next turn |
| `systemOne.retentionDays` | `30` | next turn |
| `systemOne.maxMiB` | `64` | next turn |

`systemOne.engines` is a map from an engine name you choose to an engine definition:

| Field | Meaning |
| --- | --- |
| `kind` | `systemone` for a server that answers `POST /v1/systemone`, or `llm` for an ordinary chat target read as a decider. Required. |
| `target` | A `targets[].id`. Required. A name that is not in `targets` is a settings error. |
| `model` | The wire model id. Absent means the target's default model. |
| `mode` | `auto` (the default), `logprobs` or `answer`. Only valid on `kind: llm`. `auto` uses first-token logprobs when the server returns them and falls back to five votes when it does not. |
| `profile` | The capability profile of the served model: `generic` (the default), `jev`, `laya`, `laya-multilingual`, `julia-1`, `gliner2.5-small`, `gliner2.5-decide` or `strands-decider`. Only valid on `kind: systemone`. It declares which decision tasks the model may be asked and the limits its publisher states, so a question the model cannot carry is abstained on before any byte leaves. It is a declaration, not a measurement: it installs nothing and makes no build fitted. The profiles are tabulated in [Capability profiles](../architecture/system-one.md#capability-profiles). |

`systemOne.sites` maps a site id (`turn`, `toolCall`, `toolResult`, `turnEnd`, `relevance`, `consult`, `drafts`, `steer`) to an engine name, or to `{ engine, timeoutMs, tasks }`, where both other fields are optional. `timeoutMs` replaces the site's default deadline for that binding and must be an integer of at least 1. `tasks` routes one decision task of the site to another declared engine, for example `turn: { engine: jev, tasks: { recipe: julia } }`; the questions of that task go to the named engine and the rest to the site's own. The tasks a site asks are `intent`, `recipe` and `clusterSelect` at `turn`, `toolRisk` at `toolCall`, `injection` at `toolResult`, `turnEnd` at `turnEnd`, `relevance` and `clusterSelect` at `relevance`, `consult` at `consult`, `drafts` at `drafts` and `steer` at `steer`. A routed engine that cannot answer leaves its task unanswered rather than falling back to the site's engine. A site with no entry is off, and a site set to `null` is off too, which lets a later settings layer turn off a site an earlier layer binds. An engine name that `systemOne.engines` does not define, or a task the site does not ask, is a settings error.

`systemOne.cuts` maps an answering build to fitted overrides. See [Calibration and shadow mode](#calibration-and-shadow-mode).

`systemOne.record` turns the local training dataset on. `systemOne.retentionDays` and `systemOne.maxMiB` bound it and must be integers of at least 1. See [The training dataset](#the-training-dataset).

The terminal `/settings` overlay lists the site bindings and the dataset keys under Advanced, Experimental. A site row binds the site to an engine already declared in the settings file and keeps the binding's `timeoutMs` and `tasks`; engines and cuts are edited in the file. The GUI shows only the dataset controls, in its "Decision engines (experimental)" group, with a line saying where the rest is set. A running session re-reads the block on every call, so an edited engine or binding applies to the next question without a restart. The defaults are in `src/core/defaults.ts`, validation is in `src/core/config.ts`, and effect timing is classified in `src/domains/config/classify.ts`.

## Engines

An engine answers typed questions for a state. Clio Coder builds one engine per configured name and rebuilds it only when its own configuration changes. The mechanics of each kind are in [Engines](../architecture/system-one.md#engines) on the architecture page.

### Engine kind `systemone`

The target's runtime must implement typed decisions: `typesafe-jev` (a hosted decision engine, default model `jev-latest`, credential `TYPESAFE_API_KEY`) or `systemone` (a self-hosted server, with a default 480-token window that `capabilities.contextWindow` raises). Answers are calibrated probabilities, and the engine's `profile` decides which questions it is sent. The answering build is the model name the server reports, for example `jev-1.13.0`, and every cut is keyed by it. Clio Coder's shipped cuts are fitted for the hosted engine's `jev-1.13.0` build. Any other build on the same wire, including a self-hosted one, is validated the same way, by fitting cuts on that exact build. Binding a chat-only runtime with `kind: systemone` is reported as a problem by doctor.

### Engine kind `llm`

Any chat target Clio already knows can act as an engine. The target needs a chat wire and a model, or a runtime that Clio can call one-shot. No LLM build has fitted cuts, so an LLM engine runs in shadow until you supply cuts for its exact build string, `llm:<runtime>@<host>/<model>#<mode>:<prompt version>`. A runtime that cannot return logprobs can only vote, and policy reads an uncalibrated yes or no as no answer even with a cut; the card advisory, `consult` and `/draft` still use votes. A call whose state does not fit the target's window is not sent. A question costs two requests with logprobs and five without, which is why only the on-demand sites suit a base model.

Every request an `llm` engine sends, including schema retries, passes the same paid-request admission as the main session. It counts toward the session's cost ceiling and token totals and is recorded under `system-one`, which `/usage` and `clio-coder usage report` show as System One calls without counting them as turns. Admission never waits for a ceiling raise: a refused request fails the whole decision, and the site behaves as if System One were absent. With `safety.limits.sessionCostUsd: 0` there is no ceiling, so admission refuses no request for cost.

## Decision sites

A site is named by the object it judges. One call to a site carries one bounded state and every question about that state. The deadline bounds the call, which nothing waits on except the `consult` tool and the `/draft` judge; `timeoutMs` on the binding replaces the default. How a site is defined and read is in [Sites are keyed by the object they judge](../architecture/system-one.md#sites-are-keyed-by-the-object-they-judge) and [Where sites are read](../architecture/system-one.md#where-sites-are-read).

| Site | Judges | Default deadline | What its answer does |
| --- | --- | --- | --- |
| `turn` | The operator's request, read at submit | 600 ms | Under a fitted build, hints, orientation, direction, dispatch expectation and prewarm, when the reading lands in time. Otherwise recorded. |
| `toolCall` | A proposed tool call | 5000 ms for the approval card, 1500 ms for the yolo gate | Card advisory. The yolo gate only records. |
| `toolResult` | Content returned by `web_fetch`, `web_read` and MCP tools | 1500 ms | Recorded only. |
| `turnEnd` | The assistant's finished message | 5000 ms | Recorded only. |
| `relevance` | Catalog entries against a need | 1500 ms | Reorders skills, gateway capabilities and memory from a finished ranking. |
| `consult` | Evidence the main agent supplies | 3000 ms | The `consult` tool. |
| `drafts` | Candidate answers | 5000 ms | `/draft` judging. |
| `steer` | A message the operator queued during a run | 3000 ms | Recorded only. |

### `turn`: hints and acts that land in time

The site asks whether the request is answerable without the workspace, whether it is work for workers, its shape (single, parallel, sequence, council), its intent, whether it asks for an orientation tour or is an undecided follow-up, and which installed recipe a dispatch would name first.

The call starts when you submit and nothing waits for it. Its readers take a reading only if it has landed when they read, and only from a fitted build: the turn controller reads it before the prompt is built, and the hint registration, plan-close and the prewarm read it as the prompt is built. A reading that lands later, or comes from a build without a fitted cut, is only recorded. A canceled turn does not abort the call, so its reading is still recorded. A landed, fitted reading can:

- Add a `[Scope]` hint: the request reads as answerable without inspecting the workspace, so answer directly.
- Add a `[Plan]` hint: the request reads as work suited to workers, so the delegation rules apply. It is suppressed when the request already names delegation.
- Tell the turn controller that an orientation or a direction workflow is wanted (`turnControl.workflows`), and that a dispatch is expected. An expected dispatch suppresses the orientation scout only when its probability is at least the orientation probability, so a request that reads more like a tour than a dispatch still gets the scout (an engine that reports no probabilities keeps the plain expectation). The shipped cut for the orientation reading is high, so the orientation scout fires only when the request explicitly asks for a tour of the project. Without a reading the turn controller can only collect finished background runs, and it skips the Git and ledger reads the other workflows need.
- Predict the worker about to be dispatched so its process can be held ready. This prewarm runs only when `fleet.speculativeDispatch` is true, which is also experimental, and it holds two workers for a parallel shape and one otherwise. A recipe catalog larger than the engine reads in one question is asked by the catalog's own categories first, and a recipe chosen by category is picked by a second call chained after the first, never by a second wait. Both steps need the `turn.recipeGroup` and `turn.recipeInGroup` cuts, which no shipped build has, so they act only under operator cuts. A catalog whose recipes carry no categories is not asked, and the reason is recorded.

Every hint and act is a suggestion the main agent or the turn controller may ignore.

### `toolCall`: approval-card advisory and the yolo gate

The site rates the blast radius of a call on a four-rung ladder (`contained`, `local`, `broad`, `irreversible`) and asks whether it reaches outside the workspace and whether it destroys data that version control or a reinstall cannot restore. It sees only the call's allowlisted, secret-redacted one-line target, never raw arguments.

- **Card advisory.** While an approval card is open in the TUI, one advisory sentence can appear: "Experimental advisory only, nothing below is gated on it: blast radius reads as `<rung>`", followed by whether the call reaches outside the workspace when the engine was decided about that, and by "Judged by `<build>`". It reads no cut, so any build's answer can appear. It is not waited on, so it cannot delay an approval, and it changes nothing about allow, deny or stop. An undecided reading shows nothing.
- **Yolo gate.** At autonomy `yolo`, in an interactive session only, an `execute` call that the classifier did not recognize (which `yolo` runs unread) is read by the gate as it starts running. The gate is experimental and record-only: the call is admitted exactly as `yolo` admits it, nothing waits for the engine, and no confirmation card is raised, fitted build or not. The reading is recorded under the tool call id. It never sees calls the classifier already parks, blocks or recognizes, and headless runs and ACP sessions never reach it.

### `toolResult`: reading external content for the record

Only results from `web_fetch`, `web_read` and MCP tools are read. They carry third parties' text. Clio Coder's own listings, recipes and worker reports are written to direct an agent and are never sent. The result reaches the agent at once and unchanged, labeled only by the deterministic marker scan and the tool's own untrusted-content banner. The site reads it detached for instructions aimed at an agent and its reading is recorded. It adds no banner, so a late reading can never label content the agent has already read. A result that carries an information-flow restriction is not sent to an engine whose destination that restriction does not allow.

### `turnEnd`: recorded readings of the finished turn

After a turn settles, the site reads the assistant's final message, detached. Its readings (whether the message asks the operator something, blocks on a decision, announced work never started, claims a passing check, finished a unit of work, stopped mid-operation or moved on from the request) are recorded beside the turn outcome. Settlement never waits for them, and the clarification streak that gates the `direction` workflow keeps its own regex reading of the closing text.

No prose-question nudge reads the reply. Turn-ending guidance lives in the prompt and the `ask_user` result. The plan-close registration uses explicit proposal mode, the intent of a fitted `turn` reading that landed in time, or, without one, the operator's request naming a plan; never this site's reading of the reply.

### `steer`: recorded readings of queued messages

When a message is queued during a run, the site reads it detached: how it relates to the work in progress (a correction, an addition, a new task, a stop, a question) and how soon it should land. Nothing reads the answer; delivery follows the operator's keys and the queue navigator. What became of the entry (delivered at which slot after how long, removed and why, relabeled by whom) is recorded as outcome rows joined to the reading by the entry id. No cut exists for this site, so no build can act on it.

### `relevance`: ranking skills, capabilities and memory

Long catalogs are ranked by local vocabulary first. This site scores the pruned entries by meaning, and the caller uses the scores only to reorder a skills listing or gateway result, or to add related entries beside a query's own hits. It never removes an entry and never reorders entries a query matched.

A listing never waits for this site. The ranker answers from rankings that have already finished, kept by catalog, question, binding and the session's flow restrictions. On a miss the listing keeps its order, and one detached call fills the ranking for the next listing that asks the same thing. A build without the `relevance.ranked` marker never reorders anything, and once it is known to be unfitted it is asked only when `systemOne.record` is on. One call scores up to 256 entries that fit the engine's window. A larger catalog is asked by its categories, which needs a `clusters` cut that no build has yet and entries that carry described categories, so such a listing keeps its order and leaves no decision row.

### `consult`: the agent asks directly

When the `consult` site is bound at startup, the main agent gets a `consult` tool, behind the gateway. It sends one to four typed questions (`yesNo`, `pick`, `rate`) about a small `state` (at most 2 KB as JSON) and up to eight workspace `paths` (the first 6,000 characters of each, secrets redacted, under the same containment and protected-path rules as `read`; a file that fails a check is skipped and named with its reason). A question is at most 400 characters, and a `pick` or `rate` takes 2 to 8 options or rungs of at most 200 characters each. It returns the probability distribution per question, the answering build, the engine and the latency, never a chosen option. The tool waits for its answer up to the deadline, because the agent chose to ask, and when no answer arrives it says so and tells the agent to proceed with its own assessment. At most three calls per turn. Workers never get it. Consult has no cut, so an unfitted build answers exactly as a fitted one. Evidence files carry their information-flow restrictions into the check. Because the tool set is built at startup, binding or unbinding `systemOne.sites.consult` needs a restart.

### `drafts`: judging `/draft`

`/draft [count] <request>` runs 2 to 4 candidate answers in parallel (3 by default). With `systemOne.sites.drafts` bound, one `choice` question over the candidates says which to read first and how decisive that pick was, and soundness is shown as advice. Nothing here enters the session by itself. `Enter` on a finished draft closes the overlay and appends that draft's text to the composer below anything already typed. It is never sent. Candidates are spread by sampling temperature, except for models that refuse a sampler (Claude models from 4.7 on, Codex and reasoning OpenAI or Azure Responses models, and any model whose compat block sets `supportsTemperature: false`). Those candidates run without `temperature` and differ through a different prompt angle each. If a provider still answers with an `Unsupported parameter: temperature` style rejection, that candidate is retried once without it. When a judge call exists, taking a draft also records a `draft` outcome row holding the label taken, the judge's pick and whether they agreed. `Esc` records nothing. The legend shows `Enter use` only while the selected draft can be taken. Unbound, the overlay says the candidates were not judged and names the key to bind.

## Calibration and shadow mode

A probability means something only for the build that produced it. Clio Coder therefore keys every cut by the answering build, extended with the renderer and site version for profiles that use a bounded renderer. The rule and the shipped table are in [Calibration](../architecture/system-one.md#calibration-cuts-belong-to-a-threshold-identity) on the architecture page.

- **Fitted cuts** ship for the `jev-1.13.0` build only. LLM engines and other builds have none until a run fits them.
- **`systemOne.cuts` overrides.** Add cuts for a build the table lacks, or replace one. Keys are `<site>.<key>` and values are between 0.01 and 0.99. The operator's value wins over the table. For the legacy wire and for LLM engines the map key is the build string. For `julia-1` and the `gliner2.5-*` profiles it is the threshold identity, `<build>+<renderer>@<site version>`, which the ledger's per-engine route records show.

```yaml
systemOne:
  cuts:
    "jev-1.13.0":
      turn.direct: 0.80
```

- **Shadow mode.** A site whose answering build has no cut for it never hints, ranks or acts, and its answers are recorded, so the ledger and the dataset show what it would have said. The card advisory, `consult` and `/draft` read no cut and show any build's answer, marked with that build. Clio learns a build from its first answer. At the automatic sites no call is waited on, whether its build is known or not. Once a build is known to be unfitted, the `turn`, `toolCall` gate, `toolResult`, `turnEnd`, `steer` and `relevance` sites make no call at all while `systemOne.record` is off, because only the dataset would use the answer, and so leave no ledger row either. The build is rechecked once its last answer is ten minutes old.
- **Safety sites only record.** The yolo gate and the tool-result classifier add no confirmation and no banner, fitted or not. A cut can never remove friction.

Cuts are measured with `scripts/decision-probe.ts` against a labeled fixture under `tests/fixtures/decision-cases/`. The procedure is in [Validating a Laya build](../architecture/system-one.md#validating-a-laya-build). Both files live in the source repository and are not in the npm package, so fitting runs from a source checkout. Doctor reports the shipped table's cuts as measured and cuts written under `systemOne.cuts` as operator-configured, never as measured.

## Privacy

State is redacted in the process, before it is built into a request. The runner scrubs every state with Clio Coder's secret filters before any engine sees it, so a hosted decision engine or LLM API receives redacted text and the records start from that same redacted text. Tool arguments are never sent to the `toolCall` site, only the card's allowlisted one-line target. A hosted engine still receives the operator's request text and bounded tool output, so bind a hosted engine only to targets you would send that text to. A local server keeps everything on the machine.

Every engine request is also checked against the information-flow restrictions its evidence carries. A source rule whose recipients do not include the engine's target refuses the request, the call ends as `flow-denied`, and nothing is sent. See [Information flow](information-flow.md).

The training dataset applies a second pass on its own copy: a key-name pass for values with no secret-shaped text (`password: hunter2`), and the operator's home directory rewritten to `~`. Export applies the pass again. Redaction is best effort.

## The training dataset

The session ledger always keeps a compact `systemOne` row per call (site, engine, build, outcome, latency, the answers and policy outcome, a hash of the state, but never the state itself). This is the cheap record that makes a silent site diagnosable.

`systemOne.record: true` additionally keeps a local, opt-in dataset intended for fitting cuts and comparing engine builds. It lives at `<state dir>/systemone/YYYY-MM-DD.jsonl`, one append-only file per UTC day, with the directory mode `0700` and files `0600`. Nothing leaves the machine unless you export it and send the file yourself. Day files older than `systemOne.retentionDays` are deleted, and when the directory exceeds `systemOne.maxMiB` the oldest day files are deleted first. The newest file is never deleted for size. The row kinds (`decision`, `spec`, `outcome`), the outcome sources and the write rules are specified in [Records](../architecture/system-one.md#records).

Inspect and export it:

```bash
clio-coder systemone status
clio-coder systemone export --out dataset.jsonl [--since 2026-09-01] [--site toolCall]
```

`status` prints whether recording is on, the directory, the file count and date range, the size against the cap with the retention days, row counts by kind, and where each site is bound (the engine, its kind, the target and model, any deadline, or the reason the binding cannot answer). `export` writes one JSON line per decision joined to the full text of its questions and every outcome recorded for it. `--out` is required, is replaced atomically and may not point into the dataset directory. `--since` takes a UTC day and `--site` one site id. An export that matches nothing, or that finds question specs missing from the selected days or unreadable rows, says so. `clio-coder systemone --help` prints the usage and exits 0.

`systemone` exits 0 on success, 2 for a usage error (an unknown command or flag, a missing `--out`, a `--since` that is not a day, a `--site` that is not a site id, or an `--out` inside the dataset directory) and 1 when reading or writing fails. Read an export before sharing it, because it holds the operator's own requests.

## Doctor rows

`clio-coder doctor` never asks a decision. It reports the configuration, and the System One rows are listed in [Doctor](doctor.md): one for an off layer, one per bound site, one per bound `systemone` engine and one for the dataset. The engine rows give the profile, the window and where it comes from, whether Julia-1 options are counted by tokenizer, and the passive round trip, so a machine with named targets reads as a map of its placements.

## Retired settings keys

Two settings keys are retired without replacement: `fleet.decisionProfiles` and `turnControl.interpretation` (including `turnControl.interpretation.fallback`). A non-empty `fleet.decisionProfiles` fails validation with `retired without replacement: System One replaced decision profiles; bind an engine under systemOne.engines and systemOne.sites. Remove this key`, and any `turnControl.interpretation` key fails the same way, pointing at the `turn` site, which reads the request without any fallback to the main model. An empty `fleet.decisionProfiles: {}`, which older `init` runs wrote, is accepted silently. Nothing is migrated automatically. Rebind decision engines by hand under `systemOne.engines` and `systemOne.sites`. [Configuration and Targets](configuration-and-targets.md) covers retired settings paths in general.

## Failure behavior

Every failure leaves the unbound behavior in place: a failed call returns nothing, and the caller behaves as if System One were absent. Each call ends in one outcome that the ledger records, and three consecutive timeouts at one site open a breaker for five minutes. The outcomes and the breaker are specified in [The runner](../architecture/system-one.md#the-runner). To see why a site is silent, read `clio-coder systemone status`, the `system one (experimental)` doctor rows and the ledger's `systemOne` rows.

## Related

- [System One Architecture](../architecture/system-one.md)
- [Configuration Reference](configuration-reference.md) and [Configuration and Targets](configuration-and-targets.md)
- [Safety Model](../architecture/safety-model.md)
- [Doctor](doctor.md)
- [Troubleshooting](troubleshooting.md)
