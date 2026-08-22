# Clio test harness reference

How to drive the real Clio binary, a mock provider, the ACP surface, and a
real pseudo-terminal in tests. Every model here is a stub; these are machinery
tests. A run against a real model is `benchmarks/internal/SKILL.md`.

## Contents
- The spawn harness (`runCli`, `makeScratchHome`)
- Mocking a provider (OpenAI-compatible SSE fixture)
- ACP over JSON-RPC/stdio
- The PTY (`openPty`, `runInPty`)
- One-off probes (no test file)

## The spawn harness

`tests/harness/spawn.ts` spawns `node dist/cli/index.js` with piped stdio, so
**build first** (or keep `npm run dev` running) before running smoke.

```ts
import { makeScratchHome, runCli } from "../harness/spawn.js";

const scratch = makeScratchHome();
try {
  await runCli(["doctor", "--fix"], { env: scratch.env });   // bootstrap config
  const res = await runCli(["targets", "--json"], { env: scratch.env, timeoutMs: 20_000 });
  // res = { code, signal, stdout, stderr }
  const parsed = JSON.parse(res.stdout) as { targets: unknown[] };
} finally {
  scratch.cleanup();
}
```

- `runCli(args, { env, cwd, timeoutMs, input })` → `Promise<{ code, signal, stdout, stderr }>`.
  Default `timeoutMs` is 15_000; raise it for `run`/`acp`.
- `makeScratchHome()` → `{ dir, env, cleanup }`. The `env` sets `CLIO_CODER_HOME`,
  `CLIO_CODER_DATA_DIR`, `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_CACHE_DIR`, and
  `CLIO_CODER_REQUIRE_HOME_PREFIX=1`. **Always pass `env: scratch.env`** so the test
  never touches the developer's real config, and always `cleanup()` in `finally`.
- Bootstrap a scratch home with `runCli(["doctor", "--fix"], …)` before commands
  that need settings.

Useful flags seen in smoke tests: `--no-context-files`, `--no-skills`,
`--skill <path>`, `--json`. For the live CLI surface, run `clio-coder --help` and
`clio-coder <command> --help` rather than hardcoding a command list here.

## Mocking a provider

To exercise an agent `run` without a real model, stand up an in-process
OpenAI-compatible server that streams one SSE chunk, then point a target at it by
patching `settings.yaml`. This is the pattern in `tests/smoke/cli.test.ts`:

```ts
// 1. Start a fixture that replies with a fixed string over text/event-stream.
const fixture = await startOpenAICompatFixture("mock reply");
// 2. Patch the scratch settings.yaml: add an `openai-compat` target whose
//    url is fixture.url, set orchestrator.target/model to it, and supply the
//    apiKeyEnvVar it expects.
seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
// 3. Run, providing the key env var the target references.
const res = await runCli(["--no-context-files", "run", "hello"], {
  env: { ...scratch.env, CLIO_CODER_TEST_OPENAI_KEY: "sk-test" },
  timeoutMs: 20_000,
});
// res.stdout === "mock reply\n"
await closeServer(fixture.server);
```

The fixture also records `fixture.requests`, so you can assert what Clio sent
(e.g. that an explicit `--skill` was injected into the prompt).

## ACP over JSON-RPC/stdio

`clio-coder acp` speaks ACP v1 over stdio. Drive it with a line-delimited JSON-RPC
client (see `createJsonRpcProcessClient` in the smoke test): `initialize` →
`session/new` → `session/prompt` → `session/close`. Streaming arrives as
`session/update` notifications whose `update.sessionUpdate` must be a v1 variant
(`agent_message_chunk`, `tool_call`, `plan`, `current_mode_update`, …). A
non-spec discriminator breaks strict clients like Zed, so the smoke test asserts
every emitted variant is in the v1 set.

## The PTY

Piped stdio reports no terminal width and no TTY, so the TUI refuses to start
and every width-sensitive path collapses to 80 columns. `tests/harness/pty.ts`
opens a real pseudo-terminal through `node-pty` (a devDependency, never
shipped):

```ts
import { openPty, runInPty, stripAnsi, visibleLines } from "../harness/pty.js";

// Scripted: type on a schedule, stop when the output matches, bounded by a timeout.
const run = await runInPty(process.execPath, [CLI], { cols: 120, rows: 40, cwd, env,
  readyWhen: /ctx /, input: [{ afterMs: 200, data: "/quit\r" }], until: /bye/, timeoutMs: 20_000 });

// Controllable: write, resize, pause output, wait for a matcher, wait for exit.
const session = await openPty(process.execPath, [CLI], { cols: 140, rows: 44, cwd, env });
await session.waitForOutput((out) => /ctx /.test(stripAnsi(out)), 30_000);
session.write("/quit\r");
await session.waitForExit(10_000);
```

Use it only for what a pipe cannot show: width, raw mode, SIGINT through a
terminal, the alternate-screen and keyboard-protocol teardown. The three
suites that need it are `tests/smoke/tui-width-matrix.test.ts`,
`instant-shell-pty.test.ts`, and `render-trace-pty.test.ts`. Anything else
belongs on `runCli`.

## One-off probes (no test file)

To poke at Clio without writing a permanent test, drop a throwaway script in
your scratch directory and run it with tsx. Delete it when done — never leave
probes under `tests/`, `scripts/`, or `benchmarks/`.

```ts
// /tmp/probe.ts
import { makeScratchHome, runCli } from "/abs/path/to/repo/tests/harness/spawn.js";
const scratch = makeScratchHome();
await runCli(["doctor", "--fix"], { env: scratch.env });
const out = await runCli(["skills", "list", "--json", "--all"], { env: scratch.env, cwd: process.cwd() });
console.log(out.stdout.slice(0, 400));
scratch.cleanup();
```

```bash
npx tsx /tmp/probe.ts
```
