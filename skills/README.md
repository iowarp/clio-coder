# Clio Skills Marketplace

Curated, version-controlled skills that Clio Coder's authors have reviewed and
approved. This folder is the **marketplace catalog**, which acts as a publishing shelf rather than a
runtime store.

## Marketplace vs runtime

Clio's engine discovers *runtime* skills from these roots (see
`src/domains/resources/skills/loader.ts`):

- extension roots
- `~/.agents`, `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.copilot` → their `skills/` subdir
- `<clio-config>/skills` (per-user)
- project `.agents` / `.claude` / `.codex` / `.opencode` / `.github` → their `skills/` subdir
- `.clio/skills` (per-project)

This repo's `skills/` directory is **not** one of those roots, so nothing here
auto-loads. That gap is deliberate.

| | Runtime skill | Marketplace skill (here) |
|---|---|---|
| Location | a discovery root above | `skills/<name>/` in this repo |
| Author | any user or harness | Clio authors, reviewed |
| Provenance | none required | `clio:` block with `registry-id` + `source-url` + `audit: pass` |
| Auto-loaded | yes | no, as it must be installed |

"Approved" is visible in the frontmatter: a maintainer set `clio.audit: pass`
and a `version`. A skill a user wrote themselves carries none of those fields.

## Catalog

| Skill | Type | Use when |
|---|---|---|
| [`grill-me`](grill-me/) | interview | A plan or idea needs stress-testing through a one-question-at-a-time interview before code is written. Ends with a decision log. |
| [`prd`](prd/) | interview | An idea must become a locked product spec via a phase-gated interview, ending in PRD.md plus milestone prompts. |
| [`cut-it`](cut-it/) | workflow | A plan, PRD, or milestone must become an executable sprint of dependency-ordered slices with done-when criteria. |
| [`context-prime`](context-prime/) | workflow | A session begins and you need to load project state, the last handoff, and orientation before acting. |
| [`context-handoff`](context-handoff/) | workflow | A session is ending and work continues in a new session or another agent. Writes the artifact `context-prime` reads. |
| [`clio-dev`](clio-dev/) | discipline | Modifying Clio's own source in this repo; deciding whether a change stays local or becomes a contribution. |
| [`clio-test`](clio-test/) | reference | Writing or verifying changes to Clio against the real harness (contracts / smoke / boundaries). |
| [`arxiv-literature`](arxiv-literature/) | research | Searching arXiv, summarizing papers, comparing papers, or producing compact literature surveys while protecting main-agent context. |
| [`scientific-debugging`](scientific-debugging/) | workflow | Debugging has stalled or produces wrong numbers, NaNs, or flaky results. Forces falsifiable hypotheses across fault classes and evidence-cited verdicts before any fix. |
| [`experiment-protocol`](experiment-protocol/) | workflow | A benchmark, optimization, or numerical comparison needs success criteria locked before results exist. Pre-registers thresholds into the repo validation contract. |
| [`scientific-modernization`](scientific-modernization/) | workflow | Established scientific software is being modernized, ported, rewritten, packaged, accelerated, or replaced. Locks an independent scientific oracle, staged compatibility evidence, and durable stewardship before release. |
| [`design-council`](design-council/) | workflow | A design decision has real tradeoffs and needs several composed expert perspectives that debate through read-only dispatched workers before code is written. |
| [`find-skills`](find-skills/) | workflow | A capability might exist as an installable skill. Searches with `clio skills search`, browses the ecosystem read-only, and installs only through `clio skills install`. |
| [`credentials`](credentials/) | discipline | A task needs an API key, token, or facility credential. Verifies presence without exposing values, collects new secrets via hidden terminal input, and contains leaks. |
| [`workflow-distiller`](workflow-distiller/) | workflow | A workflow that just ran should become a reusable skill. Reconstructs it from the session record, interviews, checks overlap, gates on approval, then writes it following `skill-craft`. |
| [`herdr`](herdr/) | integration | The user asks to launch, drive, or inspect another agent or command in a Herdr pane — including a second Clio Coder instance. Requires `HERDR_ENV=1`. |
| [`ast-grep`](ast-grep/) | workflow | A code search needs structure, not text: AST patterns, "X inside Y", or grep is too noisy. Test-first rule writing, search only. |
| [`piv-commit`](piv-commit/) | workflow | The user asks to commit finished work. One atomic conventional commit, explicit-path staging, no push. |
| [`piv-create-pr`](piv-create-pr/) | workflow | The user asks to push the branch and open a PR. Base detection, state gates, structured body, URL back. |
| [`piv-investigate-issue`](piv-investigate-issue/) | workflow | A GitHub issue needs diagnosis before a fix: parallel exploration, evidence-cited why-chain, reviewable RCA. |
| [`piv-review-changes`](piv-review-changes/) | workflow | Pre-commit review of uncommitted work: real bugs and security, verified findings, severity-ranked report. |
| [`worktree-create`](worktree-create/) | workflow | Stand up isolated worktrees for parallel branches: detected install/config/health-check, per-worktree verification. |
| [`worktree-merge`](worktree-merge/) | workflow | Integrate finished worktree branches through a throwaway integration branch with per-merge tests and a full final gate. |
| [`resolving-merge-conflicts`](resolving-merge-conflicts/) | workflow | A merge/rebase is stopped on conflicts. Resolves from both sides' reconstructed intent, validates, completes the operation. |
| [`plan-create-prd`](plan-create-prd/) | interview | A greenfield idea needs a problem-first product document with a falsifiable hypothesis and zero engineering decisions. |
| [`plan-architecture`](plan-architecture/) | interview | An intent needs its engineering approach decided interactively: options, trade-offs, spikes, a high-level decision doc. |
| [`plan-create-stories`](plan-create-stories/) | workflow | A finished PRD/architecture doc must become real tracker tickets with verifiable acceptance criteria. |
| [`tdd`](tdd/) | discipline | Build or fix test-first: red → green at pre-agreed public seams, one vertical slice per cycle. |
| [`prototype`](prototype/) | workflow | A design question should be answered with clearly-marked throwaway code, then the verdict captured and the code discarded. |
| [`coding-standards`](coding-standards/) | reference | TypeScript correct-by-construction standards: errors as values, parse don't validate, deep modules. Provisional. |
| [`tech-spec`](tech-spec/) | workflow | A typed call-stack architecture handoff: contracts + execution flows, implementation-ready. User-invoked only. Provisional. |
| [`skill-craft`](skill-craft/) | reference | Writing, reviewing, or pruning any SKILL.md: invocation cost, trigger-only descriptions, completion criteria, progressive disclosure, and the pruning pass. |

