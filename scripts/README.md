# Repository tooling

These tools build the checkout, check source and package contents, maintain
catalogs, install Clio, and qualify or publish a release. The four installers
named in `release-manifest.json` also ship in the npm package.

| Command | Purpose and effects |
| --- | --- |
| `pnpm build` / `pnpm dev` | Build the application and its codemap; dev watches source changes. |
| `pnpm lint` | Check formatting, source boundaries, local catalog pins, resource paths and configuration consistency. No remote package refresh. |
| `pnpm test` / `pnpm test:gui` | Run the compact source-based behavior selections in `ci-tests.mjs`. |
| `pnpm test:file -- <path>` | Run a focused root test with isolated Clio state. |
| `pnpm test:full` / `pnpm test:gui:full` | Run historical investigation suites explicitly. Root full tests require a current build. |
| `pnpm test:package` | Exercise the installed package explicitly. |
| `pnpm library:check` / `pnpm skills:check` | Verify local catalog content and generated projections against committed pins. |
| `pnpm library:pin` / `pnpm skills:pin` | Refresh generated catalogs. Library pinning also fetches blessed remote packages. |
| `pnpm pi:surface-diff` / `pnpm pi:surface-snapshot` | Review consumed Pi declarations or refresh their snapshot during dependency maintenance. |
| `pnpm run check` | Run `typecheck` and Biome (errors only) at once: the few-second loop before `pnpm run lint`. |
| `pnpm run typecheck` / `pnpm run typecheck:tsc` / `pnpm run typecheck:compare` | Typecheck source, tests and scripts with the Rust port `tsrs --fast` (the default, about 1 s, falling back to `tsc` with a notice where tsrs cannot run), with TypeScript 7's own `tsc` as the reference (about 6 s), or run both over the same project and fail if their diagnostics differ; release preparation runs the last. See "Typechecking" in `CONTRIBUTING.md`. |
| `pnpm herdr:pin` | Fetch and verify the selected Herdr release and its schema. |
| `node scripts/build-windows-launcher.mjs --verify-pins` / `--check` / `--write` | Check the committed native Windows launchers (installed as the git shim's `git.exe` and the installer's `clio-coder.exe`) against `assets/windows-launcher/pins.json`; rebuild them from `assets/windows-launcher/launcher.c` with the pinned zig and compare byte for byte; or rebuild them and rewrite the pins. `--check` and `--write` download zig into `TMPDIR` unless `--zig <path>` names one. |
| `pnpm hooks:install` | Install guards against committing ignored files. |
| `node scripts/export-github-wiki.mjs --from <wiki> --to <checkout>` | Render a complete generated wiki into a GitHub wiki checkout, replacing its pages. It refuses partial generations, broken links and private material, and never commits or pushes. |
| `pnpm install:local --dry-run` | Preview checkout installation. Actual installation can build, replace the launcher and run local repair. |
| `sh scripts/install.sh --dry-run` | Preview the Unix managed installer, which accepts Clio 0.6.0 or newer. Actual installation downloads and activates a package. |
| `pnpm release:readiness` | Check public versions, documentation provenance, media, the Windows launcher pins and an isolated website build. |
| `pnpm ci` / `pnpm ci:release` | Qualify one candidate package and website artifact; reuse qualification for the same clean commit. |
| `pnpm release:rehearse` | Exercise qualification/publication checks without publishing a package or release. Uses a temporary remote branch with explicit interactive approval. |
| `pnpm release` | Qualify, publish npm as the owner, request protected GitHub publication, then offer owner dist-tag forwarding and local cleanup. |
| `node --import tsx scripts/decision-probe.ts <fixture> --engine <name>` | Calibrate a System One binding against labeled fixtures. Calls the selected engine; reports results to stdout/stderr without changing settings. Explicit operator use only. |

CI consumes one prepared artifact for the required `ci (22)` and `ci (24)`
checks. The release workflow verifies that npm already serves those exact bytes
before creating the GitHub tag/release and promoting stable public surfaces.
Npm publication and dist-tag writes remain in the owner's interactive command
while trusted publishing is unavailable. Dev snapshots remain disabled.

Keep disposable output in a uniquely owned scratch directory outside the checkout,
and set `TMPDIR` to it before running commands that create temporary files. Never
use system `/tmp`
or commit run output under `scripts/`. Retired local benchmark and smoke scripts
remain recoverable from Git history.
