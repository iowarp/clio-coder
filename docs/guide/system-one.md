# System One

System One is a fast decision model that Clio asks calibrated questions at fixed decision sites. It reads a bounded, redacted state about one object (the operator's request, a proposed tool call, a tool result, a finished turn, a catalog) and returns probabilities. Clio's policy turns those probabilities into hints, extra confirmations, banners or preparation. System One never answers the operator, never edits anything and never removes friction that Clio's own safety rules impose.

System One is experimental. Its sites, settings keys and shipped cuts may change between releases, and every site stays in shadow until a fitted cut exists for the answering build.

It is off until you bind an engine to a site. With nothing bound Clio behaves exactly as it did before System One existed, and every failure of a bound engine (timeout, refusal, unusable reply) also degrades to that behavior. The design contract is in [System One Architecture](../architecture/system-one.md).

## Quick start

This example binds a hosted decision engine through the `typesafe-jev` runtime. Add a target, declare an engine over it, and bind the sites you want.

```yaml
targets:
  - id: jev
    runtime: typesafe-jev        # reads TYPESAFE_API_KEY
    defaultModel: jev-latest

systemOne:
  engines:
    jev:
      kind: systemone
      target: jev
  sites:
    turn: jev
    toolCall: jev
    toolResult: jev
    turnEnd: jev
    relevance: jev
```

Then run `clio-coder doctor` and read the `system one <site>` rows, or `clio-coder systemone status`. A site binding applies from the next turn. Only the `consult` site needs a restart.

A self-hosted server that answers `POST /v1/systemone` uses runtime `systemone` with a `url` on the target. The wire is the same, so the engine block is identical.

## What System One is not

- It is not the main model and does not change which model answers you.
- It is not a safety net. Its gates only add one confirmation, and the classifier, damage-control rules and protected paths decide first.
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
| `mode` | `auto`, `logprobs` or `answer`. Only valid on `kind: llm`. `auto` uses first-token logprobs when the server returns them and falls back to five votes when it does not. |

`systemOne.sites` maps a site id (`turn`, `toolCall`, `toolResult`, `turnEnd`, `relevance`, `consult`, `drafts`) to an engine name, or to `{ engine, timeoutMs }` to replace the site's default deadline for that binding. A site with no entry is off. An engine name that `systemOne.engines` does not define is a settings error.

`systemOne.cuts` maps an answering build to fitted overrides. See [Calibration and shadow mode](#calibration-and-shadow-mode).

`systemOne.record` turns the local training dataset on. `systemOne.retentionDays` and `systemOne.maxMiB` bound it and must be integers of at least 1. See [The training dataset](#the-training-dataset).

The `/settings` overlay lists these keys under Decision engines in its Fleet section. A running session re-reads the block on every call, so an edited engine or binding applies to the next question without a restart. The defaults are in `src/core/defaults.ts`, validation is in `src/core/config.ts`, and effect timing is classified in `src/domains/config/classify.ts`.

## Engines

An engine answers typed questions for a state. Clio builds one engine per configured name and rebuilds it only when its own configuration changes.

### Engine kind `systemone`

The target's runtime must implement typed decisions: `typesafe-jev` (a hosted decision engine, default model `jev-latest`, credential `TYPESAFE_API_KEY`) or `systemone` (a self-hosted server). Answers are calibrated probabilities. The answering build is the model name the server reports, for example `jev-1.13.0`, and every cut is keyed by that name. Clio's shipped cuts are fitted for the hosted engine's `jev-1.13.0` build. Any other build on the same wire, including a self-hosted one, is validated the same way, by fitting cuts on that exact build. Binding a chat-only runtime with `kind: systemone` is reported as a problem by doctor.

### Engine kind `llm`

Any chat target Clio already knows can act as an engine. The target needs a chat wire and a model, or a runtime that Clio can call one-shot. In `logprobs` mode the engine reads the first-token letter alternatives of a one-letter answer, the only way an LLM yields a probability. In `answer` mode it asks for five votes with the option order alternating, and marks the answers uncalibrated. `auto` picks once per target, model and URL from the first real request and re-checks a no-logprobs verdict after ten minutes. A question with more than 26 options is read as a tournament and flagged approximate.

The build key of an LLM engine is `llm:<runtime>@<host>/<model>#<mode>:<prompt version>`. No LLM build has fitted cuts, so an LLM engine runs in shadow until you supply cuts for its exact build string. Its state can be large relative to its window, and a call whose state does not fit the target's window is not sent.

Every request an `llm` engine sends, including schema retries, passes the same paid-request admission as the main session. It counts toward the session's cost ceiling and token totals and is recorded under `system-one`, which `/usage` and `clio-coder usage report` show as System One calls without counting them as turns. Admission never waits for a ceiling raise: a refused request fails the whole decision, and the site behaves as if System One were absent.

## Decision sites

A site is named by the object it judges. One call to a site carries one bounded state and every question about that state. The deadline is the default for the site and `timeoutMs` on the binding replaces it.

| Site | Judges | Default deadline | What it can do |
| --- | --- | --- | --- |
| `turn` | The operator's request, read before the turn | 600 ms | Hints, orientation, direction, dispatch expectation, prewarm |
| `toolCall` | A proposed tool call | 5000 ms for the approval card, 1500 ms for the yolo gate | Card advisory, one extra confirmation under `yolo` |
| `toolResult` | Content returned by `web_fetch`, `web_read` and MCP tools | 1500 ms | Untrusted-content banner |
| `turnEnd` | The assistant's finished message | 5000 ms | Clarification streak and turn outcome record |
| `relevance` | Catalog entries against a need | 1500 ms | Ranks skills, gateway capabilities and memory |
| `consult` | Evidence the main agent supplies | 3000 ms | The `consult` tool |
| `drafts` | Candidate answers | 5000 ms | `/draft` judging |

### `turn`: hints and acts before the turn

The site asks whether the request is answerable without the workspace, whether it is work for workers, its shape (single, parallel, sequence, council), its intent, whether it asks for an orientation tour or is an undecided follow-up, and which installed recipe a dispatch would name first. Under a fitted build it can:

- Add a `[Scope]` hint: the request reads as answerable without inspecting the workspace, so answer directly.
- Add a `[Plan]` hint: the request reads as work suited to workers, so the delegation rules apply. It is suppressed when the request already names delegation.
- Tell the turn controller that an orientation or a direction workflow is wanted (`turnControl.workflows`), and that a dispatch is expected. An expected dispatch suppresses the orientation scout only when its probability is at least the orientation probability, so a request that reads more like a tour than a dispatch still gets the scout (an engine that reports no probabilities keeps the plain expectation). The shipped cut for the orientation reading is high, so the orientation scout fires only when the request explicitly asks for a tour of the project.
- Predict the worker about to be dispatched so its process can be held ready. This prewarm runs only when `fleet.speculativeDispatch` is true, and it holds two workers for a parallel shape and one otherwise.

Every hint and act is a suggestion the main agent or the turn controller may ignore. Under a fitted build the turn site runs before the prompt is admitted, so a slow engine costs up to the deadline on each turn, and a canceled turn abandons the call. A build without a fitted cut is shadowed and records the answers without holding the turn.

### `toolCall`: approval-card advisory and the yolo gate

The site rates the blast radius of a call on a four-rung ladder (`contained`, `local`, `broad`, `irreversible`) and asks whether it reaches outside the workspace and whether it destroys data that version control or a reinstall cannot restore. It sees only the call's allowlisted, secret-redacted one-line target, never raw arguments.

- **Card advisory.** While an approval card is open in the TUI, one advisory sentence can appear: "Advisory only, nothing below is gated on it: blast radius reads as `<rung>`" with the answering build. It is not waited on, so it cannot delay an approval, and it changes nothing about allow, deny or stop. An undecided reading shows nothing.
- **Yolo gate.** At autonomy `yolo`, in an interactive session only, an `execute` call that the classifier did not recognize (which `yolo` would otherwise run unread) is sent to the gate first. Under a fitted build, a call that reads as reaching far or destroying data becomes one confirmation card titled "System One confirmation", stating the reason and the build. The gate only adds friction. It never touches calls the classifier already parks, blocks or recognizes, and headless runs and ACP sessions never reach it. If the gate is unavailable, `yolo` is exactly as permissive as before.

### `toolResult`: injection banner on external content

Only results from `web_fetch`, `web_read` and MCP tools are screened. They carry third parties' text. Clio's own listings, recipes and worker reports are written to direct an agent and are never sent. The site reads intent, so a paraphrased injection is caught and a document that merely quotes an attack is not. A flag puts a System One finding and the untrusted-content banner in front of the result. It never clears a result the deterministic marker scan already flagged. Under an unfitted build the call is recorded and never flags.

### `turnEnd`: clarification streak and turn outcomes

After a turn settles, the site reads the assistant's final message. Its reading of whether the message asks the operator something feeds the clarification streak that gates the `direction` workflow and the turn outcome record. When the site has no usable answer, the clarification streak keeps its existing fallback.

The settled turn waits at most 1.2 s for the answer, counted from when it was first asked. A slower answer is recorded but never waited on. An unfitted build never delays the turn. Other readings, including whether the message blocks on a decision, announced work never started, a claimed passing check and whether the work moved on, are recorded without changing policy.

The prose-question nudge has been removed. Turn-ending guidance lives in the prompt and the `ask_user` result. The plan-close registration uses explicit proposal mode, the already cached `turn` intent, or, when no turn verdict exists, the operator's request naming a plan; never this site's reading of the reply.

### `relevance`: ranking skills, capabilities and memory

Long catalogs are ranked by local vocabulary first. This site scores the pruned entries by meaning, and the caller uses the scores only to reorder a skills listing or gateway result, or to add related entries beside a query's own hits. It never removes an entry and never reorders entries a query matched. A build without the `relevance.ranked` marker is asked only when `systemOne.record` is on, and never reorders anything.

### `consult`: the agent asks directly

When the `consult` site is bound at startup, the main agent gets a `consult` tool. It sends one to four typed questions (`yesNo`, `pick`, `rate`) about a small `state` (at most 2 KB as JSON) and up to eight workspace `paths` (the head of each, secrets redacted, under the same containment and protected-path rules as `read`). It returns the probability distribution, the answering build and the latency, never a chosen option. At most three calls per turn. Workers never get it. Consult has no cut, so an unfitted build answers exactly as a fitted one. Because the tool set is built at startup, binding or unbinding `systemOne.sites.consult` needs a restart.

### `drafts`: judging `/draft`

`/draft` runs several candidate answers in parallel. With `systemOne.sites.drafts` bound, one `choice` question over the candidates says which to read first and how decisive that pick was, and soundness is shown as advice. Nothing here enters the session by itself. `Enter` on a finished draft closes the overlay and appends that draft's text to the composer below anything already typed. It is never sent. Candidates are spread by sampling temperature, except for models that refuse a sampler (Claude models from 4.7 on, Codex and reasoning OpenAI or Azure Responses models, and any model whose compat block sets `supportsTemperature: false`). Those candidates run without `temperature` and differ through a different prompt angle each. If a provider still answers with an `Unsupported parameter: temperature` style rejection, that candidate is retried once without it. When a judge call exists, taking a draft also records a `draft` outcome row holding the label taken, the judge's pick and whether they agreed. `Esc` records nothing. The legend shows `Enter use` only while the selected draft can be taken. Unbound, the overlay says the candidates were not judged and names the key to bind.

## Calibration and shadow mode

A probability means something only for the build that produced it. Clio therefore keys every cut by the answering build.

- **Fitted cuts** live in `FITTED_CUTS` in `src/domains/system-one/calibration.ts`, each fitted from a labeled run on that exact build. The table ships cuts for the `jev-1.13.0` build only. LLM engines and other builds have none until a run fits them.
- **`systemOne.cuts` overrides.** Add cuts for a build the table lacks, or replace one. Keys are `<site>.<key>` and values are between 0.01 and 0.99. The operator's value wins over the table.

```yaml
systemOne:
  cuts:
    "jev-1.13.0":
      turn.direct: 0.80
```

- **Shadow mode.** A site under a build with no cut for it is recorded and never hints, gates or acts. The engine is still called, so the ledger and the dataset show what it would have said. An unfitted build never holds anything up. The yolo gate and the tool-result screen are detached: the tool goes ahead at once and the answer is only recorded. The `turn` and `turnEnd` calls are detached when `systemOne.record` is on and are not made at all when it is off, and `relevance` is skipped when it is off, because a shadowed answer can change nothing and only the dataset would use it. With `record` off, a shadowed `turn`, `turnEnd` or `relevance` site therefore leaves no ledger row either. The build is rechecked once its last answer ages out, after which a fitted build is waited on again.
- **Safety sites only tighten.** A cut can add a confirmation or a banner, never remove one.

Use `scripts/decision-probe.ts` against a labeled fixture under `tests/fixtures/decision-cases/` to measure a build. It calls the engine live, reports agreement, abstentions and errors per question, prints the answering build and suggests a cut with its margin to each class. It is an explicit operator run and is never part of CI.

## Privacy

State is redacted in the process, before it is built into a request. The runner scrubs every state with Clio's secret filters before any engine sees it, so a hosted decision engine or LLM API receives redacted text and the records hold the same redacted text. Tool arguments are never sent to the `toolCall` site, only the card's allowlisted one-line target. A hosted engine still receives the operator's request text and bounded tool output, so bind a hosted engine only to targets you would send that text to. A local server keeps everything on the machine.

The training dataset applies a second pass on its own copy: a key-name pass for values with no secret-shaped text (`password: hunter2`), and the operator's home directory rewritten to `~`. Redaction is best effort.

## The training dataset

The session ledger always keeps a compact `systemOne` row per call (site, engine, build, outcome, latency, the answers and policy outcome, a hash of the state, but never the state itself). This is the cheap record that makes a silent site diagnosable.

`systemOne.record: true` additionally keeps a local, opt-in dataset intended for fitting cuts and comparing engine builds.

- **Location.** `<state dir>/systemone/YYYY-MM-DD.jsonl`, one append-only file per UTC day. The directory is mode `0700` and the files `0600`. Nothing leaves the machine unless you export it and send the file yourself.
- **Row kinds.** `decision` (one call with its redacted state, capped at 16 KiB, the answers and the policy outcome), `spec` (the question text, written once per hash so decisions stay small) and `outcome` (what followed: `turn`, `next-operator`, `permission`, `follow-up`, `draft` or `compaction`, joined to its decision by `ref`).
- **Retention.** Day files older than `systemOne.retentionDays` are deleted, and when the directory exceeds `systemOne.maxMiB` the oldest day files are deleted first. The newest file is never deleted for size. Pruning runs on the first dataset write of a session and at most hourly after.
- **Writes** are queued and appended off the turn path, and a failed write drops its batch and warns once.

Inspect and export it:

```bash
clio-coder systemone status
clio-coder systemone export --out dataset.jsonl [--since 2026-09-01] [--site toolCall]
```

`status` prints whether recording is on, the directory, the file count and date range, the size against the cap, row counts by kind, and where each site is bound. `export` writes one JSON line per decision joined to the full text of its questions and every outcome recorded for it. `--out` is required, is replaced atomically and may not point into the dataset directory. `--since` takes a UTC day and `--site` one site id. Read an export before sharing it, because it holds the operator's own requests.

## Doctor rows

`clio-coder doctor` never asks a decision. It reports the configuration.

| Row | Meaning |
| --- | --- |
| `system one <site>` (one per site) | `INFO` "off; no engine bound" when unbound. `WARN` when the binding cannot resolve (an undefined engine, an unconfigured target, an unregistered runtime, a runtime that does not answer typed decisions) with the reason and "the site stays silent". `WARN` when it resolves but `connection <target>` is not verified, since the site may fall back every turn. Otherwise `OK` with the engine, its kind, the target, model and any deadline. |
| `system one dataset` | Whether recording is on, the day files and their range, size, and the retention and cap. `WARN` when the directory cannot be read or is over the cap. |

See [Doctor](doctor.md).

## Migration from 0.5.7

The earlier decision layer (decision profiles, the pre-turn brief, the main-model interpretation fallback, per-site calibration) was replaced and has no compatibility mode.

| Removed | Replacement |
| --- | --- |
| `fleet.decisionProfiles` | `systemOne.engines` and `systemOne.sites` |
| `turnControl.interpretation` (including `.fallback`) | The `turn` site reads the request, and nothing falls back to the main model |

An empty `fleet.decisionProfiles: {}` written by `init` from 0.5.3 through 0.5.7 is accepted silently. A non-empty block fails validation with `retired without replacement: System One replaced decision profiles; bind an engine under systemOne.engines and systemOne.sites. Remove this key`. Any `turnControl.interpretation` key fails the same way. Released versions never wrote that key, so only a hand-written block or a settings file from a 0.5.8 development build carries it; delete it from `settings.yaml`. Nothing is migrated automatically. Rebind your decision engines by hand under `systemOne`.

## Failure behavior

Every call ends in exactly one outcome that the ledger records: `answered`, `failed`, `timeout`, `canceled`, `overflow` (the state does not fit the engine's window) or `breaker-open`. Three consecutive timeouts at one site open a breaker for five minutes, after which one call probes the engine again. Only timeouts trip it, since a refusal returns fast and costs the turn nothing. A failed call returns nothing and the caller behaves as if System One were absent.

## Related

- [System One Architecture](../architecture/system-one.md)
- [Configuration Reference](configuration-reference.md) and [Configuration and Targets](configuration-and-targets.md)
- [Safety Model](../architecture/safety-model.md)
- [Doctor](doctor.md)
- [Troubleshooting](troubleshooting.md)
