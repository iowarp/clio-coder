import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { BUILTIN_RUNTIMES } from "../../../src/domains/providers/runtimes/builtins.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";

const VALID_API_FAMILIES = new Set<string>([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"lmstudio-native",
	"mistral-conversations",
	"ollama-native",
	"rerank-http",
	"embeddings-http",
	"claude-agent-sdk",
	"subprocess-claude-code",
	"subprocess-codex",
	"subprocess-gemini",
	"subprocess-copilot",
	"subprocess-opencode",
]);

const VALID_AUTH = new Set<string>(["api-key", "oauth", "aws-sdk", "vertex-adc", "cli", "none"]);
const VALID_KINDS = new Set<string>(["http", "subprocess", "sdk"]);
const VALID_TIERS = new Set<string>([
	"protocol",
	"cloud",
	"local-native",
	"sdk",
	"cli",
	"cli-gold",
	"cli-silver",
	"cli-bronze",
]);

function describeDescriptor(desc: RuntimeDescriptor): string {
	return `${desc.id} (${desc.kind}/${desc.apiFamily})`;
}

describe("providers/runtimes built-in descriptors", () => {
	it("there is at least one descriptor", () => {
		ok(BUILTIN_RUNTIMES.length > 0, "BUILTIN_RUNTIMES must not be empty");
	});

	it("every descriptor has unique id + required shape", () => {
		const seen = new Set<string>();
		for (const desc of BUILTIN_RUNTIMES) {
			const label = describeDescriptor(desc);
			strictEqual(typeof desc.id, "string", `${label}: id must be a string`);
			ok(desc.id.length > 0, `${label}: id must be non-empty`);
			ok(!seen.has(desc.id), `${label}: duplicate id`);
			seen.add(desc.id);

			strictEqual(typeof desc.displayName, "string", `${label}: displayName must be a string`);
			ok(desc.displayName.length > 0, `${label}: displayName must be non-empty`);

			ok(VALID_KINDS.has(desc.kind), `${label}: invalid kind '${desc.kind}'`);
			ok(desc.tier !== undefined && VALID_TIERS.has(desc.tier), `${label}: invalid tier '${String(desc.tier)}'`);
			ok(VALID_API_FAMILIES.has(desc.apiFamily), `${label}: invalid apiFamily '${desc.apiFamily}'`);
			ok(VALID_AUTH.has(desc.auth), `${label}: invalid auth '${desc.auth}'`);

			ok(
				desc.defaultCapabilities !== null && typeof desc.defaultCapabilities === "object",
				`${label}: defaultCapabilities must be an object`,
			);
			const caps = desc.defaultCapabilities;
			strictEqual(typeof caps.chat, "boolean", `${label}: defaultCapabilities.chat must be boolean`);
			strictEqual(typeof caps.tools, "boolean", `${label}: defaultCapabilities.tools must be boolean`);
			strictEqual(typeof caps.contextWindow, "number", `${label}: defaultCapabilities.contextWindow must be a number`);
			strictEqual(typeof caps.maxTokens, "number", `${label}: defaultCapabilities.maxTokens must be a number`);

			strictEqual(typeof desc.synthesizeModel, "function", `${label}: synthesizeModel must be a function`);
			if (desc.probe !== undefined) {
				strictEqual(typeof desc.probe, "function", `${label}: probe must be a function when set`);
			}
			if (desc.probeModels !== undefined) {
				strictEqual(typeof desc.probeModels, "function", `${label}: probeModels must be a function when set`);
			}
		}
	});

	it("subprocess descriptors live under the subprocess-* apiFamily namespace", () => {
		for (const desc of BUILTIN_RUNTIMES) {
			if (desc.kind !== "subprocess") continue;
			ok(
				desc.apiFamily.startsWith("subprocess-"),
				`${describeDescriptor(desc)}: subprocess kind requires subprocess-* apiFamily`,
			);
		}
	});

	it("registers local CLI-backed targets with native CLI auth semantics", () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));
		for (const id of ["claude-code-sdk", "claude-code-cli", "codex-cli", "gemini-cli", "copilot-cli", "opencode-cli"]) {
			const desc = byId.get(id);
			ok(desc, `missing runtime ${id}`);
			strictEqual(desc.auth, "cli", `${id}: expected native CLI auth`);
			ok(desc.knownModels && desc.knownModels.length > 0, `${id}: expected static model hints`);
		}
		strictEqual(byId.get("claude-code-sdk")?.tier, "sdk");
		strictEqual(byId.get("claude-code-cli")?.tier, "cli-gold");
		strictEqual(byId.get("codex-cli")?.tier, "cli-gold");
		strictEqual(byId.get("copilot-cli")?.tier, "cli-silver");
		strictEqual(byId.get("opencode-cli")?.tier, "cli-bronze");
		ok(byId.get("claude-code-sdk")?.knownModels?.includes("claude-opus-4-7"));
		ok(byId.get("copilot-cli")?.knownModels?.includes("claude-sonnet-4.6"));
		ok(!byId.get("copilot-cli")?.knownModels?.includes("claude-sonnet-4-6"));
		ok(byId.get("gemini-cli")?.knownModels?.includes("gemini-3-flash-preview"));
		ok(!byId.get("gemini-cli")?.knownModels?.includes("gemini-3.0-flash"));
	});
});
