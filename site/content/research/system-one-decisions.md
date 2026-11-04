Can a small, fast decision model make a coding agent's work better? System One is where Clio Coder asks that question. You bring a model that answers typed questions, and Clio Coder gives the agent a `consult` tool, a screen beside the safety judge, and optional triage of queued messages.

The plumbing has shipped. Whether it helps is still open, and the evidence so far is thin.

::: note Open question, described for v0.6.8
System One is off until you name a route, and its keys and tool may change between releases. The team, students, and outside researchers are welcome to work on it. All samples below are small, and every experiment on this page is proposed and not yet run.
:::

## The question

Three questions sit inside the big one, and each could come back negative.

- **Trajectories.** With a decision model bound, does the agent take a better path through a task: fewer wrong turns, fewer rounds, and the same or better accepted result?
- **Question formation.** Which questions can a small model answer usefully, and what must the question carry for that to happen?
- **Training.** Could a model trained on agent work outperform a general one on these questions?

## What is measured so far

These were measured on the current design, on small samples. They show what the parts do. None of them shows that System One improves an agent's work.

::: compare
| Measurement | Result | Sample |
| --- | --- | --- |
| Filter recall on a file digest, on Jev | 0.77, 0.82, 0.92 | Three sets of 6 queries |
| Filter recall on the first 512 characters, on Jev | 0.65, 0.35, 0.92 | The same three sets |
| Filter recall by query type | 0.92 for what a file is for; at best 0.58 for how it behaves | The same sets |
| Judge screen, on a real Haiku judge | Parked 8 of 8 injected pages | 8 pages |
| Judge screen latency | Screen 104 to 157 ms; judge verdict 938 to 1370 ms | The same run |
| Steering triage, how a message relates to the work | 105 of 105 | The relation pick only |
| `consult` calls with Jev bound | 0 calls | 12 real Haiku sessions, 6 with Jev bound |
:::

Read those together. A digest holds up better than a file's opening characters on two of the three sets and ties on the third. It finds what a file is for and misses much of what a file does, which fits a digest that never carries the body.

Precision is weak. Between a third and more than half of filter matches can be wrong, so a filter can narrow a list and cannot settle anything. The screen result covers injected pages only, and it says nothing about how often the screen would park an honest page.

The most important number is the last row. Given the tool, the agent did not call it once. Nothing has measured a benefit from `consult`, because none of the measured sessions used it on its own.

### One earlier run, on a design that no longer exists

An on/off evaluation ran the older fixed-site design, where Clio Coder asked its own questions at fixed points in a turn. That design is gone, and so is the run's raw data. Only these numbers remain, so nobody can reanalyze them.

The run used build `jev-1.14.0` with Haiku as the main model, over 24 episodes. Total time with System One on was 1.237 times total time with it off, meaning slower, with an interval of 1.037 to 1.484. Acceptance was 24 of 24 in both arms. Hints fired on 4 of 32 turns and changed no rounds.

Do not read that as a verdict on `consult` or on decision models in general. It says that one design cost time and bought nothing visible on that sample.

## Why it matters

A main model is slow and expensive for the small judgments an agent makes constantly: which file to open, whether a web page is trying to instruct it, whether a queued message means stop.

The judge screen numbers show a decision can return in about a tenth of a verdict's time. If small decisions like these can steer the larger model, long agent work gets cheaper and safer.

The clock is a poor measure of that. A decision that adds a second and saves a wrong branch is a win that total time can hide, and a saved second that leads the agent astray is a loss. That is why the direction below is to evaluate on trajectories.

## Directions to work on

### Evaluate on trajectories

Define what a better path means and measure it per episode: rounds, tool calls, files read and then never used, repeated failed commands, cost, and whether the result was accepted. Clio Coder journals each decision without its content, so the outcome, latency, route, and answering build can be set against the rest of the run.

Agents did not reach for `consult`, so a first result may be about adoption: what tool description or prompting makes an agent use it when it would help, and whether forcing the call helps at all.

### Form better questions

`consult` asks yes-or-no, pick, or rate questions over a small state, and it filters lists against one criterion.

