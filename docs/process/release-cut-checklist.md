# Release-Cut Checklist

Qualify one committed candidate and its exact npm tarball. Publication uses a fast
preflight of that evidence. Development investigations are separate and are never
implicitly repeated by a publish lifecycle hook.

## Prepare locally

1. Inspect `git status --short --branch`. Preserve operator work. Use one local
   candidate branch; do not push main, candidate branches, or tags without authorization.
2. Set the approved version in `package.json` and `assets/acp-registry/agent.json`,
   date the matching top changelog section, and align the README install tag.
3. Commit all candidate changes. Qualification refuses tracked or untracked source
   changes. Ignored operator files are not candidate inputs; ignored `dist/` bytes
   are verified through the actual npm package.
4. Install once with `pnpm install --frozen-lockfile`. Record cold installation time
   separately when comparing hosted gate times.

## Working-tree pre-release checks

Before the final candidate is committed, use the existing development commands:

```bash
pnpm run ci
node scripts/check-release.mjs
pnpm run test:package
```

The graphical application in `apps/clio-coder-gui` is not bundled by this release
and none of these gates build or check it. It keeps its own gate, listed under
optional development investigations below.

Run relevant extended provider, configuration, and terminal checks when those
surfaces changed. These working-tree results prepare a candidate; they do not
create the publication qualification receipt. Do not invoke `ci:release` on a
dirty tree: it requires a clean commit and invalidates the previous receipt before
checking the source. Qualify again after the remaining implementation work is
finished and the final candidate is committed.

For v0.5.0, inspect configure and `/settings` navigation, effective-settings
privacy, footer diagnostics, passive target discovery, explicit reasoning/tool
qualification, and direct/gateway cancellation and lifecycle behavior. Treat live
provider smokes as resource-consuming checks and coordinate server access. A
metadata listing does not prove tool correctness, full-context capacity, or GPU
residency. Keep platform coverage and unresolved process-isolation limitations
explicit; a successful smoke is not evidence of OS containment.

## Qualify the candidate

```bash
pnpm run ci:release
```

This runs:

- The routine gate: root types, lint/hygiene and library pins, one build, core
  safety/session/provider/accounting/extension contracts, three real CLI/ACP/process
  smoke files, and the web authentication and runtime boundary tests.
- Web TypeScript checks and the shipped dependency advisory/package audit.
- One exact npm tarball install with normal lifecycle scripts, installed resources,
  lazy chunks, CLI and extension/library behavior, both web workers and a real Chrome
  boot/reconnect against that installed server.
- Native invocation timing with delayed real HTTP headers, durable call timing and
  eval first-call selection.

No real model, npm login or publication occurs. An unavailable registry or advisory
service fails qualification. Chrome must be installed at `/usr/bin/google-chrome` on
Linux. Windows subprocess semantics have a separate narrow CI lane; a Linux pass is
not evidence of a full Windows or macOS pass.

The command prints the qualified SHA, tarball path and SHA-256. Evidence lives outside
the checkout under `~/.cache/clio-coder/qualification/<checkout-id>/`, bounded to one
candidate per checkout. Starting qualification deletes the earlier receipt. A failed
or cancelled run cannot leave an older qualification available for publication.
Qualification also repacks after testing and refuses changed package bytes.

Do not run the full suite, rebuild, repack for manual installation, or repeat the
routine gate afterward. Relevant development regressions should be exercised while
implementing the change, before qualifying the final committed candidate.

## Review and authorize remote changes

Present the exact commit, package digest, verification results and release notes.
Every remote main/tag update, GitHub release and npm publication requires explicit
maintainer authorization.

After authorization, fetch origin, check that `origin/main` is an ancestor of the
candidate, and fast-forward local main. Verify the SHA is unchanged. Fetch once more
and stop on unexpected remote movement before pushing only main. After required CI
passes for that SHA, create and push only the annotated version tag matching
`package.json`. Never use a dotted release-tag name for a branch.

A temporary `ci-scratch-*` branch is permitted only when explicitly authorized for
hosted verification. Its CI runs candidate qualification. Delete that owned remote
branch after inspection. Routine main/PR CI runs `pnpm run ci` as `ci (22)` and cancels superseded
runs. The required `ci (24)` check tests only engine, provider and durable-session
compatibility on the other supported Node major, without another build or full gate.

## GitHub release

The tag workflow qualifies the exact tagged source with read-only permissions. It
uploads the tested tarball and checksum. A separate `release` job has `needs: qualify`,
verifies the downloaded checksum and creates the release using the matching changelog
section. Only that job has `contents: write`. Failure or cancellation of qualification
prevents release creation. No retries, `continue-on-error`, independent repacking or
npm publication are part of the workflow.

## Publish after authorization

From the unchanged locally qualified checkout, with the same Node version:

```bash
pnpm run release:preflight
npm publish
```

`prepublishOnly` performs the same fast preflight. It checks the clean source SHA,
Node version, qualification age (maximum 24 hours), original tarball digest, current
npm package digest, and dated matching release notes. Current packaging includes
ignored build output, so changing a chunk also invalidates the qualification. Missing,
stale or changed inputs fail closed and require `pnpm run ci:release` again.

Use normal npm authentication separately when publication is authorized. Confirm the
version is available before publishing; do not log in or publish merely to test this
pipeline. No `--ignore-scripts`, bypass flags or hand-authored "already tested" markers.

Verify npm availability and installation after publication, reconcile completed and
outstanding milestone issues, and close out the local candidate branch only after its
work is proven on canonical main. Published tags are immutable.

## Optional development investigations

```bash
pnpm run test:file -- tests/extended/<file>.test.ts
pnpm run test:full
pnpm run test:gui:full
pnpm --filter @iowarp/clio-coder-gui verify
pnpm run smoke:real-home -- --target <configured-target-id> --strict
```

The full root/web suites, browser viewport/accessibility matrix, live models, native
host interoperability and operator-home checks support development and investigations.
They are not publication gates. Keep scratch outside the checkout, bound it, clean it,
and retain subprocess ownership until children settle. Never move an unresolved
correctness failure out of a required gate to obtain a green release.
