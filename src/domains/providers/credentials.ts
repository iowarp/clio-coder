/**
 * Compatibility shim for legacy API-key-only callers.
 *
 * The new auth architecture lives under src/domains/providers/auth/** and is
 * provider-keyed with API-key + OAuth support. This module preserves the old
 * `openCredentialStore()` and `credentialsPresent()` surface for setup flows
 * and older tests while routing them through the new store.
 */

import { openAuthStorage } from "./auth/index.js";
import { getRuntimeRegistry } from "./registry.js";

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

export function openCredentialStore(): CredentialStore {
	const auth = openAuthStorage();
	return {
		get(providerId: string): CredentialEntry | null {
			const credential = auth.get(providerId);
			if (!credential || credential.type !== "api_key") return null;
			return {
				providerId,
				key: credential.key,
				updatedAt: credential.updatedAt,
				source: "file",
			};
		},
		set(providerId: string, key: string): void {
			auth.setApiKey(providerId, key);
			process.stderr.write(`[clio:credentials] set provider=${providerId}\n`);
		},
		remove(providerId: string): void {
			if (!auth.hasStored(providerId)) return;
			auth.remove(providerId);
			process.stderr.write(`[clio:credentials] remove provider=${providerId}\n`);
		},
		list(): ReadonlyArray<Omit<CredentialEntry, "key">> {
			return auth
				.listStored()
				.filter((entry) => entry.type === "api_key")
				.map((entry) => ({
					providerId: entry.providerId,
					updatedAt: entry.updatedAt,
					source: "file" as const,
				}));
		},
	};
}

export function credentialsPresent(): Set<string> {
	const present = new Set<string>();
	const registry = getRuntimeRegistry();
	const auth = openAuthStorage();
	for (const desc of registry.list()) {
		const envVar = desc.credentialsEnvVar;
		if (!envVar) continue;
		const providerId = desc.id;
		const status = auth.status(providerId, { explicitEnvVar: envVar, includeFallback: false });
		if (status.available) {
			present.add(envVar);
		}
	}
	return present;
}
