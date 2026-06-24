/**
 * Thin engine-boundary wrapper over pi-ai OAuth helpers.
 *
 * Domains and CLI code must import these helpers from src/engine/** rather
 * than value-importing pi-ai directly.
 */

import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
	type OAuthProviderInterface,
	type OAuthSelectPrompt,
	findEnvKeys as piFindEnvKeys,
	getEnvApiKey as piGetEnvApiKey,
} from "@earendil-works/pi-ai";
import {
	getOAuthProvider as piGetOAuthProvider,
	getOAuthProviders as piGetOAuthProviders,
	loginOpenAICodex as piLoginOpenAICodex,
	registerOAuthProvider as piRegisterOAuthProvider,
	resetOAuthProviders as piResetOAuthProviders,
	unregisterOAuthProvider as piUnregisterOAuthProvider,
} from "@earendil-works/pi-ai/oauth";
import { alcfOAuthProvider } from "./alcf-oauth.js";

export type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderId, OAuthProviderInterface, OAuthSelectPrompt };

export function getEngineEnvApiKey(providerId: string): string | undefined {
	try {
		return piGetEnvApiKey(providerId);
	} catch {
		return undefined;
	}
}

export function findEngineEnvKeys(providerId: string): string[] | undefined {
	try {
		return piFindEnvKeys(providerId);
	} catch {
		return undefined;
	}
}

export function getEngineOAuthProvider(providerId: string): OAuthProviderInterface | undefined {
	return piGetOAuthProvider(providerId);
}

export function listEngineOAuthProviders(): OAuthProviderInterface[] {
	return piGetOAuthProviders();
}

export function registerEngineOAuthProvider(provider: OAuthProviderInterface): void {
	piRegisterOAuthProvider(provider);
}

export function unregisterEngineOAuthProvider(providerId: string): void {
	piUnregisterOAuthProvider(providerId);
}

export function resetEngineOAuthProviders(): void {
	clioOAuthProvidersRegistered = false;
	piResetOAuthProviders();
}

let clioOAuthProvidersRegistered = false;

export function registerClioOAuthProviders(): void {
	if (clioOAuthProvidersRegistered) return;
	clioOAuthProvidersRegistered = true;
	registerEngineOAuthProvider(alcfOAuthProvider);
}

export async function loginWithEngineOAuthProvider(
	providerId: OAuthProviderId,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	if (providerId === "openai-codex") {
		return piLoginOpenAICodex({
			...callbacks,
			originator: "clio",
		});
	}
	const provider = piGetOAuthProvider(providerId);
	if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
	return provider.login(callbacks);
}

export async function refreshEngineOAuthCredentials(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = piGetOAuthProvider(providerId);
	if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
	return provider.refreshToken(credentials);
}

export function getEngineOAuthApiKey(providerId: OAuthProviderId, credentials: OAuthCredentials): string {
	const provider = piGetOAuthProvider(providerId);
	if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
	return provider.getApiKey(credentials);
}
