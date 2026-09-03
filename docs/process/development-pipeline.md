# Development Pipeline

> **Visual blueprint:** The source checkout includes the complete
> [Development Pipeline visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/development_pipeline_blueprint.html).

How a change to Clio Coder moves from "we noticed something" to a published
release. This is the process the maintainers follow and the process Clio
herself follows when dogfooding: every stage is a marketplace skill, so any
harness that loads the skills (Clio, Claude Code, Codex) runs the same
pipeline. One-shot reactive prompting is the anti-pattern this page retires:
work that is not traceable to an issue does not merge.

## The lifecycle

Three stages. A skill earns a stage only when it encodes repo policy a
model cannot guess or an irreversibility gate a small model will skip
under pressure; git mechanics alone never justify a stage.

| Stage | Skill | Output |
| --- | --- | --- |
| 1. File | [`file-ticket`](../../skills/git/file-ticket/) | A labeled GitHub issue with evidence and acceptance criteria |
| 2. Fix | [`fix-issue`](../../skills/git/fix-issue/) | An uncommitted, verified change where failing tests preceded the fix, self-reviewed against the issue's acceptance criteria |
| 3. Ship | [`ship`](../../skills/git/ship/) | An atomic conventional commit referencing the issue (`fixes #N`); contributors push it to their fork and open a PR, while maintainer work stays local for gated integration; merge is a human decision |

Releases follow [release-cut-checklist.md](../history/release-cut-checklist.md) as a
human-gated checklist, not a skill. Worktrees
([`worktree-create`](../../skills/git/worktree-create/),
[`worktree-merge`](../../skills/git/worktree-merge/)),
[`resolve-merge-conflicts`](../../skills/git/resolve-merge-conflicts/), and
[`tdd`](../../skills/coding/tdd/) are à-la-carte tools reached for when the
situation calls for them, not stages every change passes through. An RCA
written as the closing comment on the issue (`rca` label) is an artifact of
hard bugs, not a mandatory toll booth. Batch ticket creation from a PRD
bypasses stage 1 and uses [`backlog`](../../skills/planning/backlog/)
instead; everything downstream is identical.

## Closeout

A merged PR is not operationally finished until its local scaffolding is
closed. After the human merge decision:

1. Fetch and prune, confirm the PR's merged state, and identify the resulting
   commit on `origin/main`. Direct ancestry proves an ordinary merge; a squash
   or cherry-pick needs the PR-to-result evidence because commit identity and
   patch identity can both change during integration.
2. Inspect every associated worktree for tracked changes, untracked files, and
   ignored state that carries evidence rather than rebuildable output. Remove
   it through `git worktree remove`; forcing removal requires explicit approval
   to discard what remains.
3. Delete the local source and integration branches. For a contributor PR,
   delete the merged branch from the contributor's fork. The canonical
   repository never hosts topic, integration, or release-candidate branches.
4. Turn unfinished experimental findings into an issue with evidence and a
   next decision. Do not use indefinite `work/`, `wip/`, `keep/`, or temporary
   tags as a substitute for backlog state.
5. Report the remaining worktrees, local branches, stashes, local-only tags,
   and canonical remote heads. The expected canonical head set is exactly
   `refs/heads/main`; every survivor needs an owner and purpose.

Maintainer release candidates are local-only and use a compact branch name
that cannot collide with their tag: branch `v043`, tag `v0.4.3`. Gate the exact
candidate, require fetched `origin/main` to be its ancestor, fast-forward local
`main`, fetch again, and push only `refs/heads/main:refs/heads/main` with
explicit authorization. After CI passes, push only the fully qualified
annotated tag. Once the tag's peeled commit equals the reviewed commit on
`main` and the release succeeds, delete the local candidate branch. Published
dotted release tags are immutable history and are never cleanup targets.

## Inheriting a Pi release

Pi dependency upgrades use a fixed five-step review so that upstream fixes
replace Clio copies without crossing the product boundary:

1. Read the release notes or package changelogs for `pi-ai`, `pi-agent-core`,
   and `pi-tui`.
2. Run `npm run pi:surface-diff`. A changed or removed symbol that Clio imports
   is an error; a new export is review input.
3. Run the focused contracts in the
   [Pi regression net](../architecture/pi-boundary.md#pi-regression-net), then run `npm run ci`.
4. Walk Pi's fixed-issue list against the
   [Pi SDK boundary table](../architecture/pi-boundary.md). For every fix in a surface Clio
   still owns, either delete Clio's copy in favor of Pi or add a dated reason
   for keeping the delta.
5. Review the matching pi-coding-agent release diff for application features
   worth a Clio ticket.

After review, regenerate `docs/pi-surface.json` with
`npm run pi:surface-snapshot`, inspect the symbol and signature changes, and
commit the dependency pins, snapshot, boundary notes, and proving contracts
together. `npm run lint` invokes the surface check automatically when the
installed Pi versions differ from the checked-in snapshot.

## Test lanes

`npm test` uses Node's test runner over every `tests/contracts/*.test.ts` and
`tests/smoke/*.test.ts` file, with `tests/harness/tmp-root.ts` preloaded to
isolate test state. Its `pretest` hook builds `dist/` when the CLI bundle is
absent. Run one focused file while iterating with:

```bash
npm run test:file -- tests/contracts/<name>.test.ts
```

There is no committed weighted-shard or special serial-lane runner. Keep timing
claims within the focused contract that owns them, and use the full `npm run ci`
gate before handoff.

## Issue conventions

- **Title**: conventional tag plus imperative summary (`fix: memory overlay
  cannot scroll`), matching `.github/ISSUE_TEMPLATE/` prefixes.
- **Body**: Problem, Reproduce, Evidence with `file:line` pointers,
  Acceptance criteria as a verifiable checklist, Links.
- **Labels**: exactly one type label (`bug`, `enhancement`,
  `documentation`, `question`) plus applicable `area:*` labels.
- **Milestone**: the open release milestone when the work is committed to
  it; unassigned issues carry `needs-triage` until a human places them.

### Label taxonomy

| Kind | Labels | Meaning |
| --- | --- | --- |
| Type | `bug`, `enhancement`, `documentation`, `question` | What the issue is; exactly one |
| Area | `area:tui`, `area:engine`, `area:memory`, `area:dispatch`, `area:skills`, `area:cli`, `area:api`, `area:docs` | Which subsystem; one or more |
| Status | `needs-triage`, `rca`, `blocked` | Where in the lifecycle |
| Community | `good first issue`, `help wanted`, `duplicate`, `invalid`, `wontfix` | GitHub defaults, unchanged |

New `area:*` labels are proposed in an issue, not created ad hoc.

## Milestones are releases

Each open milestone names an upcoming version. Triage means
assigning an issue to a milestone or explicitly leaving it in the backlog.
A release cut requires every issue in its milestone to be closed
or bumped; the milestone closes when the tag is published.

## Dogfooding setup

The marketplace copy under `skills/git/` is the committed source of truth,
pinned in `skills/registry.yaml` by `npm run skills:pin`. Runtime roots are
gitignored, so each developer installs locally:

```bash
cp -r skills/git/file-ticket .clio-coder/skills/   # Clio Coder
cp -r skills/git/file-ticket .claude/skills/       # Claude Code
```

The other pipeline skills are model-invoked from the marketplace catalog the
same way. When a skill changes, re-run `npm run skills:pin` and re-copy;
drift between an installed copy and the pinned hash surfaces a warning at
activation.
