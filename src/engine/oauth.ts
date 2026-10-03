/**
 * Engine-boundary wrapper over pi-ai provider auth.
 *
 * Pi owns the OAuth protocol: `Models.getAuth()` refreshes an expiring token
 * under the credential store's lock, re-checks expiry inside it, and derives
 * request auth with `OAuthAuth.toAuth`. Clio owns where credentials live, so
 * the domain's `AuthStorage` implements Pi's `CredentialStore` and this module
 * binds one `Models` to each store. Domains and CLI code import these helpers
 * from src/engine/** rather than value-importing pi-ai directly.
 *
 * Only providers Clio has a runtime or login flow for appear here. Pi's
 * `openai` and `openrouter` providers also advertise OAuth, but a stored
 * `openai` OAuth credential would be read by the API-key `openai` runtime as
 * a bearer for the wrong endpoint, so the list is an allow-list.
 */

import type {
	CredentialStore,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthSelectPrompt,
	Provider,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { alcfOAuth } from "./alcf-oauth.js";

export type { OAuthCredentials, OAuthLoginCallbacks, OAuthSelectPrompt };

const ALCF_GATEWAY_ORIGIN = "https://inference-api.alcf.anl.gov/resource_server";

/** Adapt Clio's login callbacks, which the CLI and TUI implement, to Pi's AuthInteraction. */
function interactionFromLoginCallbacks(callbacks: OAuthLoginCallbacks): ProviderAuthInteraction {
	return {
		signal: callbacks.signal ?? new AbortController().signal,
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
}

let providers: ReadonlyMap<string, Provider> | undefined;

function oauthProviders(): ReadonlyMap<string, Provider> {
	providers ??= new Map(
		[
			anthropicProvider(),
			openaiCodexProvider(),
			githubCopilotProvider(),
			createProvider({
				id: "alcf",
				name: "ALCF Inference",
				baseUrl: ALCF_GATEWAY_ORIGIN,
				auth: { oauth: alcfOAuth },
				models: [],
				api: openAICompletionsApi(),
			}),
		].map((provider): [string, Provider] => [provider.id, provider]),
	);
	return providers;
}

export function hasEngineOAuthProvider(providerId: string): boolean {
	return oauthProviders().has(providerId);
}

export function listEngineOAuthProviders(): ReadonlyArray<{ id: string; name: string }> {
	return [...oauthProviders().values()].flatMap((provider) =>
		provider.auth.oauth ? [{ id: provider.id, name: provider.auth.oauth.name }] : [],
	);
}

export async function loginWithEngineOAuthProvider(
	providerId: string,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const oauth = oauthProviders().get(providerId)?.auth.oauth;
	if (!oauth) throw new Error(`unknown OAuth provider: ${providerId}`);
	return oauth.login(interactionFromLoginCallbacks(callbacks));
}

const modelsByStore = new WeakMap<CredentialStore, MutableModels>();

function modelsFor(store: CredentialStore): MutableModels {
	let models = modelsByStore.get(store);
	if (!models) {
		models = createModels({ credentials: store });
		for (const provider of oauthProviders().values()) models.setProvider(provider);
		modelsByStore.set(store, models);
	}
	return models;
}

/**
 * Request auth for a stored OAuth credential. Pi refreshes through `store.modify`
 * when the token expires within five minutes and rejects with a ModelsError when
 * the refresh or the store write fails. A token that has not expired yet still
 * authenticates, so a failed early refresh falls back to it instead of dropping a
 * key the caller could have used until true expiry. An expired token, a missing
 * credential and an abort propagate to the caller.
 */
export async function resolveEngineOAuthApiKey(
	store: CredentialStore,
	providerId: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const resolved = await modelsFor(store).getAuth(providerId, signal ? { signal } : undefined);
		return resolved?.auth.apiKey;
	} catch (error) {
		if (signal?.aborted) throw error;
		const oauth = oauthProviders().get(providerId)?.auth.oauth;
		const credential = await store.read(providerId);
		if (oauth && credential?.type === "oauth" && Date.now() < credential.expires) {
			return (await oauth.toAuth(credential)).apiKey;
		}
		throw error;
	}
}
