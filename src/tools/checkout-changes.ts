import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { internalGitArgv } from "../core/internal-git.js";

const execFileAsync = promisify(execFile);

export interface CheckoutSnapshot {
	root: string;
	paths: ReadonlyMap<string, string>;
}

/** Above this size a run's delta identifies a dirty file by its stat tuple instead of reading it. */
const CONTENT_IDENTITY_MAX_BYTES = 1024 * 1024;

/**
 * Bytes read from each end of a dirty file on every snapshot, whether or not its stat moved. A rewrite that keeps
 * size, mtime, ctime and inode (one inside the same timestamp tick) is still seen when it changes these bytes.
 */
const STAT_SAMPLE_BYTES = 64 * 1024;

/** Files a snapshot stats and reads at once. */
const OBSERVE_CONCURRENCY = 16;

/** Each entry's status code and lstat tuple, so a later snapshot reuses the identity of a file that did not move. */
const observedStats = new WeakMap<CheckoutSnapshot, ReadonlyMap<string, string>>();

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

/** A digest of a file's first and last {@link STAT_SAMPLE_BYTES}, or of all of it when it is no longer than both. */
async function sampleDigest(candidate: Buffer, size: number): Promise<string> {
	const hash = createHash("sha256");
	const handle = await open(candidate, "r");
	try {
		const spans: ReadonlyArray<readonly [number, number]> =
			size <= 2 * STAT_SAMPLE_BYTES
				? [[0, size]]
				: [
						[0, STAT_SAMPLE_BYTES],
						[size - STAT_SAMPLE_BYTES, STAT_SAMPLE_BYTES],
					];
		for (const [position, length] of spans) {
			const buffer = Buffer.allocUnsafe(length);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

/**
 * The same git-visible state, off the event loop and keyed on stat. An entry whose status code,
 * (mode, size, mtime, ctime, inode) and first and last 64 KiB match `reference` keeps the identity it had there;
 * one that moved is read again up to 1 MiB, so a rewrite that leaves the content as it was is no change, and a
 * larger file is its stat tuple with those sampled bytes. Bound: a rewrite inside one timestamp tick that keeps
 * size and inode and changes only bytes between the two sampled ends goes unseen.
 */
async function observeCheckout(cwd: string, reference: CheckoutSnapshot | null): Promise<CheckoutSnapshot | null> {
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
	const known = reference !== null && reference.root === root ? observedStats.get(reference) : undefined;
	const rootPrefix = Buffer.from(`${root}/`);
	const entries = [...statusEntries(status)];
	const observed: Array<{ tuple: string | null; identity: string }> = [];
	const observe = async ({
		code,
		raw,
		name,
	}: (typeof entries)[number]): Promise<{ tuple: string | null; identity: string }> => {
		const hash = createHash("sha256").update(code);
		let tuple: string | null = null;
		try {
			const candidate = Buffer.concat([rootPrefix, raw]);
			const stat = await lstat(candidate, { bigint: true });
			tuple = `${code.toString("latin1")}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
			if (stat.isFile()) tuple = `${tuple}:${await sampleDigest(candidate, Number(stat.size))}`;
			const kept = known?.get(name) === tuple ? reference?.paths.get(name) : undefined;
			if (kept !== undefined) return { tuple, identity: kept };
			hash.update(String(stat.mode));
			if (stat.isSymbolicLink()) hash.update(await readlink(candidate, { encoding: "buffer" }));
			else if (stat.isFile()) {
				hash.update(stat.size <= CONTENT_IDENTITY_MAX_BYTES ? await readFile(candidate) : `stat:${tuple}`);
			}
		} catch {
			hash.update("missing-or-unreadable");
		}
		return { tuple, identity: hash.digest("hex") };
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
	const paths = new Map<string, string>();
	entries.forEach(({ name }, index) => {
		const { tuple, identity } = observed[index] ?? { tuple: null, identity: "" };
		if (tuple !== null) stats.set(name, tuple);
		else stats.delete(name);
		paths.set(name, identity);
	});
	const snapshot = { root, paths };
	observedStats.set(snapshot, stats);
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

/** The checkout's state now, comparable with `before`; only files whose stat moved since it are read. */
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
	const stats = observedStats.get(after);
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
