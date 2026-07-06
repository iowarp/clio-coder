import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import type { DispatchContract, DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import type {
	ObservabilityNotice,
	ObservabilityRunSummary,
	ObservabilitySnapshot,
} from "../../src/domains/observability/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import {
	FLEET_OVERLAY_WIDTH,
	formatFleetOverlayBodyLines,
	openFleetOverlay,
} from "../../src/interactive/fleet-overlay.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const hasTruncatedAnsi = (text: string): boolean =>
	text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").includes(ESC);
const theme = clioTheme();

function snapshot(overrides: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
	return {
		generatedAt: "2026-06-10T00:00:00.000Z",
		running: [],
		retrying: [],
		totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		...overrides,
	};
}

function runningRow(runId: string): DispatchSnapshot["running"][number] {
	return {
		runId,
		agentId: "coder",
		runtimeKind: "http",
		outcomePhase: "running",
		heartbeat: "alive",
		lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
		startedAt: "2026-06-10T00:00:00.000Z",
		elapsedMs: 1000,
		tokens: { input: 1, output: 1, total: 2 },
		costUsd: 0,
	};
}

// deriveRunEvidenceState only reads runs, notices, and pendingEvidenceBuildRunIds.
function observability(
	overrides: {
		runs?: ObservabilityRunSummary[];
		notices?: ObservabilityNotice[];
		pendingEvidenceBuildRunIds?: string[];
	} = {},
): ObservabilitySnapshot {
	return {
		runs: overrides.runs ?? [],
		notices: overrides.notices ?? [],
		pendingEvidenceBuildRunIds: overrides.pendingEvidenceBuildRunIds ?? [],
	} as unknown as ObservabilitySnapshot;
}

function readyRun(runId: string, evidenceId: string): ObservabilityRunSummary {
	return {
		runId,
		evidence: { evidenceId, firstPassSuccess: true, findingCount: 0, tags: [] },
	} as unknown as ObservabilityRunSummary;
}

function overlayHandle(): OverlayHandle {
	return {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
}

function fakeTui(
	rows = 42,
	columns = 132,
): {
	tui: TUI;
	component: () => Component;
	options: () => OverlayOptions | undefined;
} {
	let mounted: Component | null = null;
	let overlayOptions: OverlayOptions | undefined;
	const tui = {
		terminal: { rows, columns },
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
			mounted = component;
			overlayOptions = options;
			return overlayHandle();
		},
		requestRender() {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay was not mounted");
			return mounted;
		},
		options: () => overlayOptions,
	};
}

function evidenceErrorNotice(runId: string, message: string): ObservabilityNotice {
	return { id: `notice-${runId}`, at: 0, kind: "evidence", level: "error", message, ref: { runId } };
}

function spec(id: string, audience: AgentSpec["audience"]): AgentSpec {
	return {
		id,
		name: id,
		description: `${id} agent`,
		source: "builtin",
		filepath: `/builtin/${id}.md`,
		tools: [],
		category: "research",
		capabilityClass: "read-only",
		latencyClass: "fast",
		projectContextTier: "bounded",
		audience,
		tags: [],
		skills: [],
		output: null,
		body: "",
	};
}

function fakeAgents(): AgentsContract {
	const specs = [
		spec("coder", "base"),
		spec("scout", "shadow"),
		spec("provenance", "shadow"),
		spec("internal-scout-helper", "internal"),
		spec("claude-cli", "base"),
	];
	return {
		list: () => [],
		get: () => null,
		listSpecs: () => specs,
		getSpec: (id: string) => specs.find((entry) => entry.id === id) ?? null,
		reload() {},
		parseFleet: () => ({ steps: [] }),
	};
}

function settingsForFleet(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "mini", runtime: "openai-compat", url: "http://localhost:1234", defaultModel: "model-old" }];
	settings.workers.profiles.fast = { target: "mini", model: "model-old", thinkingLevel: "off" };
	settings.workers.agentBindings.scout = "fast";
	settings.delegation.agents = [{ id: "claude-cli", command: "claude", args: ["--acp"] }];
	return settings;
}

function fakeProviders(settings: () => Readonly<ClioSettings>): ProvidersContract {
	return {
		list: () =>
			settings().targets.map((target) => ({
				target,
				runtime: null,
				available: true,
				reason: "",
				health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 1 },
				capabilities: {
					chat: true,
					tools: true,
					reasoning: false,
					vision: false,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					contextWindow: 4096,
					maxTokens: 1024,
				},
				discoveredModels: ["model-new", "model-old"],
				discoveredModelsSource: "probe",
			})),
		getTarget: (id: string) => settings().targets.find((target) => target.id === id) ?? null,
		getRuntime: () => null,
	} as unknown as ProvidersContract;
}

