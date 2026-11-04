/**
 * An engine over any chat target that can hold a reply to a schema: every question
 * of a call in one request (`llm-batch.ts`), named by what the server reported on
 * that response. A label has no probability scale, so this engine declares a label
 * readout. Another readout would be another declared capability, not a mode.
 */

import { modelEndpointKey, registerForegroundStream } from "../../providers/endpoint-capacity.js";
import type { OneShotPort } from "../../providers/one-shot.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import { engineCapabilities, PROFILES } from "../profiles.js";
import type { DecisionEngine, EngineDestination, EngineReply, EngineRequest } from "../types.js";
import {
	BATCH_PROMPT_VERSION,
	batchMaxTokens,
	batchPrompt,
	batchSchema,
	decidedAnswer,
	isDecided,
	readBatchReply,
	renderState,
} from "./llm-batch.js";
import type { AnsweredIdentity, Channel } from "./llm-wire.js";
import { chatBaseUrl, createHttpChannel, createOneShotChannel, hasChatWire } from "./llm-wire.js";
import type { EngineHost } from "./shared.js";

/** Headroom for the system prompt and framing that the state estimate does not count. */
const PROMPT_RESERVE_TOKENS = 256;

export interface LlmEngineInput {
	readonly name: string;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string | null;
	readonly host: EngineHost;
	readonly oneShot?: OneShotPort | undefined;
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		// A malformed URL still has to yield a stable build key; the request itself fails loudly.
		return baseUrl;
	}
}

/** The build a response is named under: the name and fingerprint this response reported. */
function batchBuild(target: TargetDescriptor, runtimeId: string, answered: AnsweredIdentity): string {
	const baseUrl = hasChatWire(runtimeId) ? chatBaseUrl(runtimeId, target) : null;
	const fingerprint = answered.fingerprint === undefined ? "" : `~${answered.fingerprint}`;
	return `llm:${runtimeId}@${baseUrl === null ? "oneshot" : hostOf(baseUrl)}/${answered.model}${fingerprint}#batch:${BATCH_PROMPT_VERSION}`;
}

/** Why an LLM engine over this target cannot answer, or null when it can. */
export function llmEngineProblem(input: {
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string | null;
	readonly oneShot: boolean;
}): string | null {
	const { target, runtime } = input;
	if (!runtime.defaultCapabilities.chat && target.capabilities?.chat !== true) {
		return `runtime '${runtime.id}' has no chat wire`;
	}
	if (hasChatWire(runtime.id)) {
		if (chatBaseUrl(runtime.id, target) === null) return `target '${target.id}' has no url`;
	} else if (!input.oneShot) {
		return `runtime '${runtime.id}' has no HTTP chat wire and no one-shot port is available`;
	}
	if ((input.model ?? target.defaultModel) === undefined) {
		return `no model: name one on the engine or give target '${target.id}' a default model`;
	}
	return null;
}

/** Every question of the call in one request. An unreadable reply is a failed call, never a guess. */
async function decideBatch(
	channel: Channel,
	target: TargetDescriptor,
	runtimeId: string,
	name: string,
	request: EngineRequest,
): Promise<EngineReply> {
	const asked: Record<string, EngineRequest["questions"][string]> = {};
	const answers: Record<string, EngineReply["answers"][string]> = {};
	for (const [id, question] of Object.entries(request.questions)) {
		if (!isDecided(question)) {
			asked[id] = question;
			continue;
		}
		const only = decidedAnswer(question);
		if (only !== null) answers[id] = only;
	}
	const reply = await channel.batch(
		batchPrompt(renderState(request.state), asked),
		batchSchema(asked),
		batchMaxTokens(asked),
	);
	// A response that names no model can't be told apart from any other server's.
	if (reply.answered === null)
		throw new Error(`llm engine '${name}': the response names no model, so no identity is established`);
	const read = readBatchReply(reply.text, asked);
	if (read === null) throw new Error(`llm engine '${name}' returned no JSON object`);
	return {
		build: batchBuild(target, runtimeId, reply.answered),
		answers: { ...answers, ...read },
		...(reply.usage ? { usage: reply.usage } : {}),
	};
}

function promptWindow(declared: unknown): number | null {
	if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) return null;
	return declared > PROMPT_RESERVE_TOKENS * 4 ? declared - PROMPT_RESERVE_TOKENS : declared;
}

export function createLlmEngine(input: LlmEngineInput): DecisionEngine {
	const { name, target, runtime, model, host } = input;
	const profile = PROFILES["llm-structured"];
	const destination: EngineDestination = {
		targetId: target.id,
		runtimeId: runtime.id,
		wireModelId: model ?? target.defaultModel ?? null,
		...(target.url !== undefined ? { url: target.url } : {}),
	};
	return {
		name,
		kind: "llm",
		profile: profile.id,
		destination,
		capabilities: engineCapabilities(
			profile,
			promptWindow(target.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow),
		),
		async decide(request: EngineRequest): Promise<EngineReply> {
			const wireModel = destination.wireModelId;
			if (wireModel === null) throw new Error(`llm engine '${name}' has no model`);
			const baseUrl = hasChatWire(runtime.id) ? chatBaseUrl(runtime.id, target) : null;
			if (baseUrl === null && input.oneShot === undefined) {
				throw new Error(`llm engine '${name}' has no chat wire and no one-shot port`);
			}
			const channel =
				baseUrl !== null
					? createHttpChannel({ engine: name, target, runtime, model: wireModel, baseUrl, host, signal: request.signal })
					: createOneShotChannel({
							engine: name,
							targetId: destination.targetId,
							model: wireModel,
							port: input.oneShot as OneShotPort,
							signal: request.signal,
						});
			// An ask is something a caller waits on, so on a one-slot server it preempts
			// background memory rather than queueing behind optional work.
			const endpointKey = modelEndpointKey(target, wireModel);
			const release = endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
			try {
				return await decideBatch(channel, target, runtime.id, name, request);
			} finally {
				release();
			}
		},
	};
}
