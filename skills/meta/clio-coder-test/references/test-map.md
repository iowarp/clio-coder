# Where Clio's tests live

The root repository has contract and smoke tests under `tests/`; import
boundaries run through the lint hygiene checker. Add a test beside the closest
current behavior, and create a new file only for a genuinely new cluster.

## Layout

| Lane | Path | Runner | Build needed |
|---|---|---|---|
| Contracts | `tests/contracts/*.test.ts` | `npm run test:file -- <file-or-files>` through tsx and the temp-root preload | No; imports `src/` |
| Smoke | `tests/smoke/*.test.ts` | `npm run test:file -- <file-or-files>` | Yes; spawns `dist/cli/index.js` |
| Boundaries | `tests/boundaries/check-boundaries.ts` | `npm run lint` through `scripts/check-hygiene.ts` | No |
| Root full suite | Contract and smoke files | `npm run test` | Yes for current smoke behavior |
| Trace viewer | `apps/trace-viewer/tests/*.test.mjs` | `npm run test:trace-viewer` | No |
| Workbench | `apps/workbench/tests/` | `deno task verify` from `apps/workbench` | The command builds the app |

`npm run ci` orders typecheck, lint, skill-pin verification, build, the root
suite, and trace-viewer tests. `npm run ci:release` adds the release audit. The
Workbench gate is separate.

## Contract files

| Area | Current files under `tests/contracts/` |
|---|---|
| Authentication | `auth-login-write-failure`, `auth-storage-durability` |
| Context, session, and state | `context-lifecycle`, `memory-scope`, `project-bootstrap`, `session-durability`, `state-file-lock`, `task-board-done`, `working-set-core` |
| Config, routing, and presentation | `footer-context-window`, `knob-aliases`, `pane-remedies`, `rendering-invariants`, `route-identity-keying`, `settings-migration` |
| Dispatch, fleet, and workers | `dispatch-admission`, `dispatch-lifecycle`, `dispatch-schema`, `fleet-lifecycle`, `host-verification-batch`, `intent-requirements`, `worker-attestation-surface`, `worker-boundary` |
| Prompts, engine loop, and middleware | `compact-prompt-contracts`, `engine-lifecycle`, `loop-detector`, `loop-guard-epoch`, `middleware-hooks`, `prompt-cache-correctness`, `prompt-prefix-layout`, `prompt-role-routing`, `prompt-session-snapshot`, `prompt-tool-hints` |
| Providers and model policy | `gemma-channel-filter`, `llamacpp-router-probe`, `local-model-family-resolution`, `provider-context-boundary`, `provider-transport`, `synthesis-lock`, `thinking-off-wire` |
| Safety and tools | `bash-exec-settlement`, `rejection-feedback`, `safe-resource-write`, `safety-gates`, `tool-boundaries` |
| Evidence, eval, and release | `eval-boundary`, `evidence-integrity`, `metering-integrity`, `release-boundary` |
| Extensions, interop, and skills | `extension-compatibility`, `extension-reload-coordinator`, `extension-reload-slash`, `extension-resources`, `extension-snapshot`, `interop-boundary`, `marketplace-offer`, `skill-install` |
| Documentation server | `docs-server` |

Append `.test.ts` to every stem in the table. Use `rg` over the files before
choosing a lane; related behavior can span more than one focused contract.

## Smoke files

| Boundary | File under `tests/smoke/` |
|---|---|
| ACP v1 over JSON-RPC stdio, permission requests, and text/image content | `acp-boundary.test.ts` |
| Core CLI health, local-provider run, receipts, events, and autonomy | `cli-core.test.ts` |
| `npm pack`, installed resources, and installed codewiki navigation | `installed-package.test.ts` |
| Signal propagation through a real tool child | `process-lifecycle.test.ts` |
| Real-binary setup, onboarding, migration, and launch behavior | `real-binary-boot.test.ts` |

The smoke files own their child-process helpers. There is no shared
`tests/harness/spawn.ts` and no PTY smoke lane in the current tree.

## Harness and fixture modules

| File | Purpose |
|---|---|
| `tests/harness/tmp-root.ts` | Preloaded guarded temp root and cleanup for every root test run |
| `tests/harness/tmp-git-guard.ts` | Prevents accidental `.git` creation in the system or test temp root |
| `tests/harness/scratch-env.ts` | Child-process and in-process Clio state isolation |
| `tests/harness/dispatch.ts` | Dispatch bundle, fast reproducibility, isolated state, and event-loop helpers |
| `tests/harness/dispatch-stub-context.ts` | Minimal domain context for dispatch contracts |
| `tests/harness/receipt.ts` | Typed run-envelope and receipt fixtures |
| `tests/harness/openai-compat-fixture.ts` | Loopback OpenAI-compatible server and target seeders |

Child fixtures in `tests/fixtures/` are
`capacity-lease-child.ts`, `codewiki-coordinator-child.ts`, and
`evidence-index-writer.ts`.

## Running a subset

```bash
# all contracts (the shell expands the file pattern)
npm run test:file -- tests/contracts/*.test.ts

# one contract or smoke file
npm run test:file -- tests/contracts/skill-install.test.ts
npm run build
npm run test:file -- tests/smoke/cli-core.test.ts

# only it.only or describe.only within one file
npm run test:file -- --test-only tests/contracts/skill-install.test.ts
```

## Writing tests

- Use `node:test` and `node:assert/strict`.
- End local TypeScript import specifiers in `.js` for NodeNext resolution.
- Keep `tsconfig.tests.json` strict, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; narrow indexed values before use.
- Let the package script preload `tmp-root.ts`. Tests that mutate Clio state or
  `process.env` should use `scratch-env.ts` and restore in teardown.
- Use a loopback fixture for provider behavior. Do not contact a configured or
  public model from a deterministic test.
- Build before a focused smoke run. `npm run ci` already builds before testing.
- Keep a smoke process driver local to the boundary it exercises unless a
  genuinely shared contract appears.
