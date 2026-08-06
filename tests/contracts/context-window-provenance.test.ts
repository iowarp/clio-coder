import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatContextWindow } from "../../src/cli/targets.js";
import { capabilitiesFor, mergeProbeResult } from "../../src/domains/providers/extension.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type {
	KnowledgeBase,
	KnowledgeBaseEntry,
	KnowledgeBaseHit,
} from "../../src/domains/providers/types/knowledge-base.js";
import type { ProbeResult, RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

/**
 * A llama.cpp-style descriptor: its 8192 is a placeholder for whatever model
 * the operator loaded, never a fact about that model.
 */
const RUNTIME_PLACEHOLDER_WINDOW = 8192;

function runtime(): RuntimeDescriptor {
	return {
		id: "llamacpp",
		displayName: "llama.cpp",
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: {
			...EMPTY_CAPABILITIES,
			chat: true,
			tools: true,
			contextWindow: RUNTIME_PLACEHOLDER_WINDOW,
			maxTokens: 4096,
		},
		synthesizeModel: () => ({ id: "x", provider: "x" }) as never,
	};
}

function target(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
	return { id: "router", runtime: "llamacpp", url: "http://localhost:8080", defaultModel: "selected", ...overrides };
}

class EmptyKnowledgeBase implements KnowledgeBase {
	lookup(_modelId: string): KnowledgeBaseHit | null {
		return null;
	}
	entries(): ReadonlyArray<KnowledgeBaseEntry> {
		return [];
	}
}

function resolve(tgt: TargetDescriptor, probe: ProbeResult): ReturnType<typeof capabilitiesFor> {
	const desc = runtime();
	return capabilitiesFor(desc, tgt, mergeProbeResult(desc, tgt, probe, undefined), new EmptyKnowledgeBase());
}

describe("contracts/context window provenance", () => {
	it("a router that reports no window leaves the runtime placeholder marked as a guess", () => {
		// This is the `/props` -> `n_ctx: 0` case: the probe succeeded and
		// discovered a catalog, but nothing answered the window.
		const resolved = resolve(target(), { ok: true, models: ["selected"] });

		strictEqual(resolved.capabilities.contextWindow, RUNTIME_PLACEHOLDER_WINDOW);
		strictEqual(resolved.contextWindowProvenance, "runtime-default");
		strictEqual(
			formatContextWindow(resolved),
			`ctx ${RUNTIME_PLACEHOLDER_WINDOW} (unverified runtime default)`,
			"a guess must not read like a discovered capability",
		);
	});

	it("a real positive window from the target-wide probe is adopted", () => {
		const resolved = resolve(target(), {
			ok: true,
			discoveredCapabilities: { contextWindow: 131_072 },
			capabilityModelId: "selected",
		});

		strictEqual(resolved.capabilities.contextWindow, 131_072);
		strictEqual(resolved.contextWindowProvenance, "discovered");
		strictEqual(formatContextWindow(resolved), "ctx 131072");
	});

	it("the selected model's own /v1/models row answers when /props reported nothing", () => {
		// A llama-swap-style router answers `/props` with `n_ctx: 0` and carries
		// the window only in the per-model catalog row.
		const resolved = resolve(target(), {
			ok: true,
			models: ["selected", "other"],
			modelCapabilities: { selected: { contextWindow: 262_144 }, other: { contextWindow: 4_096 } },
		});

		strictEqual(resolved.capabilities.contextWindow, 262_144);
		strictEqual(resolved.contextWindowProvenance, "discovered");
	});

	it("another loaded model's window never answers for the selected model", () => {
		const resolved = resolve(target(), {
			ok: true,
			models: ["selected", "other"],
			modelCapabilities: { other: { contextWindow: 262_144 } },
		});

		strictEqual(
			resolved.capabilities.contextWindow,
			RUNTIME_PLACEHOLDER_WINDOW,
			"a sibling model's window is another model's fact",
		);
		strictEqual(resolved.contextWindowProvenance, "runtime-default");
	});

	it("a target-wide probe keyed to a different model never answers for the selected model", () => {
		const resolved = resolve(target(), {
			ok: true,
			discoveredCapabilities: { contextWindow: 262_144 },
			capabilityModelId: "other",
		});

		strictEqual(resolved.capabilities.contextWindow, RUNTIME_PLACEHOLDER_WINDOW);
		strictEqual(resolved.contextWindowProvenance, "runtime-default");
	});

	it("an operator's configured window wins over discovery and is labelled as configured", () => {
		const resolved = resolve(target({ capabilities: { contextWindow: 32_768 } }), {
			ok: true,
			modelCapabilities: { selected: { contextWindow: 262_144 } },
		});

		strictEqual(resolved.capabilities.contextWindow, 32_768);
		strictEqual(resolved.contextWindowProvenance, "configured");
		strictEqual(formatContextWindow(resolved), "ctx 32768");
	});

	it("a window discovered before a transient outage survives the failed probe", () => {
		const desc = runtime();
		const tgt = target();
		const healthy = capabilitiesFor(
			desc,
			tgt,
			mergeProbeResult(desc, tgt, { ok: true, modelCapabilities: { selected: { contextWindow: 262_144 } } }, undefined),
			new EmptyKnowledgeBase(),
		);
		const previous = {
			target: tgt,
			runtime: desc,
			available: true,
			reason: "ready",
			health: { status: "healthy" as const, lastCheckAt: "t0", lastError: null, latencyMs: 5 },
			capabilities: healthy.capabilities,
			contextWindowProvenance: healthy.contextWindowProvenance,
			probeCapabilities: null,
			probeModelCapabilities: { selected: { contextWindow: 262_144 } },
			probeModelId: null,
			discoveredModels: ["selected"],
			discoveredModelsSource: "probe" as const,
			discoveredModelStates: null,
		};

		const afterOutage = capabilitiesFor(
			desc,
			tgt,
			mergeProbeResult(desc, tgt, { ok: false, error: "ECONNREFUSED" }, previous),
			new EmptyKnowledgeBase(),
		);

		strictEqual(afterOutage.capabilities.contextWindow, 262_144, "an outage is not evidence the window shrank");
		strictEqual(afterOutage.contextWindowProvenance, "discovered");
	});
});
