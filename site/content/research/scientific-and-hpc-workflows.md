What evidence would convince a domain scientist that a change made by an agent is correct? Scientific code has checks most software lacks, such as conservation laws, reference solutions, and published results.

It also has its own hazards, including schedulers, shared allocations, and results that look plausible while being wrong. Clio Coder has shipped tools for this work. Nobody has yet studied how far they go.

::: note Open question, described for v0.6.8
The skills and integrations on this page have shipped. This page has no study results because none exist yet, and every experiment here is proposed and not yet run. The team, students, and outside researchers are welcome, especially people who own real scientific codes.
:::

## The question

- **Trust.** What must an agent produce so that a domain expert accepts a numerical change, and does an external reference or a pre-registered check actually catch wrong results?
- **Modernization.** Can an agent port or rewrite established scientific software in stages, with each stage independently validated, at acceptable cost?
- **Cluster work.** Can an agent use a scheduler responsibly, and what does it waste when it does not?

## What is known so far

These are facts about what ships at this version. They are not study results.

The library has research skills. `experiment-protocol` pre-registers a performance study, numerical comparison, sweep, or benchmark, locking thresholds, tolerances, environment pins, and verdict conditions before any measurement. `scientific-modernization` ports or rewrites scientific software in independently validated stages against an external scientific oracle.

`scientific-debugging`, `slurm-jobs`, and `arxiv-literature` are also there, and the `materio` plugin supports materials-science research.

For clusters, Clio Coder installs without root on a login node, and it reaches Slurm through the clio-kit MCP server, with each submission and cancellation confirmed before it reaches the scheduler. Clio Coder does not submit its own workers through a scheduler.

The one worked example is [a temperature-calibration change](/tutorials/temperature-calibration.html), recorded from a real session with seven tests. It is a demonstration on a small task. No study covers real solvers, a domain expert's judgment, or how often an oracle catches an agent's error.

## Why it matters

A wrong numerical result can look fine and travel into a paper. If agents are going to touch scientific code, the field needs methods that make their errors visible, and evidence about which methods work. Some research groups also hold old codes that few people can maintain, so careful, validated modernization could be valuable if it can be trusted.

## Directions to work on

**Test the oracle.** Inject known errors into a scientific kernel and find out how often a pre-registered check catches them, and how often an agent talks its way around one.

**Run a real modernization.** Take a small code with reference output through `scientific-modernization`, and report stages, costs, failures, and what the maintainer thought of the result.

**Measure scheduler behavior.** Using a small allocation, record what an agent submits, how often it resubmits, and how much of the allocation produces useful output.

**Study expert acceptance.** Show domain scientists an agent's change with and without its evidence, and ask what they would accept and why.

## Use Clio Coder on it today

::: steps
### Install a research skill

```sh
clio-coder library install skill:experiment-protocol --project --dry-run
clio-coder library install skill:experiment-protocol --project
```

Then call it in a session:

```text
/skill experiment-protocol Compare my solver against the reference output. Define the tolerances before running anything.
```

### Add Slurm when you need it

Install clio-kit on a host where `sbatch` reaches your cluster, declare its server in `mcp.yaml`, and install the skill. The [Slurm guide](/docs/guide/slurm.html) gives the exact file.

```sh
clio-coder library install skill:slurm-jobs --project
```

The [pre-registration tutorial](/tutorials/pre-register-a-benchmark.html) and the [Slurm tutorial](/tutorials/submit-a-slurm-job.html) walk through both.

### Keep the record

Headless runs and dispatched workers are sealed, so a study can cite and share them. [Can an agent run be a scientific record?](/research/sealed-run-records.html) covers what that does and does not show.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. A kernel with published reference output is a good place to begin.
:::

**Can a pre-registered check catch an agent's numerical error?**

::: steps
### Choose a kernel

Pick a small numerical routine with reference output you trust, from your field if possible. Put it in a repository with its reference data.

### Pre-register

Use `experiment-protocol` to lock the tolerances and verdict conditions, and commit them before any change is made.

### Ask for a port

Ask the agent to port or refactor the kernel, and run the check. Record the verdict, the cost, and whether the agent edited anything it should not have.

### Inject an error

Separately, introduce a subtle error, such as a changed constant or a lost precision step, then ask the agent to review the code and run the check. Record whether it was caught, and by what.

### Report it

Open a GitHub issue with the kernel, the tolerances, the verdicts, and what a person in the field made of the result.
:::

Needs: a laptop and any chat route for everything above. A local model server avoids sending code to a provider. A cluster account is needed only for scheduler work.

## How to join

Open a GitHub issue on [the repository](https://github.com/iowarp/clio-coder/issues) saying what you want to try, before or after you run it, and read the [contributor guide](https://github.com/iowarp/clio-coder/blob/main/CONTRIBUTING.md) for code changes. Negative results and replications are welcome.

::: limits Boundaries
- A passing check shows only what that check tests. Choose it with someone who knows the science.
- Your site's access rules, allocation limits, and data policies apply to anything an agent does there.
- Do not publish data or code you may not share.
:::

::: next
- [A numerical change, checked with Clio Coder](/tutorials/temperature-calibration.html)
- [Install on a cluster](/docs/guide/hpc-clusters.html)
- [Slurm workflows](/docs/guide/slurm.html)
:::