Each SKILL.md may declare `allowed-tools` / `disallowed-tools`. After a skill
loads, Clio enforces that declaration at tool admission until the turn (or
worker run) ends: calls outside the merged surface are blocked with reason
code `skill_surface`, with `context` and `ask_user` always admitted. A
skill can narrow its tool surface but never grant tools the host would not
allow. Full semantics: docs/safety-model.md, "Skill tool surface narrowing".

## Install (activate a marketplace skill)

`clio skills install` is the bridge from marketplace to runtime. It copies a
skill into a discovery root and stamps install provenance so Clio can load it.

```bash
# Project scope (default): copy into <repo>/.clio/skills
clio skills install context-handoff

# User scope: copy into the Clio config skills dir, available everywhere
clio skills install clio-dev --user
```

Bare names resolve through the local marketplace (this catalog when run from
the repo, `CLIO_SKILL_CATALOG_DIR`, or the skill-marketplace.json index); an
existing local path always wins over a same-named marketplace entry.

After install, confirm Clio sees it:

```bash
clio skills list            # human view
clio skills inspect context-handoff # full metadata + provenance
```

Installed copies are frozen; refresh them from their `source-url` provenance
with `clio skills update <name>` or `clio skills sync`. While developing a
catalog skill, load it directly without installing:
`clio --skill skills/<name>/SKILL.md`.

Uninstall is just removing the copy: `rm -r .clio/skills/<name>` (or the
user-scope equivalent). Installs never write outside `.clio/skills` or the
user config skills dir, both of which are gitignored / outside the repo.

### Skill discovery and find-skills precedence

Clio ships [`find-skills`](find-skills/) so that discovery and installation
both route through `clio skills`. A community skill of the same name is
commonly present in the compat roots (`~/.agents/skills`,
`~/.claude/skills`) and drives the external `npx skills` installer, which
bypasses Clio. Compat roots stay enabled, and the loader resolves name
collisions by precedence: the Clio user root and `.clio/skills` outrank the
compat roots. Install the catalog copy so it wins:

```bash
clio skills install find-skills --user   # or --project for one repo
```

## Frontmatter spec

The frontmatter contract has two layers, and the split is the point:

