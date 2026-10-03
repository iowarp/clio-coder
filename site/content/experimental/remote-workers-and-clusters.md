A worker does not have to run where your conversation does. Clio Coder can send a bounded task to another machine over the SSH access you already have, and it installs without root on a cluster login node. Both are for people who know their machines and their site's rules.

::: note Experimental in v0.6.0
Verified SSH nodes, the exact-build installer, Tailscale discovery, and returning edits from a separate checkout are new in v0.6.0. Commands and prerequisites may change. None of this replaces a scheduler or an institution's access policy.
:::

::: needs
- Noninteractive SSH access to the machine.
- The project at the same absolute path on both machines, on shared storage or as matching clean Git checkouts.
- The same Clio Coder version on both, and a model route the worker can reach from there.
:::

## Add a node and prove it is ready

```sh
clio-coder fleet nodes add build-node --host build-node --max-workers 1
clio-coder fleet nodes install build-node --yes
clio-coder fleet nodes test build-node --record
```

`install` copies the build you are running to the node's home directory, with no sudo and no shell profile edits. Run it without `--yes` first to preview it. It needs Node.js 22.19 or newer and npm on the node. The recorded test is what makes a node eligible for this project.

A record lasts one day and is tied to the host, user, port, key, and client version, so an upgrade or an endpoint change needs a new test. In the terminal, `/settings fleet` offers the same steps under **Add SSH node**. `clio-coder fleet nodes discover` lists Tailscale peers as candidates and adds nothing by itself.

## Decide where work runs

Adding a node moves nothing. Unpinned work stays local until you name a node for a task, pin one in a worker profile, answer the once-per-session placement question, or set a standing preference. A node that is full queues the work. A pinned task whose node is not ready fails with the reason and does not run somewhere else.

Workers on a separate checkout edit in an isolated task worktree on the node. Clio Coder commits there, fetches the branch over SSH, checks that it touches only the allowed paths, and then runs your usual verification and guarded apply. A failure leaves the node's branch in place for you to inspect.

## On a cluster

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

The installer needs no root, refuses to run under sudo, and brings a private Node.js 24. On x64 login nodes with glibc from 2.17 to 2.27 it selects a compatible Node.js build. Behind a proxy, export `https_proxy` first; the cluster guide lists the variables for mirrored and offline installs.

That private Node.js is not added to `PATH`. A node installed this way already has Clio Coder, so skip `fleet nodes install` there and keep its version equal to your client's.

Clio Coder does not submit jobs for its own workers. Scheduler work goes through the clio-kit Slurm tools, which the agent calls to submit, list, describe, and cancel jobs, each with your approval.

::: limits
- Worker slots limit concurrency. They are not an allocation, and a login node is not a compute node.
- A remote worker sandboxes its commands only when bubblewrap is present on that node.
- Clio Coder does not clone repositories, map paths, install project dependencies, or stage data on a node.
- A worker that uses a cloud model sends its input to that provider from the node.
:::

::: next
- [Work from a laptop with remote workers](/tutorials/work-from-a-laptop-with-remote-workers.html)
- [Install on a cluster](/docs/guide/hpc-clusters.html)
- [Slurm workflows](/docs/guide/slurm.html)
:::
