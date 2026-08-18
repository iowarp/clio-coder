import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { CLIO_MIN_CONTEXT_WINDOW } from "../../src/core/context-floor.js";
import {
	EMPTY_CAPABILITIES,
	type RuntimeDescriptor,
	type TargetDescriptor,
} from "../../src/domains/providers/index.js";
import { resolveContextWindowDetails } from "../../src/domains/providers/runtime-resolution.js";
import { DEFAULT_COMPACTION_THRESHOLD } from "../../src/domains/session/compaction/auto.js";
import {
	buildSnapshotCategories,
	type ContextSnapshot,
	reconcileSnapshot,
} from "../../src/domains/session/context-accounting.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";

function groupTokens(ledger: ReturnType<typeof buildContextLedger>, category: string): number {
	return ledger.groups.find((group) => group.category === category)?.tokens ?? 0;
}

function testRuntime(id: "ollama-native" | "lmstudio"): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "http",
		tier: "local-native",
		apiFamily: id === "lmstudio" ? "openai-completions" : id,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, contextWindow: CLIO_MIN_CONTEXT_WINDOW },
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

	it("falls back to the shared compaction threshold when none is configured", () => {
		const window = 1000;
		const expectedReserve = Math.round(window * (1 - DEFAULT_COMPACTION_THRESHOLD));

		const ledger = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: window,
			systemPromptTokens: 100,
			compactionAuto: true,
		});
		strictEqual(ledger.reserveTokens, expectedReserve);

		const categories = buildSnapshotCategories({
			systemPrompt: "You are a coding assistant.",
			effectiveContextWindow: window,
			compactionThreshold: null,
		});
		strictEqual(categories.reserve, expectedReserve);
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

	it("buckets dynamic context prompt fragments into their ledger categories", () => {
		const ledger = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: 1000,
			promptSegments: [
				{ id: "context.project-rules", tokenEstimate: 11 },
				{ id: "context.operator-profile", tokenEstimate: 13 },
				{ id: "context.clio-repo-awareness", tokenEstimate: 17 },
				{ id: "context.unknown-fragment", tokenEstimate: 19 },
			],
		});

		strictEqual(groupTokens(ledger, "project"), 11);
		strictEqual(groupTokens(ledger, "memory"), 13);
		strictEqual(groupTokens(ledger, "system"), 36);
	});

	it("counts active project rule fragments as project context instead of system prompt", () => {
		const ledger = buildContextLedger({
			provider: "test",
			model: "test-model",
			contextWindow: 1000,
			promptSegments: [
				{ id: "identity", tokenEstimate: 8 },
				{ id: "context.project-rules", tokenEstimate: 42 },
			],
		});

		strictEqual(groupTokens(ledger, "project"), 42);
		strictEqual(groupTokens(ledger, "system"), 8);
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

	/**
	 * A window nothing declared is a guess. `clio-coder targets` already annotates the
	 * runtime-default case as unverified; the session path resolved the same
	 * placeholder and reported it as settled fact, so a hosted target whose model
	 * Clio has never heard of planned against a blanket number with no notice.
	 */
	it("warns that a runtime-default window is the descriptor's blanket figure, not a reported one", () => {
		const runtime: RuntimeDescriptor = {
			id: "openrouter",
			displayName: "openrouter",
			kind: "http",
			tier: "cloud",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, contextWindow: 128000 },
			synthesizeModel() {
				throw new Error("not used in this test");
			},
		};
		const target: TargetDescriptor = { id: "hosted", runtime: "openrouter", capabilities: {} };

		const details = resolveContextWindowDetails(target, runtime, "model-clio-never-heard-of", null, null);

		strictEqual(details.effectiveContextWindow, 128000);
		strictEqual(details.contextWindowSource, "descriptor-default");
		strictEqual(details.warning, null, "a 128k window is not a degradation to warn about");
		ok(details.provenanceNotice !== null, "a blanket runtime default must be reported as one");
		ok(details.provenanceNotice.includes("not a figure this target reported"));
	});

	/**
	 * The old fallback was 8192, a number that predates every model Clio runs
	 * against. It was indistinguishable from a real answer at every call site
	 * that consumed it, so a target that merely failed to report its window ran
	 * the whole session at 6% of its real capacity with no way to notice.
	 * Assuming the floor and labelling it an assumption is both closer to the
	 * truth and recoverable.
	 */
	it("assumes Clio's floor, not 8192, when nothing declares a window", () => {
		const runtime: RuntimeDescriptor = {
			id: "custom-runtime",
			displayName: "custom-runtime",
			kind: "http",
			tier: "cloud",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES },
			synthesizeModel() {
				throw new Error("not used in this test");
			},
		};
		const target: TargetDescriptor = { id: "custom", runtime: "custom-runtime", capabilities: {} };

		const details = resolveContextWindowDetails(target, runtime, "model", null, null);

		strictEqual(details.effectiveContextWindow, CLIO_MIN_CONTEXT_WINDOW);
		strictEqual(details.contextWindowSource, "unknown");
		ok(details.provenanceNotice !== null, "an undeclared window must be reported as an assumption");
		ok(details.provenanceNotice.includes("assumed minimum"));
		strictEqual(details.warning, null, "the assumed floor is not itself a degradation");
	});

	it("carries Clio's floor through a local-native descriptor default", () => {
		const target: TargetDescriptor = {
			id: "local-target",
			runtime: "ollama-native",
			capabilities: {},
		};
		const runtime = testRuntime("ollama-native");

		const details = resolveContextWindowDetails(target, runtime, "model", null, null);
		strictEqual(details.desiredContextWindow, CLIO_MIN_CONTEXT_WINDOW);
		strictEqual(details.effectiveContextWindow, CLIO_MIN_CONTEXT_WINDOW);
		strictEqual(details.contextWindowSource, "descriptor-default");
		ok(details.provenanceNotice !== null, "a descriptor blanket is still an assumption");
	});

	/**
	 * A probed number always wins, including when it is small. The floor is what
	 * Clio assumes in the absence of an answer, never a value it substitutes for
	 * one it was given: a model served at 32k really does have 32k today, and
	 * planning against 131072 would overrun every request.
	 */
	it("keeps a probed window that is below the floor and warns about it", () => {
		const target: TargetDescriptor = {
			id: "local-target",
			runtime: "lmstudio",
			capabilities: {},
		};
		const runtime = testRuntime("lmstudio");

		const details = resolveContextWindowDetails(target, runtime, "model", null, 32000);
		strictEqual(details.desiredContextWindow, CLIO_MIN_CONTEXT_WINDOW);
		strictEqual(details.effectiveContextWindow, 32000);
		// `probe`, not `loaded`: the target reported a window for this model
		// without saying it is the one a resident instance is serving. Only
		// discovery's per-model loaded window earns the `loaded` label.
		strictEqual(details.contextWindowSource, "probe");
		ok(details.warning !== null);
		ok(details.warning.includes("32000"));
		strictEqual(details.provenanceNotice, null, "a probed number is not an assumption");
	});

	/**
	 * Several frontier models ship at exactly 128,000 rather than 2^17. Warning
	 * that such a target is 2% short of Clio's assumed floor is noise on a
	 * target that is entirely adequate, so the warn line sits below the
	 * assumption rather than at it.
	 */
	it("does not warn about a 128,000-token window three thousand tokens under the floor", () => {
		const runtime: RuntimeDescriptor = {
			id: "hosted-128k",
			displayName: "hosted-128k",
			kind: "http",
			tier: "cloud",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, contextWindow: 128000 },
			synthesizeModel() {
				throw new Error("not used in this test");
			},
		};
		const target: TargetDescriptor = { id: "hosted", runtime: "hosted-128k", capabilities: {} };

		const details = resolveContextWindowDetails(target, runtime, "model", null, 128000);
		strictEqual(details.effectiveContextWindow, 128000);
		strictEqual(details.warning, null);
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
