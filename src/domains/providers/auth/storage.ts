import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { OAuthLoginCallbacks } from "../../../engine/oauth.js";
import type { RuntimeAuth, RuntimeDescriptor } from "../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../types/target-descriptor.js";

import { normalizeStoredApiKeyRef, resolveEnvironmentApiKey, resolveStoredApiKey } from "./api-key.js";
import {
	getOAuthApiKey,
	getOAuthProvider,
	listOAuthProviders,
	loginWithOAuthProvider,
	refreshOAuthCredentials,
} from "./oauth.js";

export interface ApiKeyCredential {
	type: "api_key";
	key: string;
	updatedAt: string;
}

export interface OAuthCredential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	updatedAt: string;
	[key: string]: unknown;
}

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export interface LockResult<T> {
	result: T;
	next?: string;
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
	/** Where the store lives, for error text. Absent for non-file backends. */
	describe?(): string;
}

/**
 * Refusal to rewrite a credentials store that did not fully parse. Thrown
 * rather than recorded because every caller is a write the operator asked for,
 * and the alternatives are both wrong: writing destroys credentials, and
 * silently doing nothing reports success over a store that never changed.
 */
export class AuthStorageDamagedError extends Error {
	constructor(
		readonly damage: string,
		readonly path: string | undefined,
	) {
		super(
			[
				`refusing to write credentials: ${damage}.`,
				path ? `File: ${path}` : null,
				"Writing would replace the whole file and lose whatever is stored there.",
				"Move the file aside once you have recovered anything you need, then log in again.",
			]
				.filter((line): line is string => line !== null)
				.join(" "),
		);
		this.name = "AuthStorageDamagedError";
	}
}

export interface AuthTarget {
	providerId: string;
	/**
	 * Target id scoping runtime overrides. Absent for runtime-only targets
	 * (e.g. the auth-selector list of connectable providers) because those do
	 * not belong to a specific target.
	 */
	targetId?: string;
	explicitEnvVar?: string;
	runtimeAuth: RuntimeAuth;
}

export interface AuthStatus {
	providerId: string;
	available: boolean;
	credentialType: AuthCredential["type"] | null;
	source: "runtime-override" | "stored-api-key" | "stored-oauth" | "environment" | "fallback" | "not-required" | "none";
	detail: string | null;
}

export interface AuthResolution extends AuthStatus {
	apiKey?: string;
}

interface AuthStorageShapeV1 {
	version?: 1;
	entries?: Record<string, { key?: string; updatedAt?: string }>;
}

