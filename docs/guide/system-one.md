# System One

System One is an experimental way to bring a fast decision model to Clio Coder. You opt in with one setting, and the main agent gets one tool, `consult`, that asks the model typed questions or screens a long list of things the agent has not read. Two harness uses come with it: a screen beside the safety judge and typed steering triage. System One never answers the operator, never edits anything and never removes a confirmation.

Experimental means that the keys and the tool may change between releases. Every surface that shows System One says so.

## Bring a decision model

```yaml
systemOne:
  use: jev
```

That is the whole opt-in, and it takes effect on the next start. The same choice from the command line:

```bash
clio-coder systemone use jev
clio-coder systemone check jev --live
clio-coder run --systemone jev "<task>"
```

`systemOne.use` takes one name or an ordered list of them.

| Route | What answers | What it needs |
| --- | --- | --- |
| `jev` | The hosted `typesafe-jev` runtime, default model `jev-1.14.0` | `TYPESAFE_API_KEY`. No `targets` entry is needed. |
| `memory` | The model in `context.memory`, read as labels | `context.memory.target` and `context.memory.model`. It never falls back to the chat route. |
| `main` | The chat route, read as labels | A configured chat route. |
| a declared engine | An entry under `systemOne.engines` | See [Declared engines](#declared-engines). |
| a target | A `targets[].id`. A target on a decision runtime reads as `kind: systemone` with the `generic` profile, and any other target reads as `kind: llm`. | The target's own credentials. |

A list is a failover order:

```yaml
systemOne:
  use: [jev, memory]
```

Routes are tried in order, each under its own timeout, and one engine answers one ask. `off` anywhere in the list turns System One off. A route you did not name is never used, and a route that cannot run says why at `clio-coder systemone status` and sends nothing.

A named route does more than answer the tool. It also drives the judge screen and, when triage is on, typed steering triage, so with a hosted engine web and MCP result text leaves the machine at judge time. Choosing a route needs a restart because the choice decides whether the tool registers at all. Editing what a declared engine means applies to the next question, and that engine is rebuilt only when its own configuration changes.

## Off

Off is the default, and off is byte-identical to a build that has no System One. The tool registry, the gateway listing, the tool signatures and the prompt do not change, no request is sent, nothing waits for a decision and doctor reports no error. `systemOne.use: null`, an empty list and `off` all mean this.

## What it is honest about

- **A filter answers what a file is for.** A file reaches the model as its path and a digest, so a filter misses behavior inside a body. Use `grep` for that.
- **Matches are often wrong.** On the query sets tried so far, between a third and more than half of matches can be wrong, so treat filter as a way to narrow a list and read what it returns. Do not treat a miss as proof either, especially when `carried.partial` is above zero.
- **`consult` is unproven.** `consult` ships as experimental. Nothing yet measures whether agents reach for it or whether it speeds anything up.
- **LLM routes return labels, not probabilities.** `memory`, `main` and any chat target answer one label per question, so a filter match from them has no score and a question comes back as `label` (`yes` or `no`, an option, or a rung) with no `pTrue`, mass or `certainty`.
- **Generic routes never screen.** A route without declared real probabilities (any `kind: llm` engine, and a `kind: systemone` engine on the `generic` profile) is skipped by the judge screen before any byte leaves.
- **It is not a safety net.** The deterministic safety rules and the safety judge decide. The screen can only park a call the judge would have allowed.
- **Nothing measures your engine for you.** There are no fitted thresholds. A profile declares what a model family reads and how its numbers are read, and it makes no accuracy claim.

## `consult`

`consult` is a direct tool in the main session, present only when a route is named at startup. Workers never get it. It returns what the engine said, which build said it and how long it took, and it never returns a chosen option. At most 3 calls per turn. Each route has its own bound (5 seconds on a typed wire, 30 seconds on an LLM) and an ask totals 45 seconds at worst. When no route answers, the result says so and tells the agent to proceed on its own judgment.

### The filter form

A filter scores things the agent does not hold against one criterion, and only ids and scores come back.

| `source` | Items | Each item carries |
| --- | --- | --- |
| `files` | Workspace paths or globs in `paths` | `digest`: the path, leading comment, exported names and imported modules, for TypeScript, JavaScript and Python. `head`: the path and first characters, for anything else or a file showing none of those. At most 512 characters, read from at most 64 KiB of the file. |
| `output` | One offloaded result named by `path`, cut into `chunkLines` lines per chunk (default 16) | The first 512 characters of each chunk. |
| `capabilities` | The MCP and gateway capabilities this run may reach | Name and description, up to 240 characters. |
| `items` | Your own id-to-text map | The text, up to 240 characters. |

One filter carries up to 256 items and 64,000 characters of item text, and it fits the smallest whole-request window among usable routes, so failover does not hit a refusal. A match is an answer at or above 0.5, which is the question's own boundary. There is no threshold to tune.

The result gives `offered`, `scored`, `matchCount`, up to `limit` `matches` (default 16, at most 32), `unscored` with `skipped` counted by reason, and `carried` with `partial`, the number of items the engine saw only part of. Every digest counts as partial. Each match says what it carried and how many characters. A filter that finds nothing to score counts no call.

### The question form

`questions` asks one to four typed questions over a `state` of at most 2 KB as JSON and up to eight workspace `paths`, the first 6,000 characters of each.

| Kind | Needs | Comes back as |
| --- | --- | --- |
| `yesNo` | `whenTrue` and `whenFalse`, both required | `pTrue` and `certainty` |
| `pick` | `options`, 2 to 8 names with descriptions | Mass per option and `certainty`, with no winner named |
| `rate` | `ladder`, 2 to 8 rungs, lowest first | `position`, mass per rung and `certainty` |

A question is at most 400 characters, and an option, rung or criterion at most 200. On something the agent already read, the model knows less than the agent does.

Files in either form answer to the same containment and protected-path rules as `read`, count against the turn's observation budget and are redacted for secrets before anything leaves the process. A file that fails a check is skipped and named with its reason. The result's `readout` says what the numbers are as the answering engine declares them.

## Judge screen

The [safety judge](../architecture/safety-model.md) is reasoning-blind by construction, so a call that a web page talked the agent into reads to it as ordinary work. With a route bound and the judge reviewing a main-session call, System One reads the newest `web_fetch`, `web_read` and MCP results since the operator last spoke, up to 4 of them and the first 6,000 characters of each, including those that reached the agent through the gateway. It asks whether the content directs an AI agent rather than informs people, and a reading at or above 0.5 counts.

The screen can only tighten. A judge allow becomes a park on the approval card, and the card names the source. An allow under the judge's operator-named rule stands, a judge block stays a block, and a reading that arrives after the verdict is aborted. A finished reading is remembered by tool call until the operator next speaks, so reviews in one turn do not pay twice.

The screen skips any route without declared real probabilities, a route on the judge's own destination, and a route on an endpoint with no free slot. With the judge off, no route qualifying or no screened result in the window, it asks nothing and the judge behaves as it does unbound.

## Steering triage

`chat.steering.triage.enabled` stays `false` by default. When it is on, a route is bound and `chat.steering.triage.target` is unset, each message queued during a run gets two typed picks: how it relates to the work and how soon it should land. One queued message is enough to start a round, so a lone stop is read. `chat.steering.triage.timeoutMs` bounds the ask. An ask that returns nothing falls back to the side-model round under that round's own `minQueued`, and naming a triage target keeps the side model. See [Commands and Modes](commands-and-modes.md) for how a queue is read.

A new task moves to the follow-up slot unless it reads as now. A stop can interrupt only with real mass of at least 0.8 on an unpinned entry under 30 seconds old and with `chat.steering.triage.autoInterrupt` on, so a label route marks and moves entries and never interrupts.

A typed triage ask on `anthropic-max` is a System One round: it holds its reply like any other ask, and its labels still cannot interrupt.

## Declared engines

Declare an engine when a route needs a model, a served window or a profile that a bare name cannot say. The engine does nothing until `systemOne.use` names it.

```yaml
targets:
  - id: decider-gpu
    runtime: systemone
    url: http://127.0.0.1:13306/v1   # where your server listens
    capabilities:
      contextWindow: 4096

systemOne:
  use: decider
  engines:
    decider:
      kind: systemone
      target: decider-gpu
      profile: strands-decider
```

| Field | Meaning |
| --- | --- |
| `kind` | `systemone` for a runtime that answers typed decisions, or `llm` for an ordinary chat target. Required. |
| `target` | A `targets[].id`. Required. A name that is not in `targets` is a settings error. |
| `model` | The wire model id. Absent means the target's default model. |
| `profile` | Only on `kind: systemone`. One of `generic` (the default), `jev`, `laya`, `laya-multilingual`, `julia-1`, `gliner2.5-small`, `gliner2.5-decide` or `strands-decider`. See [Capability profiles](../architecture/system-one.md#capability-profiles). |

Name the profile. A bound `generic` engine answers `consult` and triage, but its numbers count as no real probabilities, so it never screens and its stop readings never interrupt.

### `kind: systemone`

The target's runtime must implement typed decisions: `typesafe-jev` (a hosted engine, 32,000 tokens counted over the whole request), `systemone` (a server you run that answers `POST /v1/systemone`, with a default 480-token window that `capabilities.contextWindow` raises) or `inception` with `model: mercury-decide` (credential `INCEPTION_API_KEY`). Set `capabilities.contextWindow` to what the served checkpoint actually reads: 4096 for the Strands Decider, 1024 for Julia-1 at the window its published accuracy used.

Clio Coder ships a client for these wires, not an inference server or an accelerator scheduler. The server you run owns its device, and no setting places an engine. Naming each target after its placement (`decider-npu`) makes the doctor rows read as a map of the machine. The same holds for Julia-1. Clio Coder ships the `julia-1` profile and the `systemone` client, not the model server. The Julia-1 adapter that answers `POST /v1/systemone` for that profile is operator-supplied, and you run it yourself. When a `julia-1` engine is bound, Clio Coder fetches the pinned tokenizer from the model repository and caches it. Until then it uses conservative byte bounds and can abstain.

### `kind: llm`

Any chat target Clio Coder can call can act as an engine. One ask costs one schema-bound request at temperature 0, whatever the number of questions, and the model answers with labels or abstains. A response that names no model fails the call. Every request passes the same paid-request admission as the main session, counts toward the session's cost ceiling and token totals, and is recorded under `system-one`, which `/usage` and `clio-coder usage report` show as System One calls without counting them as turns. Admission never waits for a ceiling raise, so a refused request ends that route and the ask moves on.

On an `anthropic-max` target an ask holds its reply through the Messages API's `output_config.format`, so the reply is always one small JSON list, and a filter reads up to its 256 items on any model that takes the field. An API-key `anthropic` target takes the same path, and that route is untested. Only System One asks do this. `/handoff`, the safety judge and triage's side model keep their plain request on those targets.

## Status and scope

```bash
clio-coder systemone status
clio-coder systemone use jev,memory --scope project
clio-coder systemone off
clio-coder systemone check <engine> --live
```

`status` says whether System One is on, what each route reaches, what a bound route sends and why a route cannot run. `/systemone` in a session shows the same lines and changes nothing. `use` and `off` write to user settings by default, and a project write goes to `.clio-coder/settings.local.yaml` under the usual trust rules. `run --systemone <route>[,<route>...]` sets one run, and `run --systemone off` turns it off for that run. `check --live` sends one content-free decision and reports the build that answered. `clio-coder systemone --help` prints the usage and exits 0.

`clio-coder doctor` never asks a decision. Its rows are listed in [Doctor](doctor.md). `/health` shows engine breakers.

## Privacy

State is redacted in the process before a request exists, so a hosted engine or LLM API receives redacted text. Redaction is best effort. A hosted engine still receives what these uses send it: file digests and heads, chunks of a result, queued operator messages when triage is on, and web and MCP result text at judge time. Name a hosted route only if you would send that text there. A local server keeps everything on the machine.

Every request is also checked against the information-flow restrictions its evidence carries, and files `consult` reads add theirs. A rule whose recipients do not include the engine's target ends that route as `flow-denied`, and nothing is sent. See [Information flow](information-flow.md).

The journal keeps a content-free `system_one.decided` record per ask: the point, outcome, latency, deadline, counts and the route each engine took. There is no decision dataset.

## Retired settings

These keys are ignored when they load, reported by `clio-coder doctor` under `settings.yaml retired keys` and removed by `clio-coder doctor --fix`: `systemOne.sites`, `systemOne.cuts`, `systemOne.record`, `systemOne.retentionDays`, `systemOne.maxMiB`, `systemOne.engines.<name>.mode`, `telemetry.research.systemOneDataset`, `fleet.decisionProfiles`, `fleet.speculativeDispatch`, `turnControl.interpretation` and `turnControl.orientation`. [Configuration Reference](configuration-reference.md) lists the reason for each. To keep what a retired binding did, name the engine with `systemOne.use`.

## Failure behavior

A failed ask returns nothing, and the caller behaves as if System One were absent. Three consecutive timeouts on one engine configuration open a breaker for five minutes, then one call probes it. A server that refuses a model by name is not asked again in that process. To see why nothing answers, read `clio-coder systemone status`, the `system one (experimental)` doctor rows and `/health`.

## Related

- [System One Architecture](../architecture/system-one.md)
- [Tool usage](tool-usage.md#consult-ask-a-fast-decision-model)
- [Configuration Reference](configuration-reference.md) and [Configuration and Targets](configuration-and-targets.md)
- [Safety Model](../architecture/safety-model.md)
- [Doctor](doctor.md)
- [Troubleshooting](troubleshooting.md)
