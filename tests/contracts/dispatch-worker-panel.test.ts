import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	agentAudiencePresentation,
	agentDisplayLabel,
	createDispatchBoardStore,
	type DispatchBoardRow,
	type DispatchBoardStatus,
	dispatchOriginPresentation,
	formatTaskIslandLines,
	renderDispatchCard,
} from "../../src/interactive/dispatch-board.js";
import { type AgentWorkFacts, activityQuadrant, buildHarnessStatePill } from "../../src/interactive/footer/widgets.js";
import type { AgentStatus } from "../../src/interactive/status/index.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function makeRow(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "scout",
		runtimeKind: "http",
		runtimeId: "rt-1",
		targetId: "local",
		wireModelId: "kat-coder",
		status: "running",
		elapsedMs: 1200,
		tokenCount: 512,
		costUsd: 0.01,
		costProvenance: "known",
		inputTokens: 300,
		outputTokens: 212,
		ttftMs: 180,
		...overrides,
	};
}

function workFacts(dispatchRows: ReadonlyArray<DispatchBoardRow>): AgentWorkFacts {
	return { statusText: null, dispatchSummary: null, toolTally: "none · 0✗", dispatchRows, lastTurn: null };
}

// The panel is wide enough here that fitUnits keeps every unit; the narrow-width
// behavior gets its own case below.
function panel(dispatchRows: ReadonlyArray<DispatchBoardRow>, width = 96, maxWorkers = 4): string {
	return strip(activityQuadrant(workFacts(dispatchRows), { width, maxWorkers }).join("\n"));
}

function startRun(bus: ReturnType<typeof createSafeEventBus>, runId: string, agentId: string): void {
	bus.emit(BusChannels.DispatchStarted, {
		runId,
		agentId,
		agentAudience: "shadow",
		executionRole: "builder",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "runtime",
		runtimeKind: "http",
		requestOrigin: "agent",
		node: "mini",
		pid: 1,
	} as never);
}

describe("internal-process identity", () => {
	it("carries agent names unprefixed on every audience", () => {
		for (const agentAudience of ["base", "custom", "shadow", "internal"] as const) {
			strictEqual(agentDisplayLabel(makeRow({ agentAudience })), "scout");
		}
	});

	it("marks shadow and internal runs with a glyph and tone instead of sh:/in:", () => {
		strictEqual(agentAudiencePresentation({ agentAudience: "shadow" })?.glyph, GLYPH.subProcess);
		strictEqual(agentAudiencePresentation({ agentAudience: "shadow" })?.token, "muted");
		strictEqual(agentAudiencePresentation({ agentAudience: "internal" })?.glyph, GLYPH.subProcess);
		strictEqual(agentAudiencePresentation({ agentAudience: "internal" })?.token, "dim");
		strictEqual(agentAudiencePresentation({ agentAudience: "base" }), null);
		strictEqual(agentAudiencePresentation({}), null);
	});

	it("keeps sh:/in: out of the card and the worker row", () => {
		for (const agentAudience of ["shadow", "internal"] as const) {
			const row = makeRow({ agentAudience });
			const card = strip(renderDispatchCard(row, 76).join("\n"));
			ok(!card.includes("sh:"), `card leaked a prefix for ${agentAudience}`);
			ok(!card.includes("in:"), `card leaked a prefix for ${agentAudience}`);
			ok(card.includes(GLYPH.subProcess), `card lost the sub-process glyph for ${agentAudience}`);

			const rendered = panel([row]);
			ok(!rendered.includes("sh:"), `panel leaked a prefix for ${agentAudience}`);
			ok(!rendered.includes("in:"), `panel leaked a prefix for ${agentAudience}`);
			ok(rendered.includes(`${GLYPH.subProcess} scout`), `panel lost the sub-process glyph for ${agentAudience}`);
		}
	});

	it("leaves operator-requested agents unmarked", () => {
		ok(!panel([makeRow({ agentAudience: "base" })]).includes(GLYPH.subProcess));
	});
});

