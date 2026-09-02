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
- project `.agents` / `.claude` / `.codex` / `.opencode` / `.github` → their `skills/` subdir (model-visible only when `integrations.projectResources.trustProjectImports` is true; untrusted by default)
- `.clio-coder/skills` (per-project)

This repo's `skills/` directory is **not** one of those roots, so nothing here
auto-loads. That gap is deliberate.

| | Runtime skill | Marketplace skill (here) |
|---|---|---|
| Location | a discovery root above | `skills/<category>/<name>/` in this repo |
| Author | any user or harness | Clio authors, reviewed |
| Provenance | none required | `clio:` block with `registry-id` + `source-url` + `audit: pass` |
| Auto-loaded | yes | no, as it must be installed |

"Approved" is visible in the frontmatter: a maintainer set `clio.audit: pass`
and a `version`. A skill a user wrote themselves carries none of those fields.

## Catalog

The catalog is organized by theme: each skill lives at
`skills/<category>/<name>/`. Skill names stay globally unique; the category
folder is presentation and provenance, not a namespace.

### `planning/` — from idea to committed intent

| Skill | Type | Use when |
|---|---|---|
| [`product-intent`](planning/product-intent/) | interview | A greenfield idea needs a problem-first product document with a falsifiable hypothesis and zero engineering decisions. |
| [`prd`](planning/prd/) | interview | An idea must become a locked product spec via a phase-gated interview, ending in PRD.md plus milestone prompts. |
| [`architecture`](planning/architecture/) | interview | An intent needs its engineering approach decided interactively: options, trade-offs, spikes, a high-level decision doc. |
| [`backlog`](planning/backlog/) | workflow | A finished PRD/architecture doc must become real tracker tickets with verifiable acceptance criteria. |
| [`tech-spec`](planning/tech-spec/) | workflow | A typed call-stack architecture handoff: contracts + execution flows, implementation-ready. User-invoked only. Provisional. |

### `coding/` — building and searching code

| Skill | Type | Use when |
|---|---|---|
| [`tdd`](coding/tdd/) | discipline | Build or fix test-first: red → green at pre-agreed public seams, one vertical slice per cycle. |
| [`prototype`](coding/prototype/) | workflow | A design question should be answered with clearly-marked throwaway code, then the verdict captured and the code discarded. |
| [`ast-grep`](coding/ast-grep/) | workflow | A code search needs structure, not text: AST patterns, "X inside Y", or grep is too noisy. Test-first rule writing, search only. |
| [`coding-standards`](coding/coding-standards/) | reference | TypeScript correct-by-construction standards: errors as values, parse don't validate, deep modules. Provisional. |

### `git/` — commits, PRs, worktrees, conflicts

| Skill | Type | Use when |
|---|---|---|
| [`file-ticket`](git/file-ticket/) | workflow | Something noticed mid-session must become a tracker issue: capture evidence, dedup, compose, confirm, create via gh. |
| [`fix-issue`](git/fix-issue/) | workflow | A tracker issue should be resolved: diagnose only the unknown, fix test-first, self-review against the issue's acceptance criteria. |
| [`ship`](git/ship/) | workflow | Finished work leaves the machine: one atomic conventional commit referencing the issue, gated push, PR on explicit intent. |
| [`worktree-create`](git/worktree-create/) | workflow | Stand up isolated worktrees for parallel branches: detected install/config/health-check, per-worktree verification. |
| [`worktree-merge`](git/worktree-merge/) | workflow | Integrate finished worktree branches through a throwaway integration branch with per-merge tests and a full final gate. |
| [`resolve-merge-conflicts`](git/resolve-merge-conflicts/) | workflow | A merge/rebase is stopped on conflicts. Resolves from both sides' reconstructed intent, validates, completes the operation. |

### `research/` — scientific and literature work

