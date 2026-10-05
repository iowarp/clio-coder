A useful coding result includes more than "done." You need to know what changed, which checks ran, and whether those results still apply to the files you are reviewing. Clio Coder v0.6.0 can use your repository's declared checks and a project quality policy to make those questions explicit.

::: note What this establishes
Recorded verification is evidence about named checks and named inputs. It is not proof of correctness; your tests still need to cover the behavior that matters.
:::

::: needs
- A Git repository with a test or build check it already declares, such as a package script or a CI step.
- Clio Coder with a model that supports tool calling.
- Time to read the resolved command before you approve it.
:::

## Start with checks the project already owns

The verifier derives checks from supported build systems, project scripts, and CI definitions. When it cannot resolve a requested check, it should not substitute an arbitrary command and call it a pass.

::: prompt
Run this project's test check through verify. Report its exit status, failures, and anything you could not check.
:::

::: capture tui-verify-result
The same request in the temperature-calibration example, with the check's working directory named.
:::

Read the resolved command and working directory before approving execution. `verify` is subject to command admission: naming a check does not grant permission to run it, and a denied command is not a validation result.

When a command needs your approval, the terminal card names the tool, the exact command, and, for commands it recognizes, an **Effect** line in plain words.

::: capture tui-approval-effect
:::

The [tools guide](/docs/guide/tool-usage.html) covers discovery and execution. The [temperature-calibration example](/tutorials/temperature-calibration.html) follows a small numerical correction with recorded test results.

## Declare what particular changes require

A quality policy selects required checks by changed path. At the Git workspace root:

```yaml title=.clio-coder/quality.yaml
version: 1
rules:
  - id: source
    paths: ["src/**", "tests/**"]
    inputs: ["src/**", "tests/**", "package.json", "package-lock.json"]
    checks: [test]
    allowLimitations: false
```

::: steps
### Name the changes a rule covers

`paths` selects the rule: here, any change under `src/` or `tests/`.

### List every input the result depends on

`inputs` feeds freshness. Include fixtures, configuration, helper files, and lockfiles; this example assumes the root package declares a `test` script and uses that lockfile.

### Name existing checks, not commands

`checks` refers to declared checks. A policy cannot insert an arbitrary shell command or bypass approvals.

### Decide whether limitations are acceptable

`allowLimitations: false` means a reported limitation does not satisfy the rule.
:::

Clio Coder does not write this policy for you. Review it as a repository contract: a command that passes a narrow subset of tests should not satisfy a policy that requires the full declared test check.

## Inspect freshness after editing

::: diagram check-freshness
:::

Clio Coder compares source, check-declaration, and policy fingerprints. A passing check becomes stale after relevant inputs change, and a later failure supersedes an earlier pass of the same check.

This matters during an iterative fix. The agent might run a test, make another edit, and then summarize the earlier success. The current assessment should describe the work that exists now, not the best result observed along the way.

Required checks run through `verify` without argument or working-directory overrides. Declare subproject checks with the correct working directory in the supported catalog or a root script. The [quality-policy guide](/docs/guide/quality-policy.html) explains check identity and freshness.

## Read the result where you work

On the desktop alpha, the Session column's **Artifacts** card lists receipts, outputs, and session records, **Changes** lists the files a turn changed, and **Evidence** appears once a run has a receipt. In the terminal, `/view` opens artifacts and receipts.

::: capture tui-view-result
:::

::: result What to look for
The actual check, its result, and any missing evidence. A receipt is an inspectable record of the run; it is not a certificate that every scientific or operational requirement was met. Receipts sealed by 0.5 releases still verify; one sealed under an older integrity format is reported as retired and is not read as evidence.
:::

::: limits
- Snapshots need Git and a workspace at the repository root. They cover tracked and nonignored untracked source within the documented bounds.
- They do not establish the state of external datasets, installed dependencies, running services, or other hidden inputs.
- A valid policy selects high rigor by default and asks to continue for outstanding checks when recovery is possible; normal rigor makes the assessment advisory. Neither grants extra execution authority.
- Numerical comparisons, integration tests, and human review may still be necessary.
:::

::: next
- [A numerical change, checked with Clio Coder](/tutorials/temperature-calibration.html)
- [Quality policy guide](/docs/guide/quality-policy.html)
- [Install Clio Coder](/#start)
:::
