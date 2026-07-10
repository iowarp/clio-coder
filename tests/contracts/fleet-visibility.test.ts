import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { FleetNodeSnapshot } from "../../src/domains/scheduling/cluster.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	formatWorkerContextMeter,
	workerContextSeverity,
	workerContextView,
} from "../../src/interactive/context-meter.js";
import {
	createDispatchBoardStore,
	type DispatchBoardRow,
	formatDispatchBoardLines,
	renderDispatchCard,
} from "../../src/interactive/dispatch-board.js";
import { formatFleetNodesBodyLines, formatFleetOverlayBodyLines } from "../../src/interactive/fleet-overlay.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping needs the escape byte.
const ANSI = /\[[0-9;]*m/g;
function strip(text: string): string {
	return text.replace(ANSI, "");
}

function boardRow(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-visibility1",
		agentId: "coder",
		runtimeKind: "http",
		runtimeId: "openai",
		targetId: "default",
		wireModelId: "gpt-4o",
		status: "running",
		elapsedMs: 4200,
		tokenCount: 900,
		costUsd: 0.01,
		inputTokens: 700,
		outputTokens: 200,
		ttftMs: 120,
		...overrides,
	};
}

describe("per-worker context meter", () => {
	it("classifies thresholds at 80 and 95 percent", () => {
		strictEqual(workerContextSeverity(0), "healthy");
		strictEqual(workerContextSeverity(79), "healthy");
		strictEqual(workerContextSeverity(80), "warn");
		strictEqual(workerContextSeverity(94), "warn");
		strictEqual(workerContextSeverity(95), "critical");
		strictEqual(workerContextSeverity(100), "critical");
	});

	it("derives the view only when a window and usage are known, capped at 100", () => {
		strictEqual(workerContextView(1000, undefined), null);
		strictEqual(workerContextView(1000, 0), null);
		strictEqual(workerContextView(0, 8000), null);
		deepStrictEqual(workerContextView(4000, 8000), {
			pct: 50,
			severity: "healthy",
			usedTokens: 4000,
			contextWindow: 8000,
		});
		strictEqual(workerContextView(9000, 8000)?.pct, 100);
	});

	it("renders a compact colored unit or nothing", () => {
		strictEqual(formatWorkerContextMeter(100, undefined), null);
		const healthy = formatWorkerContextMeter(4000, 8000);
		ok(healthy !== null && strip(healthy) === "ctx 50%");
		const critical = formatWorkerContextMeter(7800, 8000);
		ok(critical !== null && strip(critical) === "ctx 98%");
	});
});

