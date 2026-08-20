import { ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeScratchHome, runCli, seedDoctorFix } from "../harness/spawn.js";

/**
 * Built-binary contracts for the V8 compile cache. The unit contracts in
 * tests/contracts/compile-cache.test.ts prove the settle and scrub semantics;
 * these prove the wiring through dist/cli/index.js: read-only commands and
 * pristine homes stay untouched, and the interactive boot path populates the
 * cache under an initialized install's own cache root.
 *
 * Hermetic by construction: every case pins NODE_COMPILE_CACHE and
 * NODE_DISABLE_COMPILE_CACHE to undefined (spawn omits undefined values), so
 * a host machine that sets either cannot change what the child observes.
 */

function scratch(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
	const home = makeScratchHome();
	return {
		...home,
		env: { ...home.env, NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: undefined },
	};
}

describe("smoke/compile cache through the built CLI", () => {
	it("keeps fast paths and read-only commands off the cache, initialized or not", async () => {
		const { env, dir, cleanup } = scratch();
		try {
			const cacheRoot = join(dir, "cache");
			for (const args of [["--version"], ["--help"], ["paths", "--json"]]) {
				const result = await runCli(args, { env });
				strictEqual(result.code, 0, result.stderr);
			}
			strictEqual(existsSync(cacheRoot), false, "an untouched home stays untouched");
			// `paths` documents "Read-only: nothing is created", and that must
			// hold on an initialized install too: no read-only command may
			// enable the cache as a side effect.
			await seedDoctorFix(dir);
			// Help on a boot command is itself zero-side-effect, per the
			// repository's help contract; the enable guard runs before the
			// command module's own help check.
			for (const args of [["paths", "--json"], ["doctor"], ["run", "--help"], ["acp", "--help"]]) {
				const result = await runCli(args, { env });
				strictEqual(result.code, 0, result.stderr);
			}
			strictEqual(
				existsSync(join(cacheRoot, "v8-compile-cache")),
				false,
				"read-only commands and boot-command help never enable the cache",
			);
		} finally {
			cleanup();
		}
	});

	it("enables the cache on the interactive boot path of an initialized install", async () => {
		const { env, dir, cleanup } = scratch();
		try {
			await seedDoctorFix(dir);
			// Bare non-TTY execution takes runClioCommand's bannered boot, the
			// same entrypoint the TUI uses, and exits on its own.
			const result = await runCli([], { env, timeoutMs: 60_000 });
			strictEqual(result.code, 0, result.stderr);
			ok(existsSync(join(dir, "cache", "v8-compile-cache")), "the boot graph compiled through Clio's cache dir");
		} finally {
			cleanup();
		}
	});

	it("yields to an operator-supplied NODE_COMPILE_CACHE", async () => {
		const { env, dir, cleanup } = scratch();
		try {
			await seedDoctorFix(dir);
			const operatorDir = join(dir, "operator-cache");
			const result = await runCli([], { env: { ...env, NODE_COMPILE_CACHE: operatorDir }, timeoutMs: 60_000 });
			strictEqual(result.code, 0, result.stderr);
			ok(existsSync(operatorDir), "the operator's directory is the one Node used");
			strictEqual(existsSync(join(dir, "cache", "v8-compile-cache")), false, "Clio's default never competes");
		} finally {
			cleanup();
		}
	});
});
