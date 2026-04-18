/**
 * Credentials reader/writer for provider API keys. Backs a tiny store under
 * `clioConfigDir()/credentials.yaml` with mode 0600. A keychain-aware entry
 * type is scaffolded for v0.2; v0.1 always reads/writes the YAML file.
 *
 * Security posture:
 *   - write path opens tmp with explicit 0o600 (umask is not trusted) then
 *     fsync + rename; the file never exists on disk under a wider mode.
 *   - chmod 0o600 is re-applied after rename as belt-and-suspenders.
 *   - logging NEVER includes the credential value. `[clio:credentials] set
 *     provider=<id>` is the only supported log shape.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { clioConfigDir } from "../../core/xdg.js";
import { getRuntimeRegistry } from "./registry.js";

/**
 * Secret-grade atomic write. Opens the tmp file with an explicit 0o600 mode so
 * the secret never lives on disk under a wider mode (umask can otherwise leave
 * a transient 0o644 window between write and chmod). Intentionally does NOT
 * reuse `engine/session.ts#atomicWrite`, which is tuned for non-secret
 * artifacts and opens with the process umask.
 */
function atomicWriteSecret(absPath: string, contents: string): void {
	const tmp = join(dirname(absPath), `.${basename(absPath)}.${randomUUID()}.tmp`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, absPath);
}

export interface CredentialEntry {
	providerId: string;
	key: string;
	updatedAt: string;
	source: "file" | "keychain";
}

export interface CredentialStore {
	get(providerId: string): CredentialEntry | null;
	set(providerId: string, key: string): void;
	remove(providerId: string): void;
	list(): ReadonlyArray<Omit<CredentialEntry, "key">>;
}

interface FileEntry {
	key: string;
	updatedAt: string;
}

interface FileShape {
	version: 1;
	entries: Record<string, FileEntry>;
}

function credentialsPath(): string {
	return join(clioConfigDir(), "credentials.yaml");
}

function emptyShape(): FileShape {
	return { version: 1, entries: {} };
}

function readShape(path: string): FileShape {
	if (!existsSync(path)) return emptyShape();
	const raw = readFileSync(path, "utf8");
	if (raw.trim().length === 0) return emptyShape();
	const parsed = parseYaml(raw) as Partial<FileShape> | null;
	if (!parsed || typeof parsed !== "object") return emptyShape();
	const entries =
		parsed.entries && typeof parsed.entries === "object" ? (parsed.entries as Record<string, FileEntry>) : {};
	return { version: 1, entries };
}

function writeShape(path: string, shape: FileShape): void {
	atomicWriteSecret(path, stringifyYaml(shape));
	// Redundant once the tmp file is opened at 0o600 and renamed, but kept as
	// belt-and-suspenders: obvious intent, and it covers edge cases where the
	// destination name pre-exists with a wider mode on some filesystems.
	chmodSync(path, 0o600);
}

export function openCredentialStore(_opts?: { preferKeychain?: boolean }): CredentialStore {
	// v0.1: preferKeychain is accepted but ignored. Flag exists so callers can
	// adopt the keychain path without changing their call sites when v0.2 lands.
	const path = credentialsPath();

	// Touch the file with mode 0600 so concurrent readers never encounter a
	// transiently world-readable file created under a loose umask.
	if (!existsSync(path)) {
		writeShape(path, emptyShape());
	}

	return {
		get(providerId: string): CredentialEntry | null {
			const shape = readShape(path);
			const entry = shape.entries[providerId];
			if (!entry || typeof entry.key !== "string" || entry.key.length === 0) return null;
			return {
				providerId,
				key: entry.key,
				updatedAt: entry.updatedAt,
				source: "file",
			};
		},
		set(providerId: string, key: string): void {
			if (typeof key !== "string" || key.length === 0) {
				throw new Error(`credentials.set: empty key for provider=${providerId}`);
			}
			const shape = readShape(path);
			shape.entries[providerId] = { key, updatedAt: new Date().toISOString() };
			writeShape(path, shape);
			process.stderr.write(`[clio:credentials] set provider=${providerId}\n`);
		},
		remove(providerId: string): void {
			const shape = readShape(path);
			if (!(providerId in shape.entries)) return;
			delete shape.entries[providerId];
			writeShape(path, shape);
			process.stderr.write(`[clio:credentials] remove provider=${providerId}\n`);
		},
		list(): ReadonlyArray<Omit<CredentialEntry, "key">> {
			const shape = readShape(path);
			return Object.entries(shape.entries).map(([providerId, entry]) => ({
				providerId,
				updatedAt: entry.updatedAt,
				source: "file" as const,
			}));
		},
	};
}

/**
 * Returns the set of env-var names that runtimes should consider "present",
 * drawing from both `process.env` and the YAML credentials file. A runtime
 * descriptor lacking a `credentialsEnvVar` (e.g. bedrock via AWS SDK)
 * contributes nothing here; its availability is handled by the runtime's
 * own auth path. Keyed by descriptor id so the credential store and the
 * runtime registry agree on a single identifier.
 */
export function credentialsPresent(): Set<string> {
	const present = new Set<string>();
	const registry = getRuntimeRegistry();

	let shape: FileShape = emptyShape();
	const path = credentialsPath();
	if (existsSync(path)) {
		try {
			shape = readShape(path);
		} catch {
			shape = emptyShape();
		}
	}

	for (const desc of registry.list()) {
		const envVar = desc.credentialsEnvVar;
		if (!envVar) continue;
		const envVal = process.env[envVar]?.trim();
		if (envVal && envVal.length > 0) {
			present.add(envVar);
			continue;
		}
		const entry = shape.entries[desc.id];
		if (entry && typeof entry.key === "string" && entry.key.length > 0) {
			present.add(envVar);
		}
	}

	return present;
}
