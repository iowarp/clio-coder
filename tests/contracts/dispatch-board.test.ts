import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import type {
	ObservabilityNotice,
	ObservabilityRunSummary,
	ObservabilitySnapshot,
} from "../../src/domains/observability/index.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	createDispatchBoardStore,
	createDispatchBoardView,
	type DispatchBoardRow,
	deriveRunEvidenceState,
	dispatchStatusPresentation,
	formatDispatchBoardLines,
	formatTaskIslandLines,
	isDispatchBoardRowCancellable,
	isDispatchBoardRowSteerable,
	renderDispatchCard,
	sanitizeDispatchTaskSummary,
	TASK_ISLAND_WIDTH,
} from "../../src/interactive/dispatch-board.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);

function makeRow(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "alpha",
		runtimeKind: "http",
		runtimeId: "rt-1",
		targetId: "local",
		wireModelId: "qwen3-coder",
		status: "running",
		elapsedMs: 1200,
		tokenCount: 512,
		costUsd: 0.0123,
		costProvenance: "known",
		inputTokens: 300,
		outputTokens: 212,
		ttftMs: 180,
		...overrides,
	};
}

type RunEvidence = NonNullable<ObservabilityRunSummary["evidence"]>;

// Minimal observability snapshot: deriveRunEvidenceState only reads runs,
// notices, and pendingEvidenceBuildRunIds, so the rest is elided via cast.
function makeSnapshot(
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

function runSummary(runId: string, evidence: RunEvidence | null = null): ObservabilityRunSummary {
	return { runId, evidence } as unknown as ObservabilityRunSummary;
}

function readyEvidence(evidenceId: string): RunEvidence {
	return { evidenceId, firstPassSuccess: true, findingCount: 0, tags: [] };
}

function evidenceNotice(
	runId: string | undefined,
	level: ObservabilityNotice["level"],
	message: string,
): ObservabilityNotice {
	return {
		id: `notice-${message}`,
		at: 0,
		kind: "evidence",
		level,
		message,
		...(runId !== undefined ? { ref: { runId } } : {}),
	};
}

// Strip every well-formed SGR sequence (ESC [ ... m). If a bare ESC byte
// survives, a string was sliced through the middle of an escape sequence and
// the rendered output is corrupt.
function hasTruncatedAnsi(text: string): boolean {
	const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
	return text.replace(sgr, "").includes(ESC);
}

const stripSgr = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("dispatch board island frames", () => {
	it("opens the fleet-run island with the canonical framed title", () => {
		const top = stripSgr(formatTaskIslandLines([makeRow()])[0] ?? "");
		strictEqual(/^┌─ Fleet runs ─+┐$/.test(top), true, `fleet-run island top border "${top}"`);
	});

	it("separates island rows with a full-width inner divider", () => {
		const lines = formatTaskIslandLines([makeRow({ runId: "a" }), makeRow({ runId: "b", agentId: "beta" })]).map(
			stripSgr,
		);
		const divider = lines.find((line) => line.includes(GLYPH.innerDivider));
		ok(divider, "expected a ╌ inner divider between rows");
		ok(divider.includes(GLYPH.innerDivider.repeat(TASK_ISLAND_WIDTH)), `divider should span the island: "${divider}"`);
	});

	it("frames a dispatch card as ┌─ label ─ … ─ elapsed ─┐ with the elapsed meta before the corner", () => {
		const top = stripSgr(renderDispatchCard(makeRow({ agentId: "researcher", elapsedMs: 42_000 }), 80)[0] ?? "");
		match(top, /^┌─ researcher ─+ 42s ─┐$/, `dispatch card top border "${top}"`);
	});

	it("shows active and total slots for the run's inference endpoint", () => {
		const rendered = stripSgr(
			renderDispatchCard(makeRow({ endpoint: { key: "http://mini:8080", label: "mini:8080", limit: 2 } }), 80, undefined, {
				endpointActive: 1,
			}).join("\n"),
		);
		ok(rendered.includes("slots 1/2 mini:8080"), rendered);
	});

	it("shows queued endpoint work beside occupancy instead of counting it as an active slot", () => {
		const endpoint = { key: "http://queue-test.invalid:9444", label: "queue-test:9444", limit: 1 };
		const rendered = stripSgr(
			formatDispatchBoardLines(
				[makeRow({ runId: "running", endpoint }), makeRow({ runId: "queued", status: "enqueued", endpoint })],
				100,
			).join("\n"),
		);
		ok(rendered.includes("slots 1/1 +1 queued queue-test:9444"), rendered);
		ok(!rendered.includes("slots 2/1"), rendered);
	});
});

describe("dispatch board task island", () => {
	it("renders every framed line at exactly TASK_ISLAND_WIDTH + 4 columns (empty state)", () => {
		const expected = TASK_ISLAND_WIDTH + 4;
		for (const line of formatTaskIslandLines([])) {
			strictEqual(visibleWidth(line), expected, `empty-state line "${line}" should span ${expected} columns`);
		}
	});

	it("keeps the frame aligned with one, several, and overflowing rows", () => {
		const expected = TASK_ISLAND_WIDTH + 4;
		const rowSets: DispatchBoardRow[][] = [
			[makeRow()],
			[makeRow({ runId: "a" }), makeRow({ runId: "b", status: "completed", agentId: "beta" })],
			Array.from({ length: 7 }, (_, i) => makeRow({ runId: `r${i}`, agentId: `agent-${i}` })),
		];
		for (const rows of rowSets) {
			for (const line of formatTaskIslandLines(rows)) {
				strictEqual(visibleWidth(line), expected, `line "${line}" should span ${expected} columns`);
			}
		}
	});

	it("never truncates a styled line through the middle of an ANSI escape", () => {
		// A long agent label is what used to trip the ANSI-unaware cell slicer.
		const rows = [makeRow({ agentId: "very-long-agent-identifier-that-overflows-the-island" })];
		for (const line of formatTaskIslandLines(rows)) {
			ok(!hasTruncatedAnsi(line), `line carries a truncated escape sequence: ${JSON.stringify(line)}`);
		}
	});

	it("renders the agent label as plain bold, dropping the accent color", () => {
		const theme = clioTheme();
		const island = formatTaskIslandLines([makeRow({ agentId: "reviewer" })]).join("\n");
		ok(island.includes(theme.paint("reviewer", { bold: true })), "the agent label should be plain bold");
		ok(!island.includes(theme.style("accent", "reviewer", { bold: true })), "the agent label must drop its accent color");
	});

	it("reads a queued island row as a status pill with no throughput", () => {
		const rows = [makeRow({ status: "enqueued", agentId: "reviewer", elapsedMs: 3000, inputTokens: 0, outputTokens: 0 })];
		const stripped = formatTaskIslandLines(rows).map(stripSgr);
		const rowLine = stripped.find((line) => line.includes("reviewer"));
		ok(rowLine, "expected the reviewer row");
		ok(
			rowLine.includes(`${GLYPH.queued} reviewer · queued · 3.0s`),
			`queued row should read as a status pill, got: "${rowLine}"`,
		);
		ok(!stripped.join("\n").includes("/s)"), "a queued island row shows no (N/s) throughput");
	});

	it("separates island content with the dim middot and never the retired bullet", () => {
		const island = formatTaskIslandLines([makeRow()]).join("\n");
		ok(!island.includes("•"), "island must not render the retired • bullet");
		ok(stripSgr(island).includes("·"), "island should separate chips with the · middot");
	});

	it("renders a bounded task summary beneath the selected worker identity", () => {
		const rendered = stripSgr(
			formatTaskIslandLines([makeRow({ taskSummary: "Map the dispatch lifecycle and report control gaps" })]).join("\n"),
		);
		ok(rendered.includes("Map the dispatch lifecycle and report"), rendered);
		ok(rendered.includes("Fleet runs"), rendered);
	});
});

describe("dispatch board card", () => {
	it("renders every card line at the requested width", () => {
		for (const width of [60, 76, 100]) {
			for (const line of renderDispatchCard(makeRow(), width)) {
				strictEqual(visibleWidth(line), width, `width ${width}: line "${line}" should span ${width} columns`);
			}
		}
	});

	it("renders telemetry token counts through the compact footer formatter", () => {
		const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
		const stripped = renderDispatchCard(makeRow({ inputTokens: 12_000, outputTokens: 3_000, tokenCount: 15_000 }), 76)
			.join("\n")
			.replace(sgr, "");
		ok(stripped.includes(`${GLYPH.up} 12k`), `input should read compact, got: ${stripped}`);
		ok(stripped.includes(`${GLYPH.down} 3k`), `output should read compact, got: ${stripped}`);
		ok(stripped.includes("total 15k"), `total should read compact, got: ${stripped}`);
	});

	it("renders a compact terminal detail line for failed, dead, and aborted cards", () => {
		for (const status of ["failed", "dead", "aborted"] as const) {
			const lines = renderDispatchCard(makeRow({ status, outcomeDetail: "fatal\nworker crash" }), 76);
			const joined = lines.map(stripSgr).join("\n");
			ok(/\bdetail\b/.test(joined), `expected a dim detail key row, got: ${joined}`);
			ok(joined.includes("fatal worker crash"), `expected the detail text, got: ${joined}`);
			for (const line of lines) {
				strictEqual(visibleWidth(line), 76, `line "${line}" should span 76 columns`);
			}
		}
	});

	it("separates card content with the dim middot and never the retired bullet", () => {
		const card = renderDispatchCard(makeRow(), 76).join("\n");
		ok(!card.includes("•"), "card must not render the retired • bullet");
		ok(stripSgr(card).includes("·"), "card should separate chips with the · middot");
	});

	it("paints exactly one red element on a failed card and keeps telemetry neutral", () => {
		const theme = clioTheme();
		const rendered = renderDispatchCard(makeRow({ status: "failed", outcomeDetail: "boom" }), 76).join("\n");
		const errorSeq = theme.fgSequence("error");
		const successSeq = theme.fgSequence("success");
		strictEqual(rendered.split(errorSeq).length - 1, 1, "a failed card carries exactly one red element");
		strictEqual(rendered.split(successSeq).length - 1, 0, "telemetry output tokens must not render green");
		ok(stripSgr(rendered).includes(`${GLYPH.error} failed`), "the single red element is the status value");
	});

	it("renders cost and TTFT muted, never amber warning or the accentDeep structure color", () => {
		const theme = clioTheme();
		const rendered = renderDispatchCard(makeRow({ ttftMs: 180, costUsd: 0.5 }), 76).join("\n");
		strictEqual(rendered.split(theme.fgSequence("warning")).length - 1, 0, "cost must not be amber warning");
		strictEqual(rendered.split(theme.fgSequence("accentDeep")).length - 1, 0, "TTFT and rate must not be accentDeep");
		const stripped = stripSgr(rendered);
		ok(stripped.includes("ttft 180ms"), `expected a muted ttft value, got: ${stripped}`);
		ok(stripped.includes("cost $0.50"), `expected a muted cost value, got: ${stripped}`);
	});

	it("renders truthful cost provenance labels as whole telemetry units", () => {
		const estimated = stripSgr(renderDispatchCard(makeRow({ costUsd: 0.5, costProvenance: "estimated" }), 76).join("\n"));
		ok(estimated.includes("cost ~$0.50 est"), estimated);

		// A card owns its cost column and cannot drop the field the way the footer
		// and /cost do, so it names the absence instead of doubling the word.
		const { costProvenance: _legacyProvenance, ...legacyRow } = makeRow({ costUsd: 0 });
		const unknown = stripSgr(renderDispatchCard(legacyRow, 76).join("\n"));
		ok(unknown.includes("cost not measured"), unknown);

		const narrow = stripSgr(renderDispatchCard(makeRow({ costUsd: 0.5, costProvenance: "estimated" }), 34).join("\n"));
		ok(!narrow.includes("~$0.50") || narrow.includes("~$0.50 est"), narrow);
	});

	it("suppresses throughput on a queued card", () => {
		const rendered = renderDispatchCard(
			makeRow({ status: "enqueued", inputTokens: 0, outputTokens: 0, tokenCount: 0, elapsedMs: 3000 }),
			76,
		).join("\n");
		ok(!rendered.includes("/s)"), "a queued card shows no (N/s) throughput");
	});

	it("renders task identity, run id, and a selection cursor without breaking width", () => {
		const lines = renderDispatchCard(
			makeRow({ runId: "run-task-123", taskSummary: "Audit worker cancellation semantics" }),
			76,
			undefined,
			{ selected: true },
		);
		const rendered = lines.map(stripSgr).join("\n");
		ok(rendered.includes(`${GLYPH.cursor} alpha`), rendered);
		ok(rendered.includes("Audit worker cancellation semantics"), rendered);
		ok(rendered.includes("run-task-123"), rendered);
		for (const line of lines) strictEqual(visibleWidth(line), 76);
	});

	it("wraps task and terminal-detail prose inside an expanded card", () => {
		const taskSummary = "Audit cancellation semantics and explain every operator-visible recovery path before stopping.";
		const outcomeDetail = "The worker stopped after the endpoint closed; reconnect the target and retry this dispatch.";
		const lines = renderDispatchCard(makeRow({ taskSummary, status: "failed", outcomeDetail }), 44);
		const collapsed = lines.map(stripSgr).join(" ").replace(/[│\s]+/gu, " ");

		ok(collapsed.includes(taskSummary), `task summary was cut: ${collapsed}`);
		ok(collapsed.includes(outcomeDetail), `terminal detail was cut: ${collapsed}`);
		for (const line of lines) strictEqual(visibleWidth(line), 44, stripSgr(line));
	});
});

describe("dispatch task summary safety", () => {
	it("strips terminal controls, collapses whitespace, and bounds lifecycle task text", () => {
		const esc = String.fromCharCode(27);
		const summary = sanitizeDispatchTaskSummary(`${esc}[31mred${esc}[0m\n\tmap ${"repository ".repeat(40)}`);
		ok(summary);
		ok(!summary.includes(esc), summary);
		ok(!summary.includes("\n"), summary);
		ok(summary.startsWith("red map repository"), summary);
		ok(visibleWidth(summary) <= 240, summary);
		ok(summary.endsWith("…"), summary);
	});
});

describe("dispatch status presentation", () => {
	it("joins running and queued fleet work under the action token", () => {
		// Running fleet work is Clio acting, so it shares the action orange with
		// queued work rather than the old teal-running/orange-queued split.
		strictEqual(dispatchStatusPresentation("running").token, "action");
		strictEqual(dispatchStatusPresentation("enqueued").token, "action");
	});

	it("distinguishes cancellation and retry transitions from running work", () => {
		strictEqual(dispatchStatusPresentation("cancelling").label, "cancelling");
		strictEqual(dispatchStatusPresentation("cancelling").token, "warning");
		strictEqual(dispatchStatusPresentation("retrying").glyph, GLYPH.phaseRetry);
		strictEqual(dispatchStatusPresentation("retrying").token, "warning");
	});

	it("keeps every terminal and attention outcome in its own status token", () => {
		strictEqual(dispatchStatusPresentation("completed").token, "success");
		strictEqual(dispatchStatusPresentation("failed").token, "error");
		strictEqual(dispatchStatusPresentation("dead").token, "error");
		strictEqual(dispatchStatusPresentation("aborted").token, "dim");
		strictEqual(dispatchStatusPresentation("stale").token, "warning");
	});

	it("carries the section 5 glyph vocabulary for each status", () => {
		strictEqual(dispatchStatusPresentation("running").glyph, GLYPH.running);
		strictEqual(dispatchStatusPresentation("enqueued").glyph, GLYPH.queued);
		strictEqual(dispatchStatusPresentation("completed").glyph, GLYPH.ok);
		strictEqual(dispatchStatusPresentation("failed").glyph, GLYPH.error);
		strictEqual(dispatchStatusPresentation("aborted").glyph, GLYPH.cancelled);
		strictEqual(dispatchStatusPresentation("stale").glyph, GLYPH.warnInline);
	});
});

describe("dispatch board operator capabilities", () => {
	it("offers steering only for live HTTP and SDK rows", () => {
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "running" })), true);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "running", runtimeKind: "sdk" })), true);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "stale" })), true);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "enqueued" })), true);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "running", runtimeKind: "subprocess" })), false);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "running", runtimeKind: "acp-delegation" })), false);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "retrying" })), false);
		strictEqual(isDispatchBoardRowSteerable(makeRow({ status: "completed" })), false);
	});

	it("offers cancellation for active workers and retry timers, never history", () => {
		for (const status of ["running", "stale", "enqueued", "retrying"] as const) {
			strictEqual(isDispatchBoardRowCancellable(makeRow({ status })), true, status);
		}
		for (const status of ["cancelling", "completed", "failed", "dead", "aborted"] as const) {
			strictEqual(isDispatchBoardRowCancellable(makeRow({ status })), false, status);
		}
	});
});