describe("fleet overlay", () => {
	it("renders running rows, retry rows, and kv totals from a dispatch snapshot", () => {
		const lines = formatFleetOverlayBodyLines(
			snapshot({
				running: [
					{
						runId: "run-abcdef123456",
						agentId: "coder",
						runtimeKind: "http",
						outcomePhase: "running",
						heartbeat: "alive",
						lineage: { parentRunId: null, rootRunId: "run-abcdef123456", attempt: 0, depth: 0 },
						startedAt: "2026-06-10T00:00:00.000Z",
						elapsedMs: 12_000,
						tokens: { input: 100, output: 42, total: 142 },
						costUsd: 0.0012,
					},
				],
				retrying: [
					{
						runId: "run-retry123456",
						agentId: "verifier",
						attempt: 1,
						dueAt: "2026-06-10T00:00:05.000Z",
						reason: "stalled: no worker activity",
					},
				],
				totals: { inputTokens: 100, outputTokens: 42, totalTokens: 142, costUsd: 0.0012, runtimeSeconds: 12 },
			}),
		);

		const body = strip(lines.join("\n"));
		// Section headers now use the list-group recipe.
		ok(body.includes("── running (1)"));
		ok(body.includes("── retrying (1)"));
		ok(body.includes("── totals"));
		ok(body.includes("coder"));
		ok(body.includes("verifier"));
		// Totals render as key-value rows, not a packed `key=value` line.
		ok(/total\s+142/.test(body), `totals should read as a kv row, got: ${body}`);
		ok(/cost\s+\$0\.0012/.test(body), `cost should read as a kv row, got: ${body}`);
		ok(!body.includes("total=142"), "the packed totals line is gone");
	});

	it("renders the generated timestamp as a local clock, never a raw ISO string", () => {
		const body = strip(formatFleetOverlayBodyLines(snapshot()).join("\n"));
		ok(/generated \d{2}:\d{2}:\d{2}\b/.test(body), `generated line should carry a clock, got: ${body}`);
		ok(!body.includes("2026-06-10T00:00:00.000Z"), "the raw ISO string must not survive");
	});

	it("tokens status-ish cells: stale is a warning and failed is an error", () => {
		const lines = formatFleetOverlayBodyLines(
			snapshot({
				running: [
					{
						runId: "run-stale00001",
						agentId: "coder",
						runtimeKind: "http",
						outcomePhase: "failed",
						heartbeat: "stale",
						lineage: { parentRunId: null, rootRunId: "run-stale00001", attempt: 1, depth: 0 },
						startedAt: "2026-06-10T00:00:00.000Z",
						elapsedMs: 4_000,
						tokens: { input: 10, output: 5, total: 15 },
						costUsd: 0,
					},
				],
			}),
		);
		const body = lines.join("\n");
		ok(body.includes(theme.fgSequence("warning")), "a stale heartbeat should paint the warning token");
		ok(body.includes(theme.fgSequence("error")), "a failed phase should paint the error token");
	});

	it("renders costs at or above a cent with two decimals via the shared formatter", () => {
		const body = strip(
			formatFleetOverlayBodyLines(
				snapshot({
					totals: { inputTokens: 100, outputTokens: 42, totalTokens: 142, costUsd: 0.42, runtimeSeconds: 12 },
				}),
			).join("\n"),
		);
		ok(/cost\s+\$0\.42\b/.test(body), `cost should read cents, got: ${body}`);
		ok(!body.includes("$0.4200"), "the shared formatter drops the four-decimal fleet form");
	});

	it("states the cross-process limitation when no in-process rows exist", () => {
		const body = strip(formatFleetOverlayBodyLines(snapshot()).join("\n"));
		ok(body.includes("── running (0)"));
		ok(body.includes("── retrying (0)"));
		ok(body.includes("Cross-process live retry state is not attached to the TUI"));
	});

	it("marks running rows with pending, ready, and failed proof markers from the observability snapshot", () => {
		const dispatchSnapshot = snapshot({
			running: [runningRow("run-ready"), runningRow("run-pending"), runningRow("run-failed")],
		});
		const obs = observability({
			pendingEvidenceBuildRunIds: ["run-pending"],
			runs: [readyRun("run-ready", "ev-ready")],
			notices: [evidenceErrorNotice("run-failed", "sandbox denied")],
		});
		const lines = formatFleetOverlayBodyLines(dispatchSnapshot, 96, obs);
		const body = strip(lines.join("\n"));
		ok(body.includes(`${GLYPH.ok} proof`), `expected a ready proof marker, got: ${body}`);
		ok(body.includes(`${GLYPH.queued} proof`), `expected a pending proof marker, got: ${body}`);
		ok(body.includes(`${GLYPH.error} proof`), `expected a failed proof marker, got: ${body}`);
		for (const line of lines) {
			ok(visibleWidth(line) <= 96, `line "${line}" should fit within 96 columns`);
			ok(!hasTruncatedAnsi(line), `line carries a truncated escape: ${JSON.stringify(line)}`);
		}
	});

	it("omits proof markers when no observability snapshot is provided", () => {
		const body = strip(formatFleetOverlayBodyLines(snapshot({ running: [runningRow("run-1")] }), 96).join("\n"));
		ok(!body.includes("proof"), `running rows must not show a proof marker without a snapshot, got: ${body}`);
	});

	it("parses /fleet as the fleet overlay command", () => {
		strictEqual(parseSlashCommand("/fleet").kind, "fleet");
	});

	it("mounts full-row width so footer text cannot bleed beside the modal", () => {
		const harness = fakeTui();
		const dispatch = { snapshot: () => snapshot() } as unknown as DispatchContract;
		const handle = openFleetOverlay(harness.tui, dispatch);

		strictEqual(FLEET_OVERLAY_WIDTH, "100%");
		strictEqual(harness.options()?.width, "100%");
		const lines = harness.component().render(132);
		for (const line of lines) strictEqual(visibleWidth(line), 132);
		handle.hide();
	});

	it("exposes shadow native agents in the binding picker while keeping ACP and internal agents out", () => {
		const harness = fakeTui();
		const dispatch = { snapshot: () => snapshot() } as unknown as DispatchContract;
		let settings = settingsForFleet();
		settings.workers.agentBindings = {};
		const handle = openFleetOverlay(harness.tui, dispatch, {
			agents: fakeAgents(),
			getSettings: () => settings,
			writeSettings: (next) => {
				settings = next;
			},
		});
		try {
			const component = harness.component();
			component.handleInput?.("\t");
			component.handleInput?.("\t");
			component.handleInput?.("b");

			const rendered = strip(component.render(132).join("\n"));
			ok(rendered.includes("scout (shadow)"), rendered);
			ok(rendered.includes("provenance (shadow)"), rendered);
			ok(rendered.includes("coder (base)"), rendered);
			ok(!rendered.includes("internal-scout-helper"), rendered);
			ok(!rendered.includes("claude-cli"), rendered);
		} finally {
			handle.hide();
		}
	});

	it("renders every bindable native agent in the bindings tab, even when unbound", () => {
		const harness = fakeTui();
		const dispatch = { snapshot: () => snapshot() } as unknown as DispatchContract;
		let settings = settingsForFleet();
		const handle = openFleetOverlay(harness.tui, dispatch, {
			agents: fakeAgents(),
			getSettings: () => settings,
			writeSettings: (next) => {
				settings = next;
			},
		});
		try {
			const component = harness.component();
			component.handleInput?.("\t");
			component.handleInput?.("\t");

			const rendered = strip(component.render(132).join("\n"));
			ok(rendered.includes("agent routes (3)"), rendered);
			ok(rendered.includes("coder"), rendered);
			ok(rendered.includes("provenance"), rendered);
			ok(rendered.includes("scout"), rendered);
			ok(rendered.includes("(unbound)"), rendered);
			ok(rendered.includes("fast"), rendered);
			ok(!rendered.includes("internal-scout-helper"), rendered);
			ok(!rendered.includes("claude-cli"), rendered);
		} finally {
			handle.hide();
		}
	});

	it("lets the bindings tab change the selected shadow agent profile model", () => {
		const harness = fakeTui();
		const dispatch = { snapshot: () => snapshot() } as unknown as DispatchContract;
		let settings = settingsForFleet();
		const handle = openFleetOverlay(harness.tui, dispatch, {
			agents: fakeAgents(),
			providers: fakeProviders(() => settings),
			getSettings: () => settings,
			writeSettings: (next) => {
				settings = next;
			},
		});
		try {
			const component = harness.component();
			component.handleInput?.("\t");
			component.handleInput?.("\t");
			component.handleInput?.("k");
			let rendered = strip(component.render(132).join("\n"));
			ok(rendered.includes("scout"), rendered);
			ok(rendered.includes("shadow"), rendered);
			ok(rendered.includes("model-old"), rendered);

			component.handleInput?.("m");
			rendered = strip(component.render(132).join("\n"));
			ok(rendered.includes("Select model for mini"), rendered);
			ok(rendered.includes("model-new"), rendered);

			component.handleInput?.(ENTER);

			strictEqual(settings.workers.profiles.fast?.model, "model-new");
		} finally {
			handle.hide();
		}
	});
});
