# v0.4.1 Release-Cut Checklist

> **Visual blueprint:** The source checkout includes the complete
> [v0.4.1 Release-Cut Checklist visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/release_cut_checklist_blueprint.html).

> [!IMPORTANT]
> Historical release record. v0.4.1 has been published, and this checklist is
> retained to explain how that release was cut. It is not the procedure for
> v0.4.2 or any later release; paths, gates, versions, dates, and authorization
> state must be re-established from current source before a future cut.

This is the ordered procedure for turning the prepared `v0.4.1` branch into a
published release. Everything above the **AUTHORIZATION BOUNDARY** is local,
repeatable, and reversible. Everything below it changes a remote ref, creates a
release, or publishes an immutable package and therefore requires the
operator's explicit approval of the exact candidate SHA and commands.

## Part 1: verify the exact candidate

1. Resolve and record the exact candidate SHA. Confirm `package.json` and both
   version fields in `package-lock.json` are `0.4.1`, and confirm the first
   version heading in `CHANGELOG.md` is exactly
   `## 0.4.1 - 2026-09-01`. Work from the branch ref explicitly when a branch
   and tag share the name: `refs/heads/v0.4.1` is the branch and
   `refs/tags/v0.4.1` is the tag.
2. Confirm the tracked worktree is clean. Do not fold unrelated local or
   ignored release evidence into the candidate.
3. Install exactly from the lockfile:

   ```sh
   npm ci --prefer-offline --no-audit --no-fund
   ```

4. Run the one local release gate:

   ```sh
   npm run ci:release
   ```

   `ci:release` runs `ci` and then `scripts/check-release.mjs`. The `ci` script
   performs typecheck; Biome and repository hygiene; the shipped-skill pin
   check; the build; the 35-file `node --test` suite; and the trace-viewer
   tests. The release audit then checks the built launcher and dist contents,
   version/changelog coherence, required package resources, dependency audit,
   and tarball size and contents. Run individual subcommands only to diagnose a
   failure; rerunning each one before `ci:release` does not add coverage.
5. Confirm the hosted push/PR configuration still has one CI workflow, one
   Node 22 job, and one release-gate step in `.github/workflows/ci.yml`. There
   is no repeat/shuffle job, shard matrix, or Node 24 lane.
   `.github/workflows/release.yml` is a separate tag-only publication workflow;
   it reruns the same `ci:release` gate on the tagged tree rather than inheriting
   another workflow's result.
6. Keep evals outside the gate. The engine under `src/domains/eval/` and the
   reference suites under `evals/` ship for explicit operator measurements,
   but neither CI nor `ci:release` runs an eval. When a release-specific model
   measurement is requested, run it and retain its artifacts separately:

   ```sh
   node dist/cli/index.js eval run --suite evals/behavioral-model.yaml --target <id> --clio-coder-entry dist/cli/index.js
   node dist/cli/index.js eval run --suite evals/behavioral-model-negative-control.yaml --target <id> --clio-coder-entry dist/cli/index.js
   ```

   These runs can inform an operator decision, but they are not CI or release
   gates. The model-free `evals/behavioral-machinery.yaml` suite is likewise a
   maintained reference suite, not a checked release baseline.
7. When a configured target is available, run one real built-binary turn:

   ```sh
   node dist/cli/index.js run --target <id> --autonomy read-only \
     "Report the active target and confirm this is a release smoke turn."
   ```

   Run it with an isolated `CLIO_CODER_HOME` containing only the test target.
   Record a missing or unauthorized target as a deferred live check; never
   substitute a model-dependent result for the deterministic gate.
8. Inspect the package twice: first with `npm pack --dry-run`, then with a real
   `npm pack` directed to a temporary directory. Record the filename, integrity,
   shasum, packed size, and unpacked size. Confirm `dist/`, `src/`, `skills/`,
   `evals/`, the Markdown guides, package metadata, and required runtime assets
   are present. Confirm `docs/html/`, `apps/workbench/`, `.superpowers/`,
   `tests/`, `scripts/`, scratch files, and source maps are absent.
9. Install that tarball into a clean temporary prefix with an empty
   `CLIO_CODER_HOME`. Verify `clio-coder --version`, `--help`, an empty-state
   non-TTY launch, `doctor`, and `uninstall --dry-run` without using
   developer-local state. The in-suite installed-package smoke already proves
   a packed install can launch from a foreign working directory; this step
   inspects the exact final tarball.
10. Run the interactive release matrix against the clean install. Cover fresh
    onboarding, v1 settings migration, all seven `/settings` deep links,
    retired-command tombstones, slash autocomplete, `@` references, public and
    private bang operators, paste inertness, marketplace promotion, and the
    opt-in workers dock. Record PASS / FAIL / BLOCKED with concrete evidence.
    A deterministic behavior failure blocks the cut; a model-choice outcome is
    reported as model-dependent rather than rewritten into a deterministic
    claim.

