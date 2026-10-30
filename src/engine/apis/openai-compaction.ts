import { createHash } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import type { CallFailureRecord } from "../../core/call-failure.js";
import { classifyCallFailure } from "../../core/call-failure.js";
import { codexAccountScope } from "../../core/codex-account.js";
import type { ProviderCheckpoint } from "../../core/provider-checkpoint.js";
import { readProviderCheckpoint } from "../../core/provider-checkpoint.js";
import { ProviderCompactionError, providerCheckpointFromMessage } from "../../core/provider-checkpoint-handle.js";
import type { CallMessageObserver } from "../../core/telemetry/producer.js";
import { normalizeContext } from "../context.js";
import type { CodexConfiguration, ProviderCheckpointHandle, ProviderCompactionResult } from "../types.js";

type Item = Record<string, unknown>;
type CompactionOptions = {
	clioCompactionTrigger?: boolean;
	clioProviderCompaction?: () => boolean;
	clioProviderCheckpointObserved?: (handle: ProviderCheckpointHandle, inputTokens: number) => void;
	clioCompactionPayload?: (payload: Item) => void;
};
function record(value: unknown): value is Item {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function providerCheckpointCompatibility(
	handle: ProviderCheckpointHandle,
	model: Model<Api>,
	apiKey: string | undefined,
): string | null {
	if (model.api !== "openai-codex-responses") return "non-codex-route";
	try {
		const checkpoint = readProviderCheckpoint(handle);
		if (checkpoint.compatibility.provider !== model.provider || checkpoint.compatibility.model !== model.id)
			return "provider-or-model-changed";
		const account = codexAccountScope(apiKey);
		return account !== null && account === checkpoint.compatibility.accountScope ? null : "account-changed-or-unknown";
	} catch {
		return "checkpoint-unreadable";
	}
}

/** Final payload hook: policy and O2 patches finish before opaque replay or the final trigger (#423). */
export function withProviderCheckpoint<T extends StreamOptions | SimpleStreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	context: Context,
): T | undefined {
	const nativeOptions = options as (T & CompactionOptions) | undefined;
	const trigger = nativeOptions?.clioCompactionTrigger === true;
	const users = normalizeContext(context).messages.filter(
		(message) => message.role === "user" && (typeof message.content === "string" || message.content.length > 0),
	);
	if (!trigger && !users.some(providerCheckpointFromMessage)) return options;
	if (model.api !== "openai-codex-responses") throw new ProviderCompactionError("native-replay-non-codex-route");
	let replayed: ProviderCheckpointHandle | undefined;
	const previousEvent = options?.onProviderStreamEvent;
	const previous = options?.onPayload;
	return {
		...options,
		onProviderStreamEvent: async (event, currentModel) => {
			await previousEvent?.(event, currentModel);
			if (
				replayed &&
				record(event) &&
				(event.type === "response.completed" || event.type === "response.done") &&
				record(event.response) &&
				record(event.response.usage) &&
				typeof event.response.usage.input_tokens === "number" &&
				Number.isSafeInteger(event.response.usage.input_tokens) &&
				event.response.usage.input_tokens >= 0
			) {
				try {
					nativeOptions?.clioProviderCheckpointObserved?.(replayed, event.response.usage.input_tokens);
				} catch {
					process.emitWarning("Native checkpoint replay measurement could not be saved", {
						code: "CLIO_CODER_PROVIDER_CHECKPOINT_MEASUREMENT_FAILED",
					});
				}
			}
		},
		onPayload: async (payload: unknown, currentModel: Model<Api>) => {
			if (nativeOptions?.clioProviderCompaction?.() !== true)
				throw new ProviderCompactionError("native-setting-or-route-disabled");
			const base = (await previous?.(payload, currentModel)) ?? payload;
			if (!record(base) || !Array.isArray(base.input)) throw new Error("provider checkpoint requires an input array");
			let position = 0;
			const input: unknown[] = [];
			let checkpoint: ProviderCheckpoint | undefined;
			let freshEffort: string | undefined;
			for (const item of base.input) {
				if (record(item) && item.role === "user") {
					const handle = providerCheckpointFromMessage(users[position++]);
					if (handle) {
						const incompatible = providerCheckpointCompatibility(handle, model, options?.apiKey);
						if (incompatible) throw new ProviderCompactionError(`native-replay-${incompatible}`);
						try {
							checkpoint = readProviderCheckpoint(handle);
						} catch {
							throw new ProviderCompactionError("native-replay-checkpoint-unreadable");
						}
						replayed = handle;
						const output: unknown = JSON.parse(checkpoint.outputJson);
						if (!Array.isArray(output) || !output.some((entry) => record(entry) && entry.type === "compaction"))
							throw new Error("invalid provider checkpoint output");
						input.push(...output);
						freshEffort =
							record(base.reasoning) && typeof base.reasoning.effort === "string"
								? base.reasoning.effort
								: checkpoint.effectiveEffort;
						if (freshEffort === checkpoint.initialEffort) freshEffort = undefined;
						continue;
					}
					if (freshEffort !== undefined) {
						input.push({ type: "configuration_update", reasoning: { effort: freshEffort } });
						freshEffort = undefined;
					}
				}
				if (record(item) && item.type === "configuration_update") freshEffort = undefined;
				input.push(item);
			}
			if (trigger) input.push({ type: "compaction_trigger" });
			const result = {
				...base,
				...(checkpoint && record(base.reasoning)
					? { reasoning: { ...base.reasoning, effort: checkpoint.initialEffort } }
					: {}),
				input,
			};
			nativeOptions?.clioCompactionPayload?.(result);
			return result;
		},
	} as T;
}

