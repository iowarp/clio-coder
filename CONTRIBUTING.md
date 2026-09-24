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
pnpm run build
pnpm run ci
```

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
| `pnpm run ci:release` | Qualify a candidate and its exact installed tarball (see [release checklist](CONTRIBUTING.md#validation-reference)). |

Use `pnpm test:file` (which preloads `tests/harness/tmp-root.ts`) and `tests/harness/scratch-env.ts` for state isolation. Never mutate `process.stdout.write` across async test boundaries.

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

1. Work on a focused branch (`fix/session-resume` or `feat/cli-inspect`).
2. Add focused contract tests exercising the changed behavior.
3. Keep commit subjects concise conventional commits (max 72 characters):
   ```text
   fix(session): preserve branch selection on resume
   docs: clarify worker permission scope
   feat(cli): add target inspection option
   ```
4. Verify `pnpm run ci` passes before requesting review.

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