describe("dispatch board fleet visibility", () => {
	it("renders node, gate, reroute, context meter, and tool trail on cards", () => {
		const lines = renderDispatchCard(
			boardRow({
				node: "blade",
				gate: { role: "reviewer", cycle: 2 },
				rerouteCount: 1,
				contextWindow: 8000,
				lastContextTokens: 6800,
				currentTool: "edit",
				recentTools: ["read", "grep"],
			}),
			120,
		);
		const body = strip(lines.join("\n"));
		ok(body.includes("node blade"), `node id renders, got: ${body}`);
		ok(body.includes("gate reviewer c2"), "gate badge renders");
		ok(body.includes("rerouted x1"), "reroute badge renders");
		ok(body.includes("ctx 85%"), "context meter renders");
		ok(body.includes("edit running"), "current tool renders");
		ok(body.includes("recent read grep"), "tool trail renders");
	});

	it("renders the local node when placement is absent", () => {
		const body = strip(renderDispatchCard(boardRow(), 100).join("\n"));
		ok(body.includes("node local"), `absent node renders as local, got: ${body}`);
	});

	it("folds fleet identity and live telemetry from the bus into rows", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-bus1",
				agentId: "coder",
				requestOrigin: "agent",
				targetId: "default",
				wireModelId: "gpt-4o",
				runtimeId: "openai",
				runtimeKind: "http",
				pid: 1,
				node: "mini",
				gate: { role: "candidate", cycle: 1 },
				contextWindow: 10_000,
			});
			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-bus1",
				agentId: "coder",
				event: { type: "clio_tool_start", payload: { tool: "grep" } },
			});
			let row = store.rows().find((entry) => entry.runId === "run-bus1");
			strictEqual(row?.node, "mini");
			deepStrictEqual(row?.gate, { role: "candidate", cycle: 1 });
			strictEqual(row?.contextWindow, 10_000);
			strictEqual(row?.currentTool, "grep");

			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-bus1",
				agentId: "coder",
				event: { type: "clio_tool_finish", payload: { tool: "grep", outcome: "ok" } },
			});
			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-bus1",
				agentId: "coder",
				event: {
					type: "message_end",
					message: { role: "assistant", usage: { input: 8000, output: 500, cacheRead: 1000 } },
				},
			});
			row = store.rows().find((entry) => entry.runId === "run-bus1");
			strictEqual(row?.currentTool, null);
			deepStrictEqual(row?.recentTools, ["grep"]);
			strictEqual(row?.lastContextTokens, 9500);
		} finally {
			store.unsubscribe();
		}
	});

	it("renders a 6-worker mixed local and ssh fleet coherently at 80 and 120 columns", () => {
		const rows: DispatchBoardRow[] = [
			boardRow({ runId: "r1", agentId: "coder", node: "blade", contextWindow: 8000, lastContextTokens: 2000 }),
			boardRow({ runId: "r2", agentId: "verifier", node: "mini", gate: { role: "reviewer", cycle: 1 } }),
			boardRow({ runId: "r3", agentId: "coder", node: "dragon", rerouteCount: 2, status: "stale" }),
			boardRow({ runId: "r4", agentId: "docs-writer" }),
			boardRow({ runId: "r5", agentId: "coder", status: "completed", contextWindow: 8000, lastContextTokens: 7900 }),
			boardRow({ runId: "r6", agentId: "judge", node: "blade", currentTool: "read", recentTools: ["grep", "ls"] }),
		];
		for (const width of [80, 120]) {
			const lines = formatDispatchBoardLines(rows, width);
			ok(lines.length > 0);
			for (const line of lines) {
				ok(visibleWidth(line) <= width, `line exceeds ${width} columns: '${strip(line)}' (${visibleWidth(line)})`);
			}
			const body = strip(lines.join("\n"));
			for (const nodeId of ["blade", "mini", "dragon"]) {
				ok(body.includes(`node ${nodeId}`), `node ${nodeId} visible at ${width} cols`);
			}
			ok(body.includes("node local"), `local rows render at ${width} cols`);
		}
	});
});

describe("fleet overlay fleet visibility", () => {
	it("shows the node column on running rows", () => {
		const body = strip(
			formatFleetOverlayBodyLines({
				generatedAt: "2026-07-10T00:00:00.000Z",
				running: [
					{
						runId: "run-abcdef123456",
						agentId: "coder",
						runtimeKind: "subprocess",
						outcomePhase: "running",
						heartbeat: "alive",
						lineage: { parentRunId: null, rootRunId: "run-abcdef123456", attempt: 0, depth: 0 },
						startedAt: "2026-07-10T00:00:00.000Z",
						elapsedMs: 1000,
						tokens: { input: 10, output: 2, total: 12 },
						costUsd: 0,
						node: { id: "blade", kind: "ssh", host: "blade.lan" },
					},
				],
				retrying: [],
				totals: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0, runtimeSeconds: 1 },
			}).join("\n"),
		);
		ok(/\bnode\b/.test(body), "node header renders");
		ok(body.includes("blade"), "node id renders on the row");
	});

	it("renders the nodes view with state coloring and the empty-state hint", () => {
		const nodes: FleetNodeSnapshot[] = [
			{
				id: "local",
				host: "localhost",
				kind: "local",
				state: "online",
				stateReason: null,
				activeWorkers: 1,
				maxWorkers: 0,
				labels: [],
				lastSeenAt: null,
			},
			{
				id: "blade",
				host: "blade.lan",
				kind: "ssh",
				state: "offline",
				stateReason: "2 consecutive channel failures",
				activeWorkers: 0,
				maxWorkers: 2,
				labels: ["gpu"],
				lastSeenAt: "2026-07-10T00:00:00.000Z",
			},
		];
		const body = strip(formatFleetNodesBodyLines(nodes, 120).join("\n"));
		ok(body.includes("nodes (2)"));
		ok(body.includes("blade.lan"));
		ok(body.includes("offline"));
		ok(body.includes("2 consecutive channel"), "state reason renders (clipped to its column)");

		const empty = strip(formatFleetNodesBodyLines([], 100).join("\n"));
		ok(empty.includes("no fleet nodes configured"));
		ok(empty.includes("clio doctor"));
	});
});
