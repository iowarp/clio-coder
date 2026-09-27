A useful coding result includes more than “done.” You need to know what changed, which checks ran, and whether those results still apply to the files you are reviewing. Clio Coder v0.5.7 can use your repository's declared checks and a project quality policy to make those questions explicit.

This is recorded verification, not proof of correctness. Your tests still need to cover the behavior that matters.

## Start with checks the project already owns

Ask Clio to discover the available verification checks. The verifier derives checks from supported build systems, project scripts, and CI definitions. When it cannot resolve a requested check, it should not substitute an arbitrary command and call it a pass.

> Discover this project's verification checks. Run the relevant test check through verify. Report its exit status, failures, and anything you could not check.

Read the resolved command and working directory before approving execution. `verify` is subject to command admission. Naming a check does not grant permission to run it, and a denied command is not a validation result.

The [tools guide](/docs/guide/tool-usage.html) covers discovery and execution. The [temperature-calibration example](/tutorials/temperature-calibration.html) shows a small numerical correction with recorded test results.

## Declare what particular changes require

A quality policy selects required checks by changed path. At the Git workspace root, `.clio-coder/quality.yaml` can contain:

```yaml
version: 1
rules:
  - id: source
    paths: ["src/**", "tests/**"]
    inputs: ["src/**", "tests/**", "package.json", "package-lock.json"]
    checks: [test]
    allowLimitations: false
```

This example assumes the root package declares a `test` script and uses that lockfile. Adapt it to your project. Include fixtures, configuration, helper files, and other inputs that affect the result. The policy names existing checks; it cannot insert an arbitrary shell command or bypass approvals.

Clio does not write this policy automatically. Review it as a repository contract. A command that passes a narrow subset of tests should not satisfy a policy requiring the full declared test check.

## Inspect freshness after editing

Clio compares source, check-declaration, and policy fingerprints. A passing check can become stale after relevant inputs change. A later failure supersedes an earlier pass of the same check.

This matters during an iterative fix. The agent might run a test, make another edit, and then summarize the earlier success. The current assessment should describe the work that exists now, not the best result observed at some earlier point.

Required checks are run through `verify` without argument or working-directory overrides. Declare subproject checks with the correct working directory in the supported catalog or a root script. The [quality-policy guide](/docs/guide/quality-policy.html) explains check identity and freshness in more detail.

## Read the result in the interface you use

On the desktop alpha, inspect Artifacts → Results beside the conversation. Files shows paths and changes recorded by tools. In the terminal, `/view` provides access to artifacts and receipts.

Look for the actual check, its result, and missing evidence. A receipt is an inspectable record of the run; it is not a certificate that every scientific or operational requirement was met. New receipts have a simpler schema than earlier versions, and old receipts remain readable and verifiable.

## Understand the boundaries

Snapshots need Git and a workspace at the repository root. They cover tracked and nonignored untracked source within the documented bounds. They do not establish the state of external datasets, installed dependencies, running services, or every hidden environmental input.

A valid quality policy selects high rigor by default, requesting continuation for outstanding checks when recovery is possible. Normal rigor makes the assessment advisory. Neither setting grants extra execution authority. Domain-specific numerical comparisons, integration tests, and human review may still be necessary.

[Install Clio](/#start), open a repository with checks you recognize, and ask it to inspect before editing. Define what an acceptable result needs before expanding the task to a worker fleet.
