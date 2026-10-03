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

import { filterAssistantProseStream } from "./assistant-prose-stream.js";
import { normalizeContext } from "./context.js";
import { getEngineEnvApiKey } from "./env-api-keys.js";
import { instrumentProviderCall } from "./provider-diagnostics.js";
import { guardToolArgumentStream } from "./tool-argument-stream.js";

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

export function registerEngineApiProvider(provider: EngineRegisteredApiProvider, sourceId?: string): void {
	registry.set(provider.api, { provider, ...(sourceId === undefined ? {} : { sourceId }) });
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

function resolved(api: Api): EngineRegisteredApiProvider {
	const provider = getEngineApiProvider(api);
	if (!provider) throw new Error(`No API provider registered for api: ${api}`);
	return provider;
}

function dispatchEngineStream(
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	registerEngineBuiltins();
	if (compatUniverse) return compatUniverse.stream(model, context, options);
	return resolved(model.api).stream(model, normalizeContext(context), withEnvApiKey(model, options));
}

function dispatchEngineStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	registerEngineBuiltins();
	if (compatUniverse) return compatUniverse.streamSimple(model, context, options);
	return resolved(model.api).streamSimple(model, normalizeContext(context), withEnvApiKey(model, options));
}

export function engineStream(
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	return filterAssistantProseStream(
		guardToolArgumentStream(model, context, options, (guarded) =>
			instrumentProviderCall(model, guarded, (effective) => dispatchEngineStream(model, context, effective)),
		),
		model,
	);
}

export function engineStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return filterAssistantProseStream(
		guardToolArgumentStream(model, context, options, (guarded) =>
			instrumentProviderCall(model, guarded, (effective) => dispatchEngineStreamSimple(model, context, effective)),
		),
		model,
	);
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
