# v0.3.0 Release-Cut Checklist

The ordered steps that turn the prepared `v0.3.0` branch into a published
release. Everything above the line marked **AUTHORIZATION BOUNDARY** is
repeatable and reversible and was run during the hardening sessions. Everything
below it is external or destructive, was deliberately **not run**, and needs an
explicit decision from the operator.

Nothing in this checklist has been performed against `main`, a remote, a tag,
or the npm registry.

## Status of the prepared tree

| Item | State |
| --- | --- |
| Branch | `v0.3.0`, local only |
| `package.json` version | `0.3.0`, **not bumped by the hardening sessions** |
| `main` | untouched |
| Remotes | not contacted |
| Tags | none created |
| npm registry | not contacted |

---

## Part 1: verification (repeatable, already run)

1. `npm run typecheck`
2. `npm run lint`
3. `npm run check:boundaries`
4. `npm run build`
5. `npm run test`
6. `npm run test:trace-viewer`
7. `npm run ci` (runs 1, 2, `skills:check`, 4, 5, 6)
8. `npm run ci` again under the other supported Node major. Both Node 22 and
   Node 24 must be green; the repo is developed against 22.22.3 and 24.9.0.
9. `npm run test:lifecycle` for the twenty-case lifecycle matrix against a real
   `npm pack` installed into a temporary prefix. Case 9 needs `--live` plus
   `CLIO_LIFECYCLE_URL` and `CLIO_LIFECYCLE_MODEL` naming a target whose model
   is already resident.
10. `npm run ci:release`, which adds `scripts/check-release.mjs`: dist shebang
    integrity, the forbidden-file list, the required runtime resources, and the
    tarball and unpacked size budgets.

## Part 2: version and notes (repeatable, NOT run)

These edit the working tree only. They are reversible with `git checkout` and
are listed here because the hardening sessions were explicitly scoped out of
performing them.

11. Decide the released version. The tree currently reads `0.3.0` in
    `package.json`. If that is the number to publish, no bump is needed; confirm
    it deliberately rather than by default.
12. Files carrying a version reference, to update together if the number
    changes:
    - `package.json` (`version`)
    - `CHANGELOG.md` (the `## 0.3.0 - <date>` heading and its date)
    - `DEVLOG.md` (the session headings for this release)
    - `docs/environment-variables.md` and `docs/tui-design.md` (the
      `(Version: 0.3.0)` markers on the interactive-blueprint tips)
    - `docs/html/*.html` (the `Blueprint (v0.3.0)` titles)
    - `scripts/check-release.mjs` (the measured-at figures in the budget
      comment, if the package size moved materially)
13. Confirm the `## 0.3.0` section of `CHANGELOG.md` describes every
    user-visible behavior change in the release, including the ones that alter
    existing behavior:
    - unknown slash commands now fail instead of reaching the model as chat
    - `--remove-binary` launcher ownership is identity, not a path shape
    - `reset` and `uninstall` exit 1 on partial failure instead of reporting
      success
14. Re-run `npm run ci:release` after any version edit.
15. Commit the version and notes as one commit on `v0.3.0`.

---

## AUTHORIZATION BOUNDARY

Every step below leaves the local checkout, is externally visible, or cannot be
undone by a local `git` command. **None of them has been run.**

## Part 3: clean-install verification (external, NOT run)

16. **NOT RUN** — `npm pack` and install the resulting tarball into a fresh
    temporary prefix on a machine that has never had Clio installed, with empty
    XDG roots. `npm run test:lifecycle` covers this on the development machine;
    a second machine is what proves no developer-local state is load-bearing.
17. **NOT RUN** — From that install, verify: `clio --version`, `clio --help`,
    an empty-state non-TTY launch, `clio configure` to a real target,
    `clio doctor`, one real turn, and `clio uninstall --dry-run`.
18. **NOT RUN** — Inspect the artifact by hand: `tar -tzf` the tarball, confirm
    no source maps, no `scripts/`, no `tests/`, no `benchmarks/`, no
    `apps/trace-viewer`, and that `skills/`, `docs/*.md`, `docs/html/`, the
    builtin agents, the model catalogs, and `damage-control-rules.yaml` are all
    present.

## Part 4: branch integration (destructive to history, NOT run)

19. **NOT RUN** — Decide how `v0.3.0` reaches `main`. The hardening sessions
    were forbidden to merge, rebase, or modify `main`, so no integration
    strategy has been chosen or attempted.
20. **NOT RUN** — Integrate, then re-run `npm run ci:release` on the integrated
    result. A gate that passed on the branch has not passed on the merge.

## Part 5: tag and push (external, NOT run)

21. **NOT RUN** — `git tag -a v0.3.0 -m "..."`.
22. **NOT RUN** — `git push origin <branch>`.
23. **NOT RUN** — `git push origin v0.3.0`.

## Part 6: publication (external and irreversible, NOT run)

24. **NOT RUN** — `npm publish`. Note that `prepublishOnly` runs
    `npm run ci:release`, so publication re-gates the tree; that is a safety
    net and not a substitute for step 20.
25. **NOT RUN** — Decide the dist-tag. Publishing to `latest` makes this the
    default install for every user. An experimental release may warrant
    `--tag next` instead; the CLI and README both describe v0.3.0 as
    experimental, which argues for it.
26. **NOT RUN** — A published version cannot be replaced. `npm unpublish` is
    restricted and time-limited, and a mistake is corrected by publishing a
    higher version, not by removing the wrong one.

## Part 7: post-publish verification (external, NOT run)

27. **NOT RUN** — On a clean machine, `npm install -g @iowarp/clio-coder` from
    the registry rather than from a local tarball, then repeat step 17 against
    it. This is the only step that tests what users actually receive.
28. **NOT RUN** — Verify `clio upgrade` finds and applies the published
    version from an installation of the previous release.
29. **NOT RUN** — Publish the GitHub release with the `CHANGELOG.md` section
    for this version.

---

## Rollback

There is no rollback for step 24. If a defect is found after publication, the
correction is a patch release. Before step 24, every step is reversible:
steps 21 through 23 by deleting the local and remote tag and force-updating the
branch, and steps 11 through 15 by `git reset`.
