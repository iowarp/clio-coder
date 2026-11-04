System One lets you bring a small decision model to Clio Coder. You name a route with one setting, and the main agent gets one tool, `consult`, that asks typed questions or screens a long list of things the agent has not read. The same route can also read web and MCP results beside the safety judge, and triage messages you queue during a run.

::: note Experimental in v0.6.8
System One is off until you name a route, and its keys and tool may change between releases. `consult` is unproven: nothing yet shows that agents reach for it or that it speeds anything up. Between a third and more than half of filter matches can be wrong on the query sets tried so far.
:::

::: needs
- A working chat model. System One never replaces it.
- A route to name: a hosted engine with `TYPESAFE_API_KEY`, a decision server you run, or a chat target you already use.
:::

::: steps
### Name a route

```yaml title=settings.yaml
systemOne:
  use: jev
```

Or from the shell:

```sh
clio-coder systemone use jev
```

This takes effect on the next start. A list such as `jev,memory` is a failover order, and a route you did not name is never used. For one headless run, pass `--systemone jev` to `clio-coder run`.

### Check it

```sh
clio-coder systemone status
clio-coder systemone check jev --live
```

`status` says whether System One is on, what each route reaches, what a bound route sends, and why a route cannot run. `check --live` sends one content-free decision and reports the build that answered. `/systemone` shows the same status in a session.

### See what the agent can do with it

`consult` is a direct tool in the main session, limited to three calls a turn. Workers do not get it. The agent decides when to call it, so you may see few calls or none.
:::

::: result What you should see
`status` names your route as on, and `check --live` reports a build. This shows the route answers. It says nothing about whether its answers are good on your repository, and nothing measures your engine for you.
:::

## Choose a route

::: compare
| Route | What answers | What it returns |
| --- | --- | --- |
| `jev` | A hosted engine, with no `targets` entry needed | Real probabilities |
| A declared engine | A decision server you run, with a named profile | What its profile declares |
| `memory` | The model in `context.memory` | One label per question |
| `main` or a chat target | A chat route you already have | One label per question |
:::

Label routes have no real probabilities, so a filter match from them has no score. They also never drive the judge screen, and a stop label from them never interrupts a run.

## What each use does

**Filter.** `consult` scores up to 256 items against one criterion, and only ids and scores enter the agent's context. A file reaches the model as its path and a digest of its leading comment, exports, and imports, so a filter misses behavior inside a body. Treat it as a way to narrow a list, then read what it returns. Use `grep` to find behavior.

**Questions.** `consult` also asks one to four typed questions: yes or no, pick, or rate. It returns numbers, never a chosen option. The agent decides. On something the agent already read, the model knows less than the agent does.

**Judge screen.** When the safety judge reviews a main-session call, System One reads recent web and MCP results and asks whether they instruct an AI agent. It can only tighten: a judge allow becomes a card that names the source, and a block stays a block. It runs only on routes that declare real probabilities.

**Steering triage.** With `chat.steering.triage.enabled` on, each queued message gets two typed picks: how it relates to the work and how soon it should land. Triage is off by default.

## Where your data goes

A hosted route receives what these uses send: file digests and heads, chunks of a result, web and MCP result text, and queued messages. Naming a route enables the judge screen too, so result text can leave the machine at judge time. State is redacted first, and redaction is best effort. Use a route you run yourself when that matters.

## Turn it off

```sh
clio-coder systemone off
```

Off is the default, and it sends no request and adds nothing to the prompt or the tool list. A failed ask returns nothing, and the agent carries on as if System One were absent.

::: limits Boundaries
- It is not a safety net. The deterministic safety rules and the judge decide, and no use removes a confirmation.
- A filter miss is not proof either, especially when `carried.partial` is above zero.
- Profiles declare how a model family's numbers are read. They make no accuracy claim, and there are no fitted thresholds.
- Clio Coder ships a client for these wires, not an inference server.
- The fixed decision sites, `/draft` judging, and the decision dataset from earlier releases are gone. `clio-coder doctor --fix` removes their retired settings.
:::

::: next
- [The full System One guide](https://github.com/iowarp/clio-coder/blob/main/docs/guide/system-one.md)
- [Diffusion models in the terminal](/experimental/diffusion-models.html)
- [Let Clio Coder work without watching every call](/tutorials/let-it-work-with-containment-and-rewind.html)
:::
