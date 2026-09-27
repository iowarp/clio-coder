Your conversation and a worker process do not have to run on the same machine. Clio Coder can coordinate native workers over SSH, letting a local session direct work in a configured remote environment.

The v0.5.7 fleet has specific prerequisites: SSH access, a matching Clio runtime, a writable state directory, an available model route, and the project at the same absolute path on each node. A cluster login or a VPS account alone does not satisfy that setup.

## Choose the right execution location

First distinguish inference from execution. A local worker calling a remote model endpoint still runs its tools locally. A remote native worker runs its tools on the selected SSH node. A target URL using localhost resolves on that worker's machine.

This matters when a project needs a particular compiler, filesystem, or dataset. It also matters for information policy: a remote worker configured with a cloud target may send model input onward to that provider.

Use machines and routes permitted for your project. This workflow does not grant access to institutional systems or override their scheduler and data rules.

## Declare one node first

Fleet nodes are configured under `fleet.nodes` in user settings. The local node already exists and is not declared there.

```yaml
fleet:
  nodes:
    - id: build-node
      host: build-node.example.net
      maxWorkers: 1
```

This is a configuration template, not a live host or a recorded deployment. Replace the host and use your own SSH configuration. Ensure the project is available at the same absolute path before admitting work. The [fleet guide](/docs/guide/fleet-dispatch.html) describes additional fields and profile pins.

A remote VPS with a different checkout path is not automatically compatible. The current transport does not promise to synchronize an arbitrary repository or stage datasets for you. Establish a supported filesystem layout deliberately.

## Run preflight before dispatch

```sh
clio-coder doctor
```

Plain doctor is diagnostic. It reports node probes without refreshing dispatch eligibility. After reviewing the setup and understanding the changes, the documented `clio-coder doctor --fix` records passing preflight results.

An unavailable or incompatible remote node can remain a warning while local work stays usable. A changed host, project root, or local runtime upgrade invalidates the relevant preflight record. Refresh the setup instead of expecting a pinned task to fall back silently to another machine.

Worker specification v5 requires compatible fleet nodes. Upgrade clients and workers together when release notes require it; session format changes also affect which clients can reopen conversations.

## Keep the first task bounded

Ask one worker to inspect a familiar part of the project or run a known check. Select its node through the supported profile or dispatch configuration and review the assignment before execution.

Remote workers retain default worker authority, even when the coordinating session uses yolo. Capacity limits bound concurrent work; they do not create a scheduler allocation or permission to use another person's resources.

On a university or laboratory cluster, use an approved execution environment. Do not launch a fleet on a login node merely because SSH works. The [Slurm guide](/docs/guide/slurm.html) describes the project's separate allocation-aware tooling; SSH fleet support is not universal batch-scheduler integration.

## Follow work from the local session

The terminal remains the primary interface for the full workflow. The desktop alpha can show conversations, fleet activity, and recorded results, but it has a subset of terminal workflows. A local browser interface is not a public hosted control service.

Check queued, active, failed, and completed work, then review results and the actual project changes. Some external peers cannot receive live steering; native SSH workers and peer bridges are different execution paths.

[Install Clio](/#start) and complete a local [first session](/tutorials/first-session.html) before adding a node. The useful next step is one remote task you can inspect, followed by a deployment that respects your environment's access and capacity rules.
