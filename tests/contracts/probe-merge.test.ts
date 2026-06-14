import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import { mergeProbeResult } from "../../src/domains/providers/extension.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

function runtime(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
	return {
		id: "ollama-native",
		displayName: "Ollama",
		kind: "http",
		apiFamily: "ollama-native",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: "x", provider: "x" }) as never,
		...overrides,
	};
}

function target(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
	return { id: "local", runtime: "ollama-native", url: "http://localhost:11434", defaultModel: "m1", ...overrides };
}

function previousSuccess(desc: RuntimeDescriptor, tgt: TargetDescriptor): TargetStatus {
	return {
		target: tgt,
		runtime: desc,
		available: true,
		reason: "ready",
		health: { status: "healthy", lastCheckAt: "t0", lastError: null, latencyMs: 5 },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		probeCapabilities: { chat: true, tools: true, reasoning: true },
		probeModelCapabilities: { m1: { reasoning: true } },
		probeModelId: "m1",
		discoveredModels: ["m1", "m2"],
		discoveredModelsSource: "probe",
		discoveredModelStates: { m1: { state: "loaded" }, m2: { state: "unloaded" } },
	};
}

describe("contracts/probe-merge", () => {
	it("retains the last successful catalog and load states across a transient probe failure", () => {
		const desc = runtime({ knownModels: ["static-only"] });
		const tgt = target();
		const merged = mergeProbeResult(desc, tgt, { ok: false, error: "ECONNREFUSED" }, previousSuccess(desc, tgt));
		deepStrictEqual(merged.discoveredModels, ["m1", "m2"]);
		strictEqual(merged.discoveredModelsSource, "cache");
		deepStrictEqual(merged.discoveredModelStates, { m1: { state: "loaded" }, m2: { state: "unloaded" } });
		deepStrictEqual(merged.probeCapabilities, { chat: true, tools: true, reasoning: true });
		strictEqual(merged.probeModelId, "m1");
	});

	it("replaces the catalog when a probe succeeds", () => {
		const desc = runtime();
		const tgt = target();
		const merged = mergeProbeResult(
			desc,
			tgt,
			{ ok: true, models: ["fresh"], modelStates: { fresh: { state: "loaded" } } },
			previousSuccess(desc, tgt),
		);
		deepStrictEqual(merged.discoveredModels, ["fresh"]);
		strictEqual(merged.discoveredModelsSource, "probe");
		deepStrictEqual(merged.discoveredModelStates, { fresh: { state: "loaded" } });
	});

	it("does not resurrect a stale catalog for a target whose identity changed", () => {
		const desc = runtime({ knownModels: ["static-only"] });
		const previous = previousSuccess(desc, target());
		const moved = target({ url: "http://elsewhere:11434" });
		const merged = mergeProbeResult(desc, moved, { ok: false, error: "down" }, previous);
		deepStrictEqual(merged.discoveredModels, ["static-only"]);
		strictEqual(merged.discoveredModelsSource, "runtime");
	});

	it("falls back to known models on a first-ever probe failure with no previous status", () => {
		const desc = runtime({ knownModels: ["static-only"] });
		const merged = mergeProbeResult(desc, target(), { ok: false }, undefined);
		deepStrictEqual(merged.discoveredModels, ["static-only"]);
		strictEqual(merged.discoveredModelsSource, "runtime");
	});
});
