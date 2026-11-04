---
title: "Test fixtures and helper processes"
summary: "Describes the scripted stdio peers and helper processes under tests/fixtures that contract and extended tests spawn to exercise MCP, ACP, Slurm, shutdown, and Windows spawn behavior. Use it to find which fixture a test drives and what each mode does."
sources:
  - "tests/fixtures/mcp-fake-server.mjs"
  - "tests/fixtures/acp-error-peer.mjs"
  - "tests/fixtures/shutdown/owner.ts"
  - "tests/fixtures/context-replay/generate-fixture.mjs"
  - "tests/fixtures/mcp-slurm-server.mjs"
  - "tests/fixtures/acp-output.mjs"
  - "tests/fixtures/antigravity-launcher.cs"
  - "tests/fixtures/codewiki-coordinator-child.ts"
tests:
  - "tests/contracts/mcp-stdio-client.test.ts"
  - "tests/contracts/acp-peer-error.test.ts"
  - "tests/extended/editor-bash-shutdown.test.ts"
  - "tests/extended/acp-transport.test.ts"
  - "tests/contracts/slurm-mcp.test.ts"
  - "tests/contracts/antigravity-subprocess.test.ts"
invariants:
  - "In tests/fixtures/mcp-fake-server.mjs, initialize is answered with the client's requested protocol version (default 2025-06-18) in every mode that does not return early before the common reply; the mode is the first argv value, defaulting to normal."
  - "In tests/fixtures/acp-error-peer.mjs, an initialize request whose clientCapabilities contain a true value or a non-empty nested object is rejected with error code -32602."
  - "In tests/extended/editor-bash-shutdown.test.ts, the editor and wiki cases assert the owner exits with code 143 after SIGTERM for every resistance level; the whole describe block is skipped on platforms other than Linux."
  - "The ACP output fixture drives the production stdout transport through six scenarios, and tests/extended/acp-transport.test.ts runs each scenario as a separate child process with a five-second timeout."
validate:
  - "pnpm run test:file -- tests/contracts/mcp-stdio-client.test.ts"
  - "pnpm run test:file -- tests/contracts/acp-peer-error.test.ts"
  - "pnpm run test:file -- tests/extended/editor-bash-shutdown.test.ts"
  - "pnpm run test:file -- tests/extended/acp-transport.test.ts"
---

# Test fixtures and helper processes

This area holds the small scripted processes that tests spawn in place of real providers, real MCP servers, a real Slurm scheduler, or a real Windows toolchain. A reader needs it when a contract test fails inside a fixture, when adding a behavior mode, or when deciding whether a fixture already covers a protocol case. Most fixtures are plain Node or TypeScript programs that read and write one JSON-RPC message per line on stdio. The directory also holds a generated data file and a Windows launcher source; those are described below at the level inspected.

## What the fixtures do

