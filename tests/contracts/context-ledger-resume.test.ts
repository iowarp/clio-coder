/**
 * After /resume the transcript, turn meta, and footer telemetry all replayed,
 * but /context said `context window unknown · 0 tokens estimated in context`
 * and the meter read `?%` until the next turn (issue #189). The ledger bailed
 * out whenever no agent runtime existed yet, which is every resumed session
 * before its first new turn, and ignored the snapshot the previous process
 * had persisted for exactly these messages.
 */
import { ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { appendContextSnapshot, type ContextSnapshot } from "../../src/domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { renderContextLedgerLines } from "../../src/interactive/context-overlay.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import { createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const runtime: RuntimeDescriptor = {
	id: "llamacpp",
	displayName: "llama.cpp",
	kind: "http",
	tier: "local-native",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 32768, maxTokens: 8192 },
	synthesizeModel() {
		throw new Error("not used in this test");
	},
};

function providersStub(probedWindow: number | null): ProvidersContract {
	const target = { id: "mini", runtime: "llamacpp", url: "http://127.0.0.1:1", defaultModel: "ornith" };
	const status = {
		target,
		runtime,
		available: true,
		reason: "ok",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities, ...(probedWindow ? { contextWindow: probedWindow } : {}) },
		...(probedWindow
			? {
					probeCapabilities: { contextWindow: probedWindow },
					probeModelId: "ornith",
					discoveredModelStates: {
						ornith: { state: "unknown", contextSlots: { totalContextSize: probedWindow * 4, slots: 4 } },
					},
				}
			: {}),
		discoveredModels: ["ornith"],
		discoveredModelsSource: "probe",
	} as unknown as TargetStatus;
	return {
		list: () => [status],
		getTarget: (id: string) => (id === "mini" ? target : null),
		getRuntime: (id: string) => (id === "llamacpp" ? runtime : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
	} as unknown as ProvidersContract;
}

function resumedSnapshot(meta: SessionMeta): ContextSnapshot {
	return {
		snapshotId: "snap-2",
		sessionId: meta.id,
		turnId: "assistant-2",
		providerId: "mini",
		runtimeId: "llamacpp",
		modelId: "ornith",
		desiredContextWindow: 131072,
		effectiveContextWindow: 196608,
		contextWindowSource: "probe",
		categories: {
			system: 4_000,
			tools: 6_000,
			agents: 0,
			skills: 0,
			memory: 0,
			project: 0,
			messages: 9_000,
			reserve: 19_660,
			free: 157_948,
			streaming: 0,
		},
		sources: { total: "reconciled", splits: {} },
		compactionThreshold: 0.9,
		recordedAt: "2026-08-23T00:00:02.000Z",
	} as ContextSnapshot;
}

describe("contracts/context ledger after resume", () => {
	let isolated: IsolatedClioEnv;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-ledger-resume-");
	});
	afterEach(() => {
		isolated.restore();
	});

	function harness(probedWindow: number | null) {
		const meta = { id: "session-resumed", createdAt: "2026-08-23T00:00:00.000Z", cwd: process.cwd() } as SessionMeta;
		appendContextSnapshot(meta, resumedSnapshot(meta));
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		settings.orchestrator.target = "mini";
		settings.orchestrator.model = "ornith";
		const state = createTurnState("off");
		const context = createTurnContext({
			state,
			getSettings: () => settings,
			providers: providersStub(probedWindow),
			session: { current: () => meta } as SessionContract,
			readSessionEntries: () => [],
			middleware: { fireCompactionHook() {} } as never,
			emitNotice: () => {},
		});
		return { context, state };
	}

	it("reports the resumed snapshot's tokens and the probed window before any new turn", () => {
		const h = harness(196608);
		strictEqual(h.state.runtime, null, "no runtime exists until the first turn of this process");
		h.context.resetForSession();

		const ledger = h.context.contextLedger();
		strictEqual(ledger.contextWindow, 196608, "the live resolution answers the window");
		strictEqual(ledger.contextWindowSource, "probe");
		ok(ledger.usedTokens >= 19_000, `the resumed snapshot answers the tokens: ${ledger.usedTokens}`);
		strictEqual(ledger.measured, true, "a reconciled snapshot is a measured figure");
		const lines = renderContextLedgerLines(ledger, 80).map(strip);
		const summary = lines.find((line) => line.includes("tokens ("));
		ok(summary, lines.join("\n"));
		ok(summary.includes("/ 196,608 (786,432 / 4 slots) tokens"), summary);
		ok(!lines.some((line) => line.includes("context window unknown")), lines.join("\n"));

		const usage = h.context.contextUsage();
		strictEqual(usage.contextWindow, 196608, "the footer meter gets the same window");
		ok((usage.tokens ?? 0) >= 19_000, `the footer meter gets the same tokens: ${JSON.stringify(usage)}`);
	});

	it("falls back to the window the snapshot recorded when the target has not been probed", () => {
		const h = harness(null);
		h.context.resetForSession();
		const ledger = h.context.contextLedger();
		// The unprobed runtime default still resolves, so that wins over the
		// recorded figure; the recorded one is the floor when nothing resolves.
		ok(ledger.contextWindow > 0, "never `unknown · 0` after a resume");
		ok(ledger.usedTokens >= 19_000, `tokens come from the snapshot: ${ledger.usedTokens}`);
	});

	it("keeps the honest unknown for a fresh session with no snapshot and no target", () => {
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		settings.orchestrator.target = "";
		settings.orchestrator.model = "";
		const state = createTurnState("off");
		const context = createTurnContext({
			state,
			getSettings: () => settings,
			providers: providersStub(null),
			middleware: { fireCompactionHook() {} } as never,
			emitNotice: () => {},
		});
		const ledger = context.contextLedger();
		strictEqual(ledger.contextWindow, 0);
		strictEqual(ledger.usedTokens, 0);
	});
});
