## What it is

System One is an experimental way to bring a fast decision model to Clio Coder. It is off by default and sends nothing until you name a route. The main agent then gets one tool, `consult`, and the route also drives a screen beside the safety judge and, when you turn it on, triage of queued messages. System One never answers you, never edits anything, and never removes a confirmation.

## Name a route

```sh
clio-coder systemone use jev
clio-coder systemone status
clio-coder systemone check jev --live
clio-coder systemone off
```

The choice takes effect on the next start. A list such as `jev,memory` is a failover order, and a route you did not name is never used. `run --systemone <route>` sets one headless run, and `/systemone` shows the status in a session.

| Route | What answers | What it needs |
| --- | --- | --- |
| `jev` | A hosted engine | `TYPESAFE_API_KEY` |
| `memory` | The model in `context.memory`, as labels | A memory target and model |
| `main` or a chat target | A chat route, as labels | That route's credentials |
| A declared engine | A decision server you run, with a named profile | An entry under `systemOne.engines` |

## The two consult forms

Only the main session gets `consult`, at most 3 calls per turn.

| Form | What the agent sends | What comes back |
| --- | --- | --- |
| Filter | Up to 256 files or items and one criterion | Ids and scores of matches |
| Questions | One to four `yesNo`, `pick`, or `rate` questions | Probabilities, or a label on an LLM route |

A filter sees a file as its path and a digest; use `grep` for behavior inside a body.

## The judge screen

When the safety judge reviews a call, System One asks whether the newest web and MCP results direct an AI agent. A positive reading can only turn a judge allow into a park on the approval card. LLM routes never screen.

## Declare an engine

```yaml
targets:
  - id: decider-gpu
    runtime: systemone
    url: http://127.0.0.1:13306/v1
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

You run the server. Name a profile: a `generic` engine never screens.

## When it fails

A failed ask returns nothing and the agent proceeds alone. Three timeouts in a row open a five-minute breaker; see `/health`.

## What to expect

`consult` filters a list against one criterion or asks typed questions, and the agent decides what to do with the answer. Between a third and more than half of filter matches can be wrong on the query sets tried so far, and nothing yet shows that `consult` helps. A hosted route receives what these uses send, including web and MCP result text at judge time. Redaction is best effort, so use a route you run yourself when that matters. An [information flow](/docs/guide/information-flow.html) rule that excludes the engine's target ends that route as `flow-denied`, and nothing is sent.

Read [the research page](/research/system-one-decisions.html) for what has been measured and what is still open.
