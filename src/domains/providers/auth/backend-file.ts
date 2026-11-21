import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AclHost, applyOwnerOnlyAcl } from "../../../core/owner-only-acl.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLock, withStateFileLockSync } from "../../../core/state-file-lock.js";
import { resolveClioDirs } from "../../../core/xdg.js";
import type { AuthOperationOptions } from "../../../engine/types.js";

import type { AuthStorageBackend, LockResult } from "./storage.js";

// Both the sync and async lock paths funnel through the canonical writer. It is
// sync-only, but the credentials file is tiny, the write runs under an exclusive
// lock on a rare auth path, and delegating additionally gains the directory
// fsync the hand-rolled variants lacked. The explicit chmod pins the file to
// exactly 0o600: safeResourceWrite creates its temp with mode 0o600, which umask
// can still narrow, so we re-assert the secret's mode after the rename.
// On Windows the mode protects nothing: a new file carries the ACL it inherits
// from the config directory. So the directory is made owner-only before each
// write, with inheritable grants, and the temp file starts owner-only; the
// renamed file is made owner-only after it. A failure keeps the written
// credentials, warns once, and doctor reports the ACL.
let aclWarningShown = false;

function atomicWriteSecret(absPath: string, contents: string, aclHost: AclHost): void {
	const dirFailure = applyOwnerOnlyAcl(dirname(absPath), aclHost, { directory: true });
	safeResourceWrite(absPath, contents, { encoding: "utf8", mode: 0o600 });
	chmodSync(absPath, 0o600);
	const aclFailure =
		applyOwnerOnlyAcl(absPath, aclHost) ?? (dirFailure === null ? null : `its directory: ${dirFailure}`);
	if (aclFailure !== null && !aclWarningShown) {
		aclWarningShown = true;
		process.stderr.write(
			`warning: could not make ${absPath} owner-only (${aclFailure}); other local accounts may be able to read it. Run \`clio-coder doctor\`.\n`,
		);
	}
}

export function authStoragePath(): string {
	return join(resolveClioDirs().config, "credentials.yaml");
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(
		private readonly path: string = authStoragePath(),
		private readonly aclHost: AclHost = {},
	) {}

	describe(): string {
		return this.path;
	}

	private ensureParentDir(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
	}

	// Writers publish complete files with an atomic rename, so a reader sees
	// either the prior or next committed snapshot without creating a lockfile or
	// initializing a missing home. Read-modify-write operations still take the
	// exclusive lock below and read again inside it before merging changes.
	read(): string | undefined {
		try {
			return readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		return withStateFileLockSync(this.path, () => {
			const current = this.read();
			const { result, next } = fn(current);
			if (next !== undefined) {
				atomicWriteSecret(this.path, next, this.aclHost);
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
		return withStateFileLock(
			this.path,
			async () => {
				options?.signal?.throwIfAborted();
				const current = existsSync(this.path) ? await readFile(this.path, "utf8") : undefined;
				const { result, next } = await fn(current);
				options?.signal?.throwIfAborted();
				if (next !== undefined) {
					atomicWriteSecret(this.path, next, this.aclHost);
				}
				return result;
			},
			options?.signal ? { signal: options.signal } : {},
		);
	}
}
