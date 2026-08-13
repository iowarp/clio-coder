# Clio test harness reference

How to drive the real Clio binary, a mock provider, and the ACP surface in
tests. All of this is non-interactive — there is no pty harness in v0.2.2.

## Contents
- The spawn harness (`runCli`, `makeScratchHome`)
- Mocking a provider (OpenAI-compatible SSE fixture)
- ACP over JSON-RPC/stdio
- One-off probes (no test file)

## The spawn harness

`tests/harness/spawn.ts` is the only harness. It spawns `node dist/cli/index.js`,
so **build first** (or keep `npm run dev` running) before `test:smoke`.

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
- `makeScratchHome()` → `{ dir, env, cleanup }`. The `env` sets `CLIO_HOME`,
  `CLIO_DATA_DIR`, `CLIO_CONFIG_DIR`, `CLIO_CACHE_DIR`, and
  `CLIO_REQUIRE_HOME_PREFIX=1`. **Always pass `env: scratch.env`** so the test
  never touches the developer's real config, and always `cleanup()` in `finally`.
- Bootstrap a scratch home with `runCli(["doctor", "--fix"], …)` before commands
  that need settings.

Useful flags seen in smoke tests: `--no-context-files`, `--no-skills`,
`--skill <path>`, `--json`. For the live CLI surface, run `clio --help` and
`clio <command> --help` rather than hardcoding a command list here.

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
  env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
  timeoutMs: 20_000,
});
// res.stdout === "mock reply\n"
await closeServer(fixture.server);
```

The fixture also records `fixture.requests`, so you can assert what Clio sent
(e.g. that an explicit `--skill` was injected into the prompt).

## ACP over JSON-RPC/stdio

`clio acp` speaks ACP v1 over stdio. Drive it with a line-delimited JSON-RPC
client (see `createJsonRpcProcessClient` in the smoke test): `initialize` →
`session/new` → `session/prompt` → `session/close`. Streaming arrives as
`session/update` notifications whose `update.sessionUpdate` must be a v1 variant
(`agent_message_chunk`, `tool_call`, `plan`, `current_mode_update`, …). A
non-spec discriminator breaks strict clients like Zed, so the smoke test asserts
every emitted variant is in the v1 set.

## One-off probes (no test file)

To poke at Clio without writing a permanent test, drop a throwaway script in
`/tmp` and run it with tsx. Delete it when done — never leave probes under
`tests/` or `scripts/`.

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
