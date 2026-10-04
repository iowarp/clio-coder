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
| `pnpm run test` | Standard test suite (contracts + fast smoke tests). |
| `pnpm run ci` | Routine gate: types, lint, build, test, maintenance, and GUI checks. |
| `pnpm run test:full` | Full root test investigation, including extended regressions. |
| `pnpm run ci:release` | Qualify a candidate: static gates, the full root and GUI test tiers, the package audit, and its exact installed tarball. |
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

1. Work on a focused branch (`fix/session-resume` or `feat/cli-inspect`) cut from the current version branch, such as `v060` for 0.6.0. Open the pull request against that branch. `main` moves only when a release ships.
2. Add focused contract tests exercising the changed behavior.
3. Keep commit subjects concise conventional commits (max 72 characters):
   ```text
   fix(session): preserve branch selection on resume
   docs: clarify worker permission scope
   feat(cli): add target inspection option
   ```
4. Verify `pnpm run ci` passes before requesting review.

## Branches and Releases

- `main` is always the latest stable release and moves only by fast-forward.
- Development happens on the version branch, currently `v060`. The next patch line follows the same naming (`v061` for 0.6.1). Pull requests target that branch.
- Tags are immutable. A published tag is never moved or recreated.
- Release candidates are versioned `X.Y.Z-rc.N` and ship under the npm `beta` dist-tag. Users opt in with `clio-coder upgrade --channel=beta`.
- Patch releases (`0.6.1`, `0.6.2`) ship fixes after `0.6.0`.

A release is one dispatched run of `.github/workflows/release.yml`, and nobody pushes a tag by hand:

1. Commit the release version in `package.json` and `assets/acp-registry/agent.json`, and title the top `CHANGELOG.md` section `## X.Y.Z - YYYY-MM-DD`. Push the version branch.
2. Optionally rehearse: `pnpm run ci:release` qualifies the commit locally, and a push to a `ci-scratch-*` branch runs the same gates hosted.
3. Dispatch the workflow on the branch whose head is the release commit: `gh workflow run release.yml --ref v060 -f sha=<full sha>`. The run refuses a sha that is not that head and a version whose tag already exists.
4. The run executes every CI gate, then qualifies the exact package: the package audit and the installed-tarball suite. The full root and GUI test tiers (`test:full`, `test:gui:full`) run in the local `pnpm run ci:release`, not on the hosted runner.
5. Only then does the `release` job publish that qualified `candidate.tgz` to npm through trusted publishing with provenance, and create the `vX.Y.Z` tag and the GitHub release from the same file. Its sha256 is printed in the run summary, so the npm tarball and the release asset are the same bytes.
6. Fast-forward `main` to the released commit.

A failed gate leaves no tag and no published package; fix the branch and dispatch again. `npm publish` from a workstation stays guarded by the `prepublishOnly` preflight, which accepts only a commit that `pnpm run ci:release` qualified within the last 24 hours, and is a fallback, not the release path.

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

Hosted CI also requires the Node 22 installed-package gate on every configured push and pull request. Within a six-minute timeout, it builds, runs `npm pack` into a temporary directory, and runs `pnpm run test:package` with `CLIO_CODER_RELEASE_TARBALL` set to the absolute tarball path. Its result is required by `ci (22)`. The local `pnpm run ci` command remains the source gate; run the installed-package suite separately against a packed build.
