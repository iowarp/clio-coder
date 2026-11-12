Does memory make an agent better at the next task, or does it only add text to a prompt? CLIO Coder has a working memory system with an approval gate, and it can also approve some of its own lessons. Nobody has yet measured whether any of this changes outcomes.

::: note Open question, described for v0.6.8
Proactive memory has shipped and is on by default. This page has no outcome numbers because none exist yet, and every experiment here is proposed and not yet run. The team, students, and outside researchers are welcome.
:::

## The question

- **Effect.** With a relevant lesson available, does an agent avoid a mistake it would otherwise repeat, at what model cost?
- **Trust.** Is the rule that lets a repository lesson approve itself safe, and how often does it approve something wrong?
- **Timing.** When should a reminder appear so that an agent acts on it without being distracted by it?

## What is known so far

These are facts about the design at this version. They are not study results.

The design follows Wu et al., *Remember When It Matters: Proactive Memory Agent for Long-Horizon Agents* (2026), adapted to CLIO Coder. A session keeps bounded banks of knowledge, attempts, and diagnoses. A rules tier makes no model calls. A model tier uses the memory route, or the chat route when no memory route is set, so a default install spends model calls on memory.

Durable lessons are separate from those banks, and only eligible approved records reach a prompt. A person can approve any record.

Repository knowledge from a task-bank entry can also receive automatic approval once one session records that the lesson held, with no contradiction or recorded regression. It waits for a person if another approved or rejected lesson already carries the same command as evidence.

CLIO Coder records two useful observations about an approved lesson: `delivered` when its reminder was submitted, and `held` when the recommended command then succeeds exactly. A held lesson did not necessarily cause that success, and the agent might have run the command anyway. That gap is the research problem in one sentence.

## Why it matters

Long agent work fails in repetitive ways: the same wrong command, the same forgotten convention, the same dead end after a reset.

Memory is the obvious fix, and also an easy way to pay for tokens that do nothing, or to teach an agent something false that then persists across sessions. Evidence here would tell users when to leave it on and developers what to cut.

## Directions to work on

**Measure counterfactual effect.** Compare paired sessions on seeded tasks with memory on and off, and with a lesson present and absent. Count repeated failures, rounds, and cost, including memory's own calls.

**Audit the approval gate.** Collect automatically approved lessons from real repositories and have a person grade them. A false-approval rate, even from a small sample, would be new evidence about whether one held session is enough.

**Study reminder timing.** Reminders can land at tool-batch boundaries, at turn end, or on the next prompt. Cadence is configurable, so whether frequent reminders help or distract can be tested.

**Compare memory routes.** A small local model and the main chat model may produce very different lessons at very different costs.

## Use CLIO Coder on it today

::: steps
### Look at what memory is doing

Open `/memory` in the terminal. Its tabs are **Lessons**, **This task**, **Review**, and **Diagnostics**. In **Review**, `a` approves a proposal and `x` rejects it. From the shell, `clio-coder memory` lists, approves, rejects, and prunes durable records.

### Control the conditions

In `/settings`, **Memory connection** and **Memory model** choose the route. **Proactive memory** turns the whole system off, or set `context.memory.enabled: false` in project settings for one arm of a study. Cost appears in `/usage` and `clio-coder usage report`.

### Capture more when you need it

```sh
clio-coder telemetry consent --workspace <dir>
```

With `telemetry.mode: research`, consent for that workspace, and `telemetry.research.content` on, CLIO Coder also records memory traces in the session's journal. This stores redacted content, so use a repository you may study.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. A result of no effect would be just as useful.
:::

**Does one approved lesson stop a repeated mistake?**

::: steps
### Seed a trap

Make a small repository where the obvious test command fails and a documented, less obvious one succeeds. Put the working command somewhere an agent must look for it. Commit that state.

### Teach it once

Run one session that hits the trap and finds the way through. Check `/memory`, and approve a lesson that names the working command. If none is proposed, write that down, since it is itself a finding.

### Run paired arms

From fresh checkouts, run the same new task five times with the lesson available and five times with `context.memory.enabled: false`. Keep the model and version fixed.

### Score it

For each session, count failed attempts of the obvious command, tool calls, and total cost from `clio-coder telemetry cost <session-id> --json`. Report the numbers for each arm and say the sample is small.

### Report it

Open a GitHub issue with the setup, the table, and the lesson's text.
:::

Needs: any chat route and a repository you can publish or describe. A local model server avoids keys and spend. Durable memory lives in your own state directory, so set `CLIO_CODER_HOME` to a separate directory for the study and keep your real lessons out of it.

## How to join

Open a GitHub issue on [the repository](https://github.com/iowarp/clio-coder/issues) saying what you want to try, before or after you run it, and read the [contributor guide](https://github.com/iowarp/clio-coder/blob/main/CONTRIBUTING.md) for code changes. Negative results and replications are welcome.

::: limits Boundaries
- `held` is an evidence-gate input and is not proof of a general claim.
- Stored memory is not fine-tuning of the underlying model.
- A background model never writes directly to the system prompt.
:::

::: next
- [Keep a long coding task on track](/tutorials/keep-long-coding-tasks-on-track.html)
- [Proactive memory guide](/docs/guide/proactive-memory.html)
- [Can an agent run be a scientific record?](/research/sealed-run-records.html)
:::
