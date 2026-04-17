/**
 * Credentials reader/writer for provider API keys. Backs a tiny store under
 * `clioConfigDir()/credentials.yaml` with mode 0600. A keychain-aware entry
 * type is scaffolded for v0.2; v0.1 always reads/writes the YAML file.
 *
 * Security posture:
 *   - file is (re)chmod'd to 0600 after every write; umask is not trusted.
 *   - write path is tmp + fsync + rename to avoid partial files.
 *   - logging NEVER includes the credential value. `[clio:credentials] set
 *     provider=<id>` is the only supported log shape.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { clioConfigDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { PROVIDER_CATALOG } from "./catalog.js";

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
	atomicWrite(path, stringifyYaml(shape));
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
 * Returns the set of env-var names that providers should consider "present",
 * drawing from both `process.env` and the YAML credentials file. A provider
 * lacking a `credentialsEnvVar` (e.g. bedrock) contributes nothing here; its
 * availability is handled by discovery.
 */
export function credentialsPresent(): Set<string> {
	const present = new Set<string>();

	let shape: FileShape = emptyShape();
	const path = credentialsPath();
	if (existsSync(path)) {
		try {
			shape = readShape(path);
		} catch {
			shape = emptyShape();
		}
	}

	for (const spec of PROVIDER_CATALOG) {
		const envVar = spec.credentialsEnvVar;
		if (!envVar) continue;
		const envVal = process.env[envVar]?.trim();
		if (envVal && envVal.length > 0) {
			present.add(envVar);
			continue;
		}
		const entry = shape.entries[spec.id];
		if (entry && typeof entry.key === "string" && entry.key.length > 0) {
			present.add(envVar);
		}
	}

	return present;
}
