# Contributing to Clio Coder

Clio Coder welcomes contributions. Clio is pre-1.0 software; public interfaces may evolve between minor releases. User-visible changes belong in [CHANGELOG.md](CHANGELOG.md), participation follows the [Code of Conduct](CODE_OF_CONDUCT.md), and security disclosures follow [SECURITY.md](SECURITY.md).

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
pnpm run ci
```

`hooks:install` adds pre-commit and pre-push guards that refuse any path `.gitignore` excludes, including one staged with `git add -f`. Keep private plans, prompts and notes under the ignored `.mine/`; `pnpm run lint` fails if an ignored path is ever tracked.

## Validation Reference

| Command | Purpose |
| --- | --- |
| `pnpm run test:file -- tests/contracts/<test>.test.ts` | Run a focused source regression with the isolated state harness. |
| `pnpm run typecheck` | Check TypeScript across source and tests. |
| `pnpm run lint` | Check formatting, architecture boundaries, Pi surface, and hygiene invariants. |
| `pnpm run check:gui` | Check GUI browser/server TypeScript and lint rules. |
| `pnpm run test` | Selected user-visible contracts and boot smokes. |
| `pnpm run ci` | Local candidate qualification, reused for the same clean commit. |
| `pnpm run test:full` | Full root test investigation, including extended regressions. |
| `pnpm run ci:release` | Same local qualification as `ci`; full investigation remains manual. |
| `pnpm run release:readiness` | Read-only package, website/docs provenance, and media readiness check; use `-- --release` only for an immutable candidate. |

Use `pnpm test:file` (which preloads `tests/harness/tmp-root.ts`) and `tests/harness/scratch-env.ts` for state isolation. Never mutate `process.stdout.write` across async test boundaries.

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

The lint suite enforces 6 boundary invariants:
1. Only `src/engine/**` may import `@earendil-works/pi-*` packages (including type imports).
2. Worker imports from domains are type-only except for declared provider rehydration seams.
3. Domains communicate exclusively via contracts and events; do not cross-import another domain's `extension.ts`.
4. `src/tools/**` must not import the interactive UI.
5. Turn-runtime modules must not import `src/entry/**`; entry points compose dependencies.
6. Preserve the protected instant-shell import graph and its declared entry seams.

See [architecture invariants](docs/architecture/architecture.md#boundary-invariants) for details. Keep CLI subcommands dynamically imported to preserve fast `--help` and startup.

## Submitting Changes

1. Work on a focused branch (`fix/session-resume` or `feat/cli-inspect`) cut from the current version branch, such as `v062` for 0.6.2. Open the pull request against that branch. `main` moves only when a release ships.
2. Add focused contract tests exercising the changed behavior.
3. Keep commit subjects concise conventional commits (max 72 characters):
   ```text
   fix(session): preserve branch selection on resume
   docs: clarify worker permission scope
   feat(cli): add target inspection option
   ```
4. Verify `pnpm run ci` passes before requesting review.

## Branches and Releases

Development happens on the public version branch, currently `v062`. Keep local
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
installed package, and boots that same archive on Node 24. Its immutable
`candidate-<sha>` artifact includes the versioned npm tarball, SHA-256 receipt,
four installers extracted from that archive, release notes, and a prepared
website. `results-<sha>` records actual test counts. The default budget is 2000
tests including runtime/platform boots. `pnpm run test:list` lists every selected
file and every contract/GUI file reserved for full investigation. No test files
are deleted. `test:full`, `test:gui:full`, and maintenance checks stay manual.

Run the interactive command in a visible terminal:

```bash
pnpm run release:rehearse
pnpm run release
```

Both commands explain their next action and ask before proceeding. Rehearsal
uses a temporary `ci-scratch-*` branch, calls the actual publisher's validation
path, and removes the branch afterward. It makes no npm, tag, release, main,
or website changes. Add `-- --platforms` to request Windows and macOS boots;
their queues do not block the two required check results. Prove Windows changes
on a native Windows clone with `core.autocrlf=false` before pushing them.

To cut a release:

1. Set the agreed version consistently in `package.json`, the GUI manifest,
   `assets/acp-registry/agent.json`, and both `version` and `publishedVersion`
   in `site/product.json`. Add dated release
   notes in `CHANGELOG.md` and update version references such as the README
   source-install command. Commit the candidate on the version branch. The
   script refuses a dirty tree or inconsistent versions; it does not invent
   release notes or silently bump versions.
2. Run `pnpm run release`. Before a new push it runs local qualification once.
   It synchronizes the branch and dispatches one hosted qualification. A
   successful manual qualification on the exact commit with unexpired artifacts
   is reused instead of rerunning its checks. Artifacts are retained for 30 days.
3. Review the candidate receipt, qualification link, package digest, and test
   count. The script requests publication through `release.yml` and prints the
   run URL. **The owner approves the protected `release` environment in GitHub.**
   Agents must leave this approval to the owner. Approval authorizes the whole
   public closeout; no terminal npm login or manual publish is needed.
4. After approval, the publisher downloads the existing artifact, verifies its
   checksums, exact successful source run, version, branch head, and main
   ancestry. It does not install project dependencies, build, pack, or test.
   npm trusted publishing mints a short-lived identity and supplies provenance.
   Only after npm accepts the exact bytes does GitHub create the tag/release
   with the versioned tarball and four installers. Stable releases become Latest.
5. The publisher fast-forwards `main`, commits the prepared site output to
   `gh-pages`, and lets GitHub's existing branch-based Pages deployment run.
   It verifies npm integrity and dist-tag, the GitHub tag/assets/Latest, main,
   and the public website before deleting the remote version branch. The
   website is prepared from the exact commit snapshot before approval; its
   `docsCommit` and `revision` identify that immutable source commit.
6. The interactive command offers to fast-forward clean local `main`, detach
   the completed version worktree, and delete the finished local branch.

For retries, rerun the failed publication jobs or run `pnpm run release` again
with the same qualification. Matching bytes already on npm are reused; draft
GitHub assets can be repaired; main/site closeout can resume. A different npm
integrity or tag commit stops the operation. If an artifact expires, recover the exact archived bytes or prepare a new
candidate commit; do not silently rebuild a previously qualified commit. Prereleases use npm `beta` and a GitHub
prerelease, and keep the development branch, stable `main`, and stable site.

### Owner configuration

On npm, configure a GitHub Actions trusted publisher for `iowarp/clio-coder`,
workflow filename `release.yml`, environment `release`. Enable direct npm
publish. Separate dist-tag management permission is unnecessary: publication
sets `latest` or `beta`. OIDC supports publishing an archive produced by a
previous qualification run; it authenticates the publishing job, not the build.
A rehearsal cannot prove npm's authorization or provenance without publishing
a new version. Do not claim those are verified by `npm publish --dry-run`.

On GitHub, the `release` environment needs the owner as required reviewer.
Leave Prevent self-review unchecked if the owner also dispatches releases.
Keep the Tag rule `v*` and add a **Branch** deployment rule
`v[0-9][0-9][0-9]` so publication from `v062` can reach the approval gate.
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
checks; those results already passed on the source commit being promoted.
Never grant an App blanket bypass of published-tag immutability.

Workflow changes can be committed and rehearsed on the version branch without
publishing. Decide the next release's product scope and version metadata when the
owner asks to cut it.

## README contract

The README is the GitHub and npm landing page. Keep installation, capabilities,
interface captures, model choices, and references easy to scan. Details belong
in the guides; command-heavy material and agent orientation use foldable blocks.

- Sections: Get started, Interfaces, Capabilities, Models, Execution policy,
  Documentation, Contribute, Acknowledgements.
- Show the terminal boot, browser overview, and browser conversation captures
  from `assets/screenshots/`. Image URLs are absolute HTTPS URLs so npm can render them.
- Keep the release-tag source installation under Get started, including launcher
  path verification. Release chronology belongs in `CHANGELOG.md`.
- Keep a collapsed **For agents** block under Documentation with source and
  installed-documentation lookup guidance.
- Update this layout contract and `README_SECTIONS` in `scripts/check-hygiene.ts`
  together when changing the landing page structure.


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

Manual qualification tests the actual archived package under isolated homes. Release
publication consumes that artifact and its successful qualification record;
there is no second build or test run in the publishing workflow.