- `tests/fixtures/mcp-fake-server.mjs` is a stdio MCP server. Its first argument selects a behavior mode (`process.argv[2]`, defaulting to `normal`). Every mode that does not return early answers `initialize` with the client's requested protocol version, or `2025-06-18` when none is given. `tools/list` with no cursor returns `PAGE_ONE` (`echo`, `fail`, `sleep`) and a `nextCursor` of `page-2`; cursor `page-2` returns `PAGE_TWO` (`media`, `structured`, `crash`, `oversized`, `invalid_utf8`, `server_request`, `list_changed`, `env`, `spawn_descendant`, `stderr_flood`, `flood_requests`). The `endless-tools` mode returns pages of 100 tools with an ever-advancing `nextCursor`. The `raw-result` mode echoes the caller's `arguments.result` verbatim. The `raw-numeric-result` mode writes literal JSON containing `9007199254740993`, `1e400`, and `-0`, so the client's number handling is exercised without JavaScript parsing. The `ignore-sigterm` mode ignores SIGTERM and exits once its parent process is gone. The `garbage`, `garbage-then-exit`, `exit-on-init`, and `silent-init` modes break protocol negotiation, and the `deaf` mode pauses stdin after its `initialize` reply.
- `tests/fixtures/mcp-slurm-server.mjs` is a stdio MCP server that speaks the five tool names of the clio-kit Slurm server (`slurm_submit`, `slurm_list`, `slurm_describe`, `slurm_cluster`, `slurm_cancel`) with matching annotations. It has no scheduler. Its first argument is a journal path; `slurm_submit` appends `submit <script_path>` and `slurm_cancel` appends `cancel <job_id>` only when the call is accepted. `slurm_cancel` returns `isError: true` with text `rejected` when `confirm_job_id` differs from `job_id`.
- `tests/fixtures/acp-error-peer.mjs` is an ACP peer that handles `initialize`, `session/new`, `session/set_config_option`, `session/set_model`, and `session/prompt`. Its mode is `process.argv[2]`. The `model-pin`, `model-variants`, `target-first`, `thought-option`, and `thought-refuse` modes publish a `select` config option in category `model` (and, for the thought modes, `thought_level`). The `prompt` handler returns a stop reason computed from the currently selected values; the `legacy-models` mode also sends an unstable `models` field that a client must not use. The `anthropic-error` mode streams an error JSON object as the message text, and `missing-stop-reason` returns an empty result object. `session/set_model` always replies with a `method not found` error and marks the session so that a later prompt returns `refusal`.
- `tests/fixtures/acp-output.mjs` takes a scenario name (`fast`, `drain`, `overflow`, `initial`, `initial-ascii`, `write-error`). It calls `takeOverStdout()` from `src/cli/output-guard.ts`, replaces `process.stdout._write` with a recorder, and drives `createStdioServerTransport` from `src/engine/acp/transport.ts` with `writeRawStdout` as its writer. Each scenario asserts its own outcome: `fast` asserts two notifications are written in order with `writableLength` of zero; `drain` holds a second write until the first callback is released; `overflow`, `initial`, and `initial-ascii` assert an `AcpProcessError` with code `acp_process_error` and the message `output buffer exceeded byte limit`; `write-error` asserts `output write failed`.
- `tests/fixtures/shutdown/owner.ts` is a process owner selected by its first argument (`editor`, `wiki`, `domains`, or `budget`). `editor` creates an editor submit controller from `src/interactive/editor-submit.ts`, registers its drain on `getTerminationCoordinator()` from `src/core/termination.ts` with `EDITOR_BASH_SHUTDOWN_MS`, and runs a bash command. `wiki` spawns a worker with `spawnWorkerProcess` from `src/domains/dispatch/worker-spawn.ts` inside `withWikiDispatchLifecycle` from `src/cli/wiki-generate.ts`. `domains` loads two extensions through `loadDomains` from `src/core/domain-loader.ts` and calls `termination.shutdown(0)` with a 300 ms persist timeout. `budget` registers drain hooks with timeouts directly and checks that the hook that never resolves is bounded.
- `tests/fixtures/antigravity-launcher.cs` is a Windows executable source. `Main` prepends a fixed `fake.mjs` argument and a Node path read from `node-executable.txt` beside the executable, quotes each argument with `QuoteArgument` using Windows argv rules, and starts the child with `UseShellExecute = false`, no shell, and redirected stdio. Its stdin is copied to the child and closed on EOF, and its exit code is the child's exit code.
- `tests/fixtures/codewiki-coordinator-child.ts` is a child-process driver for `coordinateCodewikiWrite` in `src/domains/context/codewiki/coordinator.ts`. Its `pause` mode writes a ready file and waits up to 15 seconds for a release file inside `beforeCommit`; its `follow` mode writes a waiting marker after 500 ms and a selected marker when the selection callback runs. No test in the repository spawns this file by path; the codewiki tests that exist call `coordinateCodewikiWrite` in-process.
- `tests/fixtures/context-replay/generate-fixture.mjs` writes `fixture-01.jsonl` beside itself, and that generated file is present in the tree. The generated transcript holds a session header and fourteen user, tool-call, and tool-result turn triples (reads, a find, an edit, and one read that fails with `ENOENT` before a later read succeeds). A search of `tests/` found no test that reads `fixture-01.jsonl` or imports the generator. The `clio-coder-context-replay-v3` schema string in `src/domains/context/working-set/replay/report.ts` is an output identifier, and this fixture is not shown to be its input.

## Callers and the tests that spawn them

The MCP fake server is spawned with its path from `tests/contracts/mcp-stdio-client.test.ts`, `tests/contracts/mcp-catalog-source.test.ts`, `tests/contracts/gateway-mcp.test.ts`, `tests/contracts/worker-mcp.test.ts`, `tests/contracts/acp-client-mcp.test.ts`, and `tests/contracts/mcp-cli.test.ts`. In `tests/contracts/mcp-stdio-client.test.ts`, an oversized response fails with a message matching `exceeds 1024 bytes`, an `invalid_utf8` result is rejected with `not valid UTF-8`, a `crash` call rejects with code `closed` and a message matching `exited with code 3`, and two tests check that a flood of requests from a server that stopped reading stdin fails with code `overload` and does not queue without bound.

