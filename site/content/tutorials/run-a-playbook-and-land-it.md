A playbook is a sequence of workers and code steps that the fleet runs for you. The builtin `sdlc` playbook plans, builds, tests with a bounded fix loop, reviews with a bounded revise loop, and documents, with three commits along the way. This guide runs it on one task and reads what it committed on your branch.

::: note Version scope
This guide describes v0.8.0. Run time and cost depend on your repository and the model you connect, so start with a small task.
:::

::: needs
- CLIO Coder installed, with a connected model that supports tool calling.
- A clean Git repository with a test command.
- A small, specific task you could review by hand.
:::

::: steps
### See what is available

```sh
clio-coder playbook list
```

`sdlc` shows as `setup` until the project declares the two commands it runs, `test` and `commit`.

### Declare the commands it runs

```sh
clio-coder playbook commands init
```

This drafts `.clio-coder/playbooks/commands.yaml` from your project's declarations, fully commented out, because uncommenting an entry confirms its exact command. Edit it to name what this project runs:

```yaml title=.clio-coder/playbooks/commands.yaml
version: 1
commands:
  test:
    argv: ["npm", "run", "test"]
  commit:
    argv: ["git", "commit", "-m", "{{commitMessage}}"]
```

### Check before you run

```sh
clio-coder playbook validate sdlc --var task="Add empty-input handling to the parser"
clio-coder playbook graph sdlc --var task="Add empty-input handling to the parser"
```

`validate` runs the execution preflight and `graph` prints the compiled waves, loops, scopes, and write boundaries, both without side effects. It resolves agents, targets, and profiles, and checks the session budget and write boundaries. A failed preflight during a real run exits 2 before anything dispatches.

### Run it

```sh
clio-coder fleet run sdlc --var task="Add empty-input handling to the parser"
```

The first line, on stderr, names the fleet root and plan hash. Each settled step prints one line. In another terminal, `clio-coder fleet status` shows the board and `clio-coder fleet events <root> --follow` follows the journal.

The steps work in your checkout, one after another, not in separate worktrees. The `suite` loop runs your `test` command inside the sandbox, rooted at the checkout, up to three times, and hands each of the first two failures back to the coder.

The command exits 0 only when every required step succeeded, no step was skipped, and every loop resolved. Any other finished run exits 1. A failed preflight, or an error in the scheduler itself, exits 2.

### Read what it committed

```sh
git log --oneline -3
git show --stat HEAD~2 HEAD~1 HEAD
```

The three `commit` steps commit the plan, the code, and the docs on the branch you have checked out, so there is nothing to merge or land afterwards. If you do not want the result, reset the branch to where it was before the run.

`clio-coder fleet land` is for something else: the task branch a worker dispatched with its own worktree keeps when its change was not merged.
:::

::: capture cli-playbook-graph
:::

::: result What you should see
A summary with each loop's terminal reason and any steps that need your decision, and three new commits on your branch. A finished run shows the playbook ran and its checks passed. It does not show the change is right, so read the diff.
:::

## Make it yours

```sh
clio-coder playbook new parser-fix --from sdlc
```

This copies the builtin to `.clio-coder/playbooks/parser-fix.md`, where you can change steps, agents, and limits. A resumed run replays a completed prefix of the same plan: `clio-coder fleet run <name> --resume <runId>`.

::: limits Boundaries
- Under `fleet run` nobody is attached, so a worker's ordinary ask is denied, not judged.
- One lock per Git checkout keeps two fleets out of the same workspace.
- `clio-coder telemetry verify --run <run-id>` checks the record of a run. The journals are hash-chained and unsigned, so they show consistency, not who wrote them.
:::

::: next
- [Workers and fleets](/docs/guide/fleet-dispatch.html)
- [See what a session cost and what a run did](/tutorials/see-what-a-session-cost-and-what-a-run-did.html)
:::
