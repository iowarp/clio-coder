---
name: clio-testing
description: Use when working on clio-coder - writing or modifying any code under src/, or verifying features end-to-end. Covers the four-layer test suite (unit / integration / boundaries / e2e), the pty harness for driving the interactive TUI, and the iteration loop for feature development. Activate on any src/ edit, before committing, or when the user asks about testing, verifying, probing, or whether clio works.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# clio-coder testing - what runs, what to use, how to iterate

The repo replaced ~14,700 lines of `scripts/diag-*.ts` theater with a minimal node:test suite (~1,700 lines). Everything lives under `tests/`. This skill tells you how to use it.

## Topology

```
tests/
├── unit/           pure logic, no I/O, <500ms total
├── integration/    real fs ops in a scratch XDG home (ledger, credentials)
├── boundaries/     static analysis of src/ (import rules + prompt fragments)
├── e2e/            real `clio` binary via spawn (non-interactive) + node-pty (TUI)
└── harness/
    ├── spawn.ts    runCli() + makeScratchHome() for `--version`, `doctor`, ...
    └── pty.ts      spawnClioPty() with send/expect/wait/kill for the TUI
```

## Commands

```bash
npm run typecheck          # tsc -p tsconfig.tests.json, includes tests/
npm run lint               # biome check .
npm run test:unit          # pure logic only, no filesystem or subprocesses
npm run test:integration   # filesystem, XDG, subprocess, and domain wiring
npm run test:boundaries    # import invariants and prompt-fragment checks
npm run test               # unit + integration + boundaries
npm run test:e2e           # builds first, then spawn + pty e2e
npm run ci:precommit       # typecheck + lint + boundaries + unit
npm run ci:fast            # ci:precommit + integration + build
npm run ci:full            # ci:fast + e2e without rebuilding
npm run ci                 # alias for ci:fast
```

`npm run ci` is what the default pull request workflow runs. `npm run ci:full` is the nightly and tag-push gate that includes the pty e2e suite.

## Which layer catches what

| Change site | Run this first | Why |
|---|---|---|
| `src/domains/<x>/*.ts` pure logic | `npm run test:unit` | covered by unit tests |
| `src/domains/dispatch/state.ts` | `npm run test:integration` | ledger integration test |
| `src/domains/providers/credentials.ts` | `npm run test:integration` | credentials integration test |
| `src/domains/prompts/fragments/*.md` | `npm run test:boundaries` | `boundaries/prompts.test.ts` validates frontmatter + budgets |
| any `src/` import change | `npm run test` | `boundaries/boundaries.test.ts` enforces rule1/2/3 |
| `src/cli/*.ts` | `npm run test:e2e` (non-interactive part) | spawn harness |
| `src/interactive/*.ts` or `src/entry/orchestrator.ts` | `npm run test:e2e` (pty part) | pty harness |

## Boundary rules you must not break

`tests/boundaries/check-boundaries.ts` enforces three rules. If `npm run test` reports violations:

- **rule1**: only `src/engine/**` may value-import `@mariozechner/pi-*`. Type-only imports are allowed where they erase at compile time; keep them narrow and prefer existing Clio contracts or `src/engine/types.ts` re-exports when they already cover the need.
- **rule2**: `src/worker/**` never imports `src/domains/**`. Shared types go through contracts.
- **rule3**: `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts`. Cross-domain access goes through the contract exported from `src/domains/<y>/index.ts`.

## Writing new unit tests

Use `node:test` + `node:assert/strict`. One file per domain cluster, grouped by `describe`:

```ts
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { myExport } from "../../src/domains/x/y.js";   // note .js extension

describe("x/y", () => {
	it("does the thing", () => {
		strictEqual(myExport(input), expected);
	});
});
```

**Pitfalls**:
- Import paths end in `.js`, not `.ts` (NodeNext module resolution).
- `tsconfig.tests.json` uses strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Array access returns `T | undefined`; narrow before use.
- Biome bans `delete obj.key` on hot paths. Use `Reflect.deleteProperty(obj, "key")` when you genuinely need to delete (e.g. cleaning `process.env` in a test).

## Writing new integration tests

If a test touches the filesystem, use a scratch XDG home. Pattern:

