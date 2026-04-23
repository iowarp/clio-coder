import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { OAuthLoginCallbacks } from "../../../engine/oauth.js";
import type { EndpointDescriptor } from "../types/endpoint-descriptor.js";
import type { RuntimeAuth, RuntimeDescriptor } from "../types/runtime-descriptor.js";

import { resolveEnvironmentApiKey, resolveStoredApiKey } from "./api-key.js";
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
}

export interface AuthTarget {
	providerId: string;
	/**
	 * Endpoint id scoping runtime overrides. Absent for runtime-only targets
	 * (e.g. the auth-selector list of connectable providers) because those do
	 * not belong to a specific endpoint.
	 */
	endpointId?: string;
	explicitEnvVar?: string;
	runtimeAuth: RuntimeAuth;
}

export interface AuthStatus {
	providerId: string;
	available: boolean;
	credentialType: AuthCredential["type"] | null;
	source: "runtime-override" | "stored-api-key" | "stored-oauth" | "environment" | "fallback" | "none";
	detail: string | null;
}

export interface AuthResolution extends AuthStatus {
	apiKey?: string;
}

interface StorageShapeV1 {
	version?: 1;
	entries?: Record<string, { key?: string; updatedAt?: string }>;
}

interface StorageShapeV2 {
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

function parseStorageData(content: string | undefined): AuthStorageData {
	if (!content || content.trim().length === 0) return emptyData();
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch {
		return emptyData();
	}
	if (!isRecord(parsed)) return emptyData();
	const entries = isRecord(parsed.entries) ? parsed.entries : null;
	if (!entries) return emptyData();

	const data: AuthStorageData = {};
	const version = parsed.version;
	if (
		version === 1 ||
		(version === undefined && Object.values(entries).every((value) => isRecord(value) && "key" in value))
	) {
		for (const [providerId, value] of Object.entries((entries as StorageShapeV1["entries"]) ?? {})) {
			if (!value || typeof value.key !== "string" || value.key.trim().length === 0) continue;
			data[providerId] = {
				type: "api_key",
				key: value.key,
				updatedAt: typeof value.updatedAt === "string" && value.updatedAt.length > 0 ? value.updatedAt : nowIso(),
			};
		}
		return data;
	}

	for (const [providerId, value] of Object.entries((entries as StorageShapeV2["entries"]) ?? {})) {
		const apiKey = toApiKeyCredential(value);
		if (apiKey) {
			data[providerId] = apiKey;
			continue;
		}
		const oauth = toOAuthCredential(value);
		if (oauth) {
			data[providerId] = oauth;
		}
	}
	return data;
}

function serializeStorageData(data: AuthStorageData): string {
	return stringifyYaml({
		version: 2,
		entries: data,
	});
}

export function resolveAuthTarget(endpoint: EndpointDescriptor, runtime: RuntimeDescriptor): AuthTarget {
	const providerId = endpoint.auth?.oauthProfile?.trim() || endpoint.auth?.apiKeyRef?.trim() || runtime.id;
	const target: AuthTarget = {
		providerId,
		endpointId: endpoint.id,
		runtimeAuth: runtime.auth,
	};
	const explicitEnvVar = endpoint.auth?.apiKeyEnvVar ?? runtime.credentialsEnvVar;
	if (explicitEnvVar) target.explicitEnvVar = explicitEnvVar;
	return target;
}

export function resolveRuntimeAuthTarget(runtime: RuntimeDescriptor): AuthTarget {
	const target: AuthTarget = {
		providerId: runtime.id,
		runtimeAuth: runtime.auth,
	};
	if (runtime.credentialsEnvVar) target.explicitEnvVar = runtime.credentialsEnvVar;
	return target;
}

export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides = new Map<string, string>();
	private fallbackResolver?: (providerId: string) => string | undefined;
	private errors: Error[] = [];

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
			this.data = parseStorageData(content);
		} catch (error) {
			this.recordError(error);
			this.data = emptyData();
		}
	}

	private recordError(error: unknown): void {
		this.errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	private persist(providerId: string, credential: AuthCredential | undefined): void {
		try {
			this.backend.withLock((current) => {
				const merged = parseStorageData(current);
				if (credential) merged[providerId] = credential;
				else delete merged[providerId];
				this.data = merged;
				return { result: undefined, next: serializeStorageData(merged) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	get(providerId: string): AuthCredential | undefined {
		return this.data[providerId];
	}

	set(providerId: string, credential: AuthCredential): void {
		this.data[providerId] = credential;
		this.persist(providerId, credential);
	}

	setApiKey(providerId: string, key: string): void {
		const resolved = resolveStoredApiKey(key);
		if (!resolved) throw new Error(`auth.setApiKey: empty key for provider=${providerId}`);
		this.set(providerId, { type: "api_key", key: resolved, updatedAt: nowIso() });
	}

	remove(providerId: string): void {
		delete this.data[providerId];
		this.persist(providerId, undefined);
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
	 * Install a process-lifetime API key override scoped to a specific endpoint.
	 * Overrides are keyed by `endpointId` (not providerId) so two endpoints
	 * sharing a runtime do not share the override. `clio --api-key <key>`
	 * applies only to the active endpoint, not every endpoint on that provider.
	 */
	setRuntimeOverride(endpointId: string, apiKey: string): void {
		if (endpointId.length === 0) {
			throw new Error("auth.setRuntimeOverride: empty endpointId");
		}
		const resolved = resolveStoredApiKey(apiKey);
		if (!resolved) throw new Error(`auth.setRuntimeOverride: empty key for endpoint=${endpointId}`);
		this.runtimeOverrides.set(endpointId, resolved);
	}

	clearRuntimeOverride(endpointId: string): void {
		if (endpointId.length === 0) return;
		this.runtimeOverrides.delete(endpointId);
	}

	setFallbackResolver(resolver: (providerId: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	status(
		providerId: string,
		opts?: { endpointId?: string; explicitEnvVar?: string; includeFallback?: boolean },
	): AuthStatus {
		if (opts?.endpointId && this.runtimeOverrides.has(opts.endpointId)) {
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
		const args: { endpointId?: string; explicitEnvVar?: string; includeFallback?: boolean } = {};
		if (opts?.includeFallback !== undefined) args.includeFallback = opts.includeFallback;
		if (target.explicitEnvVar) args.explicitEnvVar = target.explicitEnvVar;
		if (target.endpointId) args.endpointId = target.endpointId;
		return this.status(target.providerId, args);
	}

	private async refreshOAuthCredentialWithLock(
		providerId: string,
	): Promise<{ apiKey: string; credential: OAuthCredential } | null> {
		return this.backend.withLockAsync(async (current) => {
			const currentData = parseStorageData(current);
			this.data = currentData;
			const stored = currentData[providerId];
			if (!stored || stored.type !== "oauth") {
				return { result: null };
			}
			if (Date.now() < stored.expires) {
				return { result: { apiKey: getOAuthApiKey(providerId, stored), credential: stored } };
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
				result: { apiKey: getOAuthApiKey(providerId, next), credential: next },
				next: serializeStorageData(merged),
			};
		});
	}

	async resolveApiKey(
		providerId: string,
		opts?: { endpointId?: string; explicitEnvVar?: string; includeFallback?: boolean },
	): Promise<AuthResolution> {
		if (opts?.endpointId) {
			const override = this.runtimeOverrides.get(opts.endpointId);
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
			const apiKey = resolveStoredApiKey(stored.key);
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
					apiKey: getOAuthApiKey(providerId, stored),
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
			} catch (error) {
				this.recordError(error);
				this.reload();
				const updated = this.data[providerId];
				if (updated?.type === "oauth" && Date.now() < updated.expires) {
					return {
						providerId,
						available: true,
						credentialType: "oauth",
						source: "stored-oauth",
						detail: providerId,
						apiKey: getOAuthApiKey(providerId, updated),
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
		const args: { endpointId?: string; explicitEnvVar?: string; includeFallback?: boolean } = {};
		if (opts?.includeFallback !== undefined) args.includeFallback = opts.includeFallback;
		if (target.explicitEnvVar) args.explicitEnvVar = target.explicitEnvVar;
		if (target.endpointId) args.endpointId = target.endpointId;
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
