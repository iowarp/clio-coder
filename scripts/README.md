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
| `pnpm herdr:pin` | Fetch and verify the selected Herdr release and its schema. |
| `pnpm hooks:install` | Install guards against committing ignored files. |
| `pnpm install:local --dry-run` | Preview checkout installation. Actual installation can build, replace the launcher and run local repair. |
| `sh scripts/install.sh --dry-run` | Preview the Unix managed installer, which accepts Clio 0.6.0 or newer. Actual installation downloads and activates a package. |
| `pnpm release:readiness` | Check public versions, documentation provenance, media and an isolated website build. |
| `pnpm ci` / `pnpm ci:release` | Qualify one candidate package and website artifact; reuse qualification for the same clean commit. |
| `pnpm release:rehearse` | Exercise qualification/publication checks without publishing a package or release. Uses a temporary remote branch with explicit interactive approval. |
| `pnpm release` | Qualify, publish npm as the owner, request protected GitHub publication, then offer owner dist-tag forwarding and local cleanup. |
| `node --import tsx scripts/decision-probe.ts <fixture> --engine <name>` | Calibrate a System One binding against labeled fixtures. Calls the selected engine; reports results to stdout/stderr without changing settings. Explicit operator use only. |

CI consumes one prepared artifact for the required `ci (22)` and `ci (24)`
checks. The release workflow verifies that npm already serves those exact bytes
before creating the GitHub tag/release and promoting stable public surfaces.
Npm publication and dist-tag writes remain in the owner's interactive command
while trusted publishing is unavailable. Dev snapshots remain disabled.

Keep disposable output in a uniquely owned directory under
`/home/akougkas/clio-gym/tmp/`, `scratch/`, or `install-tests/`, and set `TMPDIR`
before running commands that create temporary files. Never use system `/tmp`
or commit run output under `scripts/`. Retired local benchmark and smoke scripts
remain recoverable from Git history.
