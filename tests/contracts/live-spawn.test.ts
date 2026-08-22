/**
 * What runNodeScript promises about the process tree it starts and the
 * environment it hands over.
 *
 * A live driver is the only caller that runs an unbounded, model-driven
 * child, so two claims in `tests/harness/spawn.ts` have to be true and not
 * merely plausible:
 *
 * 1. A timed-out run leaves no survivor. The child leads its own process
 *    group, so the timeout signals the group, not the pid: a grandchild that
 *    outlives its parent is still reached. A child that ignores SIGTERM is
 *    escalated to SIGKILL after the grace window rather than waited on
 *    forever, and either way the partial capture survives.
 * 2. `replaceEnv` means replace. The child sees the given map and nothing
 *    from this process, because that is what keeps an ambient key out of a
 *    run against a target that never asked for one.
 *
 * The survivor check writes the grandchild's pid to a file and then polls
 * `kill(pid, 0)` from here, because the only honest way to ask whether a
 * process is gone is to ask the kernel.
 */
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RunCliTimeoutError, runNodeScript } from "../harness/spawn.js";

const POSIX = process.platform !== "win32";

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Wait until `pid` is gone, or give up after `timeoutMs` and report it still alive. */
async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await sleep(50);
	}
	return !alive(pid);
}

describe("contracts/live spawn", { concurrency: false }, () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-live-spawn-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function script(name: string, source: string): string {
		const path = join(dir, name);
		writeFileSync(path, source, "utf8");
		return path;
	}

	it("a child with no handler dies to the graceful SIGTERM, before the kill escalation", async () => {
		const entry = script("term.mjs", ['process.stdout.write("up\\n");', "setInterval(() => {}, 1000);", ""].join("\n"));
		const started = Date.now();
		let caught: unknown;
		try {
			await runNodeScript(entry, [], { cwd: dir, timeoutMs: 1_000 });
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof RunCliTimeoutError, `expected RunCliTimeoutError, got ${String(caught)}`);
		strictEqual(caught.stdout, "up\n");
		strictEqual(caught.signal, "SIGTERM");
		const elapsed = Date.now() - started;
		ok(elapsed < 2_500, `settled at ${elapsed}ms; the 2s SIGKILL grace should not have been waited out`);
	});

	it("a child that ignores SIGTERM is escalated to SIGKILL and still yields its partial output", async () => {
		const entry = script(
			"ignore-term.mjs",
			[
				'process.on("SIGTERM", () => {});',
				'process.stdout.write("stubborn\\n");',
				'process.stderr.write("stubborn-err\\n");',
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
		);
		const started = Date.now();
		let caught: unknown;
		try {
			await runNodeScript(entry, [], { cwd: dir, timeoutMs: 1_000 });
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof RunCliTimeoutError, `expected RunCliTimeoutError, got ${String(caught)}`);
		strictEqual(caught.signal, "SIGKILL");
		strictEqual(caught.stdout, "stubborn\n");
		strictEqual(caught.stderr, "stubborn-err\n");
		const elapsed = Date.now() - started;
		ok(elapsed >= 2_500, `settled at ${elapsed}ms; SIGKILL must follow the 2s grace, not precede it`);
		ok(elapsed < 9_000, `settled at ${elapsed}ms; the kill grace should not have been waited out`);
	});

	it("a grandchild in the group does not survive its parent's timeout", { skip: !POSIX }, async () => {
		const pidFile = join(dir, "grandchild.pid");
		const childSource = [
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			// Ignores SIGTERM on purpose: only the group SIGKILL can end it.
			'process.on("SIGTERM", () => {});',
			"setInterval(() => {}, 1000);",
			"",
		].join("\n");
		const child = script("grandchild.mjs", childSource);
		const entry = script(
			"parent.mjs",
			[
				`import { spawn } from "node:child_process";`,
				`spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "ignore" });`,
				'process.stdout.write("parent-up\\n");',
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
		);

		let caught: unknown;
		try {
			await runNodeScript(entry, [], { cwd: dir, timeoutMs: 1_500 });
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof RunCliTimeoutError, `expected RunCliTimeoutError, got ${String(caught)}`);
		// The partial capture is kept even though the tree had to be killed.
		strictEqual(caught.stdout, "parent-up\n");
		ok(existsSync(pidFile), "the grandchild never started; the test proves nothing");
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		ok(Number.isSafeInteger(pid) && pid > 0, `bad grandchild pid ${String(pid)}`);
		ok(await waitForGone(pid, 5_000), `grandchild ${pid} outlived the run`);
	});

	it("replaceEnv hands the child exactly the given map", async () => {
		const entry = script("env.mjs", ['process.stdout.write(JSON.stringify(process.env) + "\\n");', ""].join("\n"));
		const marker = `clio-live-spawn-${process.pid}`;
		process.env.CLIO_LIVE_SPAWN_AMBIENT = marker;
		try {
			const given = { CLIO_LIVE_SPAWN_GIVEN: "given-value", PATH: process.env.PATH as string };
			const result = await runNodeScript(entry, [], { cwd: dir, timeoutMs: 15_000, env: given, replaceEnv: true });
			strictEqual(result.code, 0);
			const seen = JSON.parse(result.stdout) as Record<string, string>;
			strictEqual(seen.CLIO_LIVE_SPAWN_GIVEN, "given-value");
			strictEqual(seen.CLIO_LIVE_SPAWN_AMBIENT, undefined, "an ambient variable reached a replaceEnv child");
			// Node adds nothing of its own on POSIX, so the map is the whole environment.
			if (POSIX) {
				strictEqual(
					[...Object.keys(seen)].sort().join(","),
					["CLIO_LIVE_SPAWN_GIVEN", "PATH"].sort().join(","),
					`child environment was not exactly the given map: ${Object.keys(seen).sort().join(",")}`,
				);
			}

			// Without replaceEnv the same call layers over this process's env.
			const layered = await runNodeScript(entry, [], { cwd: dir, timeoutMs: 15_000, env: given });
			const layeredSeen = JSON.parse(layered.stdout) as Record<string, string>;
			strictEqual(layeredSeen.CLIO_LIVE_SPAWN_AMBIENT, marker);
			strictEqual(layeredSeen.CLIO_LIVE_SPAWN_GIVEN, "given-value");
		} finally {
			Reflect.deleteProperty(process.env, "CLIO_LIVE_SPAWN_AMBIENT");
		}
	});
});