describe("dispatch board terminal taxonomy", () => {
	it("folds terminal bus cost provenance into the rendered row", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchCompleted, {
				runId: "run-cost",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				costUsd: 0.25,
				costProvenance: "estimated",
			} as never);
			const row = store.rows()[0];
			strictEqual(row?.costProvenance, "estimated");
			ok(stripSgr(renderDispatchCard(row as DispatchBoardRow, 76).join("\n")).includes("~$0.25 est"));
		} finally {
			store.unsubscribe();
		}
	});

	it("maps terminal run outcomes to board statuses with timeout detail", () => {
		const cases: Array<{ reason: string; status: DispatchBoardRow["status"]; detail?: string }> = [
			{ reason: "canceled", status: "aborted" },
			{ reason: "interrupted", status: "aborted" },
			{ reason: "stalled", status: "dead" },
			{ reason: "dead", status: "dead" },
			{ reason: "timed_out", status: "failed", detail: "turn timeout exceeded" },
			{ reason: "failed", status: "failed" },
		];

		for (const { reason, status, detail } of cases) {
			const bus = createSafeEventBus();
			const store = createDispatchBoardStore(bus);
			try {
				// Partial payloads on purpose: the board must tolerate runtime
				// events thinner than the compile-time contract, so the typed
				// emit check is bypassed with `as never`.
				bus.emit(BusChannels.DispatchStarted, {
					runId: `run-${reason}`,
					agentId: "coder",
					executionRole: "builder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
				} as never);
				bus.emit(BusChannels.DispatchFailed, {
					runId: `run-${reason}`,
					agentId: "coder",
					executionRole: "builder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
					reason,
				} as never);

				const row = store.rows()[0];
				strictEqual(row?.status, status, `${reason} should render as ${status}`);
				if (detail !== undefined) strictEqual(row?.outcomeDetail, detail);
			} finally {
				store.unsubscribe();
			}
		}
	});

	it("does not downgrade a heartbeat-dead row when the terminal event is generic failed", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-dead",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
			} as never);
			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-dead",
				agentId: "coder",
				event: { type: "heartbeat_status", status: "dead" },
			});
			strictEqual(store.rows()[0]?.status, "dead");

			bus.emit(BusChannels.DispatchFailed, {
				runId: "run-dead",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				reason: "failed",
				outcomeDetail: "exit code 1",
			} as never);
			const row = store.rows()[0];
			strictEqual(row?.status, "dead");
			strictEqual(row?.outcomeDetail, "exit code 1");
		} finally {
			store.unsubscribe();
		}
	});
});

