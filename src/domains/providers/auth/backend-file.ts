import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthOperationOptions } from "@earendil-works/pi-ai";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLock, withStateFileLockSync } from "../../../core/state-file-lock.js";
import { clioConfigDir } from "../../../core/xdg.js";

import type { AuthStorageBackend, LockResult } from "./storage.js";

// Both the sync and async lock paths funnel through the canonical writer. It is
// sync-only, but the credentials file is tiny, the write runs under an exclusive
// lock on a rare auth path, and delegating additionally gains the directory
// fsync the hand-rolled variants lacked. The explicit chmod pins the file to
// exactly 0o600: safeResourceWrite creates its temp with mode 0o600, which umask
// can still narrow, so we re-assert the secret's mode after the rename.
function atomicWriteSecret(absPath: string, contents: string): void {
	safeResourceWrite(absPath, contents, { encoding: "utf8", mode: 0o600 });
	chmodSync(absPath, 0o600);
}

export function authStoragePath(): string {
	return join(clioConfigDir(), "credentials.yaml");
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private readonly path: string = authStoragePath()) {}

	describe(): string {
		return this.path;
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

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();
		return withStateFileLockSync(this.path, () => {
			const current = existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				atomicWriteSecret(this.path, next);
			}
			return result;
		});
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();
		return withStateFileLock(
			this.path,
			async () => {
				options?.signal?.throwIfAborted();
				const current = existsSync(this.path) ? await readFile(this.path, "utf8") : undefined;
				const { result, next } = await fn(current);
				options?.signal?.throwIfAborted();
				if (next !== undefined) {
					atomicWriteSecret(this.path, next);
				}
				return result;
			},
			options?.signal ? { signal: options.signal } : {},
		);
	}
}
