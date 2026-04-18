import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { probeBinaryVersion } from "./probe-binary.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: true,
	thinkingFormat: "anthropic-extended",
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 200000,
	maxTokens: 8192,
};

const claudeCodeRuntime: RuntimeDescriptor = {
	id: "claude-code-cli",
	displayName: "Claude Code CLI",
	kind: "subprocess",
	apiFamily: "subprocess-claude-code",
	auth: "oauth",
	defaultCapabilities,
	async probe(_endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return runVersionProbe(spawn, "claude", ctx);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, _kb: KnowledgeBaseHit | null): Model<Api> {
		const stub = {
			id: wireModelId,
			name: `${endpoint.id}`,
			api: "subprocess-claude-code",
			provider: "anthropic",
			baseUrl: "",
			reasoning: defaultCapabilities.reasoning,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: defaultCapabilities.contextWindow,
			maxTokens: defaultCapabilities.maxTokens,
		};
		return stub as unknown as Model<Api>;
	},
};

async function runVersionProbe(spawnFn: typeof spawn, binary: string, ctx: ProbeContext): Promise<ProbeResult> {
	const started = performance.now();
	const result = await probeBinaryVersion(spawnFn, binary, ctx);
	const latencyMs = Math.round(performance.now() - started);
	if (result.ok) {
		const res: ProbeResult = { ok: true, latencyMs };
		if (result.version) res.serverVersion = result.version;
		return res;
	}
	const failed: ProbeResult = { ok: false, latencyMs };
	if (result.error) failed.error = result.error;
	return failed;
}

export default claudeCodeRuntime;
