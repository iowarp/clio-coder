import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import {
	createFauxCore,
	type FauxProviderRegistration,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai/providers/faux";
import "@earendil-works/pi-ai/providers/images/register-builtins";

import { getEngineEnvApiKey } from "./env-api-keys.js";
import { engineModels } from "./models.js";

export interface EngineRegisteredApiProvider extends ProviderStreams {
	api: Api;
}

interface RegistryEntry {
	provider: EngineRegisteredApiProvider;
	sourceId?: string;
}

interface CompatUniverse {
	registerApiProvider(provider: EngineRegisteredApiProvider, sourceId?: string): void;
	unregisterApiProviders(sourceId: string): void;
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

const registry = new Map<Api, RegistryEntry>();
const builtinInstances = new Map<Api, EngineRegisteredApiProvider>();
let compatUniverse: CompatUniverse | undefined;
let compatUniversePromise: Promise<void> | undefined;
let builtinsRegistered = false;

function wrappedProvider(provider: EngineRegisteredApiProvider): EngineRegisteredApiProvider {
	const { api } = provider;
	return {
		api,
		stream(model, context, options) {
			if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
			return provider.stream(model, context, options);
		},
		streamSimple(model, context, options) {
			if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
			return provider.streamSimple(model, context, options);
		},
	};
}

export function registerEngineApiProvider(provider: EngineRegisteredApiProvider, sourceId?: string): void {
	const wrapped = wrappedProvider(provider);
	registry.set(provider.api, { provider: wrapped, ...(sourceId === undefined ? {} : { sourceId }) });
	compatUniverse?.registerApiProvider(provider, sourceId);
}

function unregisterEngineApiProviders(sourceId: string): void {
	for (const [api, entry] of registry) {
		if (entry.sourceId === sourceId) registry.delete(api);
	}
	compatUniverse?.unregisterApiProviders(sourceId);
}

function getEngineApiProvider(api: Api): EngineRegisteredApiProvider | undefined {
	return registry.get(api)?.provider;
}

const BUILTIN_APIS: readonly (readonly [Api, ProviderStreams])[] = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	["pi-messages", piMessagesApi()],
];

export function registerEngineBuiltins(): void {
	if (builtinsRegistered) return;
	builtinsRegistered = true;
	for (const [api, streams] of BUILTIN_APIS) {
		if (!getEngineApiProvider(api)) registerEngineApiProvider({ api, ...streams });
		const registered = getEngineApiProvider(api);
		if (registered) builtinInstances.set(api, registered);
	}
}

function withEnvApiKey<T extends StreamOptions | SimpleStreamOptions>(
	model: Model<Api>,
	options: T | undefined,
): T | undefined {
	if (typeof options?.apiKey === "string" && options.apiKey.trim().length > 0) return options;
	const apiKey = getEngineEnvApiKey(model.provider, options?.env);
	if (!apiKey || apiKey === "<authenticated>") return options;
	return { ...options, apiKey } as T;
}

function builtinProvider(model: Model<Api>) {
	if (getEngineApiProvider(model.api) !== builtinInstances.get(model.api)) return undefined;
	const provider = engineModels.getProvider(model.provider);
	return provider?.getModels().some((candidate) => candidate.api === model.api) ? provider : undefined;
}

function resolved(api: Api): EngineRegisteredApiProvider {
	const provider = getEngineApiProvider(api);
	if (!provider) throw new Error(`No API provider registered for api: ${api}`);
	return provider;
}

function hasCloudflareAuth(options?: StreamOptions): boolean {
	return (
		(typeof options?.apiKey === "string" && options.apiKey.trim().length > 0) ||
		typeof options?.headers?.["cf-aig-authorization"] === "string"
	);
}

export function engineStream(
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	registerEngineBuiltins();
	if (compatUniverse) return compatUniverse.stream(model, context, options);
	const provider = builtinProvider(model);
	if (provider) {
		if (model.provider.startsWith("cloudflare-") && !hasCloudflareAuth(options)) {
			return engineModels.stream(model, context, options);
		}
		return provider.stream(model, context, withEnvApiKey(model, options));
	}
	return resolved(model.api).stream(model, context, withEnvApiKey(model, options));
}

export function engineStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	registerEngineBuiltins();
	if (compatUniverse) return compatUniverse.streamSimple(model, context, options);
	const provider = builtinProvider(model);
	if (provider) {
		if (model.provider.startsWith("cloudflare-") && !hasCloudflareAuth(options)) {
			return engineModels.streamSimple(model, context, options);
		}
		return provider.streamSimple(model, context, withEnvApiKey(model, options));
	}
	return resolved(model.api).streamSimple(model, context, withEnvApiKey(model, options));
}

export async function completeEngineSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return engineStreamSimple(model, context, options).result();
}

/** Engine-owned fixture seam for decorating a faux transport before registration. */
export { createFauxCore as createEngineFauxCore };

export function registerEngineFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	registerEngineBuiltins();
	const core = createFauxCore(options);
	const sourceId = `faux-provider-${Math.random().toString(36).slice(2, 10)}`;
	registerEngineApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, sourceId);
	return {
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
		unregister() {
			unregisterEngineApiProviders(sourceId);
		},
	};
}

/**
 * Join Pi's process-global registry before importing an external runtime.
 * This is intentionally the only dynamic /compat edge: no configured plugin,
 * no aggregate module. Existing Clio overrides are mirrored before plugin
 * evaluation so plugin registrations retain their historical last-writer wins.
 */
export async function activateExternalPluginApiBridge(): Promise<void> {
	if (compatUniverse) return;
	compatUniversePromise ??= (async () => {
		registerEngineBuiltins();
		const compat = (await import("@earendil-works/pi-ai/compat")) as CompatUniverse;
		for (const [api, entry] of registry) {
			// Pi's compat import has already installed its own built-ins and must keep
			// those identities so provider-owned auth/header dispatch remains active.
			if (entry.provider === builtinInstances.get(api)) continue;
			compat.registerApiProvider(entry.provider, entry.sourceId);
		}
		compatUniverse = compat;
	})().catch((error: unknown) => {
		compatUniversePromise = undefined;
		throw error;
	});
	await compatUniversePromise;
}

registerEngineBuiltins();
