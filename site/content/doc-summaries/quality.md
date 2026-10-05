## Tell Clio Coder what “checked” means in your project

A quality policy names the declared checks required when particular files change. Your repository supplies the standards; Clio records verification and assesses whether the results still match the current inputs.

At a Git workspace root, create `.clio-coder/quality.yaml`:

```yaml
version: 1
rules:
  - id: source
    paths: ["src/**", "tests/**"]
    inputs: ["src/**", "tests/**", "package.json", "package-lock.json"]
    checks: [test]
    allowLimitations: false
```

This example assumes the root `package.json` declares a `test` script. Adapt the paths, lockfile, and check IDs to your project. Include configuration, fixtures, and helper files that affect the result. Clio does not create or modify this policy automatically.

## Run the declared checks

Ask Clio Coder to discover verification checks, then run each required ID through `verify` without argument or working-directory overrides. For a subproject, declare a root script or a verifier-catalog entry with its working directory.

The policy names existing checks; it cannot introduce shell commands or bypass approval. A narrowed test run or an unrelated passing command cannot satisfy a required full check.

## Review freshness

Clio Coder compares source, check-declaration, and policy fingerprints. Edits after a passing run can make the result **stale**; a later failing run supersedes an earlier pass. Missing or unavailable evidence remains unverified.

A valid policy selects high rigor by default, which requests continuation for outstanding checks when recovery is possible. Setting `CLIO_CODER_RIGOR=normal` makes the assessment advisory. Neither mode grants additional execution authority.

Snapshots need Git and a workspace at the repository root. They cover tracked and nonignored untracked source, not external datasets, installed dependencies, or running services. Use domain-specific checks for those requirements. The full guide explains bounded snapshots and permitted limitations.

Try [the calibration example](/tutorials/temperature-calibration.html) to see a declared check and its actual result.
