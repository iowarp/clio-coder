import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { DispatchContract, DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import type { CostEntry, ObservabilityContract } from "../../src/domains/observability/index.js";
import {
	EMPTY_CAPABILITIES,
	type EndpointStatus,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { type Component, type OverlayHandle, type TUI, visibleWidth } from "../../src/engine/tui.js";
import { emitCommandNotice, runCompactWithNotice } from "../../src/interactive/command-fallbacks.js";
import type { NoticeLevel } from "../../src/interactive/command-output.js";
import { openCostOverlay } from "../../src/interactive/cost-overlay.js";
import { openFleetOverlay } from "../../src/interactive/fleet-overlay.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import {
	type AgentWorkFacts,
	type ContextEngineFacts,
	compactSecondaryLine,
} from "../../src/interactive/footer/widgets.js";
import { createMessagePickerContent } from "../../src/interactive/overlays/message-picker.js";
import { buildModelItems, ModelOverlayView, openModelOverlay } from "../../src/interactive/overlays/model-selector.js";
import { commitScopedModelSelection } from "../../src/interactive/overlays/scoped-models.js";
import { createSessionOverlayBox } from "../../src/interactive/overlays/session-selector.js";
import type { AgentStatus } from "../../src/interactive/status/types.js";
import { clioTheme } from "../../src/interactive/theme/index.js";
import { createWelcomeDashboard, deriveWelcomeDashboardStats } from "../../src/interactive/welcome-dashboard.js";

const ESC = "\x1b";
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function overlayHandle(onHide: () => void = () => {}): OverlayHandle {
	let hidden = false;
	let focused = true;
	return {
		hide(): void {
			hidden = true;
			onHide();
		},
		setHidden(nextHidden: boolean): void {
			hidden = nextHidden;
		},
		isHidden(): boolean {
			return hidden;
		},
		focus(): void {
			focused = true;
		},
		unfocus(): void {
			focused = false;
		},
		isFocused(): boolean {
			return focused;
		},
	};
}

function fakeTui(columns = 80): {
	tui: TUI;
	component: () => Component;
	renderRequests: () => number;
	hideCalls: () => number;
} {
	let mounted: Component | null = null;
	let renders = 0;
	let hides = 0;
	const tui = {
		terminal: { columns },
		showOverlay(component: Component): OverlayHandle {
			mounted = component;
			return overlayHandle(() => {
				hides += 1;
			});
		},
		requestRender(): void {
			renders += 1;
		},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay was not mounted");
			return mounted;
		},
		renderRequests: () => renders,
		hideCalls: () => hides,
	};
}

const runtimeCapabilities = {
	...EMPTY_CAPABILITIES,
	chat: true,
	tools: true,
	contextWindow: 128_000,
	maxTokens: 4096,
};

function runtimeDescriptor(): RuntimeDescriptor {
	return {
		id: "mock-runtime",
		displayName: "Mock Runtime",
		kind: "http",
		tier: "protocol",
		apiFamily: "openai-responses",
		auth: "none",
		defaultCapabilities: runtimeCapabilities,
		synthesizeModel: () => ({}) as never,
	};
}

function endpointStatus(id: string, wireModels: ReadonlyArray<string> = []): EndpointStatus {
	const runtime = runtimeDescriptor();
	return {
		endpoint: {
			id,
			runtime: runtime.id,
			url: "http://localhost:1234",
			...(wireModels.length > 0 ? { wireModels: [...wireModels] } : {}),
		},
		runtime,
		available: true,
		reason: "",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 12 },
		capabilities: runtimeCapabilities,
		discoveredModels: [],
	};
}

