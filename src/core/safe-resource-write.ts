import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { chmod, copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface SafeResourceBackupOptions {
	path?: string;
	suffix?: string;
}

export interface SafeResourceWriteRenameContext {
	targetPath: string;
	tempPath: string;
	bytes: number;
	backupPath?: string;
}

export interface SafeResourceWriteOptions {
	backup?: boolean | SafeResourceBackupOptions;
	encoding?: BufferEncoding;
	mode?: number;
	beforeRename?: (context: SafeResourceWriteRenameContext) => void;
}

export interface SafeResourceWriteResult {
	path: string;
	tempPath: string;
	bytes: number;
	backupPath?: string;
}

let resourceWriteSequence = 0;

export function safeResourceBackupPath(targetPath: string, suffix = ".bak"): string {
	return `${targetPath}${suffix}`;
}

/**
 * Flush a directory entry so a completed rename survives a crash.
 *
 * Best effort by design: directory fsync is not supported on every filesystem
 * or platform, and a rejection there is not a failed write. The temp-file
 * fsync plus rename still preserves the property that matters, which is that
 * no reader ever sees a torn file. Swallowing the error is what keeps an
 * unsupported filesystem from failing a write that in fact landed.
 */
export function fsyncDirectory(dir: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Unsupported here, and not evidence the write failed. See above.
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function fsyncFile(filePath: string): void {
	// Windows FlushFileBuffers requires a handle opened with write access.
	const fd = openSync(filePath, process.platform === "win32" ? "r+" : "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function tempPathFor(targetPath: string): string {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	const suffix = `${process.pid}-${Date.now()}-${++resourceWriteSequence}-${randomBytes(6).toString("hex")}`;
	return path.join(dir, `.${base}.tmp-${suffix}`);
}

function writeMode(targetPath: string, mode: number | undefined): number {
	if (mode !== undefined) return mode;
	try {
		return statSync(targetPath).mode & 0o777;
	} catch {
		return 0o666;
	}
}

function bufferFrom(contents: string | Uint8Array, encoding: BufferEncoding | undefined): Buffer {
	if (typeof contents === "string") return Buffer.from(contents, encoding ?? "utf8");
	return Buffer.from(contents);
}

function writeAll(fd: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.byteLength) {
		offset += writeSync(fd, buffer, offset, buffer.byteLength - offset);
	}
}

function backupOptions(backup: boolean | SafeResourceBackupOptions | undefined): SafeResourceBackupOptions | null {
	if (backup === true) return {};
	if (!backup) return null;
	return backup;
}

export function safeResourceWrite(
	targetPath: string,
	contents: string | Uint8Array,
	options: SafeResourceWriteOptions = {},
): SafeResourceWriteResult {
	const dir = path.dirname(targetPath);
	mkdirSync(dir, { recursive: true });
	const tempPath = tempPathFor(targetPath);
	const buffer = bufferFrom(contents, options.encoding);
	let tempExists = false;
	let backupPath: string | undefined;

	try {
		const fd = openSync(tempPath, "wx", writeMode(targetPath, options.mode));
		tempExists = true;
		try {
			writeAll(fd, buffer);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}

		const backup = backupOptions(options.backup);
		if (backup && existsSync(targetPath)) {
			backupPath = backup.path ?? safeResourceBackupPath(targetPath, backup.suffix ?? ".bak");
			mkdirSync(path.dirname(backupPath), { recursive: true });
			copyFileSync(targetPath, backupPath);
			// A backup of a file being tightened must not keep the old, wider
			// mode: the settings.yaml backups carry the same auth headers.
			if (options.mode !== undefined) chmodSync(backupPath, statSync(targetPath).mode & 0o777 & options.mode);
			fsyncFile(backupPath);
			fsyncDirectory(path.dirname(backupPath));
		}

		options.beforeRename?.({
			targetPath,
			tempPath,
			bytes: buffer.byteLength,
			...(backupPath ? { backupPath } : {}),
		});
		renameSync(tempPath, targetPath);
		tempExists = false;
		fsyncDirectory(dir);
		return {
			path: targetPath,
			tempPath,
			bytes: buffer.byteLength,
			...(backupPath ? { backupPath } : {}),
		};
	} catch (err) {
		if (tempExists) rmSync(tempPath, { force: true });
		throw err;
	}
}

export interface SafeResourceWriteAsyncOptions extends SafeResourceWriteOptions {
	/** A short commit section may check a snapshot and rename under its lock (#428). */
	withRename?: (commit: () => void) => void | Promise<void>;
}

export async function fsyncDirectoryAsync(dir: string): Promise<void> {
	let fd: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fd = await open(dir, "r");
		await fd.sync();
	} catch {
		// Directory fsync is best effort on unsupported filesystems, as above (#428).
	} finally {
		await fd?.close();
	}
}

/** Preserve the synchronous writer's durability while fsync runs in libuv (#428). */
export async function safeResourceWriteAsync(
	targetPath: string,
	contents: string | Uint8Array,
	options: SafeResourceWriteAsyncOptions = {},
): Promise<SafeResourceWriteResult> {
	const dir = path.dirname(targetPath);
	const buffer = bufferFrom(contents, options.encoding);
	await mkdir(dir, { recursive: true });
	const tempPath = tempPathFor(targetPath);
	let mode = options.mode;
	if (mode === undefined) {
		try {
			mode = (await stat(targetPath)).mode & 0o777;
		} catch {
			// A missing or unreadable target uses the sync writer's default (#428).
			mode = 0o666;
		}
	}
	let tempExists = false;
	let backupPath: string | undefined;
	try {
		const fd = await open(tempPath, "wx", mode);
		tempExists = true;
		try {
			await fd.writeFile(buffer);
			await fd.sync();
		} finally {
			await fd.close();
		}
		const backup = backupOptions(options.backup);
		let targetStat: Stats | undefined;
		if (backup) {
			try {
				targetStat = await stat(targetPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (backup && targetStat) {
			backupPath = backup.path ?? safeResourceBackupPath(targetPath, backup.suffix ?? ".bak");
			await mkdir(path.dirname(backupPath), { recursive: true });
			await copyFile(targetPath, backupPath);
			if (options.mode !== undefined) await chmod(backupPath, targetStat.mode & 0o777 & options.mode);
			const backupFd = await open(backupPath, process.platform === "win32" ? "r+" : "r");
			try {
				await backupFd.sync();
			} finally {
				await backupFd.close();
			}
			await fsyncDirectoryAsync(path.dirname(backupPath));
		}
		options.beforeRename?.({ targetPath, tempPath, bytes: buffer.byteLength, ...(backupPath ? { backupPath } : {}) });
		if (options.withRename) {
			// Only rename stays synchronous: a sync planner cannot wait on a lock
			// whose holder needs this thread to resume an awaited fsync (#428).
			await options.withRename(() => {
				renameSync(tempPath, targetPath);
				tempExists = false;
			});
			if (tempExists) throw new Error("safeResourceWriteAsync: commit did not rename the prepared file");
		} else {
			await rename(tempPath, targetPath);
			tempExists = false;
		}
		await fsyncDirectoryAsync(dir);
		return { path: targetPath, tempPath, bytes: buffer.byteLength, ...(backupPath ? { backupPath } : {}) };
	} catch (error) {
		if (tempExists) await rm(tempPath, { force: true });
		throw error;
	}
}
