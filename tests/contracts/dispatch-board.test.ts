import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
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
	formatTaskIslandLines,
	renderDispatchCard,
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
	it("opens the task island with the canonical ┌─ Tasks ─ fill ┐ recipe", () => {
		const top = stripSgr(formatTaskIslandLines([makeRow()])[0] ?? "");
		strictEqual(/^┌─ Tasks ─+┐$/.test(top), true, `task island top border "${top}"`);
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

	it("suppresses throughput on a queued card", () => {
		const rendered = renderDispatchCard(
			makeRow({ status: "enqueued", inputTokens: 0, outputTokens: 0, tokenCount: 0, elapsedMs: 3000 }),
			76,
		).join("\n");
		ok(!rendered.includes("/s)"), "a queued card shows no (N/s) throughput");
	});
});

describe("dispatch status presentation", () => {
	it("joins running and queued fleet work under the action token", () => {
		// Running fleet work is Clio acting, so it shares the action orange with
		// queued work rather than the old teal-running/orange-queued split.
		strictEqual(dispatchStatusPresentation("running").token, "action");
		strictEqual(dispatchStatusPresentation("enqueued").token, "action");
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

describe("dispatch board terminal taxonomy", () => {
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
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
				} as never);
				bus.emit(BusChannels.DispatchFailed, {
					runId: `run-${reason}`,
					agentId: "coder",
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
				.some((line) => line.includes("No active dispatches")),
			"empty store renders the empty state",
		);

		rows = [makeRow({ runId: "run-9", agentId: "prover" })];
		snapshot = makeSnapshot({ runs: [runSummary("run-9", readyEvidence("EV1"))] });
		const rendered = view.render(76).map(stripSgr).join("\n");
		ok(rendered.includes("prover"), `a row added after construction renders: ${rendered}`);
		ok(rendered.includes("evidence:EV1"), `the live observability snapshot supplies proof state: ${rendered}`);
	});
});