describe("dispatch origin on the board", () => {
	it("gives each origin its own glyph and leaves an unknown one unmarked", () => {
		strictEqual(dispatchOriginPresentation({ requestOrigin: "user" })?.glyph, GLYPH.workerHuman);
		strictEqual(dispatchOriginPresentation({ requestOrigin: "agent" })?.glyph, GLYPH.workerAgent);
		strictEqual(dispatchOriginPresentation({ requestOrigin: "internal" })?.glyph, GLYPH.workerInternal);
		strictEqual(dispatchOriginPresentation({}), null);
	});

	it("marks who asked on the card, the island, and the footer row", () => {
		for (const [requestOrigin, glyph] of [
			["user", GLYPH.workerHuman],
			["agent", GLYPH.workerAgent],
			["internal", GLYPH.workerInternal],
		] as const) {
			const row = makeRow({ requestOrigin });
			ok(strip(renderDispatchCard(row, 76).join("\n")).includes(`${glyph} scout`), `card lost ${requestOrigin} origin`);
			ok(strip(formatTaskIslandLines([row]).join("\n")).includes(`${glyph} scout`), `island lost ${requestOrigin} origin`);
			ok(panel([row]).includes(`${glyph} scout`), `footer row lost ${requestOrigin} origin`);
		}
	});

	// Two axes, two marks: the operator approved the plan that spawned this run,
	// and Clio picked the agent that serves it. Origin leads because it answers
	// "is this mine" first.
	it("carries origin and audience together, origin first", () => {
		const row = makeRow({ requestOrigin: "user", agentAudience: "shadow" });
		ok(panel([row]).includes(`${GLYPH.workerHuman} ${GLYPH.subProcess} scout`));
	});

	it("keeps the fleet quadrant's single orange signal on rows the model started", () => {
		const theme = clioTheme();
		const rendered = activityQuadrant(workFacts([makeRow({ requestOrigin: "agent" })]), {
			width: 96,
			maxWorkers: 4,
		}).join("\n");
		strictEqual(rendered.split(theme.fgSequence("action")).length - 1, 1);
	});
});

