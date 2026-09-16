import { randomUUID } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

function mutationQueueKey(filePath: string, depth = 0): string {
	const resolved = resolve(filePath);
	if (depth > 40) throw new Error("Too many symbolic links");
	try {
		return realpathSync.native(resolved);
	} catch {
		try {
			if (lstatSync(resolved).isSymbolicLink()) {
				return mutationQueueKey(resolve(dirname(resolved), readlinkSync(resolved)), depth + 1);
			}
		} catch {
			// Missing paths still share a key through the nearest real ancestor.
		}
		const parent = dirname(resolved);
		return parent === resolved ? resolved : join(mutationQueueKey(parent, depth), basename(resolved));
	}
}

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = mutationQueueKey(filePath);
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
}

async function resolvePublishTarget(filePath: string, depth = 0): Promise<string> {
	if (depth > 40) throw new Error("Too many symbolic links");
	const absolute = resolve(filePath);
	try {
		const info = await lstat(absolute);
		if (info.isSymbolicLink()) {
			return resolvePublishTarget(resolve(dirname(absolute), await readlink(absolute)), depth + 1);
		}
		if (!info.isFile()) throw new Error(`Refusing non-file target (including directories): ${filePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(absolute), { recursive: true });
	return join(await realpath(dirname(absolute)), basename(absolute));
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
		const target = await resolvePublishTarget(filePath);
		const previous = await stat(target).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (previous && !previous.isFile()) throw new Error(`Refusing directory or non-file target: ${filePath}`);
		tempPath = join(dirname(target), `.clio-coder-publish-${randomUUID()}.tmp`);
		const handle = await open(tempPath, "wx", previous ? previous.mode & 0o7777 : 0o666);
		let after: FileIdentity;
		try {
			await handle.writeFile(content);
			if (previous) await handle.chmod(previous.mode & 0o7777);
			await handle.sync();
			const info = await handle.stat();
			after = { bytes: info.size, mtimeMs: info.mtimeMs };
		} finally {
			await handle.close();
		}
		await (options.rename ?? rename)(tempPath, target);
		tempPath = undefined;
		const result: AtomicPublishResult = {
			before: previous ? { bytes: previous.size, mtimeMs: previous.mtimeMs } : null,
			after,
		};
		// Rename is the commit point. A later durability failure cannot honestly
		// be described as an unpublished write or safely rolled back over other writers.
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
