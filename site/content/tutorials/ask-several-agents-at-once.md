Sometimes one agent's answer is not enough. `/poll` asks two to five agents the same question independently and shows how they vote. `/council` gives a roster of two to five agents the same task and can have a judge write one answer from theirs. Both are read-only: the members read your project, argue and vote, but never change a file.

::: note Version scope
This tutorial describes v0.8.0. The output below is from CLIO Coder run against a fresh CLIO Coder home and a one-file Node package, with one local model (Qwen 3.8 27B) serving every participant. The package's Git status was clean afterwards.
:::

::: needs
- CLIO Coder connected to at least one model. Every participant can run on the same one.
- For `/council`, a roster in your settings (shown below).
- An interactive session: at the default autonomy level, a poll or a council waits for your approval.
:::

## Ask a quick question with /poll

`/poll` takes the number of participants, then the question. `--options` limits each vote to one of the listed answers, and `--rationale` asks for a short reason with each vote:

```text
/poll --options node:test|vitest|jest --rationale 3 Which test runner should a small dependency-free ES module package like this one use?
```

Without `--models`, every participant runs on your chat model. `--models litellm,big-box/qwen3-coder-next` seats them in turn on the routes you list, so the answers can come from different models. Each participant answers alone: no one sees another's answer.

## Approve the plan

A poll is a small fleet, so at the default autonomy level CLIO Coder shows the plan before anything starts. It names each participant, its agent and its model:

```text
Plan ────────────────────────────── Alt+V shows every field
p1    scout on litellm · qwen3.8-27b
p2    scout on litellm · qwen3.8-27b
p3    scout on litellm · qwen3.8-27b
cost  counts against this session's $5.00 limit
```

Enter allows it, and Esc denies it without starting anyone. At `yolo` the plan runs without this stop. Participants run as the `scout` agent, and every member of a poll or council gets only read-only tools: `read`, `grep`, `find`, `ls`, `git`, `code_nav` and `context`.

## Read the vote

Each participant appears with its time and the start of its answer. When all have voted, CLIO Coder prints the distribution:

```text
poll       3 of 3 voted; majority: node:test
node:test  ### 3 (100%)
```

The headline reads `majority` when one answer has more than half the votes, `plurality` when it leads without a majority, and `tie` when the top two are level. Here all three read `package.json`, saw a `node --test` script and kept it. `/view` opens each full answer. A participant whose vote names none of the options is asked again, with the options quoted.

## Declare a council roster

A council needs a roster. Without one, `/council` stops and says where to add it:

```text
/council needs a roster. Declare one under fleet.rosters in settings.yaml, for example fleet.rosters.default with two to five members, each with a
label and a target, then run /council <task> or name another roster with --roster <name>.
```

Each member has a label and a target, and can name a model and an agent. This roster seats one plain reader and one `tester`:

```yaml title=settings.yaml
fleet:
  rosters:
    default:
      members:
        - { label: reader, target: litellm }
        - { label: tester, target: litellm, agent: tester }
```

The roster is read on the next command, without a restart. `--roster <name>` picks another roster. A member whose target runs on an SSH fleet node, or on an agent runtime that cannot enforce read-only tools, such as an ACP peer, is refused before you approve anything.

## Ask the council, with a judge

```text
/council --synthesis judge Is add() in index.js covered by a test, and what is the smallest test that would cover it?
```

The plan card listed `reader` as `scout`, `tester` as `tester`, and a synthesis run as `oracle`. The `tester` member kept its own way of working, but the council's read-only tools still applied, so it argued for a test without writing one. After both answered, the judge read their answers, checked them against the files and wrote one answer. It opened:

```text
Both council members agree on the facts, and my own inspection confirms them:
```

It went on to say that `index.test.js` already imports `add` and checks `add(2,2)` against 4 under `node:test`, so the function is covered.

`--synthesis vote` tallies the members' votes instead, and `none`, the default, returns each answer as it is. `--rounds 2` or `3` shows each member the others' previous answers before it answers again. `--deadline 90s` stops a member that runs too long, and the council returns the rest marked partial.

::: result What you have
A spread of independent answers to one question, and for a council either a tally or one written answer with every member's answer behind it. Each member's run has its own sealed run record, and no file in the project changed.
:::

The answers stay out of your main conversation. `/fleet share <runId>` brings the synthesis or one member's answer into it.

::: limits
- Members on one model are not fully independent. They share its habits, so a unanimous vote from one model is weaker evidence than a split across several. Use `--models` or a mixed roster to spread the question.
- Every member is a model run and counts against your spending limit. Here the `tester` member alone used 22,122 tokens.
- Members run on this machine only. A council never writes files or makes a worktree.
:::

::: next
- [Workers and fleets: council](/docs/guide/fleet-dispatch.html)
- [Commands and shortcuts](/docs/guide/commands-and-modes.html)
- [Coordinate the coding agents you already use](/tutorials/coordinate-your-coding-agents.html)
:::
