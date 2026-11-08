import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type HeadlessVerifyShutdownHooks, runHeadlessVerifyChecks } from "../../src/cli/modes/run-verify.js";

const scratch: string[] = [];
const survivors: number[] = [];

afterEach(() => {
	for (const pid of survivors.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function pidFrom(file: string): Promise<number> {
	for (let i = 0; i < 200; i++) {
		if (existsSync(file)) {
			const text = readFileSync(file, "utf8").trim();
			if (text.length > 0) return Number(text);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("the check never wrote its pid");
}

function fakeShutdown(): {
	hooks: HeadlessVerifyShutdownHooks;
	drain: () => Promise<void>;
	forceExit: () => void;
	drainBudgetMs: () => number | undefined;
} {
	let drainHook: (() => void | Promise<void>) | null = null;
	let budget: number | undefined;
	const force = new Set<() => void>();
	return {
		hooks: {
			onDrain: (hook, options) => {
				drainHook = hook;
				budget = options?.timeoutMs;
			},
			onForceExit: (hook) => {
				force.add(hook);
				return () => force.delete(hook);
			},
		},
		drain: async () => {
			await drainHook?.();
		},
		forceExit: () => {
			for (const hook of force) hook();
		},
		drainBudgetMs: () => budget,
	};
}

function termIgnoringCheck(): { command: string; pidFile: string } {
	const dir = mkdtempSync(join(tmpdir(), "clio-verify-shutdown-"));
	scratch.push(dir);
	const pidFile = join(dir, "pid");
	return { command: `trap "" TERM; echo $$ > '${pidFile}'; exec sleep 60`, pidFile };
}

describe("run --verify shutdown", () => {
	it("waits on shutdown until a check that ignores TERM is killed, inside the drain budget", async () => {
		const { command, pidFile } = termIgnoringCheck();
		const shutdown = fakeShutdown();
		const results = runHeadlessVerifyChecks(
			{ checks: [{ id: "stubborn", command }], timeoutMs: 120_000, credited: () => new Set() },
			shutdown.hooks,
		);
		const pid = await pidFrom(pidFile);
		survivors.push(pid);
		const started = Date.now();
		await shutdown.drain();
		const elapsed = Date.now() - started;
		strictEqual(alive(pid), false, "the check's process survived the drain");
		ok(elapsed < (shutdown.drainBudgetMs() ?? 0), `drain took ${elapsed} ms, over its budget`);
		strictEqual((await results).length, 0);
	});

	it("kills the check's process group at once on a forced exit", async () => {
		const { command, pidFile } = termIgnoringCheck();
		const shutdown = fakeShutdown();
		const results = runHeadlessVerifyChecks(
			{ checks: [{ id: "stubborn", command }], timeoutMs: 120_000, credited: () => new Set() },
			shutdown.hooks,
		);
		const pid = await pidFrom(pidFile);
		survivors.push(pid);
		const started = Date.now();
		shutdown.forceExit();
		const [result] = await results;
		ok(Date.now() - started < 2000, "a forced exit waited on the TERM escalation");
		strictEqual(alive(pid), false);
		strictEqual(result?.passed, false);
	});
});
