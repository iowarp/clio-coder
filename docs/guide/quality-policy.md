# Project quality policies

A project quality policy tells Clio which declared checks a change requires.
It can use the project's existing linters, type checkers, tests, numerical
comparisons, or performance checks. Clio supplies the completion assessment
and verification provenance; the repository owns the standards and commands.

Create `.clio-coder/quality.yaml` at a Git workspace root:

```yaml
version: 1
rules:
  - id: core
    paths: ["src/**", "tests/**"]
    inputs: ["src/**", "tests/**", "tsconfig*.json", "pnpm-lock.yaml"]
    checks: [typecheck, lint, test]
    allowLimitations: false
  - id: frontend
    paths: ["apps/web/**"]
    inputs: ["apps/web/**", "pnpm-lock.yaml"]
    checks: [typecheck:web, test:web]
    allowLimitations: true
```

Declare these check IDs in the root `package.json`, in
[the project verifier catalog](tool-usage.md#project-verifier-catalog), or use
an exact ID that `verify()` derives from build and CI files. For subdirectory
checks, use a root package script that invokes the subproject or a catalog
entry with its declared `cwd`. The quality policy cannot introduce an
executable command or bypass execution approval.

Clio does not generate or modify this file automatically. If `.clio-coder/`
is ignored, explicitly include the policy in version control using your
repository's chosen ignore exceptions or a force-add of this one file.

## Rules and inputs

`paths` selects the mutations that activate a rule. Patterns are relative to
the workspace root, use forward slashes, and follow Node's `path.matchesGlob`
semantics. Absolute paths, backslashes and `.` or `..` path segments are
rejected. Every matching rule applies; a change to the policy itself activates
every rule in the current policy.

`inputs` adds files whose contents affect the result. It defaults to `paths`.
Clio always fingerprints both `paths` and `inputs`, so an explicit `inputs`
list cannot exclude the changed source. Include tests, compiler configuration,
lockfiles, fixtures, and helper scripts on which a check depends. The policy
file and the check's declaration source are fingerprinted separately.

`checks` names the complete declared invocations. Run them through
`verify(check="<id>")` without `args` or `cwd` overrides. A narrowed test run,
a shell command, an unrelated check, or a passing check in another package
cannot satisfy the policy. Ordinary verification still permits its existing
arguments; those invocations do not receive qualifying quality snapshots.

The parser rejects unknown fields, duplicate YAML keys, aliases, duplicate
rule IDs, and duplicate strings in a list. Version 1 permits at most 32 rules,
with 1–32 entries per pattern or check list. IDs are bounded to 64 characters,
patterns to 512 characters, and the policy to 64 KiB.

## Discover, verify and finish

Call `verify()` to see the existing checks and the quality requirements.
The structured listing includes `details.qualityPolicy` with the rules and
the SHA-256 digest of the policy bytes.

For a policy check, Clio captures source and declaration fingerprints before
and after execution. The result includes `details.quality` with `stable`, a
versioned `snapshot`, and an `error` when snapshotting was unavailable. A
command that modifies its own scoped inputs does not get a stable snapshot;
run the check again after those changes settle.

At completion, Clio compares the latest paired verification receipt for each
required check in the current turn with a fresh snapshot. A later failed run
supersedes an earlier pass. Source edits, additions, deletions, policy edits,
and changes to the check declaration invalidate an old result, including
changes made outside Clio's tools.

The assessment and completion audit record contain one structured finding
per applicable rule/check:

| State | Meaning |
| --- | --- |
| `passed` | The latest execution succeeded and its stable snapshot matches current inputs and policy. |
| `missing` | No paired native `verify` receipt for this check exists in the current turn window. |
| `failed` | The latest execution failed or did not complete successfully. |
| `stale` | The invocation was narrowed, inputs changed, or the snapshot was unstable or absent. |
| `unavailable` | Clio could not capture or compare the bounded inputs. |
| `limited` | The rule explicitly permits a check-scoped limitation; the check remains unverified. |

A valid quality policy selects high rigor by default. An explicit rigor
override still wins: `CLIO_CODER_RIGOR=normal` makes the completion assessment
an advisory; high rigor requests continuation for outstanding checks when
the current turn permits recovery. No reminder grants additional tool or
execution authority. Stop or steer a blocked run when the authorized checks
cannot be completed.

`allowLimitations` defaults to `false`. When set to `true`, a successful
`limitation` receipt whose `paths` includes the exact check ID can settle the
requirement as `limited`, never as `passed`. A generic limitation or source
filename does not waive a named check. Operator task acceptance requirements
continue to apply alongside the project policy.

## Bounds and practical limits

Snapshots currently require Git and a workspace that is the repository root.
They include Git-tracked and nonignored untracked files; ignored untracked
files are not fingerprinted. External datasets, installed dependencies,
environment variables, tool binaries, and services are not captured. A
lockfile fingerprint records dependency intent, not the installed environment.
Declare relevant source inputs explicitly and use separate checks for other
evidence you need.

Each check snapshot is bounded to 10,000 distinct inputs, 64 MiB total, and 4 MiB per
regular file. Git enumeration has a five-second timeout and a 4 MiB output
cap. Git filesystem-monitor hooks are disabled for enumeration. Scoped symlinks are refused, including links at parent components.
Snapshotting reads file contents locally and persists hashes rather than
those contents. It uses the repository's ignored-file semantics; a broad
pattern over tracked files includes everything that matches it.

Ordinary checks still run if snapshotting is unavailable, but cannot count as
fresh quality evidence. Malformed policy files produce explicit errors and
an unverified completion assessment. Repositories without a policy retain
their existing verification and completion behavior.

This is completion evidence, not an operating-system snapshot or a guarantee
against concurrent modifications during execution. The gate activates from
the finish contract's observed mutation receipts and uses its bounded recent
turn window. It does not establish scientific validity, infer undeclared
dependencies, or certify the semantics of a linter's rules.

Implementation: [quality-policy.ts](../../src/tools/verify/quality-policy.ts),
[verify](../../src/tools/verify/index.ts), and
[finish-contract.ts](../../src/domains/safety/finish-contract.ts).