describe("dispatch board operator lifecycle", () => {
	it("projects sanitized task identity from lifecycle events", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			const esc = String.fromCharCode(27);
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-task",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "user",
				pid: 1,
				task: `${esc}[31mInspect\n cancellation${esc}[0m`,
			} as never);
			strictEqual(store.rows()[0]?.taskSummary, "Inspect cancellation");
		} finally {
			store.unsubscribe();
		}
	});

	it("shows cancelling immediately when RunAborted arrives", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-cancel",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "user",
				pid: 1,
			} as never);
			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_abort",
				runId: "run-cancel",
				startedAt: new Date().toISOString(),
				elapsedMs: 10,
				reason: "operator cancel",
			});
			const row = store.rows()[0];
			strictEqual(row?.status, "cancelling");
			ok(stripSgr(renderDispatchCard(row as DispatchBoardRow, 76).join("\n")).includes("cancelling"));
		} finally {
			store.unsubscribe();
		}
	});

	it("clears an in-flight tool on every terminal lifecycle path", () => {
		for (const terminal of [BusChannels.DispatchCompleted, BusChannels.DispatchFailed] as const) {
			const bus = createSafeEventBus();
			const store = createDispatchBoardStore(bus);
			try {
				bus.emit(BusChannels.DispatchStarted, {
					runId: `run-${terminal}`,
					agentId: "coder",
					executionRole: "builder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
					requestOrigin: "user",
					pid: 1,
				} as never);
				bus.emit(BusChannels.DispatchProgress, {
					runId: `run-${terminal}`,
					agentId: "coder",
					event: { type: "clio_tool_start", payload: { tool: "edit" } },
				});
				strictEqual(store.rows()[0]?.currentTool, "edit");
				bus.emit(terminal, {
					runId: `run-${terminal}`,
					agentId: "coder",
					executionRole: "builder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
					requestOrigin: "user",
					...(terminal === BusChannels.DispatchFailed
						? { reason: "failed", outcome: "failed", outcomeDetail: "boom" }
						: { outcome: "succeeded", outcomeDetail: null }),
				} as never);
				strictEqual(store.rows()[0]?.currentTool, null);
			} finally {
				store.unsubscribe();
			}
		}
	});

	it("folds worker steer delivery acknowledgements into the run card", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-steer",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "user",
				pid: 1,
			} as never);
			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-steer",
				agentId: "coder",
				event: { type: "clio_steer_received", payload: { chars: 42 } },
			});
			const row = store.rows()[0];
			strictEqual(row?.steerAcknowledgement?.chars, 42);
			ok(stripSgr(renderDispatchCard(row as DispatchBoardRow, 76).join("\n")).includes("steer received"));
		} finally {
			store.unsubscribe();
		}
	});

	it("warns on the live card when an opaque tool opens the write record", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-open-record",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "user",
				pid: 1,
			} as never);
			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-open-record",
				agentId: "coder",
				event: {
					type: "clio_write_record_downgraded",
					payload: { reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-9" },
				},
			});
			const row = store.rows()[0];
			deepStrictEqual(row?.writeRecordDowngrade, {
				reason: "opaque_tool_succeeded",
				tool: "bash",
				toolCallId: "call-9",
			});
			const rendered = stripSgr(renderDispatchCard(row as DispatchBoardRow, 60).join("\n"));
			match(rendered, /record\s+open: a successful 'bash' call/);
			match(rendered, /paths its arguments do not name/);
		} finally {
			store.unsubscribe();
		}
	});

	it("overlays retry attempt and countdown from dispatch.snapshot and keeps it active", () => {
		const bus = createSafeEventBus();
		let retrying: DispatchSnapshot["retrying"] = [
			{
				runId: "run-retry",
				agentId: "coder",
				task: "Retry the worker with bounded context",
				attempt: 2,
				dueAt: new Date(Date.now() + 30_000).toISOString(),
				reason: "worker exited",
			},
		];
		const snapshot = (): DispatchSnapshot => ({ running: [], retrying }) as unknown as DispatchSnapshot;
		const store = createDispatchBoardStore(bus, snapshot);
		try {
			bus.emit(BusChannels.DispatchFailed, {
				runId: "run-retry",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				reason: "failed",
				outcome: "failed",
				outcomeDetail: "worker exited",
			} as never);
			store.reconcile();
			const retryRow = store.activeRows()[0];
			strictEqual(retryRow?.status, "retrying");
			strictEqual(isDispatchBoardRowCancellable(retryRow as DispatchBoardRow), true);
			strictEqual(retryRow?.retry?.attempt, 2);
			strictEqual(retryRow?.taskSummary, "Retry the worker with bounded context");
			const rendered = stripSgr(renderDispatchCard(retryRow as DispatchBoardRow, 76).join("\n"));
			ok(rendered.includes("attempt 2"), rendered);
			ok(rendered.includes("worker exited"), rendered);

			retrying = [];
			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_abort",
				runId: "run-retry",
				startedAt: null,
				elapsedMs: null,
				reason: "scheduled retry 2 canceled by operator",
			});
			strictEqual(store.activeRows().length, 0);
			strictEqual(store.rows()[0]?.status, "aborted");
		} finally {
			store.unsubscribe();
		}
	});

	it("projects live worker tokens and priced cost from dispatch.snapshot", () => {
		const bus = createSafeEventBus();
		const snapshot = (): DispatchSnapshot =>
			({
				running: [
					{
						runId: "run-live-cost",
						agentId: "scout",
						outcomePhase: "running",
						tokens: { input: 1200, output: 300, total: 1500 },
						costUsd: 0.075,
						costProvenance: "estimated",
					},
				],
				retrying: [],
			}) as unknown as DispatchSnapshot;
		const store = createDispatchBoardStore(bus, snapshot);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-live-cost",
				agentId: "scout",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "agent",
				pid: 1,
			} as never);
			store.reconcile();
			const row = store.rows()[0];
			strictEqual(row?.inputTokens, 1200);
			strictEqual(row?.outputTokens, 300);
			strictEqual(row?.tokenCount, 1500);
			strictEqual(row?.costUsd, 0.075);
			strictEqual(row?.costProvenance, "estimated");
			ok(stripSgr(renderDispatchCard(row as DispatchBoardRow, 76).join("\n")).includes("~$0.07 est"));
		} finally {
			store.unsubscribe();
		}
	});

	it("reveals the authoritative failed or dead attempt after its retry leaves the queue", () => {
		for (const scenario of [
			{ runId: "run-failed-parent", reason: "failed", terminal: "failed" },
			{ runId: "run-dead-parent", reason: "stalled", terminal: "dead" },
		] as const) {
			const bus = createSafeEventBus();
			let retrying: DispatchSnapshot["retrying"] = [
				{
					runId: scenario.runId,
					agentId: "scout",
					attempt: 1,
					dueAt: new Date(Date.now() + 1000).toISOString(),
					reason: "transient failure",
				},
			];
			const store = createDispatchBoardStore(bus, () => ({ running: [], retrying }) as unknown as DispatchSnapshot);
			try {
				bus.emit(BusChannels.DispatchFailed, {
					runId: scenario.runId,
					agentId: "scout",
					reason: scenario.reason,
					outcomeDetail: `${scenario.terminal} detail`,
				} as never);
				store.reconcile();
				strictEqual(store.activeRows()[0]?.status, "retrying");
				retrying = [];
				store.reconcile();
				strictEqual(store.activeRows().length, 0);
				strictEqual(store.rows()[0]?.status, scenario.terminal);
				strictEqual(store.rows()[0]?.outcomeDetail, `${scenario.terminal} detail`);
			} finally {
				store.unsubscribe();
			}
		}
	});

	it("keeps an aborted retry terminal while the snapshot still contains its timer", () => {
		const bus = createSafeEventBus();
		const snapshot = (): DispatchSnapshot =>
			({
				running: [],
				retrying: [
					{
						runId: "run-aborted-retry",
						agentId: "scout",
						attempt: 2,
						dueAt: new Date(Date.now() + 1000).toISOString(),
						reason: "transient failure",
					},
				],
			}) as unknown as DispatchSnapshot;
		const store = createDispatchBoardStore(bus, snapshot);
		try {
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "retrying");

			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_abort",
				runId: "run-aborted-retry",
				startedAt: null,
				elapsedMs: null,
				reason: "scheduled retry 2 canceled by operator",
			});
			store.reconcile();

			const row = store.rows()[0];
			strictEqual(row?.status, "aborted");
			strictEqual(row?.retry, undefined);
			const rendered = stripSgr(renderDispatchCard(row as DispatchBoardRow, 76).join("\n"));
			ok(!rendered.includes("retrying"), rendered);
		} finally {
			store.unsubscribe();
		}
	});

	it("keeps an authoritative cancelling projection above a lagging retry snapshot", () => {
		const bus = createSafeEventBus();
		let aborting = false;
		const snapshot = (): DispatchSnapshot =>
			({
				running: aborting
					? [
							{
								runId: "run-cancelling-retry",
								outcomePhase: "aborting",
								tokens: { input: 20, output: 5, total: 25 },
								costUsd: 0.01,
								costProvenance: "known",
							},
						]
					: [],
				retrying: [
					{
						runId: "run-cancelling-retry",
						agentId: "scout",
						attempt: 2,
						dueAt: new Date(Date.now() + 1000).toISOString(),
						reason: "transient failure",
					},
				],
			}) as unknown as DispatchSnapshot;
		const store = createDispatchBoardStore(bus, snapshot);
		try {
			bus.emit(BusChannels.DispatchFailed, {
				runId: "run-cancelling-retry",
				agentId: "scout",
				reason: "failed",
			} as never);
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "retrying");

			aborting = true;
			store.reconcile();

			const row = store.rows()[0];
			strictEqual(row?.status, "cancelling");
			strictEqual(row?.retry, undefined);
			strictEqual(row?.tokenCount, 25);
		} finally {
			store.unsubscribe();
		}
	});

	it("keeps the last retry projection across a failed snapshot and resumes after recovery", () => {
		const bus = createSafeEventBus();
		let shouldThrow = false;
		let retrying: DispatchSnapshot["retrying"] = [
			{
				runId: "run-snapshot-recovery",
				agentId: "scout",
				attempt: 2,
				dueAt: new Date(Date.now() + 1000).toISOString(),
				reason: "transient failure",
			},
		];
		const store = createDispatchBoardStore(bus, () => {
			if (shouldThrow) throw new Error("snapshot unavailable");
			return { running: [], retrying } as unknown as DispatchSnapshot;
		});
		try {
			bus.emit(BusChannels.DispatchFailed, {
				runId: "run-snapshot-recovery",
				agentId: "scout",
				reason: "failed",
			} as never);
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "retrying");

			shouldThrow = true;
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "retrying");

			shouldThrow = false;
			retrying = [];
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "failed");
		} finally {
			store.unsubscribe();
		}
	});

	it("does not reconcile from a structurally invalid snapshot collection", () => {
		const bus = createSafeEventBus();
		let malformed = false;
		let retrying: DispatchSnapshot["retrying"] = [
			{
				runId: "run-malformed-snapshot",
				agentId: "scout",
				attempt: 2,
				dueAt: new Date(Date.now() + 1000).toISOString(),
				reason: "transient failure",
			},
		];
		const store = createDispatchBoardStore(
			bus,
			() =>
				({
					running: [],
					retrying: malformed ? {} : retrying,
				}) as unknown as DispatchSnapshot,
		);
		try {
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "retrying");

			malformed = true;
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "retrying");

			malformed = false;
			retrying = [];
			store.reconcile();
			strictEqual(store.rows()[0]?.status, "failed");
		} finally {
			store.unsubscribe();
		}
	});

	it("keeps rows and activeRows pure between reconciliations", () => {
		const bus = createSafeEventBus();
		let snapshotCalls = 0;
		const store = createDispatchBoardStore(bus, () => {
			snapshotCalls += 1;
			return {
				running: [],
				retrying: [
					{
						runId: "run-pure-read",
						agentId: "scout",
						attempt: 1,
						dueAt: new Date(Date.now() + 1000).toISOString(),
						reason: "transient failure",
					},
				],
			} as unknown as DispatchSnapshot;
		});
		try {
			store.reconcile();
			const firstRows = store.rows();
			const firstActiveRows = store.activeRows();
			const firstElapsedMs = firstRows[0]?.elapsedMs;
			const secondRows = store.rows();
			const secondActiveRows = store.activeRows();

			deepStrictEqual(secondRows, firstRows);
			deepStrictEqual(secondActiveRows, firstActiveRows);
			strictEqual(secondRows[0]?.elapsedMs, firstElapsedMs);
			strictEqual(secondActiveRows[0]?.elapsedMs, firstElapsedMs);
			strictEqual(snapshotCalls, 1);
		} finally {
			store.unsubscribe();
		}
	});
});