Each engine declares what it can carry, and a question that does not fit abstains instead of being cut down. Open work includes what to put in a digest so that behavior queries improve, how to phrase criteria, and which of an agent's choices are worth asking about.

### Bring a model, and one day train one

You can bring a model today. A server that answers `POST /v1/systemone` becomes a route, and a named capability profile says how its numbers are read. Profiles make no accuracy claim, and there are no fitted thresholds, so a comparison across engines would be new evidence.

Training is an open research direction with no plan or timeline. There is no training data: the decision dataset from earlier releases was removed, and today's journal keeps decision records without content. Building an opt-in dataset is part of the work, including what consent it needs, what to redact, and what counts as a correct label.

## Use Clio Coder on it today

You need a working chat model, since System One never replaces it, and a route to name. Off is the default and sends nothing.

::: steps
### Name a route

```sh
clio-coder systemone use jev
clio-coder systemone status
clio-coder systemone check jev --live
```

`status` says what each route reaches and sends. `check --live` sends one content-free decision and reports the build that answered, which shows the route works and says nothing about its quality. A choice takes effect on the next start. For one headless run, pass `--systemone`:

```sh
clio-coder run --systemone jev "<task>"
clio-coder run --systemone off "<task>"
```

### Choose what answers

- `jev` is a hosted engine that needs `TYPESAFE_API_KEY` and returns real probabilities.
- A declared engine is a decision server you run, with a named profile.
- `memory`, `main`, or a chat target answer with one label per question. They have no real probabilities, so a filter match has no score and they never drive the judge screen.

A hosted route receives file digests and heads, chunks of results, web and MCP result text, and queued messages. Redaction is best effort. Use a route you run yourself when that matters.

### Read what happened

```sh
clio-coder telemetry timeline <session-id>
clio-coder telemetry inspect <session-id> --json
```

The timeline includes each System One decision. Use `clio-coder telemetry inspect --run <run-id>` for a dispatched or headless run.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. If you do, the result is useful whichever way it comes out.
:::

**Score the filter on a repository you know.** This extends the measurements above to new code, adds precision, and needs an afternoon.

::: steps
### Write the labels before you run anything

Pick a repository you know well. Write 12 queries, six about what a file is for and six about what a file does in its body. For each query, list by hand the files that should match.

### Run each query through `consult`

Ask for the filter form directly, one query per headless run, so the agent's choice not to call the tool does not get in the way:

```sh
clio-coder run --systemone jev "Call consult with a files filter over src/**. Criterion: <query>. Use limit 32. Report the matches and do nothing else."
```

One filter carries at most 256 items and returns at most 32 matches, so scope `paths` to fit and keep each hand-labelled list shorter than that.

### Score it

For each query, compute recall and precision against your labels, separately for the two query types. Note `carried.partial` and which items carried a digest or a head.

### Report it

Open a GitHub issue with the repository's language and size, the build `check --live` reported, your query types, and the scores. Include your sample size and leave out anything private.
:::

Needs: `TYPESAFE_API_KEY` for Jev, or your own decision server. A label route can also run this, though it returns no scores, so a comparison with Jev is a second result.

A natural second experiment, also proposed and not yet run, is a small paired on/off study: the same task and the same model, repeated with `--systemone jev` and `--systemone off`, scored on the trajectory measures above. It needs tasks whose result can be accepted or rejected mechanically, and enough repeats to report an interval.

## How to join

Open a GitHub issue on [the repository](https://github.com/iowarp/clio-coder/issues) saying what you want to try, before or after you run it, and read the [contributor guide](https://github.com/iowarp/clio-coder/blob/main/CONTRIBUTING.md) for code changes. Negative results and replications are welcome.

::: limits Boundaries
- System One is not a safety net. The deterministic safety rules and the judge decide, the screen can only tighten, and no use removes a confirmation.
- A filter miss is not proof, especially when `carried.partial` is above zero.
- Clio Coder ships a client for these wires and no inference server.
:::

::: next
- [The full System One guide](https://github.com/iowarp/clio-coder/blob/main/docs/guide/system-one.md)
- [All open questions](/research.html)
- [Let Clio Coder work without watching every call](/tutorials/let-it-work-with-containment-and-rewind.html)
:::
