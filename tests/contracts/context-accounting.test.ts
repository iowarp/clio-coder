import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	EMPTY_CAPABILITIES,
	type RuntimeDescriptor,
	type TargetDescriptor,
} from "../../src/domains/providers/index.js";
import { resolveContextWindowDetails } from "../../src/domains/providers/runtime-resolution.js";
import {
	buildSnapshotCategories,
	type ContextSnapshot,
	reconcileSnapshot,
} from "../../src/domains/session/context-accounting.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";

function testRuntime(id: "ollama-native" | "lmstudio-native"): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "http",
		tier: "local-native",
		apiFamily: id,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, contextWindow: 8192 },
		synthesizeModel() {
			throw new Error("not used in this test");
		},
	};
}

describe("contracts/context-accounting", () => {
	it("passes prompt-cache stats through the ledger and reports their absence honestly", () => {
		const withCache = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: 1000,
			promptCache: {
				shellReused: true,
				cacheReadTokens: 0,
				cacheWriteTokens: 120,
				uncachedInputTokens: 4000,
				backendVerdict: "cold",
			},
		});
		strictEqual(withCache.promptCache?.shellReused, true);
		// The dishonest case stays visible: shell reused, backend re-prefilled.
		strictEqual(withCache.promptCache?.cacheReadTokens, 0);
		strictEqual(withCache.promptCache?.uncachedInputTokens, 4000);
		strictEqual(withCache.promptCache?.backendVerdict, "cold");

		const withoutCache = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: 1000,
		});
		strictEqual(withoutCache.promptCache, null);
	});

	it("categories sum to usedTokens in the ledger", () => {
		const categories = buildSnapshotCategories({
			systemPrompt: "You are a coding assistant.",
			tools: [{ name: "read", description: "read file", parameters: {} }],
			messages: [{ role: "user", content: "hello" }],
			effectiveContextWindow: 1000,
			compactionThreshold: 0.8,
		});

		const ledger = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: 1000,
			systemPromptTokens: categories.system,
			toolSchemaTokens: categories.tools,
			messageTokens: categories.messages,
			compactionThreshold: 0.8,
			compactionAuto: true,
		});

		const getTokens = (cat: string) => ledger.meter.find((m) => m.category === cat)?.tokens ?? 0;

		const sum =
			getTokens("system") +
			getTokens("tools") +
			getTokens("agents") +
			getTokens("skills") +
			getTokens("memory") +
			getTokens("project") +
			getTokens("messages") +
			getTokens("streaming");

		strictEqual(ledger.usedTokens, sum);
	});

	it("normalizes estimated splits deterministically to the exact reconciled prompt total", () => {
		const snapshot: ContextSnapshot = {
			snapshotId: "snap-1",
			sessionId: "session-1",
			turnId: "turn-1",
			providerId: "test",
			runtimeId: "fake-runtime",
			modelId: "model",
			desiredContextWindow: 1000,
			effectiveContextWindow: 1000,
			contextWindowSource: "descriptor-default",
			categories: {
				system: 100,
				tools: 100,
				agents: 0,
				skills: 0,
				memory: 0,
				project: 0,
				messages: 300,
				reserve: 200,
				free: 300,
				streaming: 0,
			},
			sources: {
				total: "estimated",
				splits: {},
			},
		};

		const usage = {
			input: 1000,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1050,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const reconciled = reconcileSnapshot(snapshot, usage);

		strictEqual(reconciled.categories.system, 200);
		strictEqual(reconciled.categories.tools, 200);
		strictEqual(reconciled.categories.messages, 600);
		strictEqual(reconciled.categories.streaming, 50);
		strictEqual(reconciled.sources.total, "reconciled");
	});

	it("keeps local-native 128k as advisory and does not inflate unknown effective context", () => {
		const target: TargetDescriptor = {
			id: "local-target",
			runtime: "ollama-native",
			capabilities: {},
		};
		const runtime = testRuntime("ollama-native");

		const details = resolveContextWindowDetails(target, runtime, "model", null, null);
		strictEqual(details.desiredContextWindow, 128000);
		strictEqual(details.effectiveContextWindow, 8192);
		strictEqual(details.contextWindowSource, "descriptor-default");
		ok(details.warning !== null);
	});

	it("caps effectiveContextWindow and warns if probed/loaded context below 128k", () => {
		const target: TargetDescriptor = {
			id: "local-target",
			runtime: "lmstudio-native",
			capabilities: {},
		};
		const runtime = testRuntime("lmstudio-native");

		const details = resolveContextWindowDetails(target, runtime, "model", null, 32000);
		strictEqual(details.desiredContextWindow, 128000);
		strictEqual(details.effectiveContextWindow, 32000);
		strictEqual(details.contextWindowSource, "loaded");
		ok(details.warning !== null);
		ok(details.warning.includes("below the recommended 128k"));
	});

	it("exposes lastCompaction in the context ledger", () => {
		const ledger = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: 1000,
			compactionThreshold: 0.8,
			compactionAuto: true,
			lastCompaction: {
				stage: "mask_observations",
				tokensBefore: 800,
				tokensAfter: 300,
				trigger: "auto",
			},
		});

		ok(ledger.lastCompaction !== null);
		strictEqual(ledger.lastCompaction?.stage, "mask_observations");
		strictEqual(ledger.lastCompaction?.tokensBefore, 800);
		strictEqual(ledger.lastCompaction?.tokensAfter, 300);
	});
});