| Skill | Type | Use when |
|---|---|---|
| [`arxiv-literature`](research/arxiv-literature/) | research | Searching arXiv, summarizing papers, comparing papers, or producing compact literature surveys while protecting main-agent context. |
| [`scientific-debugging`](research/scientific-debugging/) | workflow | Debugging has stalled or produces wrong numbers, NaNs, or flaky results. Forces falsifiable hypotheses across fault classes and evidence-cited verdicts before any fix. |
| [`experiment-protocol`](research/experiment-protocol/) | workflow | A benchmark, optimization, or numerical comparison needs success criteria locked before results exist. Pre-registers thresholds into the repo validation contract. |
| [`scientific-modernization`](research/scientific-modernization/) | workflow | Established scientific software is being modernized, ported, rewritten, packaged, accelerated, or replaced. Locks an independent scientific oracle, staged compatibility evidence, and durable stewardship before release. |

### `context/` — session state across boundaries

| Skill | Type | Use when |
|---|---|---|
| [`context-prime`](context/context-prime/) | workflow | A session begins and you need to load project state, the last handoff, and orientation before acting. |
| [`context-handoff`](context/context-handoff/) | workflow | A session is ending and work continues in a new session or another agent. Writes the artifact `context-prime` reads. |

### `workflow/` — shaping and stress-testing how work happens

| Skill | Type | Use when |
|---|---|---|
| [`grill-me`](workflow/grill-me/) | interview | A plan or idea needs stress-testing through a one-question-at-a-time interview before code is written. Ends with a decision log. |
| [`cut-it`](workflow/cut-it/) | workflow | A plan, PRD, or milestone must become an executable sprint of dependency-ordered slices with done-when criteria. |
| [`design-council`](workflow/design-council/) | workflow | A design decision has real tradeoffs and needs several composed expert perspectives that debate through read-only dispatched workers before code is written. |
| [`workflow-distiller`](workflow/workflow-distiller/) | workflow | A workflow that just ran should become a reusable skill. Reconstructs it from the session record, interviews, checks overlap, gates on approval, then writes it following `skill-craft`. |

### `meta/` — Clio operating on itself and its ecosystem

| Skill | Type | Use when |
|---|---|---|
| [`skill-craft`](meta/skill-craft/) | reference | Writing, reviewing, or pruning any SKILL.md: invocation cost, trigger-only descriptions, completion criteria, progressive disclosure, and the pruning pass. |
| [`find-skills`](meta/find-skills/) | workflow | A capability might exist as an installable skill. Searches with `clio-coder skills search`, browses the ecosystem read-only, and installs only through `clio-coder skills install`. |
| [`clio-coder-dev`](meta/clio-coder-dev/) | discipline | Modifying Clio's own source in this repo; deciding whether a change stays local or becomes a contribution. |
| [`clio-coder-test`](meta/clio-coder-test/) | reference | Writing or verifying changes to Clio against the real harness (contracts / smoke / boundaries). |
| [`credentials`](meta/credentials/) | discipline | A task needs an API key, token, or facility credential. Verifies presence without exposing values, collects new secrets via hidden terminal input, and contains leaks. |
| [`herdr`](meta/herdr/) | integration | The user asks to launch, drive, or inspect another agent or command in a Herdr pane — including a second Clio Coder instance. Requires `HERDR_ENV=1`. |

Each SKILL.md may declare `allowed-tools` / `disallowed-tools`. After a skill
loads, Clio enforces that declaration at tool admission until the turn (or
worker run) ends: calls outside the merged surface are blocked with reason
code `skill_surface`, with `context` and `ask_user` always admitted. A
skill can narrow its tool surface but never grant tools the host would not
allow. Full semantics: docs/safety-model.md, "Skill tool surface narrowing".

## Install (activate a marketplace skill)

`clio-coder skills install` is the bridge from marketplace to runtime. It copies a
skill into a discovery root and stamps install provenance so Clio can load it.

```bash
# Project scope (default): copy into <repo>/.clio-coder/skills
clio-coder skills install context-handoff

# User scope: copy into the Clio config skills dir, available everywhere
clio-coder skills install clio-coder-dev --user

# Several at once, or a whole catalog group
clio-coder skills install context-prime context-handoff --user
clio-coder skills install --category git
```