The ACP error peer is spawned by `tests/contracts/acp-peer-error.test.ts`, which passes modes such as `anthropic-error`, `model-pin`, `model-variants`, `thought-option`, `thought-refuse`, `legacy-models`, `missing-stop-reason`, and `target-first` as arguments.

The Slurm fixture is spawned by `tests/contracts/slurm-mcp.test.ts` with `FIXTURE` resolved from `tests/fixtures/mcp-slurm-server.mjs`. The test asserts the catalog contains exactly the five names in `TOOLS`. It also checks that a `slurm_cancel` call with mismatched confirmation is blocked by policy, and that `slurm_cancel` with matching confirmation returns `ok`, with the parked tool names recorded in the same test.

The stdout transport fixture is run by `tests/extended/acp-transport.test.ts`. A loop covers the six scenarios (`drain`, `overflow`, `initial`, `initial-ascii`, `write-error`, `fast`) with `execFile(process.execPath, ["--import", "tsx", "tests/fixtures/acp-output.mjs", scenario])` and a five-second timeout. Separate in-process tests in the same file, such as the one that pauses output until drain and delivers queued UTF-8 frames in order, exercise the transport directly with a `Writable` sink.

The shutdown owner is spawned by `tests/extended/editor-bash-shutdown.test.ts`, which resolves it with `fileURLToPath(new URL("../fixtures/shutdown/owner.ts", import.meta.url))`. The describe block is skipped unless `process.platform` is `linux`. Its `editor` and `wiki` loop runs the owner against four resistance levels (`none`, `group`, `descendant`, `descendant-silent`); every case asserts `child.exitCode` equals 143 after the owner's own shutdown path, and the resistant cases additionally check the owned group and descendant exit. The test reads Linux `/proc/<pid>/stat` for the owner and its child, sends SIGTERM to the owner, and asserts the owner's pipes close within one second. The `budget` and `domains` owner modes are not exercised by the loop in this file as read; they were not traced further here.

The Windows launcher is built and run by `tests/contracts/antigravity-subprocess.test.ts`. No other test path that spawns it was found.

`tests/fixtures/headless-denial-driver.ts` and `tests/fixtures/capacity-lease-child.ts` are other helper processes in the same directory. `tests/extended/dogfood-headless-denial.test.ts` spawns `tests/fixtures/headless-denial-driver.ts` through `tsx` with an events path argument; its other spawn sites were not read here.

## Smoke suites

The files in `tests/smoke` and `tests/extended-smoke` do not reference any fixture path or fixture file name; a search of both directories for the fixture paths and generator names found no matches. Those suites run the built CLI entry and exercise boot and process behavior directly, so the fixtures on this page are not their inputs. `tests/smoke/native-call-timing.test.ts` is one such suite: it sets its `CLI` constant to `new URL("../../dist/cli/index.js", import.meta.url).pathname`, so it runs the compiled CLI produced by the build step rather than a checked-in file. The individual cases in those suites were not read in full here.

## Things to watch when editing

- Each fixture selects behavior from a mode argument. A new mode must be added in the same file as the branch it selects, and the test that passes it must use the same string.
- In `tests/fixtures/mcp-fake-server.mjs`, the `initialize` handler returns early for `silent-init`, `exit-on-init`, `garbage`, and `garbage-then-exit`. A new mode that must fail negotiation has to return before the common reply.
- In `tests/fixtures/acp-error-peer.mjs`, `initialize` fails whenever any value in `clientCapabilities` is `true` or a non-empty nested object. Changing what the client advertises changes which fixture modes can initialize.
- `tests/extended/editor-bash-shutdown.test.ts` reads Linux `/proc` fields. Changes to the owner's descendant or identity handling should be run on Linux.
- `tests/fixtures/context-replay/generate-fixture.mjs` overwrites `fixture-01.jsonl` when run. No test was found that reads that file, so regenerating it does not, by itself, change a test result.
- `tests/fixtures/codewiki-coordinator-child.ts` is not referenced by any spawn site, so its modes are not exercised by a test today.
- `tests/fixtures/mcp-slurm-server.mjs` writes its journal to the path in `argv[2]`. A test that does not pass a journal path will write to an unexpected location.

Related pages: [Tests contracts](tests/contracts.md), [Tests extended](tests/extended.md), [Tests harness](tests/harness.md), [Engine ACP](engine/acp.md), [Domains gateway](domains/gateway.md).

