# Contributing to CLIO Coder

Thank you for helping. CLIO Coder is an open-source coding agent for scientific software, and it improves fastest when the people who use it on real research code say what worked and what did not. You do not need to be an expert in the codebase to contribute.

CLIO Coder is pre-1.0, so public interfaces can change between minor releases. User-visible changes belong in [CHANGELOG.md](CHANGELOG.md), participation follows the [Code of Conduct](CODE_OF_CONDUCT.md), and security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Ways to contribute

- **Report a problem or ask for a feature.** Inside CLIO Coder, `/report bug`, `/report feature` or `/report question` drafts the report, masks paths, host names and secrets, and shows you the exact text before anything is sent. `clio-coder report` does the same from a shell. You can also open an [issue](https://github.com/iowarp/clio-coder/issues/new/choose) by hand.
- **Ask a question.** Use [Discussions](https://github.com/iowarp/clio-coder/discussions/categories/help).
- **Share how a model or machine worked.** Local models, cluster login nodes and unusual terminals are where reports help most. Post in [Model and hardware reports](https://github.com/iowarp/clio-coder/discussions/categories/model-and-hardware-reports).
- **Fix the docs.** The guides under `docs/guide/` ship in the npm package and are what CLIO Coder reads to answer questions about itself, so a correction there reaches every user.
- **Change the code.** Start with the Quickstart below, keep the change focused, and open a pull request against the current version branch.

## Quickstart

**Requirements**:
- Node.js **22.19+**
- **pnpm 10.34.5** (pinned via `packageManager`)
- **ripgrep** (`rg`) and **fd** (`fd` or `fdfind`) on `PATH`
- Linux or macOS (Windows support is best-effort)

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

`hooks:install` adds pre-commit and pre-push guards that refuse any path `.gitignore` excludes, including one staged with `git add -f`. Keep private plans, prompts and notes under the ignored `.mine/`; `pnpm run lint` fails if an ignored path is ever tracked.

## Submitting Changes

1. Work on a focused branch (`fix/session-resume` or `feat/cli-inspect`) cut from the current version branch, which is `v` plus the digits of the `package.json` version, such as `v080` for 0.8.0. Open the pull request against that branch. `main` moves only when a release ships.
2. Add focused contract tests exercising the changed behavior.
3. Keep commit subjects concise conventional commits (max 72 characters):
   ```text
   fix(session): preserve branch selection on resume
   docs: clarify worker permission scope
   feat(cli): add target inspection option
   ```
4. Before requesting review, run `pnpm run typecheck`, `pnpm run lint`, focused `pnpm run test:file` runs for the behavior you changed and `pnpm run test` for the default contract list. `pnpm run ci` is release qualification, not a routine check.

## Validation Reference

| Command | Purpose |
| --- | --- |
| `pnpm run test:file -- tests/contracts/<test>.test.ts` | Run a focused source regression with the isolated state harness. |
| `pnpm run check` | Fast loop (a few seconds): `typecheck` and Biome errors at once. Run `lint` as well before you report. |
| `pnpm run typecheck` | Check TypeScript across source and tests with `tsrs --fast`, the Rust port of the TypeScript 7 checker; falls back to `tsc` where tsrs cannot run. See [Typechecking](#typechecking). |
| `pnpm run typecheck:tsc` / `pnpm run typecheck:compare` | Check with TypeScript's own `tsc` as the reference, or run both and fail if their diagnostics differ. Use them when `typecheck` reports something surprising or stays silent about a type error you expect. |
| `pnpm run lint` | Check formatting, source boundaries, local catalog pins and package hygiene. |
| `pnpm run check:gui` | Check GUI browser/server TypeScript and lint rules. |
| `pnpm run build` | Build `dist/` without emptying it: the previous build's chunks stay so a running CLIO Coder from this tree keeps working, and chunks no live process needs are pruned afterwards. |
| `pnpm run build:release` | Clean build: empties `dist/` first. Use it for packaging, never in a tree another session runs from. |
| `pnpm run test` | Compact source-based behavior checks; no build required. |
| `pnpm run ci` | Local candidate qualification, reused for the same clean commit. |
| `pnpm run test:full` | Full root test investigation, including extended regressions. |
| `pnpm run ci:release` | Same local qualification as `ci`; full investigation remains manual. |
| `pnpm run release:readiness` | Read-only package, website/docs provenance, and media readiness check; use `-- --release` only for an immutable candidate. |

Use `pnpm test:file` (which preloads `tests/harness/tmp-root.ts`) and `tests/harness/scratch-env.ts` for state isolation. Never mutate `process.stdout.write` across async test boundaries.

## Typechecking

`pnpm run typecheck` runs [tsrs](https://github.com/oxc-project/tsrs), a Rust port of the TypeScript 7 checker, in `--fast` mode: about a second where `tsc` takes several. tsrs is a development dependency only and is not in the published package. Where tsrs cannot run, such as on win32-arm64 (no native package), after an install without optional dependencies, or when it crashes, the command prints `typecheck: using tsc, the slower reference compiler, because ...` and checks with `tsc` instead. `CLIO_CODER_TYPECHECK=tsc` forces that path. The exit code is the checker's: tsrs exits 2 and `tsc` exits 1 or 2 on type errors.

`tsc` stays authoritative:

- Release preparation (`pnpm run ci` and the `prepare` job) runs `pnpm run typecheck:compare`, so the gate is `tsc`'s verdict, and it also fails when tsrs reports anything different.
- `tests/contracts/typecheck-corpus.test.ts` (core tier) holds `tsc`, tsrs and `tsrs --fast` to the diagnostics recorded in `tests/fixtures/typecheck-corpus/expected.txt`. The corpus injects errors under the options CLIO Coder relies on: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, NodeNext `.js` specifiers, `paths` aliases, JSON modules, `isolatedModules`, TSX and declaration emit. It also covers the `file(line,col): error TSnnnn:` output agents parse, and the fallback.
- The GUI keeps its own `tsc` in `pnpm run check:gui`.

**Version pairing.** The root's reference compiler, `@typescript/native`, is the TypeScript release that tsrs ports: `tsrs.typescriptVersion` in `node_modules/tsrs/package.json`. The corpus test fails when they differ. Bump both in one commit, refresh the record with `TYPECHECK_CORPUS_WRITE=1 pnpm run test:file -- tests/contracts/typecheck-corpus.test.ts`, review the `expected.txt` diff, then run `pnpm run typecheck:compare`.

**When tsrs and tsc differ, `tsc` is right** until proven otherwise:

1. The change is judged by `tsc`'s diagnostics.
2. Reduce the difference to a minimal case and file it at [oxc-project/tsrs](https://github.com/oxc-project/tsrs/issues). The project takes issues, not pull requests.
3. If only `--fast` differs, drop `--fast` in `scripts/typecheck.mjs`. Otherwise set `typecheck` back to `tsc -p tsconfig.tests.json`, which leaves the `--fast` speed behind but changes nothing else.
4. Add the case to the corpus in the commit that moves to a tsrs release that fixes it.

**Trial.** tsrs is on trial as the default until 0.8.1 ships. It stays the default only if no qualification in that period reports a difference that the rule above did not resolve. `tsc` remains the release gate after the trial.

## GUI development

Run the API server and browser client in separate terminals. The API listens on
4317 and Vite on 4318; open the printed access link on the Vite port.

```bash
pnpm --filter @iowarp/clio-coder-gui dev:server
pnpm --filter @iowarp/clio-coder-gui dev:client
pnpm run check:gui
pnpm --filter @iowarp/clio-coder-gui test:full
```

The root build supplies both the CLI and `dist/gui/client`; the source server can
use that client build. Rebuild after changing the shared configure wizard: GUI
setup hosts a fixed `configure --gui-host` child through `server/process-policy.ts`.
The browser presents typed prompts; the CLI retains provider I/O, credential
storage, model checks, and settings writes. Keep setup replies out of operation,
conversation, and lifecycle logs. Validate first-run changes with isolated
`CLIO_CODER_HOME` and a local model fixture.

## Architecture Boundaries

The lint suite enforces the boundary rules `rule1` to `rule17` in `tests/boundaries/check-boundaries.ts`. The main invariants:
1. Only `src/engine/**` may import `@earendil-works/pi-*` packages (including type imports).
2. Worker imports from domains are type-only except for declared provider rehydration seams.
3. Domains communicate exclusively via contracts and events; do not cross-import another domain's `extension.ts`.
4. `src/tools/**` must not import the interactive UI.
5. Turn-runtime modules must not import `src/entry/**`; entry points compose dependencies.
6. Preserve the protected instant-shell import graph and its declared entry seams.

See [architecture invariants](docs/architecture/architecture.md#boundary-invariants) for details. Keep CLI subcommands dynamically imported to preserve fast `--help` and startup.

## Library & Skills

`library/` contains five package kinds: **skill, agent, prompt, fleet, and plugin** (see [library guide](library/README.md)).

```bash
clio-coder library validate <package-path> --json
clio-coder library register <package-path> --project
clio-coder library install <kind>:<name> --project
```

When modifying bundled packages or curated skills, verify and update pins:

```bash
pnpm run library:pin && pnpm run library:check
pnpm run skills:pin && pnpm run skills:check
```

## Developing with Agents

Source code, TypeScript types, and schemas are authoritative. Prefer `rg` and targeted source reads over lengthy prose documentation. Do not invent commands, configuration settings, or benchmark numbers.

## For maintainers

The rest of this page is the maintainers' reference for branches, releases and the README layout. A contributor opening a pull request does not need it.

### Branches and Releases

Development happens on the version branch, currently `v084`. Keep local
and remote version branches synchronized with ordinary pushes. `main` moves
only by fast-forward when a stable release completes. Published tags and npm
versions are immutable. The completed stable release deletes its version branch;
create the next version branch from the released `main` when development resumes.

A stable release means the same qualified version is available on npm and
GitHub, `main` points to its source commit, and the public website serves its
prepared docs and installers. There is no atomic transaction across these
services: publish npm first, then the GitHub tag/release, then promote `main` and
`gh-pages`. A partial failure is resumed with the original artifact. Never move
a published tag, rebuild a published candidate, or republish different bytes.

Pushes and pull requests launch no Actions runs. Qualification is deliberate;
the required check names remain `ci (22)` and `ci (24)`. Development qualification
accepts an `Unreleased` changelog and prepares an isolated website preview from
the candidate version. Publication separately requires a final version, dated
nonempty release notes, and matching committed website metadata. Full
investigation also limits concurrent test files to two so subprocess fixtures
do not compete with hundreds of cold boots. One manual `ci.yml` run
checks source, builds and packs once, tests selected root/GUI behavior and the
installed package on Node 22, runs the same tests and boot on Node 24, and
publishes no result unless both pass. Its immutable
`candidate-<sha>` artifact includes the versioned npm tarball, SHA-256 receipt,
four installers extracted from that archive, release notes, and a prepared
website. `results-<sha>` and `results24-<sha>` record the actual test counts. The development defaults select the root and GUI files listed in `scripts/ci-tests.mjs`; package and runtime
checks remain part of explicit qualification. `pnpm run test:list` lists every selected
file and every contract/GUI file reserved for full investigation. Redundant
prose and appearance-specific tests are retired with maintainer approval. `test:full`, `test:gui:full`, and maintenance checks stay manual.

Release with one command in a visible terminal:

```bash
pnpm run release -- --check      # read-only readiness report; needs no terminal and writes nothing
pnpm run release                 # the release
pnpm run release -- --platforms  # the release, with Windows and macOS boots added to its CI run
```

`scripts/release.mjs` is the only release driver. It never pushes before every
local gate is green, and every remote write asks for a typed phrase such as
`push v084` or `publish @iowarp/clio-coder@0.8.4`. One release command runs per
clone at a time, under a lock in
`$(git rev-parse --git-common-dir)/clio-release/`. Qualification and packing
refuse `/tmp` and `TMPDIR` paths longer than 40 characters; export a short
private one such as `TMPDIR=$HOME/.cache/cr`.

Before releasing, set the agreed version consistently in `package.json`, the GUI
manifest, `assets/acp-registry/agent.json`, and both `version` and
`publishedVersion` in `site/product.json`. Add dated release notes in
`CHANGELOG.md` and update version references such as the README source-install
command. Commit the candidate on the version branch. The command refuses a dirty
tree or inconsistent versions; it does not invent release notes or bump versions.

The command then runs these steps in order:

1. Readiness, in seconds. `pnpm run preflight -- --release` checks versions, the
   dated changelog heading and nonempty notes, release readiness, the size
   budgets the source tree decides, and the local tools. The command then checks
   that `gh` is authenticated, that `npm whoami` answers, that `origin/main` is
   an ancestor of the candidate, and that tag `v<version>` is free or already at
   the candidate. Every problem is listed at once and nothing has been built or
   pushed. `--check` stops here after printing whether a local qualification
   and a `ci.yml` run already exist for the commit.
2. Local qualification, without confirmation because it writes nothing remote.
   `scripts/release-candidate.mjs qualify` builds and packs once, then tests the
   package and boots an installed copy on Node 22 and 24 at once, under the same
   time zone, locale and pinned `rg` and `fd` as CI. A passed qualification of
   the same commit is reused. It uses this process's Node for its own major and
   `nvm`'s newest install of the other. This step is skipped when a `ci.yml`
   run of the commit already exists.
3. Push and CI. After the phrase `push <branch>`, the command pushes the version
   branch and dispatches one `ci.yml` run for the exact commit, then watches it.
   An existing run of the commit is used instead: an unfinished one is watched,
   a failed one has its failed jobs rerun on confirmation, and a successful one
   is reused if its `candidate-<sha>`, `results-<sha>` and `results24-<sha>`
   artifacts are still live.
4. Verification of the CI artifact. The command downloads the three artifacts,
   runs `release-publish.mjs verify` against the run, and runs npm's own dry
   run of the qualified tarball under the release's dist-tag. The published
   bytes are always the CI artifact, never a local pack.
5. npm, by the owner. After the phrase `publish <name>@<version>`, the command
   runs `npm publish` on the qualified tarball in the terminal so npm's
   two-factor prompt works. If npm already serves the same bytes it publishes
   nothing; different bytes stop the release. An accepted publish is recorded,
   so it is never offered twice while npm propagates.
6. GitHub, with the owner's approval. After the phrase `release v<version>`, the
   command dispatches `release.yml` and watches it. **The owner approves the
   protected `release` environment in GitHub.** Agents leave the npm publish
   and this approval to the owner. The release job waits for npm to serve the
   exact bytes, creates or repairs the draft, pins it to the candidate, uploads
   the versioned tarball and four installers, and publishes the tag and release.
   A stable release becomes Latest, fast-forwards `main`, commits the prepared
   site to `gh-pages`, and deletes the remote version branch.
7. Closeout. The command offers to forward the npm dist-tags that fell behind
   (`beta` and `dev` after a stable release, `dev` after a prerelease), then to
   fast-forward local `main` and, when `origin/main` is the candidate, delete
   the finished local version branch.

A version with a prerelease suffix, such as `0.8.4-rc.0`, goes to npm's `beta`
dist-tag and a GitHub prerelease that is not Latest; the suffix alone selects
this. Its approval covers only the tag and prerelease, so `main`, the site and
the version branch stay as they are. A stable version goes to `latest`.

For retries, run the command again. Readiness is checked again, the `ci.yml`
run of the commit and the qualified bytes on npm are reused, and a new
`release.yml` run is dispatched, whose job repairs draft GitHub assets and
completes only the steps still open. If an artifact expires, prepare a new
candidate commit; do not rebuild a previously qualified commit. A different npm
integrity or tag commit stops the operation.

The command always releases the checked-out head. If a release-tooling bug
appears after npm accepted the version, the owner finishes by dispatching
`release.yml` by hand for the published candidate. Once npm serves it, the
workflow may finish from a version-branch head that adds only release-tooling
files (`scripts/release*.mjs`, `scripts/release/`, `release.yml`,
`tests/contracts/release-*.test.ts`). With other later commits, `mode: finish`
requires npm to already serve the exact qualified bytes and the candidate to be
an ancestor of the branch head, completes only the tag, GitHub release, main
and website steps still open, never republishes, and leaves the version branch
in place. The tag, tarball and website still come from the candidate.

`pnpm run release:rehearse` is optional and not part of a routine release. Use
it after changing release tooling or workflows. It qualifies locally, pushes
the commit to a temporary `rehearse/*` branch after a typed phrase, runs one
`ci.yml` run with the publisher's rehearsal jobs (`--platforms` adds the
Windows and macOS boots), then cancels its unfinished runs and deletes the
branch. It starts from a version branch, accepts a development version and an
`Unreleased` changelog, and changes no package, tag, `main` or site. Prove Windows changes on a native Windows clone with
`core.autocrlf=false` before pushing them.

#### Owner configuration

On npm, a GitHub Actions trusted publisher is configured for
`iowarp/clio-coder`, workflow filename `release.yml`, environment `release`.
Its OIDC exchange currently returns 404, so CI neither publishes nor writes
dist-tags. The owner publishes with npm two-factor authentication inside
`pnpm run release`, and those versions carry no provenance. Dev snapshots are
refused until trusted publishing works, because their bytes exist only inside
CI. A rehearsal cannot prove npm's authorization without publishing a new
version. Do not claim it is verified by `npm publish --dry-run`.

On GitHub, the `release` environment needs the owner as required reviewer.
Leave Prevent self-review unchecked if the owner also dispatches releases.
Keep the Tag rule `v*` and add a **Branch** deployment rule
`v[0-9][0-9][0-9]` so publication from a version branch such as `v080` can reach the approval gate.
An agent authenticated with the owner's admin credentials could technically
approve or bypass the gate. A strict owner-only boundary requires separate
agent credentials and disabling administrator bypass.

Create a GitHub App with **Contents: read/write**, **Workflows: read/write**,
and **Actions: read**, with webhooks disabled, and install it on this repository
only. Workflows permission permits main promotion containing workflow changes;
Actions read verifies the qualification. Put its App ID in the protected
`release` environment variable `RELEASE_APP_ID` and its private key in the
protected environment secret `RELEASE_APP_PRIVATE_KEY`. No npm token is stored.
The publishing job mints an expiring installation token after owner approval.
The App's `gh-pages` push triggers the existing Pages deployment;
`GITHUB_TOKEN` pushes do not.

Allow this App to create `v*` release tags and perform the release fast-forward
of main. Keep rules prohibiting tag updates/deletions, non-fast-forward main
updates, and main deletion. If one ruleset mixes tag creation with immutability,
split it so the App bypasses creation restrictions only. Likewise isolate a
main pull-request requirement from structural protections before granting the
App a release-promotion bypass. Preserve `ci (22)` and `ci (24)` as required
checks. The release promotion does not satisfy them on main: the owner publishes
the qualified tarball to npm inside `pnpm run release`, `release.yml` verifies
that npm serves those exact bytes and that the manual qualification run passed
`ci (22)` and `ci (24)` on the commit, and the App then fast-forwards main
through its ruleset bypass.
Never grant an App blanket bypass of published-tag immutability.

Workflow changes can be committed and rehearsed on the version branch without
publishing. Decide the next release's product scope and version metadata when the
owner asks to cut it.

Manual qualification tests the actual archived package under isolated homes. Release
publication consumes that artifact and its successful qualification record;
there is no second build or test run in the publishing workflow.

### README contract

The README is the GitHub and npm landing page. Keep installation, capabilities,
interface captures, model choices, and references easy to scan. Details belong
in the guides; command-heavy material and agent orientation use foldable blocks.

- Open with a hero: what CLIO Coder is in one sentence, one supporting line, a
  capture of it working, and the one-line install. Use absolute HTTPS image
  URLs so npm can render them.
- Sections, in order: Why CLIO Coder, Built for science and HPC, New in
  (the current release), Get started, What you can do, Models, Interfaces,
  Safety and control, No call-home, For AI agents, Documentation, Contribute
  and get help, Acknowledgements.
- Keep the release-tag source installation under Get started, including launcher
  path verification. Release chronology belongs in `CHANGELOG.md`. While a
  release candidate is out, a note under the install commands says which
  version they install and how to get the candidate; drop it at the stable
  release.
- Keep the **For AI agents** section exact and machine-friendly: commands that
  run as written, the `run` flags and exit codes, the files to read, and what
  to leave to the human.
- Update this layout contract when changing the landing page structure.
  Routine hygiene checks installation correctness and links, not editorial layout.
