import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
	getEngineOAuthApiKey,
	getEngineOAuthProvider,
	listEngineOAuthProviders,
	loginWithEngineOAuthProvider,
	refreshEngineOAuthCredentials,
} from "../../../engine/oauth.js";

export function getOAuthProvider(providerId: string): OAuthProviderInterface | undefined {
	return getEngineOAuthProvider(providerId);
}

export function listOAuthProviders(): OAuthProviderInterface[] {
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

export function getOAuthApiKey(providerId: string, credentials: OAuthCredentials): string {
	return getEngineOAuthApiKey(providerId, credentials);
}
