A playbook is a sequence of workers and code steps that the fleet runs for you. The builtin `sdlc` playbook plans, builds, tests with a bounded fix loop, reviews with a bounded revise loop, and documents, with three commits along the way. This guide runs it on one task and lands the result on your branch.

::: note Version scope
This guide describes v0.6.7. `fleet land` needs Git 2.38 or newer. Run time and cost depend on your repository and the model you connect, so start with a small task.
:::

::: needs
- Clio Coder installed, with a connected model that supports tool calling.
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

The first line names the fleet root and plan hash. Each settled step prints one line. In another terminal, `clio-coder fleet status` shows the board and `clio-coder fleet events <root>` follows the journal.

### Land what it kept

```sh
clio-coder fleet land
clio-coder fleet land <run id>
clio-coder fleet land <run id> --yes --plan <id>
```

The first command lists the task branches finished runs kept. The second previews one: commits, changes, destination, whether it fast-forwards, and any conflict. It changes nothing. The third lands exactly that preview. Add `--squash` for one commit instead of the history.
:::

::: result What you should see
A summary with each loop's terminal reason and any steps that need your decision, then commits on your branch after you land. A finished run shows the playbook ran and its checks passed. It does not show the change is right, so read the diff.
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