```ts
const ORIGINAL_ENV = { ...process.env };
let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-myfeat-"));
	process.env.CLIO_HOME = scratch;
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
});

afterEach(() => {
	for (const k of Object.keys(process.env)) {
		if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
	}
	for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
		if (v !== undefined) process.env[k] = v;
	}
	rmSync(scratch, { recursive: true, force: true });
	resetXdgCache();
});
```

`resetXdgCache()` from `src/core/xdg.js` clears the module-level cache so env overrides take effect.

## Writing new e2e tests (non-interactive)

Use `tests/harness/spawn.ts`. The harness auto-runs from repo root and points at `dist/cli/index.js`, so **you must build before running** (`npm run test:e2e` does this automatically).

```ts
import { makeScratchHome, runCli } from "../harness/spawn.js";

const scratch = makeScratchHome();
try {
	await runCli(["doctor", "--fix"], { env: scratch.env });   // bootstrap
	const result = await runCli(["my-command", "--json"], {
		env: scratch.env,
		timeoutMs: 20_000,
	});
	strictEqual(result.code, 0);
	const parsed = JSON.parse(result.stdout);
	ok(Array.isArray(parsed));
} finally {
	scratch.cleanup();
}
```

`runCli` returns `{ code, signal, stdout, stderr }`. Always pass `env: scratch.env` so the test doesn't pollute or depend on the user's real XDG home.

## Writing new e2e tests (interactive TUI)

Use `tests/harness/pty.ts`. `spawnClioPty()` returns:

```ts
interface PtyHandle {
	send(keys: string): void;                                              // write raw bytes to the tty
	expect(pattern: RegExp | string, timeoutMs?: number): Promise<string>; // wait for a match
	output(): string;                                                      // full buffer so far (includes ANSI)
	wait(timeoutMs?: number): Promise<{ code, signal }>;                   // resolve on process exit
	kill(signal?: string): void;
	resize(cols: number, rows: number): void;
}
```

Minimal smoke pattern:

```ts
const scratch = makeScratchHome();
await runCli(["doctor", "--fix"], { env: scratch.env });   // bootstrap first
const p = spawnClioPty({ env: scratch.env });
try {
	await p.expect(/Clio Coder/, 15_000);
	p.send("/quit\r");                                // \r for Enter in a pty
	const exit = await p.wait(10_000);
	strictEqual(exit.code, 0);
} finally {
	p.kill();
	scratch.cleanup();
}
```

**Keystrokes to know**:
- `\r` is Enter
- `\x1b` is Escape (closes overlays)
- `\x04` is Ctrl-D (shuts down the TUI)
- `\x03` is Ctrl-C (raises SIGINT; passes through from overlays)
- `\x1b[A`/`\x1b[B`/`\x1b[C`/`\x1b[D` are arrow keys (up/down/right/left)

**Slash commands available**: `/quit`, `/help`, `/hotkeys`, `/run [options] <agent> <task>`, `/targets`, `/connect [target]`, `/disconnect [target]`, `/cost`, `/receipts [verify <runId>]`, `/thinking`, `/model [pattern[:thinking]]`, `/scoped-models`, `/settings`, `/resume`, `/new`, `/tree`, `/fork`, `/compact [instructions]`. Unknown `/foo` is routed as chat input.

**Pitfalls**:
- `expect` patterns match against the raw pty buffer, which contains ANSI escape sequences. Match by stable text (e.g. `/Clio Coder/`, `/Total:\s+\$0\.00/`) rather than exact layout. Strip ANSI only if you're formatting output for display (`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")`).
- Always wrap in `try/finally` with `p.kill()` so a hung pty doesn't leak.
- Always `await runCli(["doctor", "--fix"], ...)` before spawning the TUI on a scratch home, or first-run paths may hit unexpected states. The `install` subcommand was retired in v0.1.4 and is now rejected with exit 2.

## Using the pty harness as a probe (no test file needed)

When you want to poke at clio interactively to see if something works without writing a permanent test, drop a throwaway script in `/tmp/probe.ts` that imports the harness and runs `npx tsx /tmp/probe.ts`. This is faster than the test framework for one-off exploration. Delete it when done; **don't** leave exploratory scripts under `tests/` or `scripts/` (that's exactly what we eradicated).

