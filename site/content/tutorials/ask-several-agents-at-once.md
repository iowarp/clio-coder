Sometimes one agent's answer is not enough. `/poll` asks two to five agents the same question independently and shows how they vote. `/council` gives a roster of two to five agents the same task and can have a judge write one answer from theirs. Both are read-only: the members read your project, argue and vote, but never change a file.

::: note Version scope
This tutorial describes v0.8.1. The output below is from CLIO Coder run against a fresh CLIO Coder home and a one-file Node package, with participants seated on two models: Claude Haiku 5.5 on the `anthropic-max` route and GPT-6 Luna on the `openai-codex` route. The package's Git status was clean afterwards.
:::

::: needs
- CLIO Coder connected to at least one model. Every participant can run on the same one.
- For `/council`, a roster in your settings (shown below).
- An interactive session: at the default autonomy level, a poll or a council waits for your approval.
:::

## Ask a quick question with /poll

`/poll` takes the number of participants, then the question. `--options` limits each vote to one of the listed answers, and `--rationale` asks for a short reason with each vote:

```text
/poll --options node:test|vitest|jest --rationale --models anthropic-max/claude-haiku-5-5,openai-codex/gpt-6-luna 3 Which test runner should a small dependency-free ES module package like this one use?
```

Without `--models`, every participant runs on your chat model. `--models` takes a comma-separated list of `target` or `target/model` routes and seats participants on them in turn, so here p1 and p3 ran on Claude Haiku 5.5 and p2 on GPT-6 Luna. Each participant answers alone: no one sees another's answer.

## Approve the plan

A poll is a small fleet, so at the default autonomy level CLIO Coder shows the plan before anything starts. It names each participant, its agent and its model:

```text
Plan ────────────────────────────── Alt+V shows every field
p1    scout on anthropic-max · claude-haiku-5-5
p2    scout on openai-codex · gpt-6-luna
p3    scout on anthropic-max · claude-haiku-5-5
cost  counts against this session's $5.00 limit
```

Enter allows it, and Esc denies it without starting anyone. At `yolo` the plan runs without this stop. Participants run as the `scout` agent, and every member of a poll or council gets only read-only tools: `read`, `grep`, `find`, `ls`, `git`, `code_nav` and `context`.

## Read the vote

Each participant appears with its time and the start of its answer. When all have voted, CLIO Coder prints the distribution:

```text
poll       3 of 3 voted; majority: node:test
node:test  ### 3 (100%)
```

The headline reads `majority` when one answer has more than half the votes, `plurality` when it leads without a majority, and `tie` when the top two are level.

Here all three chose `node:test` in about two seconds each, on both models, and gave the same reason: it ships with Node and adds no dependency. `/view` opens each full answer. A participant whose vote names none of the options is asked again, with the options quoted.

## Declare a council roster

A council needs a roster. Without one, `/council` stops and says where to add it:

```text
/council needs a roster. Declare one under fleet.rosters in settings.yaml, for example fleet.rosters.default with two to five members, each with a label and a target, then run /council <task> or name another roster with --roster <name>.
```

Each member has a label and a target, and can name a model and an agent. This roster seats one plain reader and one `tester`:

```yaml title=settings.yaml
fleet:
  rosters:
    default:
      members:
        - { label: reader, target: anthropic-max, model: claude-haiku-5-5 }
        - { label: tester, target: openai-codex, model: gpt-6-luna, agent: tester }
```

The roster is read on the next command, without a restart. `--roster <name>` picks another roster. A member whose target runs on an SSH fleet node, or on an agent runtime that cannot enforce read-only tools, such as an ACP peer, is refused before you approve anything.

## Ask the council, with a judge

```text
/council --synthesis judge Is add() in index.js covered by a test, and what is the smallest test that would cover it?
```

The plan card listed `reader` as `scout` on Claude Haiku 5.5, `tester` as `tester` on GPT-6 Luna, and a synthesis run as `oracle` on the fleet's default route, here GPT-6 Luna. The `tester` member kept its own way of working, but the council's read-only tools still applied, so it answered without writing a test. It made 4 tool calls and answered:

```text
Yes. `index.test.js` directly tests `add(2, 2) === 4`, which covers the function’s basic behavior. The smallest test is that existing assertion; no additional test is needed for basic coverage.
```

The `reader` member finished in 1.13 seconds without answering the question. Its whole answer was one pending finding: `read index.js and index.test.js to determine coverage of add()`. The judge read both answers and wrote one, with the verdict `covered`:

```text
Yes. `index.test.js` tests `add(2, 2) === 4`. The smallest test is a single assertion that calls `add` with two inputs and checks the expected result; the existing test already does this.
```

A council does not hide a weak member. `/view` shows each member's answer beside the synthesis, so you can see that this verdict rests on one member's reading.

`--synthesis vote` tallies the members' votes instead, and `none`, the default, returns each answer as it is. `--rounds 2` or `3` shows each member the others' previous answers before it answers again. `--deadline 90s` stops a member that runs too long, and the council returns the rest marked partial.

::: result What you have
A spread of independent answers to one question, and for a council either a tally or one written answer with every member's answer behind it. Each member's run has its own sealed run record, and no file in the project changed.
:::

The answers stay out of your main conversation. `/fleet share <runId>` brings one member's answer into it; shared from the synthesis run, it brings the synthesis with every member's labelled answer.

::: limits
- Members on one model are not fully independent. They share its habits, so a unanimous vote from one model is weaker evidence than a split across several. Use `--models` or a mixed roster to spread the question.
- Every member is a model run and counts against your spending limit. Here the `tester` member alone used 7,056 tokens.
- Members run on this machine only. A council never writes files or makes a worktree.
:::

::: next
- [Workers and fleets](/docs/guide/fleet-dispatch.html)
- [Commands and shortcuts](/docs/guide/commands-and-modes.html)
- [Coordinate the coding agents you already use](/tutorials/coordinate-your-coding-agents.html)
:::
