/**
 * Thin engine-boundary wrapper over pi-ai OAuth flows.
 *
 * pi-ai 0.83 removed the global OAuth provider registry
 * (`registerOAuthProvider`/`getOAuthProvider`) in favor of per-provider
 * `ProviderAuth.oauth` flows (`login`/`refresh`/`toAuth`). Clio owns its own
 * credential persistence (`openAuthStorage()`), so this module keeps a small
 * Clio-side registry keyed by provider id that adapts those flows to the
 * engine surface the domains consume. Domains and CLI code must import these
 * helpers from src/engine/** rather than value-importing pi-ai directly.
 */

import type {
	AuthInteraction,
	OAuthAuth,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import { findEnvKeys as piFindEnvKeys, getEnvApiKey as piGetEnvApiKey } from "@earendil-works/pi-ai/compat";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { alcfOAuthProvider } from "./alcf-oauth.js";

export type { OAuthCredentials, OAuthLoginCallbacks, OAuthSelectPrompt };

/**
 * Clio's engine-level OAuth provider surface. Login keeps the legacy callback
 * shape the CLI and TUI implement; `getApiKey` is async because pi's
 * `OAuthAuth.toAuth` derivation is async.
 */
export interface EngineOAuthProvider {
	id: string;
	name: string;
	usesCallbackServer: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): Promise<string>;
}

/** Adapt Clio's legacy login callbacks to pi's AuthInteraction. */
function interactionFromLoginCallbacks(callbacks: OAuthLoginCallbacks): AuthInteraction {
	const interaction: AuthInteraction = {
		notify(event) {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({
						url: event.url,
						...(event.instructions === undefined ? {} : { instructions: event.instructions }),
					});
					return;
				case "device_code":
					callbacks.onDeviceCode({
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
						...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
					});
					return;
				case "progress":
				case "info":
					callbacks.onProgress?.(event.message);
					return;
			}
		},
		async prompt(prompt) {
			switch (prompt.type) {
				case "select": {
					const selection = await callbacks.onSelect({
						message: prompt.message,
						options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
					});
					if (selection === undefined) throw new Error("login cancelled");
					return selection;
				}
				case "manual_code":
					if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
					return callbacks.onPrompt({
						message: prompt.message,
						...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
					});
				default:
					return callbacks.onPrompt({
						message: prompt.message,
						...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
					});
			}
		},
	};
	if (callbacks.signal) interaction.signal = callbacks.signal;
	return interaction;
}

function fromOAuthAuth(id: string, auth: OAuthAuth | undefined, usesCallbackServer: boolean): EngineOAuthProvider {
	if (!auth) throw new Error(`pi-ai provider "${id}" no longer exposes an OAuth flow`);
	return {
		id,
		name: auth.name,
		usesCallbackServer,
		async login(callbacks) {
			return auth.login(interactionFromLoginCallbacks(callbacks));
		},
		async refreshToken(credentials) {
			return auth.refresh({ ...credentials, type: "oauth" });
		},
		async getApiKey(credentials) {
			const resolved = await auth.toAuth({ ...credentials, type: "oauth" });
			if (!resolved.apiKey) {
				throw new Error(`OAuth provider "${id}" resolved no API key from the stored credential`);
			}
			return resolved.apiKey;
		},
	};
}

let providers: Map<string, EngineOAuthProvider> | null = null;

function builtinProviders(): EngineOAuthProvider[] {
	return [
		fromOAuthAuth("anthropic", anthropicProvider().auth.oauth, true),
		fromOAuthAuth("openai-codex", openaiCodexProvider().auth.oauth, true),
		fromOAuthAuth("github-copilot", githubCopilotProvider().auth.oauth, false),
	];
}

function registry(): Map<string, EngineOAuthProvider> {
	if (!providers) {
		providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	}
	return providers;
}

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

export function getEngineOAuthProvider(providerId: string): EngineOAuthProvider | undefined {
	return registry().get(providerId);
}

export function listEngineOAuthProviders(): EngineOAuthProvider[] {
	return [...registry().values()];
}

function registerEngineOAuthProvider(provider: EngineOAuthProvider): void {
	registry().set(provider.id, provider);
}

let clioOAuthProvidersRegistered = false;

export function registerClioOAuthProviders(): void {
	if (clioOAuthProvidersRegistered) return;
	clioOAuthProvidersRegistered = true;
	registerEngineOAuthProvider(alcfOAuthProvider);
}

export async function loginWithEngineOAuthProvider(
	providerId: string,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const provider = registry().get(providerId);
	if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
	return provider.login(callbacks);
}

export async function refreshEngineOAuthCredentials(
	providerId: string,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = registry().get(providerId);
	if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
	return provider.refreshToken(credentials);
}

export async function getEngineOAuthApiKey(providerId: string, credentials: OAuthCredentials): Promise<string> {
	const provider = registry().get(providerId);
	if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
	return provider.getApiKey(credentials);
}
