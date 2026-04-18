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
	"subprocess-claude-code",
	"subprocess-codex",
	"subprocess-gemini",
]);

const VALID_AUTH = new Set<string>(["api-key", "oauth", "aws-sdk", "vertex-adc", "none"]);
const VALID_KINDS = new Set<string>(["http", "subprocess"]);

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
			ok(
				VALID_API_FAMILIES.has(desc.apiFamily),
				`${label}: invalid apiFamily '${desc.apiFamily}'`,
			);
			ok(VALID_AUTH.has(desc.auth), `${label}: invalid auth '${desc.auth}'`);

			ok(
				desc.defaultCapabilities !== null && typeof desc.defaultCapabilities === "object",
				`${label}: defaultCapabilities must be an object`,
			);
			const caps = desc.defaultCapabilities;
			strictEqual(typeof caps.chat, "boolean", `${label}: defaultCapabilities.chat must be boolean`);
			strictEqual(typeof caps.tools, "boolean", `${label}: defaultCapabilities.tools must be boolean`);
			strictEqual(
				typeof caps.contextWindow,
				"number",
				`${label}: defaultCapabilities.contextWindow must be a number`,
			);
			strictEqual(
				typeof caps.maxTokens,
				"number",
				`${label}: defaultCapabilities.maxTokens must be a number`,
			);

			strictEqual(
				typeof desc.synthesizeModel,
				"function",
				`${label}: synthesizeModel must be a function`,
			);
			if (desc.probe !== undefined) {
				strictEqual(typeof desc.probe, "function", `${label}: probe must be a function when set`);
			}
			if (desc.probeModels !== undefined) {
				strictEqual(
					typeof desc.probeModels,
					"function",
					`${label}: probeModels must be a function when set`,
				);
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
});