describe("dispatch board evidence state derivation", () => {
	it("derives pending from pendingEvidenceBuildRunIds and points at the run filter", () => {
		const evidence = deriveRunEvidenceState(makeSnapshot({ pendingEvidenceBuildRunIds: ["run-1"] }), "run-1");
		strictEqual(evidence.state, "pending");
		strictEqual(evidence.viewFilter, "evidence:run-1");
	});

	it("derives ready from a run's evidence bundle and folds the id into the filter", () => {
		const snap = makeSnapshot({ runs: [runSummary("run-1", readyEvidence("ev-9"))] });
		const evidence = deriveRunEvidenceState(snap, "run-1");
		strictEqual(evidence.state, "ready");
		strictEqual(evidence.evidenceId, "ev-9");
		strictEqual(evidence.viewFilter, "evidence:ev-9");
	});

	it("derives failed from the latest error-level evidence notice carrying the run id", () => {
		const snap = makeSnapshot({ notices: [evidenceNotice("run-1", "error", "sandbox denied\nbuild step")] });
		const evidence = deriveRunEvidenceState(snap, "run-1");
		strictEqual(evidence.state, "failed");
		strictEqual(evidence.reason, "sandbox denied build step");
		strictEqual(evidence.viewFilter, "evidence:run-1");
	});

	it("does not treat a trailing non-error evidence notice as a failure", () => {
		const snap = makeSnapshot({
			notices: [evidenceNotice("run-1", "error", "boom"), evidenceNotice("run-1", "warning", "retrying")],
		});
		strictEqual(deriveRunEvidenceState(snap, "run-1").state, "none");
	});

	it("ignores an error evidence notice that carries no ref.runId", () => {
		const snap = makeSnapshot({ notices: [evidenceNotice(undefined, "error", "boom")] });
		strictEqual(deriveRunEvidenceState(snap, "run-1").state, "none");
	});

	it("prefers an in-flight pending rebuild over a stale ready bundle", () => {
		const snap = makeSnapshot({
			pendingEvidenceBuildRunIds: ["run-1"],
			runs: [runSummary("run-1", readyEvidence("ev-old"))],
		});
		strictEqual(deriveRunEvidenceState(snap, "run-1").state, "pending");
	});

	it("returns a none state with a dispatch filter when nothing is known", () => {
		strictEqual(deriveRunEvidenceState(makeSnapshot(), "run-1").state, "none");
		strictEqual(deriveRunEvidenceState(makeSnapshot(), "run-1").viewFilter, "dispatch:run-1");
		strictEqual(deriveRunEvidenceState(undefined, "run-1").state, "none");
	});
});