- **Core keys stay community-standard.** `name`, `description`, `version`,
  `license`, and `allowed-tools` mean exactly what Claude Code and other agent
  loaders expect. No Clio-specific key ever lives at the top level.
- **Everything Clio-specific nests under one reserved `clio:` mapping.**
  Registry identity, provenance, audit and eval status, agent bindings, model
  guidance — all of it.

The invariant this buys: a Clio skill dropped into any `.claude/skills`
directory loads and works in Claude Code, which ignores the `clio:` block as
an unknown key. Loaded by Clio Coder, the same file carries its full
marketplace metadata. One file, no forks, no lossy export.

Required shape for every catalog skill:

```yaml
---
name: <name>                  # lowercase, hyphens, matches the folder
description: Use when ...     # triggers only, third person, <=1024 chars
version: 0.1.0
license: Apache-2.0
allowed-tools:                # optional; community-standard tool narrowing
  - read
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/<name>
  audit: pass                 # pass | warn | fail | unknown; reset to unknown on install
  provenance: designed        # designed | adapted | imported
  origin: <url or project>    # required when provenance is not "designed"
  eval-status: scenarios-recorded  # untested | scenarios-recorded | eval-run
  model-size: any             # any (runs on ~30B local models) | large
  agents:                     # optional: shadow agents / recipes the body dispatches
    - researcher
---
```

Field semantics inside `clio:`:

- `registry-id` names the audited catalog a skill claims membership of; it is
  content, participates in the pinned hash, and survives installs.
- `source-url` and `audit` are install-lifecycle fields: `clio skills install`
  rewrites `source-url` to the actual install source and resets `audit` to
  `unknown` because auditing is a human decision. Both are provenance-stripped
  before hashing.
- `provenance` records how the skill came to exist: `designed` here for Clio,
  `adapted` from an external skill (name it in `origin`), or `imported`
  near-verbatim.
- `eval-status` is honest test standing: `untested` (no scenarios),
  `scenarios-recorded` (evals.md scenarios written, not yet executed via
  `clio skills eval`), `eval-run` (scenarios executed and passing; record the
  date in evals.md when setting this).
- `model-size` is body-quality guidance: `any` means the body is written to
  the local-model bar (explicit, imperative, short steps, explicit stop
  conditions) and runs on ~30B-class local models; `large` means the skill
  leans on judgment or synthesis that degrades on small models.
- `agents` records agent bindings: the agent surfaces the skill is written
  for (`main`, `coder`, or a recipe name whose definition lists the skill)
  and, for orchestration skills, the recipes the body dispatches. A harness
  without those agents knows what degrades.
- `provisional: true` marks a skill accepted into the catalog on trial: it
  passed review but its fit for the ecosystem is still being judged, and it
  may be revised or dropped without a deprecation cycle.

`requires: [skill:<name>, ...]` stays top-level: Clio's loader consumes it for
dependency warnings, and other harnesses ignore it like any unknown key.

Legacy flat keys (`registry-id`, `source-url`, `audit` at the top level) are
still read by the loader as a fallback for copies installed before the nested
form existed; the catalog itself must use the nested form, and `npm run
skills:check` enforces that.

## Contributing / approval

A skill is "approved for the marketplace" when a maintainer:

1. Reviews `SKILL.md` against [`skill-craft`](skill-craft/) (trigger-only
   description, checkable completion criteria, progressive disclosure, pruning
   pass, evals present).
2. Confirms it carries the frontmatter spec above with `clio.audit: pass`.
3. Sets / bumps `version`.

Each skill ships an `evals.md` recording the baseline scenarios it was tested
against (RED-GREEN per [`skill-craft`](skill-craft/)). `clio skills eval <name>`
executes those scenarios instead of trusting the prose; the eval lane is the
curation gate for this catalog, not an end-user feature.

`npm run skills:pin` enforces this contract structurally: it refuses to pin a
catalog where any skill is missing the required frontmatter, `audit: pass`, or
its `evals.md`, and `npm run skills:check` (run in CI) fails on any drift
between the catalog and `registry.yaml`. Pinned hashes are provenance-stripped
(install-lifecycle stamps like `installed-at` do not count as drift; content
and registry-identity edits do), so a copy installed via `clio skills install`
still verifies against its audited source at activation.

A skill may declare typed dependencies with `requires: [skill:<name>, ...]`
frontmatter; the loader warns at load time when a required skill is not
installed, keeping composed workflows (for example a distilled skill that
references `credentials`) auditable instead of silently incomplete.