Bare names resolve through the local marketplace (this catalog when run from
the repo, `CLIO_CODER_SKILL_CATALOG_DIR`, or the skill-marketplace.json index); an
existing local path always wins over a same-named marketplace entry.
`--category` installs every marketplace skill in one catalog group and is the
short form for the sets below; it reports each install separately and exits
nonzero if any of them failed.

### Which scope

Scope is about where the skill is true, not about how much you like it. A
skill that describes how *you* work belongs to your user config; a skill that
describes how *this repository* works belongs to the repository, where a
teammate cloning it gets the same behavior.

| Set | Scope | Why |
|---|---|---|
| `context-prime`, `context-handoff` | user | Session boundaries follow the operator across every repo; a handoff written in one project is read at the start of the next. |
| `find-skills`, `skill-craft` | user | Discovery and authoring are things you do to your toolkit, not things a project does. Installing `find-skills` at user scope is also what makes the Clio copy outrank the compat-root one. |
| `credentials` | user | Credential handling is a personal-machine discipline; a repo does not get to define it. |
| `clio-coder-dev`, `clio-coder-test` | project, in this repo only | They describe Clio's own source tree. Elsewhere they are noise. |
| `--category git` | project, where `git-master` is used | Branch, PR, and worktree conventions are the repository's, and the recipe binds them by name. |
| `--category research` | project, per project | An arXiv survey or a modernization oracle is scoped to the science being done, not to the person. |
| `--category planning` | project | PRD and architecture output lands in the repo and is reviewed there. |
| `--category coding` | project | `tdd` and `coding-standards` follow the language and the test seams of the checkout. |
| `--category workflow` | either | `grill-me` and `cut-it` travel with the operator; `design-council` is worth pinning per project when the project has recurring design forks. |

When both scopes carry the same name, project wins: `.clio-coder/skills` outranks the
user root, which outranks every compat root.

After install, confirm Clio sees it:

```bash
clio-coder skills list            # human view
clio-coder skills inspect context-handoff # full metadata + provenance
```

Installed copies are frozen; refresh them from their `source-url` provenance
with `clio-coder skills update <name>` or `clio-coder skills sync`. While developing a
catalog skill, load it directly without installing:
`clio-coder --skill skills/<category>/<name>/SKILL.md`.

Uninstall is just removing the copy: `rm -r .clio-coder/skills/<name>` (or the
user-scope equivalent). Installs never write outside `.clio-coder/skills` or the
user config skills dir, both of which are gitignored / outside the repo.

### Skill discovery and find-skills precedence

Clio ships [`find-skills`](meta/find-skills/) so that discovery and installation
both route through `clio-coder skills`. A community skill of the same name is
commonly present in the compat roots (`~/.agents/skills`,
`~/.claude/skills`) and drives the external `npx skills` installer, which
bypasses Clio. Compat roots stay enabled, and the loader resolves name
collisions by precedence: the Clio user root and `.clio-coder/skills` outrank the
compat roots. Install the catalog copy so it wins:

```bash
clio-coder skills install find-skills --user   # or --project for one repo
```

## Publishing: the marketplace index

