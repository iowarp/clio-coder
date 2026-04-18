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
	toolCallFormat: "openai",
	reasoning: true,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 272000,
	maxTokens: 16384,
};

const codexRuntime: RuntimeDescriptor = {
	id: "codex-cli",
	displayName: "Codex CLI",
	kind: "subprocess",
	apiFamily: "subprocess-codex",
	auth: "oauth",
	defaultCapabilities,
	async probe(_endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const started = performance.now();
		const result = await probeBinaryVersion(spawn, "codex", ctx);
		const latencyMs = Math.round(performance.now() - started);
		if (result.ok) {
			const res: ProbeResult = { ok: true, latencyMs };
			if (result.version) res.serverVersion = result.version;
			return res;
		}
		const failed: ProbeResult = { ok: false, latencyMs };
		if (result.error) failed.error = result.error;
		return failed;
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, _kb: KnowledgeBaseHit | null): Model<Api> {
		const stub = {
			id: wireModelId,
			name: `${endpoint.id}`,
			api: "subprocess-codex",
			provider: "openai",
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

export default codexRuntime;
