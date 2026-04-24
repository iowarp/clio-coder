# Governance

Clio Coder is led by Anthony Kougkas (`@akougkas`) for IOWarp, iowarp.ai,
and Gnosis Research Center.

## Maintainer Authority

- `@akougkas` is the PI, maintainer, release owner, and required reviewer for
  changes targeting `main`.
- Maintainer approval is required for releases, npm publish, branch rules,
  security policy changes, and license changes.

## Main Branch Policy

Expected GitHub rules for `main`:

- Require a pull request before merging.
- Require at least one approving review.
- Require review from Code Owners.
- Set `@akougkas` as owner for all paths through `.github/CODEOWNERS`.
- Dismiss stale approvals when new commits are pushed.
- Require the `ci` workflow to pass.
- Require conversation resolution before merge.
- Block force pushes and branch deletion.
- Do not allow bypasses except by explicit maintainer action.

## Review Rubric

Every PR is evaluated on:

- Correctness: the change solves the stated problem.
- Scope: unrelated edits are absent or clearly justified.
- Safety: no secret leakage, destructive default, or unsafe shell path.
- Architecture: boundaries and domain contracts remain intact.
- Tests: risk is covered by unit, integration, e2e, or explicit manual proof.
- Documentation: README, changelog, status, and contributor files stay current.

## Release Rubric

A release candidate requires:

- `npm run ci` green on GitHub Actions.
- Changelog section promoted from `Unreleased` to a dated version.
- `STATUS.md` updated with the release state.
- Maintainer approval.
- Git tag created by maintainer.
- npm publish only after tag verification.
