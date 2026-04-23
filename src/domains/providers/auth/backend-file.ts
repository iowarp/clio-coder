import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { clioConfigDir } from "../../../core/xdg.js";

import type { AuthStorageBackend, LockResult } from "./storage.js";

const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_ATTEMPTS = 200;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWriteSecret(absPath: string, contents: string): void {
	const tmp = join(dirname(absPath), `.${randomUUID()}.tmp`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, absPath);
	chmodSync(absPath, 0o600);
}

async function atomicWriteSecretAsync(absPath: string, contents: string): Promise<void> {
	const tmp = join(dirname(absPath), `.${randomUUID()}.tmp`);
	const handle = await open(tmp, "wx", 0o600);
	try {
		await handle.writeFile(contents, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	renameSync(tmp, absPath);
	chmodSync(absPath, 0o600);
}

function staleLock(path: string): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs > DEFAULT_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

async function staleLockAsync(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return Date.now() - info.mtimeMs > DEFAULT_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

export function authStoragePath(): string {
	return join(clioConfigDir(), "credentials.yaml");
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private readonly path: string = authStoragePath()) {}

	private get lockPath(): string {
		return `${this.path}.lock`;
	}

	private ensureParentDir(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
	}

	private ensureFileExists(): void {
		if (existsSync(this.path)) return;
		const fd = openSync(this.path, "a", 0o600);
		closeSync(fd);
		chmodSync(this.path, 0o600);
	}

	private releaseSync(fd: number): void {
		try {
			closeSync(fd);
		} finally {
			try {
				unlinkSync(this.lockPath);
			} catch {
				// best-effort
			}
		}
	}

	private async releaseAsync(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
		try {
			await handle.close();
		} finally {
			try {
				await unlink(this.lockPath);
			} catch {
				// best-effort
			}
		}
	}

	private acquireLockSync(): number {
		for (let attempt = 0; attempt < DEFAULT_LOCK_ATTEMPTS; attempt += 1) {
			try {
				return openSync(this.lockPath, "wx", 0o600);
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (code !== "EEXIST") throw error;
				if (staleLock(this.lockPath)) {
					try {
						unlinkSync(this.lockPath);
						continue;
					} catch {
						// Another process may have replaced it; retry below.
					}
				}
				sleepSync(DEFAULT_LOCK_RETRY_MS);
			}
		}
		throw new Error(`auth backend: failed to acquire lock for ${this.path}`);
	}

	private async acquireLockAsync(): Promise<Awaited<ReturnType<typeof open>>> {
		for (let attempt = 0; attempt < DEFAULT_LOCK_ATTEMPTS; attempt += 1) {
			try {
				return await open(this.lockPath, "wx", 0o600);
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (code !== "EEXIST") throw error;
				if (await staleLockAsync(this.lockPath)) {
					try {
						await unlink(this.lockPath);
						continue;
					} catch {
						// Another process may have replaced it; retry below.
					}
				}
				await new Promise((resolve) => setTimeout(resolve, DEFAULT_LOCK_RETRY_MS));
			}
		}
		throw new Error(`auth backend: failed to acquire lock for ${this.path}`);
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();
		const fd = this.acquireLockSync();
		try {
			const current = existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				atomicWriteSecret(this.path, next);
			}
			return result;
		} finally {
			this.releaseSync(fd);
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();
		const handle = await this.acquireLockAsync();
		try {
			const current = existsSync(this.path) ? await readFile(this.path, "utf8") : undefined;
			const { result, next } = await fn(current);
			if (next !== undefined) {
				await atomicWriteSecretAsync(this.path, next);
			}
			return result;
		} finally {
			await this.releaseAsync(handle);
		}
	}
}
