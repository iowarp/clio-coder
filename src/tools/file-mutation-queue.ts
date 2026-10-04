import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalizeRawPath } from "../core/path-canonical.js";
import { type AuthoredFileIdentity, recordAuthoredPublish } from "../core/session-authored-files.js";

const fileMutationQueues = new Map<string, Promise<void>>();

/**
 * Where a mutation of filePath lands: the walk safety admission uses, so the
 * queue key and the published file are the path admission judged. Throws,
 * before anything is read or written, when that walk cannot finish.
 */
function physicalTarget(filePath: string): string {
	const target = canonicalizeRawPath(filePath, process.cwd());
	if (target === null) {
		throw new Error(`Refusing unresolvable target (a symbolic link loop or more than 40 links): ${filePath}`);
	}
	return target;
}

/**
 * Serializes in-process mutations of one physical file. A caller that walked
 * filePath in the same synchronous step passes the result as physical, and the
 * key reuses it: nothing can run between that walk and this one. publish still
 * walks again, because the queue wait and the tool's own reads come between.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>, physical?: string): Promise<T> {
	const key = physical ?? physicalTarget(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

export interface FileIdentity {
	bytes: number;
	mtimeMs: number;
}

export interface AtomicPublishResult {
	before: FileIdentity | null;
	after: FileIdentity;
	/** Publication succeeded, but directory durability could not be confirmed. */
	durabilityWarning?: string;
}

export interface AtomicPublishOptions {
	/** Test seam. Must either perform the rename or throw before publishing. */
	rename?: (tempPath: string, targetPath: string) => Promise<void>;
	/**
	 * Write-root check against the physical target, returning a block reason or
	 * null. Admission judged the path earlier; a link swapped in since then
	 * would move the write, so the target is judged again at the publish seam
	 * before any directory is created and once more after (F3).
	 */
	admitTarget?: (targetPath: string) => string | null;
}

function assertAdmitted(target: string, admitTarget: AtomicPublishOptions["admitTarget"]): void {
	const reason = admitTarget?.(target) ?? null;
	if (reason !== null) throw new Error(`Refusing write outside the permitted write roots: ${reason}`);
}

async function resolvePublishTarget(
	filePath: string,
	admitTarget?: AtomicPublishOptions["admitTarget"],
): Promise<string> {
	// Every link on the way is already followed, so a link here was swapped in
	// after resolution and is refused as a non-file rather than followed.
	const absolute = physicalTarget(filePath);
	assertAdmitted(absolute, admitTarget);
	try {
		const info = await lstat(absolute);
		if (!info.isFile()) throw new Error(`Refusing non-file target (including directories): ${filePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(absolute), { recursive: true });
	const target = join(await realpath(dirname(absolute)), basename(absolute));
	assertAdmitted(target, admitTarget);
	return target;
}

/**
 * Atomically replaces the resolved target, preserving symlinks and existing mode bits.
 * Call inside withFileMutationQueue when a read/modify/write transaction is needed.
 * External writers are not locked; the last rename wins. Atomicity and durability
 * depend on the filesystem's rename/fsync guarantees, including on shared storage.
 * Ownership, timestamps, ACLs, and extended attributes are not copied.
 */
export async function publishFileAtomically(
	filePath: string,
	content: string | Uint8Array,
	options: AtomicPublishOptions = {},
): Promise<AtomicPublishResult> {
	let tempPath: string | undefined;
	try {
		const target = await resolvePublishTarget(filePath, options.admitTarget);
		const previous = await stat(target).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (previous && !previous.isFile()) throw new Error(`Refusing directory or non-file target: ${filePath}`);
		tempPath = join(dirname(target), `.clio-coder-publish-${randomUUID()}.tmp`);
		const handle = await open(tempPath, "wx", previous ? previous.mode & 0o7777 : 0o666);
		let after: FileIdentity;
		let published: AuthoredFileIdentity;
		try {
			await handle.writeFile(content);
			if (previous) await handle.chmod(previous.mode & 0o7777);
			await handle.sync();
			const info = await handle.stat();
			after = { bytes: info.size, mtimeMs: info.mtimeMs };
			published = info;
		} finally {
			await handle.close();
		}
		await (options.rename ?? rename)(tempPath, target);
		tempPath = undefined;
		recordAuthoredPublish(target, previous, published);
		const result: AtomicPublishResult = {
			before: previous ? { bytes: previous.size, mtimeMs: previous.mtimeMs } : null,
			after,
		};
		// Rename is the commit point. A later durability failure cannot honestly
		// be described as an unpublished write or safely rolled back over other writers.
		// Windows has no directory fsync (opening one to flush fails with EPERM every time), so
		// the attempt there only puts a warning on every write.
		if (process.platform !== "win32")
			try {
				const directory = await open(dirname(target), "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			} catch (error) {
				result.durabilityWarning = `Published, but directory fsync was unavailable or failed: ${String(error)}`;
			}
		return result;
	} catch (error) {
		let cleanup = "";
		if (tempPath) {
			try {
				await unlink(tempPath);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
					cleanup = ` Temporary file cleanup failed at ${tempPath}: ${String(cleanupError)}`;
				}
			}
		}
		throw new Error(`Nothing was published: ${String(error)}.${cleanup}`, { cause: error });
	}
}
