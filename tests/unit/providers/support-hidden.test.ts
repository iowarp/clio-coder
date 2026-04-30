import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { listProviderSupportEntries } from "../../../src/domains/providers/support.js";
import type { CapabilityFlags } from "../../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";

const NO_CAPS: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 0,
	maxTokens: 0,
};

function fakeRuntime(id: string, hidden: boolean): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: NO_CAPS,
		hidden,
		synthesizeModel: () => {
			throw new Error(`synth not implemented for ${id}`);
		},
	};
}

describe("providers/support hidden filter", () => {
	it("hides runtimes flagged hidden by default", () => {
		const visible = fakeRuntime("visible-engine", false);
		const alias = fakeRuntime("legacy-alias", true);
		const entries = listProviderSupportEntries([visible, alias]);
		strictEqual(entries.length, 1);
		strictEqual(entries[0]?.runtimeId, "visible-engine");
	});

	it("includes hidden runtimes when includeHidden is true", () => {
		const visible = fakeRuntime("visible-engine", false);
		const alias = fakeRuntime("legacy-alias", true);
		const entries = listProviderSupportEntries([visible, alias], { includeHidden: true });
		strictEqual(entries.length, 2);
		const ids = entries.map((entry) => entry.runtimeId);
		ok(ids.includes("visible-engine"));
		ok(ids.includes("legacy-alias"));
	});

	it("treats missing hidden flag as visible", () => {
		const runtime: RuntimeDescriptor = {
			id: "no-flag-runtime",
			displayName: "no-flag-runtime",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: NO_CAPS,
			synthesizeModel: () => {
				throw new Error("synth not implemented");
			},
		};
		const entries = listProviderSupportEntries([runtime]);
		strictEqual(entries.length, 1);
	});
});
