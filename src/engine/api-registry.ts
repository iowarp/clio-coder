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

import { telemetryContext } from "../core/telemetry/context.js";
import { telemetryCallInContext } from "../core/telemetry/producer.js";
import { withAnthropicDiagnostics } from "./apis/anthropic-diagnostics.js";
import { observeAnthropicResponse } from "./apis/anthropic-response.js";
import { withCodexConfiguration } from "./apis/codex-configuration.js";
import { withCodexPromptItems } from "./apis/codex-prompt-items.js";
import { observeCodexTransport } from "./apis/codex-transport.js";
import { withProviderCheckpoint } from "./apis/openai-compaction.js";
import { observeResponsesModelId } from "./apis/responses-model-id.js";
import { filterAssistantProseStream } from "./assistant-prose-stream.js";
import { withClioIdentity } from "./client-identity.js";
import { normalizeContext } from "./context.js";
import { getEngineEnvApiKey } from "./env-api-keys.js";
import { onFirstGeneration } from "./generation-delta.js";
import { observePayloadBytes } from "./payload-bytes.js";
import { instrumentProviderCall, type ProviderCallScope } from "./provider-diagnostics.js";
import { researchCaptureFor } from "./research-capture.js";
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
	requested?: StreamOptions,
): AssistantMessageEventStream {
	registerEngineBuiltins();
	const options = withClioIdentity(requested);
	if (compatUniverse) return compatUniverse.stream(model, context, options);
	return resolved(model.api).stream(model, normalizeContext(context), withEnvApiKey(model, options));
}

function dispatchEngineStreamSimple(
	model: Model<Api>,
	context: Context,
	requested?: SimpleStreamOptions,
): AssistantMessageEventStream {
	registerEngineBuiltins();
	const options = withClioIdentity(requested);
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
			instrumentProviderCall(
				model,
				withProviderCheckpoint(
					model,
					withAnthropicDiagnostics(
						model,
						context,
						withCodexConfiguration(model, withCodexPromptItems(model, guarded), context),
					),
					context,
				),
				(effective) =>
					observeAnthropicResponse(model, effective, (anthropic) =>
						observeCodexTransport(model, anthropic, (transport) =>
							observeResponsesModelId(model, transport, (observed) =>
								observePayloadBytes(model, observed, (sized) => dispatchEngineStream(model, context, sized)),
							),
						),
					),
			),
		),
		model,
	);
}

export function engineStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return scopedEngineStreamSimple(model, context, options, "side");
}

/**
 * The session's own turn requests, and the prewarm that replays them through
 * the agent's stream function. Only these take a runtime's main-thread cache
 * retention, so prewarm and turn send the same cache_control (#422).
 */
export function engineMainStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return scopedEngineStreamSimple(model, context, options, "main");
}

function scopedEngineStreamSimple(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	scope: ProviderCallScope,
): AssistantMessageEventStream {
	// A call whose attempt context this request runs in is timed here: side calls through their call scope and main
	// attempts through turn-runtime. Main and worker attempts also mark their own stages; each keeps its first (#434).
	const call = telemetryCallInContext();
	call?.stage("send", "start");
	const research = researchCaptureFor(call, telemetryContext());
	// The one place a call sees its provider's HTTP response; the caller's own hook still runs after it (#434).
	const withResponse: SimpleStreamOptions | undefined = call?.observeResponse
		? {
				...options,
				onResponse: async (response, responseModel) => {
					call.observeResponse?.(response);
					await options?.onResponse?.(response, responseModel);
				},
			}
		: options;
	const stream = filterAssistantProseStream(
		guardToolArgumentStream(model, context, withResponse, (guarded) =>
			instrumentProviderCall(
				model,
				withProviderCheckpoint(
					model,
					withAnthropicDiagnostics(
						model,
						context,
						withCodexConfiguration(model, withCodexPromptItems(model, guarded), context),
					),
					context,
				),
				(effective) =>
					observeAnthropicResponse(model, effective, (anthropic) =>
						observeCodexTransport(model, anthropic, (transport) =>
							observeResponsesModelId(model, transport, (observed) =>
								observePayloadBytes(
									model,
									observed,
									(sized) => dispatchEngineStreamSimple(model, context, sized),
									research?.settle,
								),
							),
						),
					),
				scope,
			),
		),
		model,
	);
	if (!call) return stream;
	// Pi's provider owns the request from here under transport option B; TTFT is firstToken minus send.end.
	call.stage("send", "end");
	return onFirstGeneration(stream, () => call.mark("firstToken"), call.delta);
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