## Part 2: notes and package coherence

11. Confirm the `## 0.4.1 - 2026-09-01` changelog section tells the complete
    release story in release-body order and contains no `Unreleased` section
    above it. The tag workflow extracts this section verbatim for the GitHub
    Release.
12. Confirm README quickstart and source-install commands name real commands,
    current paths, and `v0.4.1`. Confirm current eval documentation points to
    `src/domains/eval/` and `evals/`, not to a retired parallel tree.
13. Confirm `docs/architecture/artifact-versions.md` includes every persisted artifact added
    or re-versioned by the candidate, including any canonical naming schema
    identifiers. A compatibility reader does not make a newly emitted schema
    optional to document.
14. After any version, changelog, package-list, or release-note edit, rerun
    `npm run ci:release` and commit the coherent result on `v0.4.1`.

## Part 3: present the gate

15. Before touching a remote ref, report the exact final candidate SHA and
    tracked status; commits added since the prior handoff; the local
    `ci:release` result; the GitHub Actions URL for the candidate when one
    exists; package and changelog versions; tarball audit; clean-install and
    interactive results; any deferred live or eval measurement; and the
    proposed commands for the remaining parts.
16. Reconfirm whether `refs/tags/v0.4.1`, a v0.4.1 GitHub Release, or
    `@iowarp/clio-coder@0.4.1` already exists. Obtain the operator's npm
    dist-tag decision explicitly; do not infer `latest` or `next` from a prior
    release.

---

## AUTHORIZATION BOUNDARY

Every step below is externally visible or cannot be undone by an ordinary
local Git command. Do not execute any of it until the operator approves the
exact SHA and commands.

## Part 4: fast-forward `main`

17. `git fetch origin` immediately before integrating. Require `origin/main`
    to be an ancestor of the reviewed candidate and confirm no other worktree
    has `main` checked out.
18. Fast-forward local `main` to `refs/heads/v0.4.1`; do not create a merge
    commit, rebase the candidate, or reset a published branch. Verify `main`
    equals the reviewed SHA and is clean.
19. Fetch once more and stop on unexpected remote movement. Push `main` without
    force.

## Part 5: exact-SHA CI, tag, and GitHub Release

20. The `main` push triggers the single `ci` workflow. Require its one Node 22
    job for the exact reviewed SHA to finish green before tagging. A red run
    blocks the cut and is investigated on its own evidence.
21. Reconfirm the tag and GitHub Release do not exist. Create annotated tag
    `v0.4.1` on the green SHA and push only `refs/tags/v0.4.1`.
22. The tag triggers `.github/workflows/release.yml`. It verifies the tag
    matches `package.json`, independently runs `npm run ci:release` on the
    tagged tree, packs the tarball, extracts the v0.4.1 changelog section, and
    creates the GitHub Release. It does not publish to npm. Verify the run SHA,
    release notes, attached tarball, and URL.

## Part 6: npm publication

23. Run `npm whoami`; confirm the registry, account, package scope, and that
    `@iowarp/clio-coder@0.4.1` is still absent.
24. Reconfirm the operator's dist-tag decision, then run `npm publish` once
    with that decision. `prepublishOnly` reruns `ci:release`; it is a final
    safety net, not a substitute for Parts 1 and 5.
25. Treat publication as irreversible. A published version cannot be replaced;
    correct a mistake with a higher version rather than attempting to reuse
    `0.4.1`.

## Part 7: post-publish verification

26. Verify `npm view @iowarp/clio-coder@0.4.1` and the selected dist-tag.
27. On a clean machine, install from the registry rather than the local
    tarball. Repeat the version/help/doctor lifecycle checks, then configure a
    real target and run one real turn when authorized.
28. From a supported pre-v0.4.1 installation, run `clio-coder upgrade` and
    verify settings v2 plus the recorded Clio Coder naming migration. Confirm
    canonical writers use the new machine identifiers and a released legacy
    identifier remains read-compatible within the documented v0.5/v0.6 window.
29. Record the final SHA, CI and tag-workflow URLs, tag, GitHub Release URL,
    npm version and dist-tag, tarball evidence, and post-publish verification in
    the release report.

---

## Rollback

There is no rollback after npm publication. Before publication, delete only
newly created release artifacts that the operator explicitly authorizes for
removal. Correct a pushed `main` branch with a new forward commit, never by
rewriting it. Local verification and note edits remain ordinary reversible Git
work until they cross the authorization boundary.
