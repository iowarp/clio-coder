import { type ResolveConfigValueOptions, resolveDynamicConfigValue } from "../../../core/resolve-config-value.js";
import { findEngineEnvKeys, getEngineEnvApiKey } from "../../../engine/oauth.js";

export interface EnvironmentApiKeyResolution {
	apiKey: string | undefined;
	source: string | null;
}

export function resolveStoredApiKey(key: string, providerId = "stored-api-key"): string | undefined {
	const trimmed = key.trim();
	if (trimmed.length === 0) return undefined;
	return resolveProviderDynamicSecret(trimmed, { providerId, field: "apiKey" });
}

export function normalizeStoredApiKeyRef(key: string): string | undefined {
	const trimmed = key.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveProviderDynamicSecret(
	value: string,
	context: { providerId: string; endpointId?: string; field?: string },
	options?: ResolveConfigValueOptions,
): string | undefined {
	void context;
	return resolveDynamicConfigValue(value, options);
}

export function resolveEnvironmentApiKey(providerId: string, explicitEnvVar?: string): EnvironmentApiKeyResolution {
	if (explicitEnvVar) {
		const fromExplicit = process.env[explicitEnvVar]?.trim();
		if (fromExplicit && fromExplicit.length > 0) {
			return { apiKey: fromExplicit, source: explicitEnvVar };
		}
	}
	for (const envVar of findEngineEnvKeys(providerId) ?? []) {
		const fromKnownEnv = process.env[envVar]?.trim();
		if (fromKnownEnv && fromKnownEnv.length > 0) {
			return { apiKey: fromKnownEnv, source: envVar };
		}
	}
	const fromKnownProvider = getEngineEnvApiKey(providerId)?.trim();
	if (fromKnownProvider && fromKnownProvider.length > 0) {
		return { apiKey: fromKnownProvider, source: null };
	}
	return { apiKey: undefined, source: explicitEnvVar ?? null };
}
