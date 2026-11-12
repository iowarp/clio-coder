When an agent's conversation is reduced to fit a model's window, what gets lost, and what does that loss cost later? CLIO Coder has several ways to reduce context and an optional index for finding things by meaning. It measures size and cost carefully. It does not yet measure whether the agent still knows what it needs.

::: note Open question, described for v0.8.0
Compaction has shipped and is on by default. Semantic context is a beta feature that is off by default. This page has no fidelity numbers because none exist yet, and every experiment here is proposed and not yet run. The team, students, and outside researchers are welcome.
:::

## The question

- **Fidelity.** Which facts survive a summary, and which kinds are most often dropped: constraints, decisions, file paths, or test results?
- **Policy.** When should a system evict old material, summarize it, or keep it, given what each choice does to the model's cache and to the next request's cost?
- **Retrieval.** Does search by meaning help an agent find the right material, compared with the `grep` and code map it already has?

## What is known so far

These are facts about the design at this version. They are not study results.

Automatic reduction normally starts at 80% of the effective window, or earlier at a 400,000-token ceiling. Working-set eviction runs first, then summarization if that is not enough. The default eviction policy is `structural-v2`. Summaries follow a fixed checkpoint shape: goal, constraints and preferences, progress, key decisions, next steps, and critical context.

CLIO Coder records whether a reduction gained anything. A summary that would not shrink the context is discarded, its cost stays in the totals, and an identical later automatic request makes no call. The journals also separate what a call read from cache and what it had to send again, so the cost side can be measured precisely.

The quality side has no measure. A checkpoint can be small, valid, and missing the one constraint that matters, and nothing would notice.

Semantic context can index code maps, wiki pages, approved memory, evidence, and registered folders with a local embedding model. Its `--qualify` check confirms that a route accepts requests and returns vectors of the right shape. It does not check retrieval quality.

## Why it matters

Long tasks now routinely outlive a model's window. A summary is a lossy step in the middle of every one of them, and its failures look like the model being forgetful or careless later on. A fidelity benchmark would let anyone compare summarizers, prompts, and policies with something better than impressions.

Cost matters too. A reduction can also break the model's cache, so the cheapest-looking choice in the moment can be expensive over the following turns.

## Directions to work on

**Build a fidelity benchmark.** Plant facts of known types in a real session, reduce it, then probe. Open sets of sessions and probes would be useful to other agent projects as well.

**Compare summarizers and instructions.** `context.compaction.model` can name a smaller model, and `/context compact <what to keep>` directs a summary. Does a cheap model lose more, and does stating what to keep actually help?

**Compare policies on total cost.** Vary `context.compaction.threshold`, `context.compaction.maxTokens`, and the working-set policy, then measure cost and cache behavior over a whole task.

**Evaluate retrieval on real questions.** Label a set of questions about a repository, then compare semantic search with `grep` and the code map on recall and on how many tool calls the agent spends.

## Use CLIO Coder on it today

::: steps
### Inspect and reduce

Open `/context` for usage, the output reserve, headroom, and any pending handoff. Then reduce with a stated purpose:

```text
/context compact Keep the objective, decisions, changed files, test results, and remaining work.
```

### Read the cost

```sh
clio-coder telemetry cache <session-id> --json
clio-coder telemetry cost <session-id> --json
clio-coder telemetry timeline <session-id> --json
```

### Try semantic search

```sh
clio-coder semantic configure --help
clio-coder semantic refresh
clio-coder semantic search "Which run produced the delayed oscillation?" --limit 5
```

This needs a local embedding route. The [semantic context tutorial](/tutorials/semantic-context-and-recordings.html) walks through setup.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. Its materials would become the start of a shared benchmark.
:::

**How many planted facts survive one summary?**

::: steps
### Plant the facts

Write 20 short facts, five each of four types: a constraint, a decision with its reason, a specific file path, and a test result. State them to the agent across the first part of a real coding session, then keep working until the session holds plenty of other material.

### Reduce the same session two ways

Use `/fork` to branch the session before reducing. Run `/context compact` with no instructions on one branch, and with instructions naming what to keep on the other.

### Probe

Ask each branch the same 20 questions, one per fact, and tell it not to open any file. Score each answer as correct, wrong, or missing, and have someone else grade a sample.

### Report it

Open a GitHub issue with the survival rate by fact type for each branch, the model used, and the session size before and after. One session is an anecdote, so say so, and repeat it if you can.
:::

Needs: any chat route, and a session long enough to reduce. A local model server avoids keys. Leave the session content out of what you publish unless you may share it.

## How to join

Open a GitHub issue on [the repository](https://github.com/iowarp/clio-coder/issues) saying what you want to try, before or after you run it, and read the [contributor guide](https://github.com/iowarp/clio-coder/blob/main/CONTRIBUTING.md) for code changes. Negative results and replications are welcome.

::: limits Boundaries
- A probe measures recall on request. An agent may still fail to apply a fact it can recite.
- Similarity finds candidates. It is not proof of a result.
- Telling a model not to open files limits what it does only as far as it follows that instruction, so check the tool calls.
:::

::: next
- [Keep a long coding task on track](/tutorials/keep-long-coding-tasks-on-track.html)
- [Context continuity guide](/docs/guide/context-continuity.html)
- [Search your project by meaning and record worker runs](/tutorials/semantic-context-and-recordings.html)
:::
