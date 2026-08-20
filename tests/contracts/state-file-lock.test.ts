import { ok, rejects, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { processBirthToken } from "../../src/core/process-identity.js";
import { withStateFileLock, withStateFileLockSync } from "../../src/core/state-file-lock.js";

// One implementation now backs settings.yaml, the dispatch admission state
// file, credentials.yaml and residency mutations, so its policy is worth
// pinning directly rather than only through each caller.
describe("contracts/state-file-lock", () => {
	let dir = "";
	let target = "";
	let lockPath = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-file-lock-"));
		target = join(dir, "state.json");
		lockPath = `${target}.lock`;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// Legacy record shape: no host, no birth token. It must keep adjudicating as
	// a record from this host, so the tests below that use it pin that path.
	function holdLock(pid: number, ageMs = 0, extra: { host?: string; birthToken?: string } = {}): void {
		writeFileSync(lockPath, `${JSON.stringify({ ...extra, pid, at: new Date().toISOString() })}\n`, "utf8");
		if (ageMs > 0) {
			const past = new Date(Date.now() - ageMs);
			utimesSync(lockPath, past, past);
		}
	}

	it("takes and releases the lock around the critical section", () => {
		const seen = withStateFileLockSync(target, () => {
			ok(existsSync(lockPath), "the lock exists while the section runs");
			return JSON.parse(readFileSync(lockPath, "utf8")) as { host: string; pid: number; birthToken: string | null };
		});
		strictEqual(seen.pid, process.pid);
		strictEqual(seen.host, hostname());
		strictEqual(seen.birthToken, processBirthToken());
		strictEqual(existsSync(lockPath), false);
	});

	it("never adjudicates a record from another host, even for a pid that is dead here", () => {
		holdLock(999999, 120_000, { host: `${hostname()}-elsewhere`, birthToken: "foreign" });
		throws(() => withStateFileLockSync(target, () => "unreachable", { timeoutMs: 50 }), /timed out .* waiting for/);
		ok(existsSync(lockPath), "a foreign host's lock is that host's to reclaim");
	});

	it("reclaims a same-host record whose pid was reused by another process", () => {
		const token = processBirthToken();
		if (token === null || token.startsWith("pid-")) return; // no birth-token source on this platform
		holdLock(process.pid, 0, { host: hostname(), birthToken: `${token}-earlier-incarnation` });
		strictEqual(
			withStateFileLockSync(target, () => "taken", { timeoutMs: 50 }),
			"taken",
		);
		// And a matching token still identifies a live holder.
		holdLock(process.pid, 0, { host: hostname(), birthToken: token });
		throws(() => withStateFileLockSync(target, () => "unreachable", { timeoutMs: 50 }), /timed out .* waiting for/);
	});

	it("releases the lock when the critical section throws", () => {
		throws(() =>
			withStateFileLockSync(target, () => {
				throw new Error("boom");
			}),
		);
		strictEqual(existsSync(lockPath), false);
	});

	it("never steals from a live owner, however old the lockfile is", () => {
		// Two minutes is past every retired stale window (5s, 30s, 130s). The
		// owner is alive, so its age says nothing about whether it is done.
		holdLock(process.pid, 120_000);
		throws(() => withStateFileLockSync(target, () => "unreachable", { timeoutMs: 50 }), /timed out .* waiting for/);
		ok(existsSync(lockPath), "a failed acquisition must not disturb the holder");
	});

	it("reclaims a lock whose owner is gone, without waiting out a stale window", () => {
		holdLock(999999);
		strictEqual(
			withStateFileLockSync(target, () => "taken", { timeoutMs: 50 }),
			"taken",
		);
		strictEqual(existsSync(lockPath), false);
	});

	it("falls back to age for a record whose owner cannot be read", () => {
		writeFileSync(lockPath, "not-a-lock-record\n", "utf8");
		throws(() => withStateFileLockSync(target, () => "unreachable", { timeoutMs: 50 }), /timed out .* waiting for/);
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockPath, past, past);
		strictEqual(
			withStateFileLockSync(target, () => "taken", { timeoutMs: 50 }),
			"taken",
		);
	});

	it("refreshes the lockfile mtime while an async holder works", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		await withStateFileLock(target, async () => {
			// Stand in for a holder that has been inside its section long enough
			// for every retired stale window to have expired underneath it.
			const past = new Date(Date.now() - 120_000);
			utimesSync(lockPath, past, past);
			ok(Date.now() - statSync(lockPath).mtimeMs > 60_000, "backdated before the refresh tick");
			t.mock.timers.tick(5_000);
			ok(Date.now() - statSync(lockPath).mtimeMs < 1_000, "the refresh drags the held lock back to now");
		});
		strictEqual(existsSync(lockPath), false);
	});

	it("run-unlocked runs the section anyway when the lock cannot be taken", async () => {
		holdLock(process.pid);
		let ran = false;
		await withStateFileLock(
			target,
			async () => {
				ran = true;
			},
			{ timeoutMs: 50, onAcquireFailure: "run-unlocked" },
		);
		ok(ran, "residency mutations must not fail a turn on a busy lock");
		ok(existsSync(lockPath), "and must not release a lock they never held");
	});

	it("fails closed by default when the lock cannot be taken", async () => {
		holdLock(process.pid);
		await rejects(
			withStateFileLock(target, async () => "unreachable", { timeoutMs: 50 }),
			/timed out .* waiting for/,
		);
	});

	it("cancels a lock convoy without entering the critical section", async () => {
		holdLock(process.pid);
		let ran = false;
		const controller = new AbortController();
		const waiting = withStateFileLock(
			target,
			async () => {
				ran = true;
			},
			{ timeoutMs: 20_000, signal: controller.signal },
		);
		controller.abort(new Error("operator cancelled lock wait"));
		await rejects(waiting, /operator cancelled lock wait/);
		strictEqual(ran, false, "an aborted waiter never enters the protected mutation");
		ok(existsSync(lockPath), "cancelling a waiter does not release the live holder's lock");
	});
});
