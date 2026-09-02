# Artifact Placement

> **Visual blueprint:** The source checkout includes the complete
> [Artifact Placement visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/artifact_placement_blueprint.html).

Every file Clio generates has one home, decided by who reads it. The rule that
follows from that: **the repo working tree holds files a human asked for.**
Anything Clio produced on its own initiative lands in the project-local
`.clio-coder/` directory or under the XDG directories, never beside your source.
`context init` can add the recommended blanket ignore for `.clio-coder/`.

This page is the contract. `src/core/artifact-paths.ts` is the code that
implements the part of it the `artifact` tool owns.

## Three audiences

| Audience | What it means | Where it goes |
| --- | --- | --- |
| Human deliverable | A file the user asked to keep, and will read and commit | Repo working tree, at the path the user named |
| Human transient | Something a human may want to read once; losing it costs nothing | Project-local `.clio-coder/` (normally gitignored) |
| Agent-to-agent state | Machine-read plumbing between turns, workers, and sessions | `.clio-coder/` for per-project state; XDG data/state/cache for per-machine state |

A class is human-facing only if a person is expected to open it. A plan an
agent wrote for its own next step is agent-to-agent state even though it is
Markdown.

## Placement by class

| Class | Location | Audience |
| --- | --- | --- |
| `artifact` tool plan / review / report | `.clio-coder/artifacts/PLAN.md`, `REVIEW.md`, `REPORT.md` | Human transient |
| Any artifact the user named a path for | that path, inside the workspace | Human deliverable |
| RCA write-ups for shipped fixes | the GitHub issue's closing comment, never a committed file | Human deliverable |
| Codewiki index | `.clio-coder/codewiki.json` | Agent-to-agent |
| Markdown wiki | `.clio-coder/wiki/` | Human transient |
| Session context state | `.clio-coder/state.json` | Agent-to-agent |
| Task-memory handoffs | `.clio-coder/handoffs/` | Agent-to-agent |
| Dispatch proposals | `.clio-coder/proposals/` | Agent-to-agent |
| Compete worktrees | `.clio-coder/worktrees/` | Agent-to-agent |
| Tool-result and harness scratch | XDG state `scratch/`, with tool offloads grouped by session | Agent-to-agent |
| Evidence bundles | XDG data `evidence/` | Human transient (`clio-coder evidence`) |
| Approved memory | XDG data `memory/` | Human transient (`clio-coder memory`) |
| Eval artifacts | XDG data `evals/` | Human transient (`clio-coder eval`) |
| Session ledgers | XDG state `sessions/` | Agent-to-agent |
| Dispatch receipts | XDG state `receipts/` | Human transient (`clio-coder trace`) |
| Audit records | XDG state `audit/` | Human transient |
| Interview transcripts | XDG state `interviews/` | Agent-to-agent |
| Caches | XDG cache | Agent-to-agent |

`clio-coder paths` prints the resolved XDG directories for your machine.

## The `artifact` tool default

`artifact(kind: plan|review|report)` without a `path` writes to
`.clio-coder/artifacts/` under the workspace root. Passing `path` writes exactly
there instead, working tree included, because a path the user named is a file
the user asked for. A path that escapes the workspace is refused.

The default is a pure function of `kind`, and has to stay that way. The action
classifier, the policy engine's write-root check, and the protected-artifacts
guard all predict where a pathless call will write, from its arguments alone,
before the tool runs. A default keyed on a session id or a timestamp would make
that prediction impossible and leave the safety layer guarding a path nobody
writes. The consequence is one file per kind: a second report overwrites the
first. Keep several by naming explicit paths.

## `.clio-coder/` and git

`clio-coder context init` checks for a blanket `.clio-coder/` ignore. With
confirmation, or with `--yes`, it appends `.clio-coder/` to `.gitignore`; without
confirmation it warns and leaves the file unchanged. A project that has never
accepted or authored that rule can therefore see generated local state in
`git status`.

Some `.clio-coder/` content is authored rather than generated, and a project
that wants it reviewed and shared commits exact files deliberately. With the
blanket parent directory ignored, child negations alone are ineffective because
Git does not descend into an excluded parent. Force-add an intentional asset,
for example:

```bash
git add -f .clio-coder/fleets/build-review.md
git add -f .clio-coder/rules/backend.md
git add -f .clio-coder/safety.yaml
```

Review the forced path before committing it. This repository commits none of
those project-local assets, and its `.gitignore` contains the blanket rule.
Benchmark workspaces are temporary external repositories.

## Finding what was hidden

Hiding transient output from the working tree must not mean losing it.

- `.clio-coder/artifacts/` is a plain directory; open it.
- `clio-coder evidence` lists and inspects evidence bundles.
- `clio-coder trace` queries the dispatch trace mirror and its receipts.
- `clio-coder memory` lists proposed and approved memory.
- `clio-coder paths` locates every XDG root.

Related: [evidence-and-memory.md](evidence-and-memory.md),
[trace-store.md](trace-store.md), [observability.md](observability.md),
[development-pipeline.md](../process/development-pipeline.md) for where RCAs are committed.
