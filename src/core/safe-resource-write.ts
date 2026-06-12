import { randomBytes } from "node:crypto";
import {
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

function fsyncDirectory(dir: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is not supported on every filesystem or platform.
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function fsyncFile(filePath: string): void {
	const fd = openSync(filePath, "r");
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