interface AuthStorageShapeV2 {
	version?: 2;
	entries?: Record<string, AuthCredential>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function emptyData(): AuthStorageData {
	return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toApiKeyCredential(raw: unknown): ApiKeyCredential | null {
	if (!isRecord(raw)) return null;
	if (raw.type === "api_key" && typeof raw.key === "string" && raw.key.trim().length > 0) {
		return {
			type: "api_key",
			key: raw.key,
			updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.length > 0 ? raw.updatedAt : nowIso(),
		};
	}
	return null;
}

function toOAuthCredential(raw: unknown): OAuthCredential | null {
	if (!isRecord(raw)) return null;
	if (
		raw.type === "oauth" &&
		typeof raw.access === "string" &&
		typeof raw.refresh === "string" &&
		typeof raw.expires === "number"
	) {
		return {
			...raw,
			type: "oauth",
			access: raw.access,
			refresh: raw.refresh,
			expires: raw.expires,
			updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.length > 0 ? raw.updatedAt : nowIso(),
		};
	}
	return null;
}

/**
 * The result of reading the credentials file, and whether reading it lost
 * anything.
 *
 * `damage` is non-null when the file held bytes this parser could not turn back
 * into credentials: invalid YAML, a shape that is not ours, or entries whose
 * fields we do not recognize. It exists because every write to this file is a
 * whole-file rewrite of the parsed view. Reading a damaged file as "no
 * credentials" and then persisting that view serializes the emptiness back over
 * the secrets, and there is no backup. A caller that is about to write must
 * refuse when `damage` is set.
 */
interface StorageRead {
	data: AuthStorageData;
	damage: string | null;
}

function readStorageData(content: string | undefined): StorageRead {
	if (!content || content.trim().length === 0) return { data: emptyData(), damage: null };
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (error) {
		// The YAML error is a summary line followed by the offending source and a
		// caret diagram. Only the summary survives being embedded in a sentence:
		// flattening the whole thing turned the diagram into trailing ": : : ^^"
		// noise that read as corruption of the message itself.
		const raw = error instanceof Error ? error.message : String(error);
		// The summary line ends on the colon that introduced the snippet, so
		// dropping the snippet leaves it dangling in front of whatever follows.
		const detail = (raw.split("\n")[0] ?? raw).trim().replace(/:$/u, "");
		return { data: emptyData(), damage: `it is not valid YAML: ${detail}` };
	}
	// A document of only comments parses to null. Nothing is stored and nothing
	// is at risk.
	if (parsed === null || parsed === undefined) return { data: emptyData(), damage: null };
	if (!isRecord(parsed)) return { data: emptyData(), damage: "its top level is not a mapping" };
	// An empty mapping is an empty store holding nothing at risk. This is not a
	// hypothetical shape: `initializeClioHome` scaffolds exactly `{}` at
	// src/core/init.ts:80, so treating it as damage made a brand-new install
	// unable to log in at all.
	if (Object.keys(parsed).length === 0) return { data: emptyData(), damage: null };
	if (!("entries" in parsed) && !("version" in parsed)) {
		return { data: emptyData(), damage: "it has neither a version nor an entries mapping" };
	}
	// `entries:` written as null, or absent next to a version, is an empty store
	// rather than a damaged one.
	const entries = isRecord(parsed.entries) ? parsed.entries : null;
	if (!entries) return { data: emptyData(), damage: null };

	const data: AuthStorageData = {};
	const unread: string[] = [];
	const version = parsed.version;
	if (
		version === 1 ||
		(version === undefined && Object.values(entries).every((value) => isRecord(value) && "key" in value))
	) {
		for (const [providerId, value] of Object.entries((entries as AuthStorageShapeV1["entries"]) ?? {})) {
			if (!value || typeof value.key !== "string" || value.key.trim().length === 0) {
				unread.push(providerId);
				continue;
			}
			data[providerId] = {
				type: "api_key",
				key: value.key,
				updatedAt: typeof value.updatedAt === "string" && value.updatedAt.length > 0 ? value.updatedAt : nowIso(),
			};
		}
		return { data, damage: unreadDamage(unread) };
	}

	for (const [providerId, value] of Object.entries((entries as AuthStorageShapeV2["entries"]) ?? {})) {
		const apiKey = toApiKeyCredential(value);
		if (apiKey) {
			data[providerId] = apiKey;
			continue;
		}
		const oauth = toOAuthCredential(value);
		if (oauth) {
			data[providerId] = oauth;
			continue;
		}
		unread.push(providerId);
	}
	return { data, damage: unreadDamage(unread) };
}

function unreadDamage(unread: ReadonlyArray<string>): string | null {
	if (unread.length === 0) return null;
	return `these entries are stored in a shape this version cannot read: ${[...unread].sort().join(", ")}`;
}

function serializeStorageData(data: AuthStorageData): string {
	return stringifyYaml({
		version: 2,
		entries: data,
	});
}

export function resolveAuthTarget(target: TargetDescriptor, runtime: RuntimeDescriptor): AuthTarget {
	const providerId =
		target.auth?.oauthProfile?.trim() || target.auth?.apiKeyRef?.trim() || runtime.oauthProviderId || runtime.id;
	const authTarget: AuthTarget = {
		providerId,
		targetId: target.id,
		runtimeAuth: runtime.auth,
	};
	const explicitEnvVar = target.auth?.apiKeyEnvVar ?? runtime.credentialsEnvVar;
	if (explicitEnvVar) authTarget.explicitEnvVar = explicitEnvVar;
	return authTarget;
}

export function resolveRuntimeAuthTarget(runtime: RuntimeDescriptor): AuthTarget {
	const target: AuthTarget = {
		providerId: runtime.oauthProviderId ?? runtime.id,
		runtimeAuth: runtime.auth,
	};
	if (runtime.credentialsEnvVar) target.explicitEnvVar = runtime.credentialsEnvVar;
	return target;
}

export function targetRequiresAuth(target: TargetDescriptor, runtime: RuntimeDescriptor): boolean {
	if (runtime.auth === "oauth") return true;
	if (runtime.auth !== "api-key") return false;
	if (target.auth?.apiKeyEnvVar || target.auth?.apiKeyRef || target.auth?.oauthProfile) return true;
	return runtime.tier === "cloud" || Boolean(runtime.credentialsEnvVar);
}

export function authNotRequiredStatus(providerId: string): AuthStatus {
	return {
		providerId,
		available: true,
		credentialType: null,
		source: "not-required",
		detail: null,
	};
}

export class AuthStorage {
	private data: AuthStorageData = {};
	private damage: string | null = null;
	private runtimeOverrides = new Map<string, string>();
	private fallbackResolver?: (providerId: string) => string | undefined;

	constructor(private readonly backend: AuthStorageBackend) {
		this.reload();
	}

	reload(): void {
		try {
			let content: string | undefined;
			this.backend.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			const read = readStorageData(content);
			this.data = read.data;
			this.damage = read.damage;
		} catch (error) {
			this.data = emptyData();
			this.damage = error instanceof Error ? `it could not be read: ${error.message}` : "it could not be read";
		}
	}

	/**
	 * Why the store on disk could not be fully read, or why the last write to it
	 * did not land, or null when it is clean. Callers that report connection
	 * state must consult this, because a damaged store reads as zero credentials
	 * and is otherwise indistinguishable from having never logged in, and a
	 * refused write leaves memory claiming a credential that disk does not hold.
	 */
	damageReason(): string | null {
		return this.damage;
	}

	private persist(providerId: string, credential: AuthCredential | undefined): void {
		try {
			this.backend.withLock((current) => {
				const read = readStorageData(current);
				if (read.damage !== null) {
					this.damage = read.damage;
					throw new AuthStorageDamagedError(read.damage, this.backend.describe?.());
				}
				const merged = read.data;
				if (credential) merged[providerId] = credential;
				else delete merged[providerId];
				this.data = merged;
				this.damage = null;
				return { result: undefined, next: serializeStorageData(merged) };
			});
		} catch (error) {
			// A write that failed for a reason the damage refusal does not cover: a
			// lock that could not be taken, a read-only config dir, a full disk.
			// This used to go into an errors array with no consumer, so the store
			// reported itself clean while disk held none of what was just written.
			// damageReason() is the channel `clio-coder auth` and `clio-coder doctor` read.
			if (error instanceof AuthStorageDamagedError) throw error;
			this.damage = error instanceof Error ? `it could not be written: ${error.message}` : "it could not be written";
		}
	}

	get(providerId: string): AuthCredential | undefined {
		return this.data[providerId];
	}

	// persist() adopts the merged view on success, so it runs first: assigning
	// in-memory ahead of it would leave a credential that reads back as stored
	// while the disk write was refused.
	set(providerId: string, credential: AuthCredential): void {
		this.persist(providerId, credential);
		this.data[providerId] = credential;
	}

	setApiKey(providerId: string, key: string): void {
		const resolved = normalizeStoredApiKeyRef(key);
		if (!resolved) throw new Error(`auth.setApiKey: empty key for provider=${providerId}`);
		this.set(providerId, { type: "api_key", key: resolved, updatedAt: nowIso() });
	}

	remove(providerId: string): void {
		this.persist(providerId, undefined);
		delete this.data[providerId];
	}

	listStored(): ReadonlyArray<{ providerId: string; type: AuthCredential["type"]; updatedAt: string }> {
		return Object.entries(this.data)
			.map(([providerId, credential]) => ({
				providerId,
				type: credential.type,
				updatedAt: credential.updatedAt,
			}))
			.sort((a, b) => a.providerId.localeCompare(b.providerId));
	}

	hasStored(providerId: string): boolean {
		return providerId in this.data;
	}

	/**
	 * Install a process-lifetime API key override scoped to a specific target.
	 * Overrides are keyed by `targetId` (not providerId) so two targets
	 * sharing a runtime do not share the override. `clio-coder --api-key <key>`
	 * applies only to the active target, not every target on that provider.
	 */
	setRuntimeOverride(targetId: string, apiKey: string): void {
		if (targetId.length === 0) {
			throw new Error("auth.setRuntimeOverride: empty targetId");
		}
		const resolved = normalizeStoredApiKeyRef(apiKey);
		if (!resolved) throw new Error(`auth.setRuntimeOverride: empty key for target=${targetId}`);
		this.runtimeOverrides.set(targetId, resolved);
	}

	clearRuntimeOverride(targetId: string): void {
		if (targetId.length === 0) return;
		this.runtimeOverrides.delete(targetId);
	}

	setFallbackResolver(resolver: (providerId: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	status(
		providerId: string,
		opts?: { targetId?: string; explicitEnvVar?: string; includeFallback?: boolean },
	): AuthStatus {
		if (opts?.targetId && this.runtimeOverrides.has(opts.targetId)) {
			return {
				providerId,
				available: true,
				credentialType: "api_key",
				source: "runtime-override",
				detail: providerId,
			};
		}

		const stored = this.data[providerId];
		if (stored?.type === "api_key") {
			return {
				providerId,
				available: true,
				credentialType: "api_key",
				source: "stored-api-key",
				detail: providerId,
			};
		}
		if (stored?.type === "oauth") {
			return {
				providerId,
				available: true,
				credentialType: "oauth",
				source: "stored-oauth",
				detail: providerId,
			};
		}

		const env = resolveEnvironmentApiKey(providerId, opts?.explicitEnvVar);
		if (env.apiKey) {
			return {
				providerId,
				available: true,
				credentialType: "api_key",
				source: "environment",
				detail: env.source ?? providerId,
			};
		}

		if (opts?.includeFallback !== false) {
			const fallback = this.fallbackResolver?.(providerId)?.trim();
			if (fallback && fallback.length > 0) {
				return {
					providerId,
					available: true,
					credentialType: "api_key",
					source: "fallback",
					detail: providerId,
				};
			}
		}

		return {
			providerId,
			available: false,
			credentialType: null,
			source: "none",
			detail: null,
		};
	}

	statusForTarget(target: AuthTarget, opts?: { includeFallback?: boolean }): AuthStatus {
		const args: { targetId?: string; explicitEnvVar?: string; includeFallback?: boolean } = {};
		if (opts?.includeFallback !== undefined) args.includeFallback = opts.includeFallback;
		if (target.explicitEnvVar) args.explicitEnvVar = target.explicitEnvVar;
		if (target.targetId) args.targetId = target.targetId;
		return this.status(target.providerId, args);
	}

	private async refreshOAuthCredentialWithLock(
		providerId: string,
	): Promise<{ apiKey: string; credential: OAuthCredential } | null> {
		return this.backend.withLockAsync(async (current) => {
			const read = readStorageData(current);
			if (read.damage !== null) {
				this.damage = read.damage;
				throw new AuthStorageDamagedError(read.damage, this.backend.describe?.());
			}
			const currentData = read.data;
			this.data = currentData;
			this.damage = null;
			const stored = currentData[providerId];
			if (stored?.type !== "oauth") {
				return { result: null };
			}
			if (Date.now() < stored.expires) {
				return { result: { apiKey: await getOAuthApiKey(providerId, stored), credential: stored } };
			}
			const refreshed = await refreshOAuthCredentials(providerId, stored);
			const next: OAuthCredential = {
				type: "oauth",
				...refreshed,
				updatedAt: nowIso(),
			};
			const merged: AuthStorageData = { ...currentData, [providerId]: next };
			this.data = merged;
			return {
				result: { apiKey: await getOAuthApiKey(providerId, next), credential: next },
				next: serializeStorageData(merged),
			};
		});
	}

	async resolveApiKey(
		providerId: string,
		opts?: { targetId?: string; explicitEnvVar?: string; includeFallback?: boolean },
	): Promise<AuthResolution> {
		if (opts?.targetId) {
			const override = this.runtimeOverrides.get(opts.targetId);
			if (override) {
				return {
					providerId,
					available: true,
					credentialType: "api_key",
					source: "runtime-override",
					detail: providerId,
					apiKey: override,
				};
			}
		}

		const stored = this.data[providerId];
		if (stored?.type === "api_key") {
			const apiKey = resolveStoredApiKey(stored.key, providerId);
			return {
				providerId,
				available: true,
				credentialType: "api_key",
				source: "stored-api-key",
				detail: providerId,
				...(apiKey ? { apiKey } : {}),
			};
		}

		if (stored?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				return {
					providerId,
					available: true,
					credentialType: "oauth",
					source: "stored-oauth",
					detail: providerId,
				};
			}
			if (Date.now() < stored.expires) {
				return {
					providerId,
					available: true,
					credentialType: "oauth",
					source: "stored-oauth",
					detail: providerId,
					apiKey: await getOAuthApiKey(providerId, stored),
				};
			}
			try {
				const refreshed = await this.refreshOAuthCredentialWithLock(providerId);
				if (refreshed) {
					return {
						providerId,
						available: true,
						credentialType: "oauth",
						source: "stored-oauth",
						detail: providerId,
						apiKey: refreshed.apiKey,
					};
				}
			} catch {
				// A refusal already recorded its reason on this.damage; a refresh that
				// failed for any other reason is answered by re-reading the store below.
				this.reload();
				const updated = this.data[providerId];
				if (updated?.type === "oauth" && Date.now() < updated.expires) {
					return {
						providerId,
						available: true,
						credentialType: "oauth",
						source: "stored-oauth",
						detail: providerId,
						apiKey: await getOAuthApiKey(providerId, updated),
					};
				}
			}
			return {
				providerId,
				available: true,
				credentialType: "oauth",
				source: "stored-oauth",
				detail: providerId,
			};
		}

		const env = resolveEnvironmentApiKey(providerId, opts?.explicitEnvVar);
		if (env.apiKey) {
			return {
				providerId,
				available: true,
				credentialType: "api_key",
				source: "environment",
				detail: env.source ?? providerId,
				apiKey: env.apiKey,
			};
		}

		if (opts?.includeFallback !== false) {
			const fallback = this.fallbackResolver?.(providerId)?.trim();
			if (fallback && fallback.length > 0) {
				return {
					providerId,
					available: true,
					credentialType: "api_key",
					source: "fallback",
					detail: providerId,
					apiKey: fallback,
				};
			}
		}

		return {
			providerId,
			available: false,
			credentialType: null,
			source: "none",
			detail: null,
		};
	}

	resolveForTarget(target: AuthTarget, opts?: { includeFallback?: boolean }): Promise<AuthResolution> {
		const args: { targetId?: string; explicitEnvVar?: string; includeFallback?: boolean } = {};
		if (opts?.includeFallback !== undefined) args.includeFallback = opts.includeFallback;
		if (target.explicitEnvVar) args.explicitEnvVar = target.explicitEnvVar;
		if (target.targetId) args.targetId = target.targetId;
		return this.resolveApiKey(target.providerId, args);
	}

	async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
		const credentials = await loginWithOAuthProvider(providerId, callbacks);
		this.set(providerId, { type: "oauth", ...credentials, updatedAt: nowIso() });
	}

	logout(providerId: string): void {
		this.remove(providerId);
	}

	getOAuthProviders(): ReadonlyArray<{ id: string; name: string }> {
		return listOAuthProviders()
			.map((provider) => ({ id: provider.id, name: provider.name }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}
}