`npm run skills:pin` writes two files. `registry.yaml` pins content hashes and
is what drift is measured against. `skill-marketplace.json` is the published
index: one entry per skill with `name`, `description`, `sourceUrl` (the
skill's own `clio.source-url`), `version`, `audit`, and `category`. It carries
no hashes, because duplicating them into a second published artifact only
creates a way for the two to disagree.

A Clio install anywhere points at it and gets bare-name installs from this
catalog:

```bash
export CLIO_CODER_SKILL_MARKETPLACE_INDEX=/path/to/skill-marketplace.json
clio-coder skills search worktree      # entries show (index, v0.2.0, audit: pass)
clio-coder skills install worktree-merge
```

Install then clones the repository named in that entry's `sourceUrl` and copies
the skill out of it, so the index is only as live as the branch its URLs name.
The catalog's `source-url` values all point at `main`; until a release branch
lands there, an install through the index fails naming the repository, the
branch, and the missing path. `npm run skills:check` fails if a skill's
`source-url` stops ending with its catalog path, which is how a skill moved
between categories cannot ship a stale pointer.

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
description: <one sentence>   # what it does, plus "Not for X; use Y" routing, <=1024 chars
triggers:                     # the phrases a user types that should reach it
  - <phrase>
version: 0.1.0
license: Apache-2.0
allowed-tools:                # optional; community-standard tool narrowing
  - read
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/<category>/<name>
  audit: pass                 # pass | warn | fail | unknown; reset to unknown on install
  provenance: designed        # designed | adapted | imported
  origin: <url or project>    # required when provenance is not "designed"
  eval-status: scenarios-recorded  # untested | scenarios-recorded | smoke-checked | eval-run
  model-size: any             # any (runs on ~30B local models) | large
  agents:                     # optional: shadow agents / recipes the body dispatches
    - researcher
---
```

Field semantics inside `clio:`:

- `registry-id` names the audited catalog a skill claims membership of; it is
  content, participates in the pinned hash, and survives installs.
- `source-url` and `audit` are install-lifecycle fields: `clio-coder skills install`
  rewrites `source-url` to the actual install source and resets `audit` to
  `unknown` because auditing is a human decision. Both are provenance-stripped
  before hashing.
- `provenance` records how the skill came to exist: `designed` here for Clio,
  `adapted` from an external skill (name it in `origin`), or `imported`
  near-verbatim.
- `eval-status` is honest test standing: `untested` (no scenarios),
  `scenarios-recorded` (evals.md scenarios written, not yet executed),
  `smoke-checked` (one representative scenario executed through
  `clio-coder skills eval` and the transcript showed the skill loading and driving
  its core behavior), `eval-run` (the full scenario set executed and passing;
  record the date in evals.md when setting this).
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

### Versioning policy

`version` describes the skill as a working instrument, and the pinned hash
already records every byte, so the version only moves when the thing an
operator runs changes:

| Change | Version |
|---|---|
| Body text, steps, completion criteria | minor bump |
| `allowed-tools` / `disallowed-tools` / `requires` | minor bump |
| `description` or `name` (what triggers it) | minor bump |
| Bundled `references/`, `scripts/`, `evals.md` scenarios | minor bump |
| `eval-status`, `audit`, `provenance`, `source-url` | no bump |
| Catalog reorganization that moves the folder | no bump |

Patch releases are for a correction that leaves the workflow identical, such as
a broken link or a typo in a step. Nothing in this catalog is 1.0: a major bump
is reserved for a skill whose triggers change enough that an operator relying on
the old one would be surprised.

Metadata changes do not bump because `registry.yaml` pins a
provenance-stripped hash, so content edits are already caught byte-exactly, and
raising a version for an `eval-status` line would make the number mean two
different things at once. The trade is deliberate: the version is coarse, the
hash is exact, and drift detection uses the hash.

## Claude Code interop

The invariant is that a catalog skill dropped unmodified into `.claude/skills`
loads and runs in Claude Code. Verified against Claude Code 2.1.231:
`skills/git/ship` copied into a scratch project's
`.claude/skills/`, invoked headlessly, loaded through the `Skill` tool and
answered a question about its own body. The `clio:` block is an unknown
frontmatter key there and is ignored.

**`allowed-tools` means the opposite thing in each harness, and that is the one
finding that shapes this section.** In Clio it narrows: after activation, calls
outside the declared surface are blocked with reason code `skill_surface`. In
Claude Code it grants: the parsed list is merged into
`toolPermissionContext.alwaysAllowRules.command`, which pre-approves those
tools for the turn. Nothing is denied there for being absent from the list.

Claude Code matches permission rules by exact string equality on the tool name,
through a four-entry alias table (`Task`, `KillShell`, `AgentOutputTool`,
`BashOutputTool`) with no case folding. Clio's tool names are lowercase
(`read`, `bash`, `web_fetch`), so none of them match a Claude Code tool. A
catalog skill's `allowed-tools` is therefore **inert** in Claude Code: it grants
nothing, denies nothing, and the skill loads and runs with whatever surface the
session already had.

That inertness is the safe outcome, and it is why the catalog keeps Clio tool
names rather than mapping them. Translating `bash` to `Bash` for
Claude-compatibility would not restrict anything; it would silently add `Bash`
to the always-allow rules of every session that loaded the skill. The same goes
for a `clio-coder skills export --for claude` lane, so there is no such lane. To keep
a well-meaning edit from introducing that, `npm run skills:check` fails on any
`allowed-tools` entry that is not a Clio tool name in canonical lowercase.

The rest of the surface, read from the same build:

| Key | Claude Code behavior |
|---|---|
| `name`, `description` | Read; description is trimmed, and a non-string one is dropped with a warning. No length limit is enforced at load. |
| `version`, `license` | Carried as metadata; `license` is unused. |
| `disable-model-invocation` | Honored, and accepts `true` or the string `"true"`. Matches Clio. |
| `allowed-tools` | Grants, as above. Accepts a YAML list or one comma/space-separated string, same as Clio. |
| `disallowed-tools` | Not read. A Clio denial is not enforced there. |
| `requires:` | Not read; ignored as an unknown key, so a dependency warning is Clio-only. |
| `clio:` | Not read; ignored as an unknown key. This is the invariant. |
| Unparseable frontmatter | The per-skill load is wrapped in a bare catch: the skill is skipped silently, with no diagnostic. Clio warns instead. |
| Size | No cap on SKILL.md. Clio rejects over 1 MiB and warns over 50 KiB, the activation delivery cap. |
| `references/`, `scripts/` subfolders | Not enumerated at load time; they are files the body tells the model to read, which works in both. |

Degradation summary for a catalog skill running under Claude Code: it loads,
its body drives the workflow, and its tool narrowing does not apply. A skill
whose safety argument rests on narrowing (`ast-grep` is search-only,
`ship` cannot edit source) is advisory there and enforced here.

## Contributing / approval

A skill is "approved for the marketplace" when a maintainer:

1. Reviews `SKILL.md` against [`skill-craft`](meta/skill-craft/) (trigger-only
   description, checkable completion criteria, progressive disclosure, pruning
   pass, evals present).
2. Confirms it carries the frontmatter spec above with `clio.audit: pass`.
3. Sets / bumps `version`.

Each skill ships an `evals.md` recording the baseline scenarios it was tested
against (RED-GREEN per [`skill-craft`](meta/skill-craft/)). `clio-coder skills eval <name>`
executes those scenarios instead of trusting the prose; the eval lane is the
curation gate for this catalog, not an end-user feature.

What the eval lane does and does not isolate, because a curation gate that
overstates its own rigor is worse than none. Each of the three arms (baseline,
treatment, judge) gets a private temp root with its workspace nested inside,
so `..` from a workspace reveals only that arm and the arms are no longer
adjacent, similarly-named siblings. The judge's copy of the treatment
transcript has the loaded SKILL.md body replaced with a marker, so a bullet
cannot pass on instructions the model merely read. But nothing confines a run
to its workspace: the write boundary is a per-run tool policy, not something a
harness can impose on a child process it spawns, and a full-auto arm has been
observed writing outside its workspace. Eval numbers are evidence about a
cooperative model, not an isolation guarantee. Run campaigns with `CLIO_CODER_*`
pointed at throwaway directories.

`npm run skills:pin` enforces this contract structurally: it refuses to pin a
catalog where any skill is missing the required frontmatter, `audit: pass`, or
its `evals.md`, declares a tool name Clio does not have, or carries a
`source-url` that no longer ends with its catalog path. `npm run skills:check`
(run in CI) fails on any drift between the catalog and either generated file,
`registry.yaml` or `skill-marketplace.json`. Pinned hashes are provenance-stripped
(install-lifecycle stamps like `installed-at` do not count as drift; content
and registry-identity edits do), so a copy installed via `clio-coder skills install`
still verifies against its audited source at activation.

A skill may declare typed dependencies with `requires: [skill:<name>, ...]`
frontmatter; the loader warns at load time when a required skill is not
installed, keeping composed workflows (for example a distilled skill that
references `credentials`) auditable instead of silently incomplete.
