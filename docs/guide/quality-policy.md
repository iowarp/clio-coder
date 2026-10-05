# Project quality policies

A project quality policy tells Clio Coder which declared checks a change requires.
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
[the project verifier catalog](tool-usage.md), or use
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
Clio Coder fingerprints Git-enumerated files matching either `paths` or `inputs`, so
an explicit `inputs` list cannot exclude covered, enumerated source. A covered
mutation absent from that inventory is unavailable, never certified as fresh.
Include tests, compiler configuration,
lockfiles, fixtures, and helper scripts on which a check depends. The policy
file and the check's declaration source are fingerprinted separately.

`checks` names the complete declared invocations. Run them through
`verify(check="<id>")` without `args` or `cwd` overrides. A narrowed test run,
a shell command, an unrelated check, or a passing check in another package
cannot satisfy the policy. Ordinary verification still permits its existing
arguments; those invocations do not receive qualifying quality snapshots.

The parser rejects unknown fields, duplicate YAML keys, aliases, duplicate
rule IDs, and duplicate strings in a list. Version 1 permits at most 32 rules,
with 1–32 entries per pattern or check list. Rule IDs are lowercase, start with
a letter, and use `a-z`, `0-9`, `.`, `_` and `-` up to 64 characters. Check IDs
use letters, digits, `:`, `.`, `_` and `-` up to 64 characters, and `frontend` is
not allowed. Patterns are bounded to 512 characters and the policy to 64 KiB.

## Discover, verify and finish

Call `verify()` to see the existing checks and the quality requirements.
The structured listing includes `details.qualityPolicy` with the rules and
the SHA-256 digest of the policy bytes.

For a policy check, Clio Coder captures source and declaration fingerprints before
and after execution. The result includes `details.quality` with `stable`, a
versioned `snapshot`, and an `error` when snapshotting was unavailable. A
command that modifies its own scoped inputs does not get a stable snapshot;
run the check again after those changes settle.

At completion, Clio compares the latest paired verification receipt for each
required check in the current turn with a fresh snapshot. A later failed run
supersedes an earlier pass. Source edits, additions, deletions, policy edits,
and changes to the check declaration invalidate an old result, including
changes made outside Clio Coder's tools.

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

A valid quality policy selects high rigor by default, as
[Rigor and the validation contract](#rigor-and-the-validation-contract)
describes. At `CLIO_CODER_RIGOR=normal` the completion assessment is an
advisory; high rigor requests continuation for outstanding checks when
the current turn permits recovery. No reminder grants additional tool or
execution authority. Stop or steer a blocked run when the authorized checks
cannot be completed.

Native and ACP dispatched workers are assessed against their actual workspace
before completion. Outstanding requirements fail an otherwise successful
high-rigor dispatch; explicit normal rigor keeps them advisory. Completion
assessment does not issue commands or expand worker authority.

`allowLimitations` defaults to `false`. When set to `true`, a successful
`limitation` receipt whose `paths` includes the exact check ID can settle the
requirement as `limited`, never as `passed`. A generic limitation or source
filename does not waive a named check. Operator task acceptance requirements
continue to apply alongside the project policy.

## Rigor and the validation contract

Rigor decides what evidence a completed turn needs. At `normal` the finish-contract advisory stays a soft reminder. At `high` an unvalidated completion claim, or an outstanding quality requirement, carries the turn onward once to run validation or record a limitation before it settles. Rigor resolves in this order ([rigor.ts](../../src/domains/safety/rigor.ts)):

1. `CLIO_CODER_RIGOR` (`high` or `normal`, case-insensitive) overrides everything.
2. A valid `.clio-coder/quality.yaml` selects `high`.
3. A valid version-1 validation contract selects `high`.
4. Otherwise `normal`. An invalid quality policy or contract is diagnosed and raises nothing, and a root-level `VALIDATION.md` is advisory prose that never raises rigor.

The validation contract ([validation-contract.ts](../../src/domains/safety/validation-contract.ts)) is the first existing of `.clio-coder/validation.yaml`, `.clio-coder/validation.yml`, `validation.yaml` and `validation.yml` at the workspace root. The file must resolve inside the workspace and stay under 256 KiB. The parser is strict: unknown fields, duplicate keys and aliases are errors, and `version` must be `1`. It states requirements and executes nothing.

| Field | Content |
| --- | --- |
| `task` | A short statement of the work being validated. |
| `runtime` | `kind` (required: `local`, `slurm`, `mpi` or `other`), and optional `nodes`, `ranks` (positive integers), `walltime` and `modules`. |
| `artifacts` | Up to 256 entries with a required `path` and optional `format`, `expected_dimensions` (name to non-negative integer), `expected_attributes` (name to string), `numerical_tolerances` (`relative`, `absolute`, `ulp`) and `preserve`. |
| `validators` | Up to 128 lines of command prose. They become runnable only through matching entries in `.clio-coder/verifiers.yaml`. |
| `notes` | Free text up to 16 KiB. |

Text values are bounded at 4 KiB, maps at 256 entries with keys of at most 256 bytes, and `modules` at 64 entries. Verifier authoring, [doctor](doctor.md) (the `validation contract` row and the `--deep` dry run) and the startup hint read the contract through the same loader, so a file either parses under one schema or is reported under one vocabulary.

## Bounds and practical limits

Snapshots currently require Git and a workspace that is the repository root.
They include Git-tracked and nonignored untracked files; ignored untracked
files are not fingerprinted. A covered mutation to such a file makes its
requirement unavailable even when a recorded snapshot otherwise matches.
Clio Coder does not scan ignored dependency or build trees to establish coverage.
External datasets, installed dependencies,
environment variables, tool binaries, and services are not captured. A
lockfile fingerprint records dependency intent, not the installed environment.
Declare relevant source inputs explicitly and use separate checks for other
evidence you need.

Each completion assessment shares Git enumeration, declaration discovery,
file fingerprints, and rule input digests across checks. Before execution,
after execution, and later completion assessments each use a fresh context.
The fingerprint budget is 10,000 distinct files and 64 MiB total across the
assessment, including declaration fingerprints, with 4 MiB per regular file.
The remaining byte budget is checked before each file read. Scope validation
is also bounded to 50,000 path components and one million glob comparisons;
exceeding a bound makes affected evidence unavailable.
Git enumeration has a five-second timeout and a 4 MiB output cap. Git
filesystem-monitor hooks are disabled for enumeration. Scoped symlinks are
refused before filtering, including dangling directory roots and ancestors of
both `paths` and `inputs` globs. Wildcard ancestors in the Git inventory are
checked too; complex brace or parenthesized scopes conservatively validate
candidates under their literal root. Links are never followed.
Snapshotting reads file contents locally and persists hashes rather than
those contents. It uses the repository's ignored-file semantics; a broad
pattern over tracked files includes everything that matches it.

Ordinary checks still run if snapshotting is unavailable, but cannot count as
fresh quality evidence. A malformed policy file makes every `verify` call return
`verify: .clio-coder/quality.yaml: <reason>` and leaves the completion
assessment unverified, with the same reason in its message. Repositories without a policy retain
their existing verification and completion behavior.

The completion gate activates from observed mutation receipts in a bounded
recent turn window. Freshness covers the selected source inputs, check
declarations, and policy. Repository checks and domain-specific acceptance
criteria define how dependencies, environment, and numerical results are validated.

Implementation: [quality-policy.ts](../../src/tools/verify/quality-policy.ts),
[verify](../../src/tools/verify/index.ts), and
[finish-contract.ts](../../src/domains/safety/finish-contract.ts).
