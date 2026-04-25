import { findEngineEnvKeys, getEngineEnvApiKey } from "../../../engine/oauth.js";

export interface EnvironmentApiKeyResolution {
	apiKey: string | undefined;
	source: string | null;
}

export function resolveStoredApiKey(key: string): string | undefined {
	const trimmed = key.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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