describe("dispatch board card proof line", () => {
	it("renders a pending proof line with the run filter and no overflow", () => {
		const evidence = deriveRunEvidenceState(makeSnapshot({ pendingEvidenceBuildRunIds: ["run-1"] }), "run-1");
		const lines = renderDispatchCard(makeRow(), 76, evidence);
		const joined = lines.map(stripSgr).join("\n");
		ok(/\bproof\b/.test(joined), `expected a dim proof key row, got: ${joined}`);
		ok(joined.includes(`${GLYPH.queued} pending`), `expected the pending marker, got: ${joined}`);
		ok(joined.includes("evidence:run-1"), `expected the run view filter, got: ${joined}`);
		for (const line of lines) {
			strictEqual(visibleWidth(line), 76, `line "${line}" should span 76 columns`);
			ok(!hasTruncatedAnsi(line), `line carries a truncated escape: ${JSON.stringify(line)}`);
		}
	});

	it("renders a ready proof line carrying the evidence id via its filter", () => {
		const snap = makeSnapshot({ runs: [runSummary("run-1", readyEvidence("ev-77"))] });
		const lines = renderDispatchCard(makeRow({ status: "completed" }), 76, deriveRunEvidenceState(snap, "run-1"));
		const joined = lines.map(stripSgr).join("\n");
		ok(joined.includes(`${GLYPH.ok} ready`), `expected the ready marker, got: ${joined}`);
		ok(joined.includes("evidence:ev-77"), `expected the evidence filter, got: ${joined}`);
		for (const line of lines) strictEqual(visibleWidth(line), 76, `line "${line}" should span 76 columns`);
	});

	it("renders a failed proof line with a compact reason and no overflow", () => {
		const snap = makeSnapshot({ notices: [evidenceNotice("run-1", "error", "sandbox denied\nbuild step")] });
		const lines = renderDispatchCard(makeRow({ status: "completed" }), 76, deriveRunEvidenceState(snap, "run-1"));
		const joined = lines.map(stripSgr).join("\n");
		ok(joined.includes(`${GLYPH.error} failed`), `expected the failed marker, got: ${joined}`);
		ok(joined.includes("sandbox denied build step"), `expected the compact reason, got: ${joined}`);
		for (const line of lines) {
			strictEqual(visibleWidth(line), 76, `line "${line}" should span 76 columns`);
			ok(!hasTruncatedAnsi(line), `line carries a truncated escape: ${JSON.stringify(line)}`);
		}
	});

	it("adds no proof line when the evidence state is none", () => {
		const baseline = renderDispatchCard(makeRow(), 76).length;
		const withNone = renderDispatchCard(makeRow(), 76, deriveRunEvidenceState(makeSnapshot(), "run-1")).length;
		strictEqual(withNone, baseline, "an unknown evidence state must not add a card line");
	});
});

