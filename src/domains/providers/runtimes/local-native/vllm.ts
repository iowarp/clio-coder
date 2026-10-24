import { CLIO_MIN_CONTEXT_WINDOW, CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import { VLLM_GPT_OSS_SERVE_FLAGS } from "../../harmony-server.js";
import { isHarmonyModelId } from "../../model-family.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { targetRootUrl } from "../common/local-synth.js";
import { makeOpenAICompatRuntime } from "../protocol/openai-compat.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: CLIO_MIN_CONTEXT_WINDOW,
	maxTokens: CLIO_MIN_MAX_OUTPUT_TOKENS,
};

const base = makeOpenAICompatRuntime({
	id: "vllm",
	displayName: "vLLM",
	provider: "vllm",
	auth: "api-key",
	tier: "local-native",
	defaultCapabilities,
	healthPath: "/health",
});

async function probeVersion(target: TargetDescriptor, ctx: ProbeContext): Promise<string | undefined> {
	const root = targetRootUrl(target);
	if (!root) return undefined;
	const headers = {
		...(ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {}),
		...target.auth?.headers,
	};
	const result = await probeJson<{ version?: unknown }>({
		url: `${root}/version`,
		timeoutMs: ctx.httpTimeoutMs,
		headers,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	const version = result.ok ? result.data?.version : undefined;
	return typeof version === "string" && version.length > 0 ? version : undefined;
}

const baseProbe = base.probe;
if (baseProbe === undefined) throw new Error("vllm: the OpenAI-compatible runtime must declare a probe");

const vllm: RuntimeDescriptor = {
	...base,
	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const result = await baseProbe(target, ctx);
		if (!result.ok) return result;
		const version = await probeVersion(target, ctx);
		const enriched: ProbeResult = { ...result };
		if (version !== undefined && enriched.serverVersion === undefined) enriched.serverVersion = version;
		const candidates = [target.defaultModel, ...(result.models ?? [])].filter(
			(id): id is string => typeof id === "string" && id.length > 0,
		);
		if (candidates.some((id) => isHarmonyModelId(id))) {
			// The flags live in harmony-server.ts so the probe, the engine and the
			// targets report name the same ones (#435).
			const note = `gpt-oss on vLLM parses Harmony only with ${VLLM_GPT_OSS_SERVE_FLAGS}; run targets --probe --tools to read the server's Harmony parsing level`;
			enriched.notes = [...(result.notes ?? []), note];
		}
		return enriched;
	},
};

export default vllm;
