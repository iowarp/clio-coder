import {
	type EngineOAuthProvider,
	getEngineOAuthApiKey,
	getEngineOAuthProvider,
	listEngineOAuthProviders,
	loginWithEngineOAuthProvider,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	refreshEngineOAuthCredentials,
} from "../../../engine/oauth.js";

export function getOAuthProvider(providerId: string): EngineOAuthProvider | undefined {
	return getEngineOAuthProvider(providerId);
}

export function listOAuthProviders(): EngineOAuthProvider[] {
	return listEngineOAuthProviders();
}

export async function loginWithOAuthProvider(
	providerId: string,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	return loginWithEngineOAuthProvider(providerId, callbacks);
}

export async function refreshOAuthCredentials(
	providerId: string,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	return refreshEngineOAuthCredentials(providerId, credentials);
}

export function getOAuthApiKey(providerId: string, credentials: OAuthCredentials): Promise<string> {
	return getEngineOAuthApiKey(providerId, credentials);
}
