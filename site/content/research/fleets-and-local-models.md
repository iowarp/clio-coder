When is it worth running several agents on one problem, and how small a model can still do useful work? CLIO Coder can run workers across local and remote machines, have candidates compete, and convene a council of models. These are shipped controls. We have no comparative numbers on when any of them pays off.

::: note Open question, described for v0.8.0
The fleet features on this page have shipped. This page has no comparative results because none exist yet, and every experiment here is proposed and not yet run. The team, students, and outside researchers are welcome.
:::

## The question

- **Multi-agent value.** Per dollar and per hour, when does compete or council beat one agent on the same task?
- **Local capability.** Which coding tasks can a model on one workstation finish, and where does it fail?
- **Heterogeneous fleets.** Does a mix of a strong planner and small workers beat a uniform fleet of either?
- **Other model families.** Do diffusion language models hold up on long agentic work?

## What is known so far

These are facts about the design at this version. They are not study results.

Compete runs 2 to 4 candidates in scratch worktrees with a read-only judge. A council runs two to five read-only members on the same task, with optional vote or judge synthesis. A review gate adds a read-only reviewer and a bounded revise loop. Workers can be routed per agent or per call, on the local machine or on SSH nodes.

Each council member can run as a named agent, such as `coder` or `architect`, with its own target, model and thinking level. The council stays read-only whatever the agent. `/poll` asks 2 to 5 participants one question as a one-round vote and shows the distribution; `--models` spreads them across models.

`arena run --check <id>` runs one declared check in each contender's worktree. The project's check file and the uncommitted files the check names are copied in first, so every contender is scored on the project's bytes, not its own copy.

Each run is sealed with its route, tokens, cost, and assessment, so a comparison can be built from records.

CLIO Coder reads local servers such as LM Studio, Ollama, and llama.cpp, and asks each for its real serving window where it can. Inception's Mercury diffusion models are available for chat and workers. They are less tested on long agentic work than the models most people use.

What is missing is any measurement across these options. A sealed record shows what one run did, which leaves open whether a different arrangement would have done better.

## Why it matters

Running four agents costs roughly four times as much, and it is not obvious what that buys. Local models matter for a different reason: some groups cannot send their code or data to a cloud provider, and they need to know what a workstation can really do before they build on it.

## Directions to work on

**Price multi-agent modes.** Take tasks with mechanical acceptance, then compare one agent, a 2-candidate compete, and a council on acceptance, cost, and time.

**Map the local frontier.** Run a graded set of tasks against a few local models. Report where tool calling, long context, and multi-file edits each break down.

**Test placement.** Try a strong orchestrator with small local workers, and the reverse. `fleet.concurrency`, worker profiles, and per-call pins give the controls.

**Try diffusion models on agent work.** Compare Mercury with a token-by-token model of similar speed or price on the same tasks.

## Use CLIO Coder on it today

::: steps
### Connect a local model

On a new home, `clio-coder` looks for a server on its default port, such as LM Studio at `http://localhost:1234` or Ollama at `http://localhost:11434`, and offers it. On another address, run `clio-coder configure` and choose **A model server or gateway**. Choose a model that supports tool calling. The [local model tutorial](/tutorials/run-on-a-local-model.html) walks through it.

### Run a single worker with a record

```sh
clio-coder run --agent <agent-id> --target <target-id> --json "<task>"
clio-coder telemetry cost --run <run-id> --json
```

`--target` and `--model` override the route for one run, so one script can sweep several models.

### Use the multi-agent shapes

In a session, ask the agent to dispatch your task in compete mode with two candidates. For a council, use `/council`:

```text
/council --synthesis judge <task>
```

For a quick comparison across two targets you have configured, here `workstation` and `lab`, ask one question:

```text
/poll --models workstation,lab --options yes|no --rationale 4 Is this patch safe to merge?
```

Rosters are set in settings. `clio-coder fleet status --json` lists runs, and `clio-coder doctor` reports readiness.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. Even a result on one bug gives the next person a method to improve.
:::

**One seeded bug: is a 2-candidate compete worth it on a local model?**

::: steps
### Prepare the task

Take a small repository with a good test suite and introduce one bug that makes a test fail. Commit that state, and write down the bug so you can grade results.

### Run both arms

From fresh checkouts, run a single agent five times and a 2-candidate compete five times, with the same model and version.

### Score it

Record for each trial whether the suite passes with the original tests unchanged, total tokens from the run records, and elapsed time. Local models have no bill, so report tokens and time.

### Report it

Open a GitHub issue with the model, the hardware, the table, and your sample size.
:::

Needs: one machine that can run a tool-calling model through a local server. A GPU helps but is not required for a small model. No keys. Extra SSH nodes are optional.

## How to join

Open a GitHub issue on [the repository](https://github.com/iowarp/clio-coder/issues) saying what you want to try, before or after you run it, and read the [contributor guide](https://github.com/iowarp/clio-coder/blob/main/CONTRIBUTING.md) for code changes. Negative results and replications are welcome.

::: limits Boundaries
- One bug in one repository does not generalize, so report it as what it is.
- Worker slots limit concurrency. They are not an allocation, and a login node is not a compute node.
- A cloud model sends its input to that provider, including from a remote node.
:::

::: next
- [Choose a model for your project](/tutorials/choose-model-for-your-project.html)
- [Run a research campaign and a blind arena](/tutorials/run-a-research-campaign-and-a-blind-arena.html)
- [Fleet guide](/docs/guide/fleet-dispatch.html)
- [Diffusion models in the terminal](/tutorials/diffusion-models.html)
:::
