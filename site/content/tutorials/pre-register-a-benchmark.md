A benchmark is easy to fool once you have seen the result. The `experiment-protocol` skill has Clio Coder write down the outcome, thresholds, tolerances, and verdict conditions before any measurement, and then keep to them. Use it for a performance study, a numerical comparison, a parameter sweep, or a solver comparison.

::: note Version scope
This guide describes v0.6.8 and skill version 0.3.2. To find out why one output is wrong, use `scientific-debugging` instead, since that is a diagnosis and not an experiment.
:::

::: needs
- A repository with the code to measure and input data you can checksum.
- A chat route, in the terminal or a headless run.
- An environment you can pin: compiler, flags, package versions, and node class.
:::

## Install the skill

```sh
clio-coder library install skill:experiment-protocol --project --dry-run
clio-coder library install skill:experiment-protocol --project
```

Read the dry run first. It shows the destination and the pin.

## Ask for a pre-registration

::: prompt Example
/skill experiment-protocol Compare the new solver against the current one on data/mesh-256.h5 for step time and accuracy. Stop after you write the contract so I can review it.
:::

The contract goes in `.clio-coder/validation.yaml`, or `VALIDATION.md` at the repository root. Creating that file raises the session's rigor immediately: from the next turn, completion claims must carry validation evidence or state a limitation.

## Review the contract

This is the step that matters, and it is yours. Check that the contract has each of these:

- **Outcome**: one sentence, with a number.
- **Thresholds**: a minimum below which the result is refuted, a target, and a stretch.
- **Tolerances**: absolute or relative, stated per metric. A bare `1e-6` is not a tolerance.
- **Environment pin**: compiler and flags, versions, node class, and scheduler context.
- **Input identity**: paths with checksums.
- **Verdict conditions**: what makes the result confirmed, refuted, or inconclusive.

Commit it before measuring anything, so the history shows it came first. In a headless run nobody can answer questions, so the skill records unstated details as explicit assumptions. Read those assumptions closely.

## Run it

The skill captures a baseline under the pinned environment, then changes one independent variable per run, and records job ids and node lists where a scheduler is involved. It compares results against the registered thresholds only.

::: result What you should see
A verdict of confirmed, refuted, or inconclusive against the numbers you committed, with any deviation logged next to the result. Rejected approaches go in a dead-ends ledger. A refuted result plus a ledger entry is a successful experiment.
:::

::: limits
- Watch for a threshold or tolerance edited after results appeared. The skill treats that as a red flag, and `git log` on the contract shows it.
- A single run on a shared machine does not establish a claim. Size repetitions to the noise.
- Findings outside the registered outcome are exploratory and need their own pre-registration.
- The skill checks process. Whether the tolerance is scientifically right is a judgment for someone who knows the field.
:::

::: next
- [A numerical change, checked with Clio Coder](/tutorials/temperature-calibration.html)
- [Check a change against your repository](/tutorials/check-a-change-against-your-repository.html)
- [What would make a scientist trust an agent's change?](/research/scientific-and-hpc-workflows.html)
:::
