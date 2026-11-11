import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { storeProjectDir } from "../../core/store-paths.js";
import { StoreRefusal } from "./types.js";

/**
 * A cross-process lock for one store key (a blob, or a tag's metadata), held
 * across a write and the record that describes it, so a second writer in
 * another process cannot slip its bytes between the two. The lock is a file
 * created with O_EXCL; a holder that died is detected by its pid on this host,
 * and a lock older than LOCK_STALE_MS is taken over whatever its owner.
 */

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 25;
const BREAK_STALE_MS = 10 * 1000;

interface LockOwner {
	pid: number;
	host: string;
	token: string;
	at: number;
}

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoOf(error) === "EPERM";
	}
}

async function isStale(file: string): Promise<boolean> {
	let owner: Partial<LockOwner> | null = null;
	try {
		owner = JSON.parse(await readFile(file, "utf8")) as Partial<LockOwner>;
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return false;
		// A half-written lock file: judge it by age alone.
	}
	try {
		if (Date.now() - (await stat(file)).mtimeMs > LOCK_STALE_MS) return true;
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return false;
		throw error;
	}
	return owner?.host === hostname() && typeof owner.pid === "number" && !pidAlive(owner.pid);
}

/**
 * Remove a stale lock. A verdict reached without holding anything can be out
 * of date by the time it acts: another breaker may already have replaced the
 * stale lock with its own fresh one. So breakers take turns through an O_EXCL
 * `.break` file and judge the lock again while they hold it. A `.break` file
 * left by a breaker that died is cleared after BREAK_STALE_MS.
 */
async function breakStale(file: string): Promise<boolean> {
	const breaker = `${file}.break`;
	try {
		await (await open(breaker, "wx", 0o600)).close();
	} catch (error) {
		if (errnoOf(error) !== "EEXIST") throw error;
		try {
			if (Date.now() - (await stat(breaker)).mtimeMs > BREAK_STALE_MS) await rm(breaker, { force: true });
		} catch (statError) {
			if (errnoOf(statError) !== "ENOENT") throw statError;
		}
		return false;
	}
	try {
		if (!(await isStale(file))) return false;
		await rm(file, { force: true });
		return true;
	} finally {
		await rm(breaker, { force: true });
	}
}

function lockFile(cwd: string, key: string): string {
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return path.join(storeProjectDir(cwd), "locks", `${digest}.lock`);
}

async function acquire(file: string, key: string): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const token = randomBytes(8).toString("hex");
	const owner: LockOwner = { pid: process.pid, host: hostname(), token, at: Date.now() };
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(file, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(owner));
			} finally {
				await handle.close();
			}
			return token;
		} catch (error) {
			if (errnoOf(error) !== "EEXIST") throw error;
		}
		if ((await isStale(file)) && (await breakStale(file))) continue;
		if (Date.now() >= deadline) {
			throw new StoreRefusal("unavailable", `Another writer holds the store lock for ${key}; try again shortly.`);
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
	}
}

async function release(file: string, token: string): Promise<void> {
	try {
		const owner = JSON.parse(await readFile(file, "utf8")) as Partial<LockOwner>;
		// A lock taken over as stale belongs to its new holder now.
		if (owner.token === token) await rm(file, { force: true });
	} catch {
		// Already gone, or unreadable: nothing of ours to release.
	}
}

/** Run fn while holding the store lock for key in this project. */
export async function withStoreLock<T>(cwd: string, key: string, fn: () => Promise<T>): Promise<T> {
	const file = lockFile(cwd, key);
	const token = await acquire(file, key);
	try {
		return await fn();
	} finally {
		await release(file, token);
	}
}