function providersFor(
	statuses: ReadonlyArray<EndpointStatus>,
	overrides: Partial<ProvidersContract> = {},
): ProvidersContract {
	const statusesRef = [...statuses];
	const base = {
		list: () => statusesRef,
		getEndpoint: (id: string) => statusesRef.find((status) => status.endpoint.id === id)?.endpoint ?? null,
		getRuntime: (id: string) => statusesRef.find((status) => status.runtime?.id === id)?.runtime ?? null,
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeEndpoint: async (id: string) => statusesRef.find((status) => status.endpoint.id === id) ?? null,
		disconnectEndpoint: () => null,
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		auth: {
			statusForTarget: () => ({
				providerId: "mock-runtime",
				available: true,
				credentialType: null,
				source: "none" as const,
				detail: null,
			}),
			resolveForTarget: async () => ({
				providerId: "mock-runtime",
				available: true,
				credentialType: null,
				source: "none" as const,
				detail: null,
			}),
			getStored: () => null,
			listStored: () => [],
			setApiKey: () => {},
			remove: () => {},
			login: async () => {},
			logout: () => {},
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		credentials: {
			hasKey: () => false,
			get: () => null,
			set: () => {},
			remove: () => {},
		},
		knowledgeBase: null,
	};
	return { ...base, ...overrides } as unknown as ProvidersContract;
}

function settings(endpoint = "mock", model = "model-a", threshold?: number): ClioSettings {
	return {
		orchestrator: { target: endpoint, model, thinkingLevel: "off" },
		autonomy: "auto-edit",
		delegation: { defaults: { toolGovernance: "clio-policy" } },
		...(threshold !== undefined ? { compaction: { threshold } } : {}),
	} as unknown as ClioSettings;
}

function costEntry(tokens: number, usd: number): CostEntry {
	return {
		providerId: "mock",
		modelId: "model-a",
		tokens,
		usd,
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTokens: 0,
	};
}

function observability(entries: CostEntry[]): ObservabilityContract {
	return {
		sessionCost: () => entries.reduce((sum, entry) => sum + entry.usd, 0),
		costEntries: () => entries,
		sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
		latestTokenThroughput: () => null,
		telemetry: () => ({}) as never,
		metrics: () => ({}) as never,
		resetSession: () => {},
		recordTokens: () => {},
		recordTokenThroughput: () => {},
	} as ObservabilityContract;
}

function emptyDispatchSnapshot(): DispatchSnapshot {
	return {
		generatedAt: "2026-06-11T00:00:00.000Z",
		running: [],
		retrying: [],
		totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
	};
}

describe("milestone 08 overlay polish regressions", () => {
	it("/model leaves nonselectable no-model rows open and reports a consistent model count", () => {
		const result = buildModelItems({
			settings: settings("empty", ""),
			providers: providersFor([endpointStatus("empty")]),
		});
		let selected = 0;
		let closed = 0;
		let renders = 0;
		const view = new ModelOverlayView(
			result.rows,
			result.summary,
			() => {
				selected += 1;
			},
			undefined,
			() => {
				closed += 1;
			},
			{ requestRender: () => (renders += 1) },
		);

		const before = stripAnsi(view.render(78).join("\n"));
		ok(before.includes("focus · 0/0 models"), before);

		view.handleInput("\n");

		strictEqual(selected, 0);
		strictEqual(closed, 0);
		strictEqual(renders, 1);
		const after = stripAnsi(view.render(78).join("\n"));
		ok(after.includes("target empty has no selectable model id"), after);
	});

	it("/model suppresses post-refresh UI writes after hide", async () => {
		let resolveProbe = (): void => {
			throw new Error("probe resolver was not installed");
		};
		const providers = providersFor([endpointStatus("mock", ["model-a"])], {
			probeEndpoint: () =>
				new Promise<EndpointStatus | null>((resolve) => {
					resolveProbe = () => resolve(endpointStatus("mock", ["model-b"]));
				}),
		});
		const harness = fakeTui(100);
		const handle = openModelOverlay(harness.tui, {
			settings: settings("mock", "model-a"),
			providers,
			onSelect: () => {},
			onClose: () => {},
			autoRefresh: false,
		});

		harness.component().handleInput?.("r");
		strictEqual(harness.renderRequests(), 1);
		handle.hide();
		resolveProbe();
		await flush();

		strictEqual(harness.hideCalls(), 1);
		strictEqual(harness.renderRequests(), 1);
	});

	it("/model auto-refreshes live model catalogs on open", async () => {
		let current = [endpointStatus("mock", ["old-model"])];
		const live = {
			...endpointStatus("mock"),
			discoveredModels: ["new-live-model"],
			discoveredModelsSource: "probe" as const,
			discoveredModelStates: { "new-live-model": { state: "loaded" as const } },
		};
		const providers = providersFor([], {
			list: () => current,
			getEndpoint: (id: string) => current.find((status) => status.endpoint.id === id)?.endpoint ?? null,
			getRuntime: (id: string) => current.find((status) => status.runtime?.id === id)?.runtime ?? null,
			probeAllLive: async () => {
				current = [live];
			},
			probeEndpoint: async (id: string) => current.find((status) => status.endpoint.id === id) ?? null,
		});
		const harness = fakeTui(100);
		const handle = openModelOverlay(harness.tui, {
			settings: settings("mock", "old-model"),
			providers,
			onSelect: () => {},
			onClose: () => {},
		});

		await flush();
		harness.component().handleInput?.("\t");
		const rendered = stripAnsi(harness.component().render(100).join("\n"));

		ok(rendered.includes("new-live-model"), rendered);
		ok(rendered.includes("state loaded"), rendered);
		handle.hide();
	});

	it("/scoped-models preserves selected scope entries that match no current row", () => {
		const next = commitScopedModelSelection(
			["old-target/old-model", "mock/model-a"],
			[{ value: "mock/model-a", label: "[x] mock/model-a" }],
			new Set(["old-target/old-model", "mock/model-a"]),
		);
		deepStrictEqual(next, ["mock/model-a", "old-target/old-model"]);
	});

	it("/cost refreshes from chat turn events and renders at the clamped frame width", () => {
		const entries: CostEntry[] = [];
		const handlers = new Set<(event: { type: string }) => void>();
		const harness = fakeTui(80);
		const handle = openCostOverlay(harness.tui, observability(entries), {
			chat: {
				onEvent(handler) {
					handlers.add(handler);
					return () => handlers.delete(handler);
				},
			},
			sessionId: "s1",
		});

		const initialLines = harness.component().render(80);
		ok(initialLines.some((line) => line.includes("─".repeat(76))));
		for (const line of initialLines) strictEqual(visibleWidth(line), 80);

		entries.push(costEntry(42, 0.5));
		for (const handler of handlers) handler({ type: "agent_end" });
		strictEqual(harness.renderRequests(), 1);

		handle.hide();
		for (const handler of handlers) handler({ type: "agent_end" });
		strictEqual(harness.renderRequests(), 1);
	});

	it("/fleet renders fixed rows at the clamped frame width", () => {
		const harness = fakeTui(80);
		const dispatch = {
			snapshot: () => ({
				...emptyDispatchSnapshot(),
				running: [
					{
						runId: "run-abcdef123456",
						agentId: "coder-with-a-very-long-name",
						runtimeKind: "http",
						outcomePhase: "running-for-a-long-time",
						heartbeat: "alive",
						lineage: { parentRunId: null, rootRunId: "run-abcdef123456", attempt: 12, depth: 3 },
						startedAt: "2026-06-11T00:00:00.000Z",
						elapsedMs: 12_345,
						tokens: { input: 1000, output: 2000, total: 3000 },
						costUsd: 0.1234,
					},
				],
			}),
		} as unknown as DispatchContract;
		const handle = openFleetOverlay(harness.tui, dispatch);

		const lines = harness.component().render(80);
		ok(lines.some((line) => line.includes("─".repeat(76))));
		for (const line of lines) strictEqual(visibleWidth(line), 80);
		handle.hide();
	});

	it("/resume clears the pending bare-Escape timer on external hide", async () => {
		let closed = 0;
		const box = createSessionOverlayBox(
			[],
			() => {},
			() => {
				closed += 1;
			},
			{ escapeGraceMs: 5 },
		);

		box.handleInput(ESC);
		box.dispose();
		await sleep(15);

		strictEqual(closed, 0);
	});

	it("command fallback notices use the typed notice channel", async () => {
		const notices: Array<{ level: NoticeLevel; text: string }> = [];
		const notice = (level: NoticeLevel, text: string): void => {
			notices.push({ level, text });
		};

		emitCommandNotice(notice, "error", "resume", "session contract unavailable");
		emitCommandNotice(notice, "error", "new", "session contract unavailable");
		emitCommandNotice(notice, "warn", "fork", "no current session to fork from; start one with /new or /resume first");
		runCompactWithNotice(undefined, notice, "now");
		runCompactWithNotice(
			async () => {
				throw new Error("boom");
			},
			notice,
			undefined,
		);
		await flush();

		deepStrictEqual(notices, [
			{ level: "error", text: "[/resume] session contract unavailable" },
			{ level: "error", text: "[/new] session contract unavailable" },
			{ level: "warn", text: "[/fork] no current session to fork from; start one with /new or /resume first" },
			{ level: "error", text: "[/compact] compaction not wired; pass onCompact to startInteractive" },
			{ level: "error", text: "[/compact] boom" },
		]);
	});

	it("/fork renders a specific empty state instead of an empty SelectList", () => {
		let forked = 0;
		let closed = 0;
		const content = createMessagePickerContent(
			[],
			() => {
				forked += 1;
			},
			() => {
				closed += 1;
			},
		);

		ok(content.render(80).join("\n").includes("no assistant turns to fork"));
		content.handleInput?.("\n");
		strictEqual(forked, 0);
		strictEqual(closed, 0);
		content.handleInput?.(ESC);
		strictEqual(closed, 1);
	});

	it("welcome dashboard recomputes target stats on each render and preserves a zero compaction threshold", () => {
		let active = "target-a";
		const providers = providersFor([endpointStatus("target-a", ["model-a"]), endpointStatus("target-b", ["model-b"])]);
		const stats = deriveWelcomeDashboardStats({
			providers,
			observability: {} as ObservabilityContract,
			getSettings: () => settings("target-a", "model-a", 0),
		});
		strictEqual(stats.compactionThreshold, "0%");

		const dashboard = createWelcomeDashboard({
			providers,
			observability: {} as ObservabilityContract,
			getSettings: () => settings(active, active === "target-a" ? "model-a" : "model-b"),
		});

		ok(stripAnsi(dashboard.render(80).join("\n")).includes("target-a"));
		active = "target-b";
		ok(stripAnsi(dashboard.render(80).join("\n")).includes("target-b"));
	});

	it("compact footer renders ledger context percentage with one decimal", () => {
		const ledger = buildContextLedger({
			provider: "mock",
			model: "model-a",
			contextWindow: 1000,
			messageTokens: 426,
		});
		const context: ContextEngineFacts = {
			label: null,
			used: ledger.usedTokens,
			contextWindow: ledger.contextWindow,
			toolSchemaTokens: null,
			compactionThreshold: null,
			compactionAuto: null,
			clioMd: null,
			memory: null,
			extensions: null,
			ledger,
		};
		const agent: AgentWorkFacts = {
			statusText: null,
			dispatchSummary: null,
			toolTally: "none",
			dispatchRows: [],
			lastTurn: null,
		};
		const status: AgentStatus = {
			phase: "idle",
			since: 0,
			lastMeaningfulAt: 0,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		};

		const line = stripAnsi(compactSecondaryLine(context, agent, 80, clioTheme(), status, null, null, null));
		ok(line.includes("42.6%"), line);
		ok(!line.includes("43%"), line);
	});

	it("footer dashboard ignores async git branch resolution after dispose", async () => {
		let resolveBranch = (_value: string | null): void => {
			throw new Error("branch resolver was not installed");
		};
		let terminalReads = 0;
		const footer = buildFooterDashboard({
			providers: providersFor([]),
			getTerminalColumns: () => {
				terminalReads += 1;
				return 80;
			},
			resolveCurrentBranch: () =>
				new Promise((resolve) => {
					resolveBranch = resolve;
				}),
		});
		strictEqual(terminalReads, 1);

		footer.dispose();
		resolveBranch("main");
		await flush();

		strictEqual(terminalReads, 1);
		footer.refresh();
		strictEqual(terminalReads, 1);
	});
});
