# v0.3.8 Release-Cut Checklist

The ordered steps that turn the prepared `v0.3.8` branch into a published
release. Everything above the line marked **AUTHORIZATION BOUNDARY** is
repeatable and reversible and is run locally before the cut. Everything below
it is external or irreversible and needs an explicit decision from the
operator. This page is the procedure and the release report carries the live
state of every step.

## Status of the prepared tree

| Item | State |
| --- | --- |
| Branch | After the release-cut evidence commit, `v0.3.8` is 30 commits ahead of `main`: the 29-commit candidate through `9b7b80cc` plus the final documentation and verification-evidence commit. The candidate includes the original implementation, the four release-test fixes (#233, #235, #238, #239), the WTF-P extension-resource merge, the `$ARGUMENTS` fidelity fix (#240), and the extension-agent resolution fix (#241). `origin/v0.3.8` remains at `af6546b2`, 17 commits behind the final local tip. |
| `package.json` version | `0.3.8`; `package-lock.json` agrees at both version fields; the top changelog heading is `## 0.3.8 - 2026-08-29`. |
| `main` | `598be99c`, the v0.3.7 release SHA; it is an ancestor of the final `v0.3.8` candidate and moves only at Part 4. |
| `origin/main` | `598be99c`, matching local `main` and still an ancestor of the final candidate. |
| Tags | `v0.3.7` exists on `598be99c`; no `v0.3.8` tag exists locally or remotely. The redundant `wtfp-safety` tag was deleted. The eight local `tmp-032-*` recovery tags remain and must never be pushed. |
| GitHub Release | `v0.3.7` is published; no GitHub Release exists for `v0.3.8`. |
| npm registry | `@iowarp/clio-coder@0.3.8` is absent; `latest` is `0.3.7`; the 0.3.8 dist-tag is undecided. |
| npm history | Published versions are 0.3.0 through 0.3.4, 0.3.6, and 0.3.7. Version 0.3.5 was published and withdrawn and can never be reused. |
| Milestone | `v0.3.8` has six open issues, all fixed on the branch: #233, #235, #238, #239, #240, and #241. They close from their `Fixes` trailers when the final candidate reaches `main`. |
| Interactive release test | The original three-round report is `docs/release-notes/v0.3.8-release-test.md` (57 PASS / 8 FAIL / 3 PARTIAL / 6 OBSERVATION / 2 NOT RUN). The continuation is `docs/release-notes/v0.3.8-verification.md` (44 PASS / 6 non-blocking FAIL / 7 OBSERVATION / 1 NOT RUN), which closes the blocker, verifies the three later merges, and carries the final `CUT` verdict. |
| Commit provenance identity | Still a post-release maintainer follow-up rather than a release gate; unchanged from 0.3.7. |

---

## Part 1: verification (repeatable)

Run against the exact final candidate with `NO_COLOR` unset and
`TERM=xterm-256color`, so the color-sensitive tests see a real terminal.

1. `npm run typecheck`
2. `npm run lint` (Biome plus the hygiene checks, which include the boundary invariants and the skills pin check)
3. `npm run skills:check`
4. `npm run build`
5. `npm run test`
6. `npm run test:trace-viewer`
7. `npm run ci` (runs 1 through 6)
8. `npm run ci:release` (7 plus `scripts/check-release.mjs`: dist shebang
   integrity, version coherence between `package.json` and the top
   `CHANGELOG.md` heading, the deterministic 26-scenario behavioral machinery
   corpus against its checked baseline, the forbidden-file list, the required
   runtime resources, and the tarball and unpacked size budgets). A baseline
   mismatch prints reviewable evidence and names prompt- or recipe-affected
   corpus results. For an intentional change, inspect that diff, run
   `node benchmarks/eval/check-behavioral-release.mjs --update` (with `TMPDIR` on a disk-backed path if `/tmp` is a small tmpfs),
   review `benchmarks/eval/behavioral-machinery-baseline.json`, and commit it
   with the change.
9. Optional: step 8 again under Node 24. Hosted CI gates on Node 22 alone,
   the `engines` floor; the weekly `flake-hunt` workflow carries Node 24.
   Repeat locally only when the cut touches runtime-sensitive code.
10. `npm run live:smoke -- --target <id>` for one real headless turn through
    the built binary against a configured target, which is the one release
    check a deterministic suite cannot give. The packaged-install lifecycle
    (pack, install into a clean prefix, run the installed launcher) is
    `tests/smoke/pack-install.test.ts` and already ran under step 5.
11. `npm pack --dry-run`, then a real `npm pack` into a temporary directory.
    Inspect the complete file list: `skills/`, `docs/*.md`, the builtin
    agents, the model catalogs, and `damage-control-rules.yaml` are present;
    `docs/html/`, `apps/workbench`, `.superpowers`, `tests/`, `scripts/`,
    `benchmarks/`, scratch files, and source maps are absent. Record the
    filename, packed and unpacked sizes, integrity, and shasum.
12. Install that tarball into a clean temporary prefix with an empty
    `CLIO_CODER_HOME` and verify `--version`, `--help`, an empty-state non-TTY
    launch, `doctor`, and `uninstall --dry-run` without developer-local state.
13. Before interactive release testing, run the model-required public
    behavioral corpus manually against the release target and built CLI:
    `node dist/cli/index.js eval run --suite benchmarks/eval/behavioral-model.yaml --target mini --clio-coder-entry dist/cli/index.js`
    and
    `node dist/cli/index.js eval run --suite benchmarks/eval/behavioral-model-negative-control.yaml --target mini --clio-coder-entry dist/cli/index.js`.
    Retain both Artifact v4 files as release evidence. The positive corpus must
    report its scenario and role rows without an undeclared envelope mismatch;
    the negative control must still record violated exploration and safety
    labels. These model-dependent runs are manual and are never required by
    ordinary deterministic CI. Continue with interactive release testing,
    which this cut added because the release is
    almost entirely interactive surface: a tester agent drives the step-12
    install through real TUI sessions in a throwaway repository, one session
    per shipped feature, against local targets for the main session and a
    cloud target for council members and advice, and writes a per-feature
    PASS / FAIL / BLOCKED table with evidence. A FAIL on a deterministic
    behavior (a refusal, a file, a receipt field, CLI output) blocks the cut;
    a BLOCKED(model) on a model decision does not.

## Part 2: version and notes (repeatable)

14. Files carrying a version reference, to update together if the number
    changes: `package.json` and `package-lock.json`, the `## 0.3.8 - <date>`
    heading in `CHANGELOG.md`, the `(Version: 0.3.8)` markers in `docs/*.md`,
    the `Blueprint (v0.3.8)` titles in `docs/html/*.html`, the `--branch`
    pin in the README install block (the hygiene lint checks it), and the
    measured-at figures in `scripts/check-release.mjs` if the package size
    moved materially. For 0.3.7 the tarball measured 6.5 MB packed and
    37.9 MB unpacked; re-measure for 0.3.8, inside the 10 MB and 50 MB ceilings set for 0.3.6.
15. Confirm the `## 0.3.8` section of `CHANGELOG.md` describes every
    user-visible behavior change under `### Added`, and every change to an
    existing behavior under `### Changed`, and carries no Workbench release
    narrative. The release workflow uses this section verbatim as the GitHub
    Release body.
16. `docs/artifact-versions.md` lists every persisted artifact this release
    added or re-versioned. For 0.3.8 that is run receipt integrity v20, which
    adds `pathProvenance` on dispatch intent and the resolved `pathScope`, and
    whose entry must also record that a receipt below v20 is reported as
    retired rather than invalid, and the durable assignment record, which now
    carries its owner pid, process birth token, and acquisition time.
17. Re-run `npm run ci:release` after any version edit and commit as one
    commit on `v0.3.8`.

## Part 3: present the gate

18. Report to the operator before touching `main`: the exact final `v0.3.8`
    SHA and clean status, the commits added since the handoff SHA, the gate
    commands with pass/fail totals, the package version and changelog heading,
    the tarball audit, the clean-install results, the interactive test table,
    and any deferred live check, confirmation that no tag, GitHub Release, or
    npm version exists yet, the proposed commands for Parts 4 through 6, and
    the npm dist-tag. The dist-tag is the operator's call; for 0.3.7 the
    operator chose `latest` on 2026-08-24; 0.3.8's dist-tag is undecided.

---

## AUTHORIZATION BOUNDARY

Every step below leaves the local checkout, is externally visible, or cannot be
undone by a local `git` command. None of them runs without the operator
confirming the exact SHA and the commands.

## Part 4: fast-forward `main`

19. `git fetch origin` immediately before integrating; require `origin/main`
    to be an ancestor of the reviewed `v0.3.8` tip and confirm no other
    worktree has `main` checked out.
20. `git checkout main && git merge --ff-only v0.3.8`. No merge commit, no
    rebase, no reset. Verify `main` equals the reviewed SHA and is clean.
21. `git fetch origin` once more; stop on any unexpected remote movement. Then
    `git push origin main`. Never `--force` or `--force-with-lease`. The push
    closes the six milestone issues through their `Fixes` trailers.

## Part 5: exact-SHA CI, tag, GitHub Release

22. The `main` push triggers the `ci` workflow. Require that exact-SHA run to
    finish green before tagging; `release.yml` then runs the same gate again on
    the tagged tree itself. A red run blocks the cut: investigate it rather than
    tagging around it, and never silence a flake with an unrelated change.
23. Reconfirm that tag `v0.3.8` and the GitHub Release do not exist, then
    `git tag -a v0.3.8 -m "Clio Coder 0.3.8"` on the green SHA and
    `git push origin refs/tags/v0.3.8`.
24. The tag push triggers `.github/workflows/release.yml`, which verifies the
    tag matches `package.json`, runs `npm run ci:release` on the tagged tree,
    extracts the `## 0.3.8` section of `CHANGELOG.md` as the release body, and
    attaches the tarball. Do not create a release by hand. Verify the run's
    SHA, the notes, the attached tarball, and the URL.

## Part 6: npm publication (irreversible)

25. `npm whoami` and confirm the registry and account; reconfirm
    `@iowarp/clio-coder@0.3.8` is still absent.
26. Obtain the operator's explicit dist-tag decision. `latest` makes this the
    default install for every user; `--tag next` keeps `0.3.7` as the default.
27. Run `npm publish` once. `prepublishOnly` re-runs `ci:release` as a safety
    net; it is not a substitute for Part 1.
28. A published version cannot be replaced. `npm unpublish` is restricted and
    time-limited; a mistake is corrected by publishing a higher version.

## Part 7: post-publish verification and follow-ups

29. `npm view @iowarp/clio-coder@0.3.8` and the selected dist-tag.
30. On a clean machine, `npm install -g @iowarp/clio-coder` from the registry
    rather than from a local tarball, then repeat step 12 against it, plus
    `configure` to a real target and one real turn when one is authorized.
    This is the only step that tests what users actually receive.
31. From an installation of 0.3.7, verify `clio-coder upgrade` finds and
    applies 0.3.8.
32. Record the SHA, CI URL, tag, GitHub Release URL, npm version and dist-tag,
    tarball evidence, and the post-publish verification in the release report.
33. Maintainer follow-up, independent of the release: verify the commit
    provenance email `clio-coder@iowarp.ai` on IOWarp-controlled GitHub and
    GitLab identities such as `clio-coder-bot` or `iowarp-clio`, and upload
    `assets/clio-coder-avatar-512.png` as the account avatar where PNG is
    required. Commit data itself cannot carry a logo, so this affects only how
    those platforms render the trailers, never whether attributed commits or
    the release work. Clio never creates accounts or performs remote
    operations for this.

---

## Rollback

There is no rollback for step 27. Before it, every step is reversible: steps
23 and 24 by deleting the local and remote tag and the draft release, steps 19
through 21 by a new forward commit on `main` (never by rewriting it), and
everything in Parts 1 and 2 by `git checkout`.