Example shape:

```ts
import { spawnClioPty, makeScratchHome } from "/absolute/path/tests/harness/pty.ts";
import { runCli } from "/absolute/path/tests/harness/spawn.ts";

const scratch = makeScratchHome();
await runCli(["doctor", "--fix"], { env: scratch.env });
const p = spawnClioPty({ env: scratch.env });
await p.expect(/Clio Coder/);
p.send("/targets\r");
await p.expect(/target|endpoint/i);
console.log("tail:", p.output().slice(-400));
p.send("/quit\r");
await p.wait();
scratch.cleanup();
```

## The iteration loop

When adding a feature:

1. Write the code.
2. `npm run ci:precommit` - typecheck, lint, boundaries, and pure unit tests.
3. `npm run ci:fast` - adds integration and build. This is the default PR gate.
4. If you touched CLI or TUI code: `npm run test:e2e`. Rebuilds first, then runs spawn + pty suites.
5. If an e2e test fails and you need to see what the TUI is actually showing, drop a probe script (pattern above) and inspect `p.output()`.
6. `npm run ci` before committing. Use `npm run ci:full` before release tags or when changing e2e harness behavior.

When debugging:

1. `npm run test -- --test-only` isolates `it.only` / `describe.only` blocks.
2. `node --import tsx --test 'tests/unit/myfile.test.ts'` runs a single file.
3. For pty flakiness, bump `timeoutMs` on the failing `expect` call before blaming the harness. TUI paints can lag behind input on slower machines.

## What NOT to do

- **Don't** add `scripts/diag-*.ts` or any `scripts/verify-*.ts`. That's the pattern we eradicated. If it's a test, it belongs under `tests/`. If it's a one-off probe, use `/tmp/` and delete when done.
- **Don't** bypass boundary rules with `// biome-ignore` or exclude patterns. If rule1/2/3 fires, fix the import; don't silence the check.
- **Don't** write tests against the simulated TUI (i.e. don't mock `pi-tui` and assert on synthetic frame contents). Test real commands via spawn, or real TUI via pty. The pre-refactor diag scripts spent 2,478 lines simulating the TUI; that coverage is now rightly zero.
- **Don't** commit with red tests. If a test fails on pre-existing `src/` state that predates your change, report it and ask. Don't delete or skip the test.

## Where tests live, concretely

| Area | File |
|---|---|
| safety domain | `tests/unit/safety.test.ts` |
| dispatch (validation/admission/backoff) | `tests/unit/dispatch.test.ts` |
| dispatch ledger and worker wiring (fs) | `tests/integration/ledger.test.ts`, `tests/integration/dispatch-concurrency.test.ts` |
| providers catalog/matcher/resolver | `tests/unit/providers/*.test.ts` |
| providers registry and knowledge base (fs) | `tests/integration/providers/registry.test.ts`, `tests/integration/providers/knowledge-base.test.ts` |
| providers credentials (fs) | `tests/integration/credentials.test.ts` |
| agents frontmatter + fleet parser | `tests/unit/agents.test.ts` |
| built-in agent files (fs) | `tests/integration/agents-builtins.test.ts` |
| prompts hash + canonicalJson | `tests/integration/prompts.test.ts` |
| core tool-names/concurrency | `tests/unit/core.test.ts` |
| core xdg (fs) | `tests/integration/core-xdg.test.ts` |
| CLI command internals (fs/XDG) | `tests/integration/cli-*.test.ts` |
| session, memory, evidence artifacts (fs) | `tests/integration/session.test.ts`, `tests/integration/memory.test.ts`, `tests/integration/evidence-builder.test.ts` |
| import boundary rules | `tests/boundaries/boundaries.test.ts` |
| prompt fragment manifests | `tests/boundaries/prompts.test.ts` |
| non-interactive CLI smoke | `tests/e2e/cli.test.ts` |
| interactive TUI smoke | `tests/e2e/interactive.test.ts` |
| spawn harness | `tests/harness/spawn.ts` |
| pty harness | `tests/harness/pty.ts` |

Add new unit tests next to the closest existing file. Don't create a new file unless you're covering a new domain cluster.
