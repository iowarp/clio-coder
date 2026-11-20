import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { internalGitArgv } from "../core/internal-git.js";

const execFileAsync = promisify(execFile);

export interface CheckoutSnapshot {
	root: string;
	paths: ReadonlyMap<string, string>;
}

/** Above this size a run's delta identifies a dirty file by its stat tuple instead of reading it. */
const CONTENT_IDENTITY_MAX_BYTES = 1024 * 1024;

/** Files a snapshot stats and reads at once. */
const OBSERVE_CONCURRENCY = 16;

/**
 * Tick window: the coarsest timestamp granularity a checkout filesystem may have, 2 s (FAT keeps mtime to 2 s; ext3,
 * HFS+ and many NFS exports to 1 s; Linux stamps even nanosecond filesystems from a clock that moves once a jiffy).
 * A file whose newer of mtime and ctime is later than this window before a snapshot started may be rewritten in the
 * same tick after the snapshot read it, keeping size and both timestamps, so a later matching stat tuple is no proof.
 */
const TIMESTAMP_TICK_NS = 2_000_000_000n;

/** Per snapshot, what proving a stat tuple's file unchanged by its content may read; past it the file is reported. */
export const RACY_DIGEST_MAX_FILES = 64;
const RACY_DIGEST_MAX_BYTES = 8 * 1024 * 1024;

interface Observation {
	/** Each entry's status code and lstat tuple, so a later snapshot reuses the identity of a file that did not move. */
	stats: ReadonlyMap<string, string>;
	/** Entries observed inside the tick window, whose matching tuple a later snapshot checks against their content. */
	racy: ReadonlySet<string>;
}

const observations = new WeakMap<CheckoutSnapshot, Observation>();

/** Before-snapshots being taken, by cwd; a run that asks meanwhile shares the one in flight. */
const pendingBaselines = new Map<string, Promise<CheckoutSnapshot | null>>();

const ROOT_ARGS = ["rev-parse", "--show-toplevel"];
const STATUS_ARGS = ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"];
const STATUS_OPTIONS = { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 };

function* statusEntries(status: Buffer): Generator<{ code: Buffer; raw: Buffer; name: string }> {
	for (let start = 0, end = status.indexOf(0); end !== -1; start = end + 1, end = status.indexOf(0, start)) {
		const item = status.subarray(start, end);
		if (item.length < 4) continue;
		const raw = item.subarray(3);
		yield { code: item.subarray(0, 2), raw, name: raw.toString("utf8") };
	}
}

/**
 * Git-visible file state, each dirty or untracked file identified by its content. Commit staging keeps this
 * content identity: its baseline persists across processes and decides what a commit takes.
 */
