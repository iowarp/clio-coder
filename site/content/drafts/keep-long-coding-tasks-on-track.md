Long coding work needs more than saved chat history. You need the current objective, the decisions that still apply, the relevant files, and the checks left to run. Clio Coder gives you controls for inspecting that context and continuing after a session grows.

This guide describes the v0.5.7 context workflow. It does not promise that every detail survives summarization or that a model cannot misunderstand a handoff.

## Give the project a usable starting point

A project handbook helps orient the model toward the repository's structure and rules. Clio's context commands can prepare a `CLIO-CODER.md` handbook and a structural code index, now called a codemap.

```sh
clio-coder context init
clio-coder context index
```

Review generated project material as you would any other change. Keep build commands and verification expectations specific to the project. An incorrect handbook makes the wrong answer easier to repeat.

The codemap helps locate structural information without reading every file into the conversation. It does not replace inspecting the implementation of a function before changing its behavior. Legacy codewiki files remain readable, but new terminology and output use codemap.

## Inspect before the context fills

In the terminal, `/context` shows usage, output reservation, remaining headroom, and any pending handoff. The desktop alpha exposes conversation context and branches in its session controls.

Watch the information you are accumulating. A large test log, an old exploration branch, and a current design decision should not all receive the same weight. Ask the agent to cite the file or tool result behind an important conclusion instead of relying on a remembered paraphrase.

If you need to reduce the conversation, give the reduction a concrete purpose:

```text
/context compact Keep the objective, decisions, changed files, test results, and remaining work.
```

Review the continuation. Compaction reduces history; it is not proof that a model retained every fact correctly. If an important constraint disappears, restate it with its source.

## Use a handoff for a defined continuation

`/handoff <goal>` prepares a continuation around a stated goal. A useful goal says what the receiving session should do next and which work should remain intact.

For example, after diagnosing a parser bug, the handoff should preserve the failing case, relevant paths, the chosen approach, and the check still required. A general instruction to “finish the project” gives the receiving model little basis for choosing its next action.

Handoffs are bound to the active branch and decisions. A fork can recall earlier notes without inheriting permission to resume its parent's pending transition. Use `/tree` and `/fork` deliberately; confirm which branch you are continuing.

## Recover an interrupted transition explicitly

If `/context` shows a pending handoff, use its exact ID with the documented recovery controls:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

These are different recovery actions, not two commands to run blindly. Choose reduction when it has not committed and another attempt remains; choose delivery when the validated commit exists. The [continuity guide](/docs/guide/context-continuity.html) explains those states.

A process restart can leave an interrupted handoff paused. Clio waits for an explicit recovery command. Do not manufacture a new handoff just because a pending one looks unfamiliar.

## Keep memory reviewable

Proactive memory is separate from the active working context. Review proposed lessons before accepting them as durable material. An observation about one repository should not quietly become a rule for every project.

Settings lets you choose the memory route, including Rules only when you do not want a background model call. Stored memory is not fine-tuning of the underlying model. Its value depends on selection, scope, and whether it is still relevant.

For a fresh task, use `/resume` or select a saved desktop conversation, confirm its branch and current files, and request the next bounded step. Start with the [first-session tutorial](/tutorials/first-session.html) if you have not connected a model yet. For extensions to a workflow, review the [resource Library](/docs/guide/resource-library.html) before loading more instructions into the session.