describe("dispatch board truncation grammar", () => {
	// Strip the frame borders and trailing pad so an assertion sees the row's
	// own last glyph rather than the card's right corner.
	const rowContent = (line: string): string => stripSgr(line).replace(/^│ /, "").replace(/ │$/, "").replace(/\s+$/, "");

	it("fits an overflowing proof row without a dangling separator at width 80", () => {
		const snap = makeSnapshot({
			notices: [evidenceNotice("run-1", "error", "sandbox denied: bench script wrote outside workspace")],
		});
		const lines = renderDispatchCard(makeRow({ status: "failed" }), 80, deriveRunEvidenceState(snap, "run-1"));
		const proof = lines.find((line) => stripSgr(line).includes("proof") && stripSgr(line).includes("failed"));
		ok(proof, lines.map(stripSgr).join("\n"));
		const content = rowContent(proof);
		ok(!content.endsWith("·"), `proof row must not end on a dangling separator: "${content}"`);
		ok(content.endsWith("…"), `proof row should close on a whole unit or a dim ellipsis: "${content}"`);
		for (const line of lines) strictEqual(visibleWidth(line), 80, `line "${line}" should span 80 columns`);
	});

	it("marks a clipped target model id with an ellipsis at width 80", () => {
		const lines = renderDispatchCard(
			makeRow({
				targetId: "blade-llamacpp-server-primary-fallback",
				wireModelId: "meta-llama-3.3-70b-instruct-q4_k_m-131072ctx",
			}),
			80,
		);
		const target = lines.map(stripSgr).find((line) => line.includes("target"));
		ok(target, lines.map(stripSgr).join("\n"));
		ok(target.includes("…"), `a clipped model id should carry an ellipsis, got: ${target}`);
		ok(!target.includes("131072ctx"), `the full model id must not survive the clip, got: ${target}`);
		for (const line of lines) strictEqual(visibleWidth(line), 80, `line "${line}" should span 80 columns`);
	});

	it("marks a clipped task-island agent label with an ellipsis and keeps its status", () => {
		const rows = [makeRow({ agentId: "integration-benchmark-harness-with-a-very-long-agent-identifier" })];
		const lines = formatTaskIslandLines(rows).map(stripSgr);
		const labelRow = lines.find((line) => line.includes("integration-benchmark"));
		ok(labelRow, lines.join("\n"));
		ok(labelRow.includes("…"), `a clipped agent label should carry an ellipsis, got: ${labelRow}`);
		ok(labelRow.includes("running"), `the status word should survive the label clip, got: ${labelRow}`);
	});

	it("refits status and telemetry rows by whole units at narrow widths", () => {
		const lines = renderDispatchCard(
			makeRow({ inputTokens: 4_000, outputTokens: 1_200, tokenCount: 5_200, elapsedMs: 93_000, costUsd: 0.021 }),
			44,
		).map(stripSgr);
		const status = lines.find((line) => line.includes("status"));
		const telemetry = lines.find((line) => line.includes("telemetry"));
		ok(status && telemetry, lines.join("\n"));
		for (const row of [status, telemetry]) {
			const content = row
				.replace(/\s*│\s*$/, "")
				.replace(/^│\s*/, "")
				.trimEnd();
			ok(!content.endsWith("·"), `row must not end on a dangling separator: "${content}"`);
			ok(!/(cost|total)$/.test(content), `row must not end on a value-less key: "${content}"`);
		}
		ok(
			!/total \d$/.test(telemetry.trimEnd().replace(/│$/, "").trimEnd()),
			`a clipped total must not read as a complete number: "${telemetry}"`,
		);
		ok(
			telemetry.includes("\u2026") || telemetry.includes("total 5.2k"),
			`telemetry closes on a whole unit or ellipsis: "${telemetry}"`,
		);
		ok(
			status.includes("\u2026") || status.includes("cost $0.02"),
			`status closes on a whole unit or ellipsis: "${status}"`,
		);
	});
});

