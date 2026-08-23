# v0.3.5 Release-Cut Checklist

The ordered steps that turn the prepared `v0.3.5` branch into a published
release. Everything above the line marked **AUTHORIZATION BOUNDARY** is
repeatable and reversible and is run locally before the cut. Everything below
it is external or irreversible and needs an explicit decision from the
operator. This page is the procedure and the release report carries the live
state of every step.

## Status of the prepared tree

| Item | State |
| --- | --- |
| Branch | `v0.3.5`, local only; pushed with the explicit refspec `refs/heads/v0.3.5` when the operator decides, never as a bare name that a tag could shadow |
| `package.json` version | `0.3.5`; the top `CHANGELOG.md` heading is `## 0.3.5 - 2026-08-23` |
| `main` | `2518f301`, the published `v0.3.4` commit; it is an ancestor of `v0.3.5` and moves only at Part 4. |
| `origin/main` | `2518f301`, matching the published `v0.3.4` commit |
| Tags | none for 0.3.5, local or remote |
| GitHub Release | none for 0.3.5 |
| npm registry | `@iowarp/clio-coder@0.3.5` absent; `latest` is `0.3.4` |
| Commit provenance identity | Post-release maintainer follow-up, not a gate: verifying `clio-coder@iowarp.ai` on IOWarp-controlled GitHub and GitLab identities (such as `clio-coder-bot` or `iowarp-clio`, with `assets/clio-coder-avatar-512.png` as the avatar) only changes how those platforms render the trailers. |

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
   `CHANGELOG.md` heading, the forbidden-file list, the required runtime
   resources, and the tarball and unpacked size budgets)
9. Step 8 again under the other supported Node major. Both Node 22 and
   Node 24 must be green; the repo is developed against 22.22.3 and 24.9.0.
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
12. Install that tarball into a clean temporary prefix with empty XDG roots and
    verify `--version`, `--help`, an empty-state non-TTY launch, `doctor`, and
    `uninstall --dry-run` without developer-local state.

## Part 2: version and notes (repeatable)

13. Files carrying a version reference, to update together if the number
    changes: `package.json` and `package-lock.json`, the `## 0.3.5 - <date>`
    heading in `CHANGELOG.md`, the `(Version: 0.3.5)` markers in `docs/*.md`,
    the `Blueprint (v0.3.5)` titles in `docs/html/*.html`, the `--branch`
    pin in the README install block (the hygiene lint checks it), and the
    measured-at figures in `scripts/check-release.mjs` if the package size
    moved materially.
14. Confirm the `## 0.3.5` section of `CHANGELOG.md` describes every
    user-visible behavior change, including the ones that alter existing
    behavior, and carries no Workbench release narrative. The release workflow
    uses this section verbatim as the GitHub Release body.
15. Re-run `npm run ci:release` after any version edit and commit as one
    commit on `v0.3.5`.

## Part 3: present the gate

16. Report to the operator before touching `main`: the exact final `v0.3.5`
    SHA and clean status, the commits added since the handoff SHA, the gate
    commands with pass/fail totals for both Node majors, the package version
    and changelog heading, the tarball audit, the clean-install results and any
    deferred live check, confirmation that no tag, GitHub Release, or npm
    version exists yet, the proposed commands for Parts 4 through 6, and the
    proposed npm dist-tag. The dist-tag is the operator's call; never guess it.

---

## AUTHORIZATION BOUNDARY

Every step below leaves the local checkout, is externally visible, or cannot be
undone by a local `git` command. None of them runs without the operator
confirming the exact SHA and the commands.

## Part 4: fast-forward `main`

17. `git fetch origin` immediately before integrating; require `origin/main`
    to be an ancestor of the reviewed `v0.3.5` tip and confirm no other
    worktree has `main` checked out.
18. `git checkout main && git merge --ff-only v0.3.5`. No merge commit, no
    rebase, no reset. Verify `main` equals the reviewed SHA and is clean.
19. `git fetch origin` once more; stop on any unexpected remote movement. Then
    `git push origin main`. Never `--force` or `--force-with-lease`.

## Part 5: exact-SHA CI, tag, GitHub Release

20. Wait for the `ci` workflow the `main` push triggers. Both the Node 22 and
    Node 24 jobs must succeed on the exact release SHA. A red or pending run
    blocks the tag; a flake is rerun only with concrete evidence, never
    silenced with an unrelated change.
21. Reconfirm that tag `v0.3.5` and the GitHub Release do not exist, then
    `git tag -a v0.3.5 -m "Clio Coder 0.3.5"` on the green SHA and
    `git push origin v0.3.5`.
22. The tag push triggers `.github/workflows/release.yml`, which requires a
    successful `ci` run for the tagged SHA, verifies the tag matches
    `package.json`, builds and audits the artifact, extracts the `## 0.3.5`
    section of `CHANGELOG.md` as the release body, and attaches the tarball.
    Do not create a release by hand. Verify the run's SHA, the notes, the
    attached tarball, and the URL.

## Part 6: npm publication (irreversible)

23. `npm whoami` and confirm the registry and account; reconfirm
    `@iowarp/clio-coder@0.3.5` is still absent.
24. Obtain the operator's explicit dist-tag decision. `latest` makes this the
    default install for every user; `--tag next` keeps `0.3.4` as the default.
25. Run `npm publish` (or `npm publish --tag next`) once. `prepublishOnly`
    re-runs `ci:release` as a safety net; it is not a substitute for Part 1.
26. A published version cannot be replaced. `npm unpublish` is restricted and
    time-limited; a mistake is corrected by publishing a higher version.

## Part 7: post-publish verification and follow-ups

27. `npm view @iowarp/clio-coder@0.3.5` and the selected dist-tag.
28. On a clean machine, `npm install -g @iowarp/clio-coder` from the registry
    rather than from a local tarball, then repeat step 12 against it, plus
    `configure` to a real target and one real turn when one is authorized.
    This is the only step that tests what users actually receive.
29. From an installation of 0.3.4, verify `clio-coder upgrade` finds and
    applies 0.3.5.
30. Record the SHA, CI URL, tag, GitHub Release URL, npm version and dist-tag,
    tarball evidence, and the post-publish verification in the release report.
31. Maintainer follow-up, independent of the release: verify the commit
    provenance email `clio-coder@iowarp.ai` on IOWarp-controlled GitHub and
    GitLab identities such as `clio-coder-bot` or `iowarp-clio`, and upload
    `assets/clio-coder-avatar-512.png` as the account avatar where PNG is
    required. Commit data itself cannot carry a logo, so this affects only how
    those platforms render the trailers, never whether attributed commits or
    the release work. Clio never creates accounts or performs remote
    operations for this.

---

## Rollback

There is no rollback for step 25. Before it, every step is reversible: steps
21 and 22 by deleting the local and remote tag and the draft release, steps 17
through 19 by a new forward commit on `main` (never by rewriting it), and
everything in Parts 1 and 2 by `git checkout`.
