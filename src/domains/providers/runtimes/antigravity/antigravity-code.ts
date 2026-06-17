import type { Api, Model } from "@earendil-works/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

/**
 * Antigravity CLI (`agy`) subscription runtime.
 *
 * A subprocess worker runtime that drives the local `agy --print`, the same
 * shape as the `claude-code` runtime: Clio spawns the CLI, streams its output,
 * and maps Clio autonomy levels onto the CLI's permission flags. `agy` brings
 * Google's Antigravity agent harness (Gemini 3.x and hosted Claude/GPT-OSS
 * models, up to ~1M tokens of context) to the Clio worker fleet.
 *
 * `agy --print` prints plain text (there is no structured event stream), so the
 * worker runner cannot mediate individual agy tool calls the way the Claude SDK
 * runner does. Permission gating is coarse: `--sandbox` for read-only-leaning
 * levels and `--dangerously-skip-permissions` only under `full-auto` plus the
 * explicit `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` environment gate. agy's own
 * `settings.json` still governs its real tool surface.
 */

export const ANTIGRAVITY_AUTH_NOTICE =
	"Uses your existing Antigravity (`agy`) login. Clio stores no Antigravity credentials. " +
	"agy runs its own agent harness as a subprocess; Clio maps autonomy levels onto its CLI flags " +
	"but cannot mediate individual agy tool calls.";

// Exact model strings accepted by `agy --model` (from `agy models`). The High
// Flash tier leads: it is the fast, large-context default.
export const ANTIGRAVITY_MODELS: ReadonlyArray<string> = [
	"Gemini 3.5 Flash (High)",
	"Gemini 3.5 Flash (Medium)",
	"Gemini 3.5 Flash (Low)",
	"Gemini 3.1 Pro (High)",
	"Gemini 3.1 Pro (Low)",
	"Claude Sonnet 4.6 (Thinking)",
	"Claude Opus 4.6 (Thinking)",
	"GPT-OSS 120B (Medium)",
];

export const antigravityCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 1_000_000,
	maxTokens: 8192,
};

const antigravityCodeRuntime: RuntimeDescriptor = {
	id: "antigravity-code",
	displayName: "Antigravity CLI",
	kind: "subprocess",
	tier: "subscription",
	// Reuses the existing `google-generative-ai` api family: the worker branches
	// to its own runner before any pi-ai inference, so this only needs to be a
	// valid, google-backed family. The runner is selected by runtime id, and the
	// plain-text parser is named by `outputParser`.
	apiFamily: "google-generative-ai",
	auth: "none",
	authNotice: ANTIGRAVITY_AUTH_NOTICE,
	knownModels: [...ANTIGRAVITY_MODELS],
	binaryName: "agy",
	headlessCommand: "agy --print",
	outputParser: "antigravity-print-text",
	defaultCapabilities: antigravityCapabilities,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: antigravityCapabilities,
			runtimeId: "antigravity-code",
			api: "google-generative-ai",
			provider: "google",
			defaultBaseUrl: "antigravity://local",
		});
	},
};

export default antigravityCodeRuntime;
