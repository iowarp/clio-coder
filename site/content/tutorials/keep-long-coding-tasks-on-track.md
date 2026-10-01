Long coding work needs more than saved chat history. You need the current objective, the decisions that still apply, the relevant files, and the checks left to run. Clio Coder gives you controls for inspecting that context and continuing after a session grows.

::: note Version scope
This guide describes the v0.6.0 context workflow. It does not promise that every detail survives summarization or that a model cannot misunderstand a handoff.
:::

::: diagram context-controls
:::

## Give the project a starting point

A project handbook orients the model toward the repository's structure and rules. The context commands prepare a `CLIO-CODER.md` handbook and a structural code index, now called a codemap.

```sh
clio-coder context init
clio-coder context index
```

Review generated project material as you would any other change. Keep build commands and verification expectations specific to the project: an incorrect handbook makes the wrong answer easier to repeat.

The codemap locates structural information without reading every file into the conversation. It does not replace reading a function before changing its behavior. Legacy codewiki files remain readable; new output uses codemap.

## Inspect before the context fills

In the terminal, `/context` shows usage, output reservation, remaining headroom, and any pending handoff. On the desktop alpha, open **Session panel**, then **Context** under **Session**. Branches and handoffs are under **Tools**.

::: capture tui-context gui-session-context gui-session-branches
The same conversation's context in the terminal and the desktop alpha, and its branches.
:::

Watch what you are accumulating. A large test log, an old exploration branch, and a current design decision should not carry the same weight. Ask the agent to cite the file or tool result behind an important conclusion instead of a remembered paraphrase.

## Reduce with a stated purpose

```text
/context compact Keep the objective, decisions, changed files, test results, and remaining work.
```

::: result After compaction
Read the continuation. Compaction reduces history; it does not prove that the model kept every fact. If an important constraint disappears, restate it with its source.
:::

## Hand off a defined continuation

`/handoff <goal>` prepares a continuation around a stated goal. A useful goal says what the receiving session should do next and which work must stay intact.

::: prompt Example handoff goal
/handoff Fix the empty-input parser bug: keep the failing case in tests/parser.test.ts, the chosen approach of validating before tokenizing, and rerun the parser tests before finishing.
:::

Handoffs are bound to the active branch and its decisions. A fork can recall earlier notes without inheriting permission to resume its parent's pending transition. Use `/tree` and `/fork` deliberately, and confirm which branch you are continuing.

## Recover an interrupted transition explicitly

If `/context` shows a pending handoff, use its exact ID:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

These are two different recoveries, not two commands to run in turn. Choose **reduce** when the reduction has not committed and another attempt remains; choose **deliver** when the validated commit exists. The [continuity guide](/docs/guide/context-continuity.html) explains those states.

A restarted process records an interrupted handoff as paused and waits for your command. Do not create a new handoff just because a pending one looks unfamiliar.

## Keep memory reviewable

Proactive memory is separate from the working context. Review a proposed lesson before accepting it as durable material; an observation about one repository should not quietly become a rule for every project.

Settings lets you choose the memory route, including **Rules only** when you do not want a background model call. Stored memory is not fine-tuning of the underlying model. Its value depends on selection, scope, and whether it is still relevant.

::: limits
- A summary is a model's reduction, so check it against sources when it matters.
- A handoff belongs to the branch that prepared it; a fork recalls its notes but cannot resume it.
- Memory proposals need review before they influence later sessions.
:::

::: next
- [Your first session with Clio](/tutorials/first-session.html)
- [Continuity guide](/docs/guide/context-continuity.html)
- [Resource Library](/docs/guide/resource-library.html)
:::