export function snapshotCheckout(cwd: string): CheckoutSnapshot | null {
	let root: string;
	let status: Buffer;
	try {
		root = realpathSync(
			execFileSync("git", internalGitArgv(["-C", cwd, ...ROOT_ARGS]), {
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			})
				.toString("utf8")
				.trim(),
		);
		status = execFileSync("git", internalGitArgv(["-C", root, ...STATUS_ARGS]), {
			...STATUS_OPTIONS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
	const paths = new Map<string, string>();
	const rootPrefix = Buffer.from(`${root}/`);
	for (const { code, raw, name } of statusEntries(status)) {
		const hash = createHash("sha256").update(code);
		try {
			// The file is opened by its raw bytes: a non-UTF-8 name decodes
			// lossily, so the decoded key alone cannot reach it and its edits
			// would hash as missing on both sides.
			const candidate = Buffer.concat([rootPrefix, raw]);
			const stat = lstatSync(candidate);
			hash.update(String(stat.mode));
			if (stat.isSymbolicLink()) hash.update(readlinkSync(candidate, { encoding: "buffer" }));
			else if (stat.isFile()) {
				const descriptor = openSync(candidate, "r");
				try {
					const buffer = Buffer.allocUnsafe(64 * 1024);
					for (;;) {
						const count = readSync(descriptor, buffer, 0, buffer.length, null);
						if (count === 0) break;
						hash.update(buffer.subarray(0, count));
					}
				} finally {
					closeSync(descriptor);
				}
			}
		} catch {
			hash.update("missing-or-unreadable");
		}
		paths.set(name, hash.digest("hex"));
	}
	return { root, paths };
}

/**
 * The same git-visible state, off the event loop and keyed on stat. An entry whose status code and
 * (mode, size, mtime, ctime, inode) match `reference` keeps the identity it had there, unless `reference` saw it
 * inside the tick window: then its content is read again, within RACY_DIGEST_MAX_FILES and RACY_DIGEST_MAX_BYTES, and
 * past them it counts as changed. One that moved is read again up to 1 MiB, so a rewrite that leaves the content as it
 * was is no change, and a larger file is its stat tuple, unless a baseline sees it inside the tick window and the
 * budget allows.
 */
async function observeCheckout(cwd: string, reference: CheckoutSnapshot | null): Promise<CheckoutSnapshot | null> {
	// Taken before any file is read, so the tick window covers every read this snapshot makes.
	const startedNs = BigInt(Date.now()) * 1_000_000n;
	let root: string;
	let status: Buffer;
	try {
		const top = await execFileAsync("git", internalGitArgv(["-C", cwd, ...ROOT_ARGS]), {
			timeout: 10_000,
			encoding: "buffer",
		});
		root = await realpath(top.stdout.toString("utf8").trim());
		status = (
			await execFileAsync("git", internalGitArgv(["-C", root, ...STATUS_ARGS]), { ...STATUS_OPTIONS, encoding: "buffer" })
		).stdout;
	} catch {
		return null;
	}
	const known = reference !== null && reference.root === root ? observations.get(reference) : undefined;
	const rootPrefix = Buffer.from(`${root}/`);
	const entries = [...statusEntries(status)];
	let digestFiles = RACY_DIGEST_MAX_FILES;
	let digestBytes = BigInt(RACY_DIGEST_MAX_BYTES);
	// Reserved before the read awaits, so concurrent readers never overrun the budget.
	const digestible = (size: bigint): boolean => {
		if (digestFiles === 0 || size > digestBytes) return false;
		digestFiles -= 1;
		digestBytes -= size;
		return true;
	};
	type Observed = { tuple: string | null; identity: string; racy: boolean };
	const observed: Observed[] = [];
	const observe = async ({ code, raw, name }: (typeof entries)[number]): Promise<Observed> => {
		const hash = createHash("sha256").update(code);
		let tuple: string | null = null;
		let racy = false;
		try {
			const candidate = Buffer.concat([rootPrefix, raw]);
			const stat = await lstat(candidate, { bigint: true });
			tuple = `${code.toString("latin1")}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
			racy = (stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) > startedNs - TIMESTAMP_TICK_NS;
			const kept = known?.stats.get(name) === tuple ? reference?.paths.get(name) : undefined;
			const recheck = kept !== undefined && known?.racy.has(name) === true;
			if (kept !== undefined && !recheck) return { tuple, identity: kept, racy };
			hash.update(String(stat.mode));
			if (stat.isSymbolicLink()) hash.update(await readlink(candidate, { encoding: "buffer" }));
			else if (stat.isFile()) {
				if (recheck) hash.update(digestible(stat.size) ? await readFile(candidate) : `unverified:${tuple}`);
				else if (stat.size <= CONTENT_IDENTITY_MAX_BYTES) hash.update(await readFile(candidate));
				// Only a baseline is a later snapshot's reference, so only it digests a large file inside the window.
				else if (racy && reference === null && digestible(stat.size)) hash.update(await readFile(candidate));
				else hash.update(`stat:${tuple}`);
			}
		} catch {
			hash.update("missing-or-unreadable");
		}
		return { tuple, identity: hash.digest("hex"), racy };
	};
	let next = 0;
	const reader = async (): Promise<void> => {
		for (let index = next++; index < entries.length; index = next++) {
			const entry = entries[index];
			if (entry !== undefined) observed[index] = await observe(entry);
		}
	};
	await Promise.all(Array.from({ length: Math.min(OBSERVE_CONCURRENCY, entries.length) }, reader));
	const stats = new Map<string, string>();
	const racy = new Set<string>();
	const paths = new Map<string, string>();
	entries.forEach(({ name }, index) => {
		const entry = observed[index] ?? { tuple: null, identity: "", racy: false };
		if (entry.tuple !== null) stats.set(name, entry.tuple);
		else stats.delete(name);
		if (entry.racy) racy.add(name);
		else racy.delete(name);
		paths.set(name, entry.identity);
	});
	const snapshot = { root, paths };
	observations.set(snapshot, { stats, racy });
	return snapshot;
}

/**
 * A run's before-snapshot of its checkout. Runs spawned against the same cwd while one is being taken share it:
 * the delta is already not attributable between concurrent peers, so one observation serves them all.
 */
export function takeCheckoutBaseline(cwd: string): Promise<CheckoutSnapshot | null> {
	const pending = pendingBaselines.get(cwd);
	if (pending !== undefined) return pending;
	const taken = observeCheckout(cwd, null);
	pendingBaselines.set(cwd, taken);
	void taken.finally(() => {
		if (pendingBaselines.get(cwd) === taken) pendingBaselines.delete(cwd);
	});
	return taken;
}

/**
 * The checkout's state now, comparable with `before`; only files whose stat moved since it, or that `before` saw
 * inside the tick window, are read.
 */
export function snapshotCheckoutSince(before: CheckoutSnapshot, cwd: string): Promise<CheckoutSnapshot | null> {
	return observeCheckout(cwd, before);
}

export function changedCheckoutPaths(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
	if (before.root !== after.root) return [];
	return [...new Set([...before.paths.keys(), ...after.paths.keys()])]
		.filter((name) => before.paths.get(name) !== after.paths.get(name))
		.sort();
}

/** Files `after` holds untracked that `before` did not list at all: what the run created and left outside git. */
export function addedUntrackedPaths(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
	const stats = observations.get(after)?.stats;
	if (stats === undefined || before.root !== after.root) return [];
	return [...stats]
		.filter(([name, tuple]) => tuple.startsWith("??:") && !before.paths.has(name))
		.map(([name]) => name)
		.sort();
}

/**
 * `git diff HEAD` over the paths this checkout changed between `before` and `after` that
 * `include` admits, or "" when nothing qualifies or git fails. A path the
 * operator had already edited before the run counts only if the run changed it again.
 */
export async function changedCheckoutDiff(
	before: CheckoutSnapshot,
	after: CheckoutSnapshot | null,
	include: (path: string) => boolean,
): Promise<string> {
	if (after === null || after.root !== before.root) return "";
	const paths = changedCheckoutPaths(before, after).filter(include);
	if (paths.length === 0) return "";
	try {
		const diff = await execFileAsync(
			"git",
			internalGitArgv(["-C", before.root, "diff", "--no-color", "HEAD", "--", ...paths]),
			{ timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" },
		);
		return diff.stdout.toString("utf8");
	} catch {
		// A diff that cannot be produced flags nothing; the run's other evidence stands.
		return "";
	}
}
