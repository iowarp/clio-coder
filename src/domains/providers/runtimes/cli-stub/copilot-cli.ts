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
	contextWindow: 200000,
	maxTokens: 8192,
};

const copilotRuntime: RuntimeDescriptor = {
	id: "copilot-cli",
	displayName: "GitHub Copilot CLI",
	kind: "subprocess",
	tier: "cli-silver",
	apiFamily: "subprocess-copilot",
	auth: "cli",
	knownModels: ["gpt-5.4", "gpt-5.4-mini", "claude-sonnet-4.6", "claude-opus-4.7"],
	binaryName: "copilot",
	defaultBinaryPath: "/home/akougkas/.nvm/versions/node/v24.9.0/bin/copilot",
	headlessCommand: "copilot --prompt <prompt> --model <model> --output-format json",
	outputParser: "copilot-jsonl",
	defaultCapabilities,
	async probe(_endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const started = performance.now();
		const result = await probeBinaryVersion(spawn, "copilot", ctx);
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
			api: "subprocess-copilot",
			provider: "github-copilot",
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

export default copilotRuntime;
