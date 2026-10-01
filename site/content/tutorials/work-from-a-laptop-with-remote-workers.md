Your conversation and a worker process do not have to run on the same machine. Clio Coder can coordinate native workers over SSH, so a local session directs work in a configured remote environment.

::: note Version scope
This guide describes the v0.6.0 fleet. The configuration below is a template, not a recorded deployment, and this workflow does not grant access to institutional systems or override their scheduler and data rules.
:::

::: needs
- SSH access to the node, under your own configuration.
- A matching Clio runtime on the node and a writable state directory.
- The project at the same absolute path on each node.
- A model route the worker can reach from the node.
:::

A cluster login or a VPS account alone does not satisfy that setup.

## Choose where each part runs

::: diagram remote-placement
:::

Inference and execution are separate. A local worker calling a remote model endpoint still runs its tools locally; a remote native worker runs its tools on the selected node. A target URL that uses localhost resolves on the worker's machine.

This matters when a project needs a particular compiler, filesystem, or dataset. It also matters for information policy: a remote worker configured with a cloud target may send model input on to that provider.

## Declare one node

Fleet nodes live under `fleet.nodes` in user settings. The local node already exists and is not declared there. **Settings**, **Fleet** chooses the default worker node for work that does not name one.

::: capture tui-settings-fleet
:::

```yaml title=settings.yaml
fleet:
  nodes:
    - id: build-node
      host: build-node.example.net
      maxWorkers: 1
```

Replace the host and use your own SSH configuration, then make sure the project is at the same absolute path before admitting work. The [fleet guide](/docs/guide/fleet-dispatch.html) describes the other fields and profile pins.

A remote server with a different checkout path is not automatically compatible. The transport does not synchronize an arbitrary repository or stage datasets for you; establish a supported filesystem layout deliberately.

## Check the node before dispatch

::: steps
### Run the diagnostic

```sh
clio-coder doctor
```

Plain doctor reports node probes without refreshing dispatch eligibility.

::: capture cli-doctor
:::

### Record passing preflight

```sh
clio-coder doctor --fix
```

Run it from the project root after you review the setup. It records each node's preflight result for that path, and only a passing record makes a node eligible for dispatch. It also creates missing Clio directories, makes `settings.yaml` and `credentials.yaml` owner-only, and rewrites retired enum values and YAML `on` and `off` booleans in `settings.yaml`, so run plain `doctor` first to preview them.

### Upgrade together

Every SSH node must run exactly the same Clio Coder version as your client. Preflight compares the versions, and upgrading the client invalidates each node's record until you run `clio-coder doctor --fix` again. In 0.6.0 the worker specification moved to version 7, so a 0.5 node rejects work from a 0.6 client.
:::

::: result What doctor tells you
An unavailable or incompatible node can stay a warning while local work remains usable. A changed host, project root, or local runtime upgrade invalidates the node's preflight record, and a pinned task does not fall back silently to another machine.
:::

## Keep the first task bounded

Ask one worker to inspect a familiar part of the project or run a known check. Select its node through the supported profile or dispatch configuration and review the assignment before it runs.

Remote workers keep default worker authority, even when the coordinating session uses yolo. Capacity limits bound concurrent work; they do not create a scheduler allocation or permission to use another person's resources.

On a university or laboratory cluster, use an approved execution environment. Do not launch a fleet on a login node merely because SSH works. The [Slurm guide](/docs/guide/slurm.html) describes separate allocation-aware tooling; SSH fleet support is not universal batch-scheduler integration.

## Follow the work from your laptop

The terminal is the primary interface for the full workflow. The desktop alpha shows conversations, fleet activity, and recorded results for a subset of terminal workflows; it is a local browser interface, not a hosted control service.

Open **Workers** with Alt+W to see queued, active, failed, and completed work, then review results and the actual project changes. Some external peers cannot receive live steering; native SSH workers and peer bridges are different execution paths.

::: limits
- SSH, a matching runtime, and the same absolute project path are prerequisites, not details.
- Clio does not stage repositories or datasets onto a node.
- Institutional access rules and schedulers still govern where work may run.
:::

::: next
- [Your first session with Clio](/tutorials/first-session.html)
- [Fleet guide](/docs/guide/fleet-dispatch.html)
- [Install Clio](/#start)
:::