/** Drain a main-route stream without publishing an empty assistant or invoking the print terminal guard (#423). */
export async function compactOpenAI(input: {
	callTelemetry?: CallMessageObserver;
	stream: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => AssistantMessageEventStream;
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions & CompactionOptions & { codexConfiguration?: CodexConfiguration };
	onUsage?: (usage: Usage | undefined, outcome: "success" | "error" | "aborted", failure?: CallFailureRecord) => void;
}): Promise<ProviderCompactionResult> {
	const { model, context, options } = input;
	const accountScope = codexAccountScope(options.apiKey);
	if (
		model.api !== "openai-codex-responses" ||
		(model as Model<Api> & { clioCoder?: { nativeCompactionProtocol?: string } }).clioCoder?.nativeCompactionProtocol !==
			"codex-responses-trigger-v1" ||
		!accountScope
	)
		throw new ProviderCompactionError("native-unsupported-route");
	let outputJson: string | undefined;
	let usage: Usage | undefined;
	let completed = false;
	let payloadPrepared = false;
	let failure: CallFailureRecord | undefined;
	let policyDigest = "";
	let initialEffort = "none";
	let effectiveEffort = "none";
	let outcome: "success" | "error" | "aborted" = "error";
	try {
		options.signal?.throwIfAborted();
		const events = input.stream(model, context, {
			...options,
			clioCompactionTrigger: true,
			// Capture after prompt items, posture policy, effort updates and checkpoint splicing (#423).
			clioCompactionPayload: (base: Item) => {
				payloadPrepared = true;
				policyDigest = createHash("sha256")
					.update(
						JSON.stringify([
							base.instructions,
							base.tools,
							...(Array.isArray(base.input) ? base.input.filter((item) => record(item) && item.role === "developer") : []),
						]),
					)
					.digest("hex");
				initialEffort =
					record(base.reasoning) && typeof base.reasoning.effort === "string" ? base.reasoning.effort : "none";
				effectiveEffort = initialEffort;
				for (const item of Array.isArray(base.input) ? base.input : []) {
					if (
						record(item) &&
						item.type === "configuration_update" &&
						record(item.reasoning) &&
						typeof item.reasoning.effort === "string"
					)
						effectiveEffort = item.reasoning.effort;
				}
			},
			onProviderStreamEvent: async (event, currentModel) => {
				await options.onProviderStreamEvent?.(event, currentModel);
				if (!record(event) || !record(event.response)) return;
				if (
					(event.type === "response.completed" || event.type === "response.done") &&
					(event.response.status === undefined || event.response.status === "completed")
				) {
					completed = true;
					const output = event.response.output;
					if (Array.isArray(output) && output.some((item) => record(item) && item.type === "compaction"))
						outputJson = JSON.stringify(output);
				}
			},
		} as SimpleStreamOptions);
		let failed = false;
		let failureCategory = "native-stream-failed";
		for await (const event of events) {
			if ("partial" in event) usage = event.partial.usage ?? usage;
			if (event.type === "done") {
				usage = event.message.usage ?? usage;
				input.callTelemetry?.settle(event.message);
			}
			if (event.type === "error") {
				usage = event.error.usage ?? usage;
				failed = true;
				const transport = (
					event.error as typeof event.error & {
						codexTransport?: { counters?: { requests?: number; sseFallbacks?: number } | null; mode?: string };
					}
				).codexTransport;
				const sent = transport?.counters
					? (transport.counters.requests ?? 0) + (transport.counters.sseFallbacks ?? 0) > 0 || transport.mode === "sse"
					: payloadPrepared;
				failure = classifyCallFailure(event.error, {
					invoked: sent || (usage?.totalTokens ?? 0) > 0,
					aborted: options.signal?.aborted ?? false,
				});
				input.callTelemetry?.settle({ ...event.error, failure });
				const detail = event.error.errorMessage ?? "";
				if (/TypeError|ReferenceError|Cannot read properties|is not a function/u.test(detail))
					throw new Error("native-compaction-programming-error");
				const replayFailure = detail.match(
					/native-replay-(?:checkpoint-unreadable|provider-or-model-changed|account-changed-or-unknown|non-codex-route)/u,
				)?.[0];
				if (detail.includes("native-setting-or-route-disabled")) failureCategory = "native-setting-or-route-disabled";
				else if (replayFailure) failureCategory = replayFailure;
				else if (/compaction|unsupported|400/iu.test(detail)) failureCategory = "native-trigger-rejected";
			}
		}
		options.signal?.throwIfAborted();
		if (failed || !completed || !outputJson || !usage)
			throw new ProviderCompactionError(failed ? failureCategory : "native-output-missing");
		outcome = "success";
		return {
			outputJson,
			usage,
			initialEffort,
			effectiveEffort,
			policyDigest,
			compatibility: { accountScope, provider: model.provider, model: model.id, protocol: "codex-responses-trigger-v1" },
		};
	} finally {
		input.callTelemetry?.settle({
			stopReason: completed ? "stop" : options.signal?.aborted ? "aborted" : "error",
			usage,
			...(failure ? { failure } : { callInvoked: completed || payloadPrepared }),
		});
		input.onUsage?.(
			(usage?.totalTokens ?? 0) > 0 || outcome === "success" ? usage : undefined,
			options.signal?.aborted ? "aborted" : outcome,
			failure,
		);
	}
}