describe("dispatch board live view", () => {
	it("renders at the granted width instead of a baked-in 76-column layout", () => {
		const row = makeRow({
			targetId: "blade-llamacpp-server-primary-fallback",
			wireModelId: "meta-llama-3.3-70b-instruct-q4_k_m-131072ctx",
		});
		const view = createDispatchBoardView(
			() => [row],
			() => undefined,
		);
		for (const width of [44, 60, 76, 96]) {
			const lines = view.render(width);
			ok(lines.length > 0, `width ${width} should render a card`);
			for (const line of lines) {
				ok(visibleWidth(line) <= width, `width ${width} line "${stripSgr(line)}" spans ${visibleWidth(line)}`);
				ok(!hasTruncatedAnsi(line), `width ${width} line must not cut through an escape sequence`);
			}
		}
	});

	it("reads rows and observability live so a repaint reflects store changes", () => {
		let rows: DispatchBoardRow[] = [];
		let snapshot: ObservabilitySnapshot | undefined;
		const view = createDispatchBoardView(
			() => rows,
			() => snapshot,
		);
		ok(
			view
				.render(76)
				.map(stripSgr)
				.some((line) => line.includes("No fleet runs yet")),
			"empty store renders the empty state",
		);

		rows = [makeRow({ runId: "run-9", agentId: "prover" })];
		snapshot = makeSnapshot({ runs: [runSummary("run-9", readyEvidence("EV1"))] });
		const rendered = view.render(76).map(stripSgr).join("\n");
		ok(rendered.includes("prover"), `a row added after construction renders: ${rendered}`);
		ok(rendered.includes("evidence:EV1"), `the live observability snapshot supplies proof state: ${rendered}`);
	});

	it("selects rows with wrapping navigation and retains selection across reorder", () => {
		const first = makeRow({ runId: "run-a", agentId: "alpha" });
		const second = makeRow({ runId: "run-b", agentId: "beta" });
		let rows = [first, second];
		const view = createDispatchBoardView(
			() => rows,
			() => undefined,
		);

		strictEqual(view.selectedRow()?.runId, "run-a");
		view.selectNext();
		strictEqual(view.selectedRow()?.runId, "run-b");
		ok(view.render(76).map(stripSgr).join("\n").includes(`${GLYPH.cursor} beta`));

		rows = [second, first];
		strictEqual(view.selectedRow()?.runId, "run-b", "run-id selection survives lifecycle sorting");
		view.selectNext();
		strictEqual(view.selectedRow()?.runId, "run-a");
		view.selectNext();
		strictEqual(view.selectedRow()?.runId, "run-b", "selection wraps at the end");

		rows = [first];
		strictEqual(view.selectedRow()?.runId, "run-a", "removing the selected row selects the first remaining row");
	});
});
