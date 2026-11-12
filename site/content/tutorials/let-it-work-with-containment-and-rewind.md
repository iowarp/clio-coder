Most of a coding task should not need you. At the `default` level, Clio Coder runs shell work inside an OS sandbox, snapshots your files before it changes them, and has a safety judge review what escapes the sandbox. You are asked only when the judge has no verdict or the decision is yours.

This guide shows how to check that setup, undo a change, and choose when to step up to `yolo`.

::: note Version scope
This guide describes v0.8.0. The sandbox needs bubblewrap on Linux; on macOS it uses an experimental `sandbox-exec` profile. Snapshots need a Git work tree. Native Windows has neither guarantee, so read what `doctor` reports on your host.
:::

::: needs
- Clio Coder installed, with a connected model.
- A Git repository you can experiment in, with a clean working tree.
:::

::: steps
### Check what this host can contain

```sh
clio-coder doctor
```

Look for the `shell sandbox` row. It names the backend and where contained commands may write. If no backend exists, commands outside the recognized set go to the judge and then to you, so the rest of this guide still holds with more questions.

### Give it a task and watch what happens

On a scratch branch, type this:

```text
Delete the build output directory, regenerate it, and run the project's test check. Report what you ran.
```

Workspace edits and contained commands run without a card. A delete inside the workspace runs after a snapshot, because the snapshot can undo it. A push or a command that leaves the sandbox goes to the judge first.

### Undo it with /rewind

```text
/rewind
```

The list shows this session's snapshots, newest first, with how many files each differs by. `Enter` previews a restore before anything is written. Confirming takes one more snapshot, so the rewind itself can be rewound.

### Tell the judge about your machine

The judge reads your typed messages and the proposed call. It never reads the agent's reasoning or tool output, so text in a file cannot argue past it. Name what is yours in your user settings:

```yaml title=settings.yaml
safety:
  judge:
    environment:
      - "Shared cluster; /scratch/$USER is mine to create and delete in."
    allow:
      - "restarting the dev containers this project's compose file defines"
```
:::

::: result What you should see
Contained work runs without a card, and `/rewind` lists a snapshot from before the first change of the turn. This shows the controls work on your host. It does not show that the agent's change is correct, so review the diff and the check results.
:::

## What still reaches you

Some decisions never go to the judge: `ask_user` questions, Clio Coder's own settings, a plan-scale dispatch, and a model edit of project settings. A permission card nobody answers within `safety.unattendedAfterSeconds` (300 by default) is denied, never approved, and the turn continues. A question nobody answers takes its recommended option, and `/decisions` shows what was chosen for you.

## When to use yolo

`yolo` is for long jobs you leave running: nothing waits for you. It is contained by default. The sandbox, snapshots, and safety judge work as at `default`, and a call that would have asked you is refused back to Clio Coder, so the job keeps going without it.

```sh
clio-coder --autonomy yolo
```

The first interactive activation shows a one-time acceptance card, and yolo is refused as root outside a detected container. A short floor still blocks deleting your home directory or a system tree, `mkfs`, writes to a block device, fork bombs, and reads of Clio Coder's credential store. Your project's approved rules and the run's ceilings also hold. Snapshots stay on.

Unconfined yolo is the skip-permissions mode for a container or another disposable environment: nothing asks, and commands run unsandboxed with your credentials. It takes effect only with `safety.yoloConfinement: unconfined` in your user settings and its own one-time acceptance. The footer shows which one is active.

::: compare
| | `default` | `yolo`, contained | `yolo`, unconfined |
| --- | --- | --- | --- |
| Shell commands | In the OS sandbox when a backend exists | As at `default` | Unsandboxed as you |
| Would-be approvals | Judge first, then you | Judge first, then refused back to Clio Coder | None |
| Your questions | Wait, then resolve after the timeout | Answered at once | Answered at once |
| Workers | Own sandbox, asks go to the judge | Dispatched as at `default` | Own sandbox, run the yolo way in their scope |
| `/rewind` | Available | Available | Available |
:::

::: limits What this does not protect
- The sandbox contains `bash` and `run_script`. Typed `write` and `edit` calls follow the rules instead.
- Ignored files, untracked files over 16 MiB, and nested repositories are not in a snapshot.
- `/rewind` restores files. It never moves refs: it prints the commands that bring a moved branch back.
- The judge is a model. It can be wrong, and a route error means no verdict, so the call parks or is denied.
- Stronger isolation needs an external sandbox such as a container.
:::

::: next
- [Tools and permissions](/docs/guide/tool-usage.html)
- [Keep a long coding task on track](/tutorials/keep-long-coding-tasks-on-track.html)
- [Check a change against your repository](/tutorials/check-a-change-against-your-repository.html)
:::