describe("footer worker chip", () => {
	const idle: AgentStatus = {
		phase: "idle",
		since: 0,
		lastMeaningfulAt: 0,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	const chip = (rows: ReadonlyArray<DispatchBoardRow>): string =>
		strip(buildHarnessStatePill(clioTheme(), idle, { tools: {}, errors: 0, active: 0 }, rows, 0, 1000, 80, true));

	it("names both counts when the operator and the model are both running work", () => {
		strictEqual(
			chip([
				makeRow({ runId: "a", requestOrigin: "user" }),
				makeRow({ runId: "b", requestOrigin: "agent" }),
				makeRow({ runId: "c", requestOrigin: "agent" }),
			]),
			`${GLYPH.workerHuman}1 ${GLYPH.workerAgent}2`,
		);
	});

	it("keeps the plain count when one kind is running", () => {
		strictEqual(
			chip([makeRow({ runId: "a", requestOrigin: "user" }), makeRow({ runId: "b", requestOrigin: "user" })]),
			"fleet 2",
		);
		strictEqual(chip([makeRow({ requestOrigin: "internal" })]), "fleet 1");
	});

	// A split that cannot name one of the running rows would report a total that
	// is short, so the plain count is the honest fallback.
	it("falls back to the plain count when a running row has no origin", () => {
		strictEqual(chip([makeRow({ runId: "a", requestOrigin: "user" }), makeRow({ runId: "b" })]), "fleet 2");
	});

	it("counts only live rows, whichever origin they carry", () => {
		strictEqual(
			chip([
				makeRow({ runId: "a", requestOrigin: "user" }),
				makeRow({ runId: "b", requestOrigin: "agent" }),
				makeRow({ runId: "c", requestOrigin: "agent", status: "completed" }),
			]),
			`${GLYPH.workerHuman}1 ${GLYPH.workerAgent}1`,
		);
	});
});

describe("dispatch worker panel render states", () => {
	const states: ReadonlyArray<[DispatchBoardStatus, string]> = [
		["enqueued", GLYPH.queued],
		["running", GLYPH.running],
		["completed", GLYPH.ok],
		["failed", GLYPH.error],
	];

	it("renders each of the four states with its shared status glyph", () => {
		for (const [status, glyph] of states) {
			const row = makeRow({ status, node: "mini", ...(status === "completed" ? { receiptId: "run-1" } : {}) });
			const rendered = panel([row]);
			ok(rendered.includes(`scout · mini · ${glyph}`), `${status} row lost its glyph: ${rendered}`);
		}
	});

	it("shows the fleet node on every row and names the local node explicitly", () => {
		ok(panel([makeRow({ node: "mini" })]).includes("scout · mini"));
		ok(panel([makeRow()]).includes("scout · local"));
	});

	it("shows the receipt id once a run has one, and never before", () => {
		ok(panel([makeRow({ status: "completed", receiptId: "1s98yv9an4jf" })]).includes("1s98yv9an4jf"));
		ok(!panel([makeRow({ status: "running", runId: "1s98yv9an4jf" })]).includes("1s98yv9an4jf"));
	});

	it("closes on a whole unit when the panel is too narrow for the receipt id", () => {
		const rendered = panel([makeRow({ status: "completed", node: "mini", receiptId: "1s98yv9an4jf" })], 24);
		ok(!rendered.includes("1s98yv9an4jf"));
		ok(rendered.includes("…"));
	});
});

describe("parallel dispatch visibility", () => {
	const scoutA = makeRow({ runId: "run-a", agentId: "scout", agentAudience: "shadow", node: "mini", elapsedMs: 4000 });
	const scoutB = makeRow({
		runId: "run-b",
		agentId: "scout",
		agentAudience: "shadow",
		node: "dynamo",
		elapsedMs: 9000,
		status: "completed",
		receiptId: "run-b",
	});

	it("gives two parallel workers two rows instead of collapsing one away", () => {
		const lines = panel([scoutA, scoutB])
			.split("\n")
			.filter((line) => line.includes(GLYPH.subProcess));
		strictEqual(lines.length, 2);
		ok(lines[0]?.includes("mini"));
		ok(lines[1]?.includes("dynamo"));
		ok(!panel([scoutA, scoutB]).includes("more"));
	});

	it("counts out loud only what the panel bound actually cuts", () => {
		const rows = [scoutA, scoutB, makeRow({ runId: "run-c" }), makeRow({ runId: "run-d" })];
		ok(!panel(rows, 96, 4).includes("+1 more"));
		ok(panel(rows, 96, 2).includes("+2 more"));
	});
});

describe("dispatch board receipt projection", () => {
	it("attaches the receipt id when a run finalizes", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			startRun(bus, "run-ok", "scout");
			strictEqual(store.rows()[0]?.receiptId, undefined);
			bus.emit(BusChannels.DispatchCompleted, {
				runId: "run-ok",
				agentId: "scout",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "agent",
				outcome: "succeeded",
				outcomeDetail: null,
			} as never);
			strictEqual(store.rows()[0]?.receiptId, "run-ok");
		} finally {
			store.unsubscribe();
		}
	});

	it("attaches the receipt id on a failed run but not on a denied retry", () => {
		for (const [reason, expected] of [
			["failed", "run-fail"],
			["retry_denied", undefined],
		] as const) {
			const bus = createSafeEventBus();
			const store = createDispatchBoardStore(bus);
			try {
				startRun(bus, "run-fail", "scout");
				bus.emit(BusChannels.DispatchFailed, {
					runId: "run-fail",
					agentId: "scout",
					executionRole: "builder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
					requestOrigin: "agent",
					outcome: "failed",
					outcomeDetail: null,
					reason,
				} as never);
				strictEqual(store.rows()[0]?.receiptId, expected);
			} finally {
				store.unsubscribe();
			}
		}
	});
});
