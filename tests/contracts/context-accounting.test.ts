import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import {
	buildSnapshotCategories,
	reconcileSnapshot,
} from "../../src/domains/session/context-accounting.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { resolveContextWindowDetails } from "../../src/domains/providers/runtime-resolution.js";

describe("contracts/context-accounting", () => {
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
		const snapshot = {
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
				total: "estimated" as const,
				splits: {} as any,
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

	it("resolves context window for local-native tiers, defaulting to 128k when unknown", () => {
		const endpoint = {
			id: "local-endpoint",
			runtime: "ollama-native",
			capabilities: {},
		} as any;
		const runtime = {
			id: "ollama-native",
			tier: "local-native",
			defaultCapabilities: { contextWindow: 8192 },
		} as any;

		const details = resolveContextWindowDetails(endpoint, runtime, "model", null, null);
		strictEqual(details.desiredContextWindow, 128000);
		strictEqual(details.effectiveContextWindow, 128000);
		strictEqual(details.contextWindowSource, "local-native-default");
		ok(details.warning === null);
	});

	it("caps effectiveContextWindow and warns if probed/loaded context below 128k", () => {
		const endpoint = {
			id: "local-endpoint",
			runtime: "lmstudio-native",
			capabilities: {},
		} as any;
		const runtime = {
			id: "lmstudio-native",
			tier: "local-native",
			defaultCapabilities: { contextWindow: 8192 },
		} as any;

		const details = resolveContextWindowDetails(endpoint, runtime, "model", null, 32000);
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
				stage: "progressive_cut",
				tokensBefore: 800,
				tokensAfter: 300,
				trigger: "auto",
			},
		});

		ok(ledger.lastCompaction !== null);
		strictEqual(ledger.lastCompaction?.stage, "progressive_cut");
		strictEqual(ledger.lastCompaction?.tokensBefore, 800);
		strictEqual(ledger.lastCompaction?.tokensAfter, 300);
	});
});
