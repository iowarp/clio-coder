System One is an optional decision layer. At a few fixed points in a session, Clio Coder can ask a small, fast model a typed question, such as "which of these drafts answers the request best?", and get back probabilities instead of prose. It never answers you, never edits files, and never removes an approval.

::: note Experimental in v0.6.0
System One is off until you bind a decision site to an engine. Settings, `clio-coder doctor`, and `/usage` label it experimental. Site names, engine options, and the settings format may change between releases.
:::

::: needs
- Clio Coder 0.6.0 with a working chat model.
- One engine: a chat target you already configured, a self-hosted `systemone` server, or a hosted decision engine account.
- A reason to try it. Nothing else in Clio Coder depends on System One.
:::

## What a decision site is

A site is one place where Clio Coder asks a question. Each site has a deadline in milliseconds or seconds. A site that is unbound, late, or failing behaves as if System One did not exist, and three timeouts in a row pause that engine for five minutes.

::: compare
| Site | What it reads | What it can do |
| --- | --- | --- |
| `drafts` | The candidates from `/draft` | Rank them and mark unsound ones |
| `toolCall` | A one-line, redacted summary of a pending command | Add an advisory line to the approval card |
| `turn` | Your request at the start of a turn | Hint scope and orientation, for a fitted engine only |
| `relevance` | Skill, capability, and memory catalogs | Reorder them |
| `consult` | A typed question from the agent | Answer it, up to three times a turn |
| `toolResult`, `turnEnd`, `steer` | Web and MCP output, the finished reply, queued messages | Record a reading only |
:::

## Start with drafts

`/draft` asks your active chat model for several answers to one request, in parallel, and shows them side by side. It works without System One. Binding the `drafts` site adds a judge.

::: steps
### Bind the site to a chat target

Add this to your settings file, using the name of a target you already have. `/settings` lists System One under Advanced, then Experimental.

```yaml title=settings.yaml
systemOne:
  engines:
    chat:
      kind: llm
      target: my-chat-target
  sites:
    drafts: chat
```

### Ask for drafts

```text
/draft 3 Write the commit message for the staged change.
```

The count is 2 to 4 and defaults to 3. Candidates differ by sampling temperature, or by a different angle in the prompt for models that refuse a temperature.

### Read the ranking, then choose

Each candidate gets a row with a probability bar. The judge's choice is marked **picked**, and a candidate it finds incorrect or incomplete is marked **judged unsound**. Enter places the selected draft in the composer without sending it. Escape closes the view.
:::

::: result Without a judge
With no `drafts` binding, the candidates still appear and the view says they were not judged. The ranking is a model's opinion about text. It did not run your tests.
:::

## Choose an engine

An `llm` engine is any chat target, and is the quickest way to try a site. Each question costs two model requests when the target returns token probabilities and five when it does not. Those requests pass the same cost ceiling as the rest of the session and appear in `/usage` as System One calls.

A `systemone` engine is a server built for these questions: a hosted decision engine, or a `systemone` server you run. The guide lists the supported engine profiles and where to place each one.

## Shadow first

An engine acts on the `turn` and `relevance` sites only when Clio Coder has measured confidence thresholds, called cuts, for that exact model build. Without cuts the engine runs in shadow: its answers are recorded and change nothing. The approval advisory, `consult`, and `/draft` show any engine's answer and name the build that gave it.

`clio-coder doctor` prints one row per bound site and per engine. To keep a local dataset of decisions and outcomes, set `systemOne.record: true`, then use `clio-coder systemone status` and `clio-coder systemone export --out <file>`. Rows are redacted, kept 30 days by default, and stay on your machine.

::: limits Know what leaves your machine
- State is redacted before any engine sees it, but a hosted engine still receives request text and bounded tool output. A local server keeps that data on your machine.
- A probability is advice. Approvals, permissions, and checks work the same with System One on or off.
- An `llm` engine spends tokens on every question.
:::

::: next
- <a href="<!-- source-blob -->/docs/guide/system-one.md">System One guide in the repository</a>
- [Choose a model for your project](/tutorials/choose-model-for-your-project.html)
- [Diffusion models in the terminal](/experimental/diffusion-models.html)
:::
