import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveToolBudgetEnvelope } from "../../src/domains/dispatch/budget-envelope.js";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { createDispatchBoardView, type DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { compactPrimaryLine, type SessionFacts } from "../../src/interactive/footer/widgets.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { abbreviateModelId, fitIdentityLabel, formatTargetLabel } from "../../src/interactive/theme/labels.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import type { WorkerEntryState } from "../../src/interactive/worker-stream.js";

const widths = [40, 44, 60, 92, 120];
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");
function bounded(rows: string[], width: number): void {
	for (const row of rows) assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} > ${width}: ${row}`);
}
function worker(): WorkerEntryState {
	return {
		assignmentId: "assignment-研究-long-id",
		runId: "run-研究-long-id",
		origin: "agent",
		agentId: "scout",
		runtime: { kind: "clio", targetId: "blade-gateway", wireModelId: "mini/qwopus3.8-27b-q6" },
		text: "Useful outcome",
		droppedLines: 0,
		tools: ["read", "bash"],
		attempts: [],
		pending: true,
		progress: {
			revision: 1,
			phase: "tool",
			tailText: "",
			droppedLines: 0,
			droppedBytes: 0,
			currentAction: { tool: "current-研究" },
			recentActions: ["newest", "older", "oldest", "earliest"].map((tool) => ({ tool })),
			toolNames: ["read", "bash"],
			settled: false,
		},
	};
}
function boardRow(id: string): DispatchBoardRow {
	return {
		runId: id,
		agentId: `scout-${id}`,
		runtimeKind: "http",
		runtimeId: "native",
		targetId: "blade-gateway",
		wireModelId: "mini/qwopus3.8-27b-q6",
		status: "enqueued",
		elapsedMs: 1000,
		tokenCount: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		ttftMs: null,
		taskSummary: "Inspect 研究 paths",
	};
}

test("abbreviated identities retain variant suffixes and complete graphemes", () => {
	const a = abbreviateModelId("mini/very-long-model-family-q6");
	const b = abbreviateModelId("mini/very-long-model-family-q8");
	assert.notEqual(a, b);
	assert.ok(a.endsWith("q6"));
	assert.ok(b.endsWith("q8"));
	for (const width of widths) {
		const label = fitIdentityLabel(`研究/👩‍🔬/${"é".repeat(80)}-q6`, width);
		assert.ok(label.endsWith("-q6"));
		assert.ok(visibleWidth(label) <= width);
		assert.doesNotMatch(label, /…\p{Mark}/u);
	}
});

for (const width of widths) {
	test(`composer preserves variant identity, modes and draft at ${width} columns`, () => {
		let streaming = false;
		let approval = false;
		let preparation: "idle" | "preparing" | "compacting" = "idle";
		const terminal = { columns: width, rows: 24, write() {} } as unknown as Terminal;
		const editor = new ClioEditor(new TuiMainScreen(terminal), {
			getModelLabel: () => ({ targetId: "blade-gateway", modelId: "mini/qwopus3.8-27b-q6" }),
			getThinkingLabel: () => "high",
			isStreaming: () => streaming,
			isAwaitingApproval: () => approval,
			getTurnPreparation: () => preparation,
		});
		let rows = editor.render(width);
		bounded(rows, width);
		assert.match(plain(rows), /MESSAGE.*q6/u);
		if (width >= 44) assert.match(plain(rows), /MESSAGE.*blad.*qwopus.*q6/u);
		streaming = true;
		assert.match(plain(editor.render(width)), /FOLLOW-UP/u);
		editor.setText("Research 研究 é");
		assert.match(plain(editor.render(width)), /STEER.*q6/u);
		approval = true;
		rows = editor.render(width);
		bounded(rows, width);
		assert.match(plain(rows), /CONFIRM/u);
		assert.equal(editor.getText(), "Research 研究 é");
		approval = false;
		streaming = false;
		preparation = "preparing";
		assert.match(plain(editor.render(width)), /PREPARING/u);
		preparation = "compacting";
		assert.match(plain(editor.render(width)), /COMPACTING/u);
		assert.equal(editor.getText(), "Research 研究 é");
	});

	test(`footer keeps worktree suffix and current phase at ${width} columns`, () => {
		const line = compactPrimaryLine(
			{
				cwd: `/tmp/${"very-long-parent/".repeat(5)}研究-worktree`,
				branch: "feature/long-branch",
				dirty: true,
				projectType: null,
				remote: null,
			},
			{} as SessionFacts,
			width,
			undefined,
			{
				phase: "tool_blocked",
				since: 0,
				lastMeaningfulAt: 0,
				watchdogTier: 0,
				watchdogPeak: 0,
				localRuntime: false,
			},
		);
		bounded([line], width);
		assert.match(stripTerminalSequences(line), /worktree.*Needs approval/u);
	});

	test(`empty board and multiple-worker navigation fit ${width} columns`, () => {
		let rows: DispatchBoardRow[] = [];
		const board = createDispatchBoardView(
			() => rows,
			() => undefined,
		);
		const empty = board.render(width);
		bounded(empty, width);
		assert.match(plain(empty), /Use \/run or \/delegate to start a run\./u);
		board.selectNext();
		assert.equal(board.selectedRow(), null);
		rows = [boardRow("研究-long-1"), boardRow("研究-long-2")];
		bounded(board.render(width), width);
		assert.match(plain(board.render(width)), /q6/u);
		board.selectNext();
		assert.equal(board.selectedRow()?.runId, "研究-long-2");
		board.toggleDetail();
		bounded(board.render(width), width);
		rows = [...rows].reverse();
		assert.equal(board.selectedRow()?.runId, "研究-long-2");
		board.selectPrevious();
		assert.equal(board.selectedRow()?.runId, "研究-long-1");
	});

	test(`worker preview favors current work and preserves pending input at ${width} columns`, () => {
		const entry = worker();
		const original = structuredClone(entry);
		let rows = renderWorkerEntryLines(entry, width, { detail: transcriptDetail("detailed"), terminalRows: 14 });
		bounded(rows, width);
		assert.match(plain(rows), /now: current-研究/u);
		assert.match(plain(rows), /last: newest/u);
		assert.deepEqual(entry, original);
		entry.receipt = { outcome: "succeeded", durationMs: 1000 };
		entry.pending = false;
		entry.text = "needs_input: checkpoint:decision\nWhich 研究 dataset should I inspect?";
		rows = renderWorkerEntryLines(entry, width, { detail: transcriptDetail("compact") });
		bounded(rows, width);
		assert.match(plain(rows), /needs input/u);
		assert.match(plain(rows), /dataset should I inspect\?/u);
		assert.doesNotMatch(plain(rows), /now:/u);
	});
}

for (const width of widths) {
	test(`active board discloses policy and full task only on detail at ${width} columns`, () => {
		const row = boardRow("run-live");
		const progress = worker().progress;
		assert.ok(progress);
		row.progress = progress;
		row.taskSummary =
			"Read only 研究 notes.txt and report the first line and line count. Do not edit files or run commands. ".repeat(3);
		row.budget = resolveToolBudgetEnvelope({
			recipeId: "debugger",
			policy: { toolCalls: 24, readReserve: 4, synthesis: true },
			hardCap: 150,
			hasReadTool: true,
			retry: false,
			revision: false,
		});
		const before = structuredClone(row);
		const board = createDispatchBoardView(
			() => [row],
			() => undefined,
		);
		const folded = board.render(width);
		bounded(folded, width);
		assert.match(plain(folded), /doing.*now current-研究/u);
		assert.doesNotMatch(plain(folded), /policy|budget|phase.*—/u);
		assert.ok(folded.length <= 13, `compact card used ${folded.length} rows`);
		board.toggleDetail();
		const expanded = board.render(width);
		bounded(expanded, width);
		assert.match(plain(expanded), /policy/u);
		assert.match(plain(expanded), /budget/u);
		assert.ok(expanded.length > folded.length);
		assert.equal(plain(expanded).replace(/\s/g, "").includes("mini/qwopus3.8-27b-q6"), true);
		assert.deepEqual(row, before);
	});

	test(`board hints expose only available actions at ${width} columns`, () => {
		let rows: DispatchBoardRow[] = [];
		const board = createDispatchBoardView(
			() => rows,
			() => undefined,
		);
		let hint: ((width: number) => string | undefined) | undefined;
		const deps = {
			transitions: { state: "closed" },
			dispatchBoard: board,
			terminal: { columns: width },
			requestRender() {},
			startDispatchBoardTicker() {},
			showOverlayFrame: (
				_tui: unknown,
				_child: unknown,
				options: { footerHint: (width: number) => string | undefined },
			) => {
				hint = options.footerHint;
				return {};
			},
		} as unknown as OverlayGeneralOpenersDeps;
		createOverlayGeneralOpeners(deps).toggleDispatchBoard();
		assert.equal(hint?.(width), "[Esc] close");
		rows = [{ ...boardRow("live"), runtimeKind: "http", status: "running" }];
		let text = hint?.(width) ?? "";
		bounded([text], width - 3);
		assert.match(text, /\[s\] steer/u);
		assert.match(text, /\[x\] cancel/u);
		rows = [{ ...boardRow("peer"), runtimeKind: "acp-delegation", status: "running" }];
		text = hint?.(width) ?? "";
		assert.doesNotMatch(text, /steer/u);
		assert.match(text, /cancel/u);
		rows = [{ ...boardRow("done"), status: "completed" }];
		text = hint?.(width) ?? "";
		assert.doesNotMatch(text, /steer|cancel/u);
		assert.match(text, /Enter.*detail/u);
	});
}

for (const width of widths) {
	test(`idle footer still names live workers at ${width} columns`, () => {
		const line = compactPrimaryLine(
			{ cwd: `/tmp/${"parent/".repeat(15)}worktree`, branch: null, dirty: false, projectType: null, remote: null },
			{} as SessionFacts,
			width,
			undefined,
			undefined,
			undefined,
			[
				{ ...boardRow("one"), status: "running" },
				{ ...boardRow("two"), status: "running" },
			],
		);
		bounded([line], width);
		assert.match(stripTerminalSequences(line), /worktree.*2 workers/u);
	});
}

for (const width of widths) {
	test(`identity and footer sanitize OSC, CSI and C0 before fitting at ${width} columns`, () => {
		const payload = `${"x".repeat(80)}\x1b]0;FAKE_MODEL_NAME\x07-q6`;
		const sanitized = `${"x".repeat(80)}-q6`;
		assert.equal(fitIdentityLabel(payload, width), fitIdentityLabel(sanitized, width));
		assert.equal(abbreviateModelId(payload), abbreviateModelId(sanitized));
		const variants = [
			["\x1b]0;OSC_TITLE_PAYLOAD\x07", ""],
			["\x1b]0;OSC_TITLE_PAYLOAD\x1b\\", ""],
			["\x1b[2J\x1b[31m", ""],
			["\x00\x07\x1f\x7f\t\r\n", " "],
		] as const;
		for (const [controls, replacement] of variants) {
			const raw = `mini/qwopus${controls}3.8-27b-q6`;
			const clean = `mini/qwopus${replacement}3.8-27b-q6`;
			assert.equal(
				formatTargetLabel("blade-gateway", raw, { width }),
				formatTargetLabel("blade-gateway", clean, { width }),
			);
			assert.equal(
				formatTargetLabel(`blade${controls}gateway`, clean, { width }),
				formatTargetLabel(`blade${replacement}gateway`, clean, { width }),
			);
			const cwd = `/tmp/${"a".repeat(80)}${controls}/leaf`;
			const cleanCwd = `/tmp/${"a".repeat(80)}${replacement}/leaf`;
			const render = (path: string) =>
				compactPrimaryLine(
					{ cwd: path, branch: null, dirty: false, projectType: null, remote: null },
					{} as SessionFacts,
					width,
				);
			const actual = render(cwd);
			assert.equal(actual, render(cleanCwd));
			bounded([actual], width);
			const plain = stripTerminalSequences(actual);
			assert.doesNotMatch(plain, /OSC_TITLE_PAYLOAD/u);
			assert.ok([...plain].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
		}
	});
}

test("shared model labels let long placement yield before distinct families", () => {
	const first = abbreviateModelId("very-long-placement/qwopus3.8-27b-q6");
	const second = abbreviateModelId("very-long-placement/llamus3.8-27b-q6");
	assert.notEqual(first, second);
	assert.match(first, /qwopus.*q6/u);
	assert.match(second, /llamus.*q6/u);
	bounded([first, second], 24);
});

for (const width of widths) {
	test(`completed trust remains honest and full provenance opens on Enter at ${width} columns`, () => {
		const row = boardRow("completed-run");
		row.status = "completed";
		row.trust = {
			version: 1,
			verdict: "unverified",
			claimant: "worker",
			unknown: [],
			refs: [],
			axes: {
				artifactIntegrity: "verified",
				validationGrounding: "absent",
				independentReview: "absent",
				autonomyEnforcement: "enforced",
				contextProvenance: "recorded",
				completionEvidence: "absent",
			},
			text:
				"sealed; no validation observed; not independently reviewed; mediated; context recorded; completion not recorded",
		};
		const original = structuredClone(row);
		const board = createDispatchBoardView(
			() => [row],
			() => undefined,
		);
		const folded = board.render(width);
		bounded(folded, width);
		const words = (lines: string[]) => plain(lines).replace(/│/gu, " ").replace(/\s+/gu, " ");
		assert.match(words(folded), /unverified; no validation observed/u);
		assert.doesNotMatch(words(folded), /independently reviewed|context recorded/u);
		board.toggleDetail();
		const full = board.render(width);
		bounded(full, width);
		assert.ok(full.length > folded.length);
		for (const clause of row.trust.text.split("; ")) assert.ok(words(full).includes(clause), clause);
		assert.deepEqual(row, original);
		board.toggleDetail();
		row.trust = {
			...row.trust,
			axes: { ...row.trust.axes, contextProvenance: "unknown" },
			text: row.trust.text.replace("context recorded", "context unknown"),
		};
		assert.match(words(board.render(width)), /context unknown/u);
		row.trust = {
			...row.trust,
			verdict: "compromised",
			axes: { ...row.trust.axes, validationGrounding: "failed" },
			text: row.trust.text.replace("no validation observed", "validation failed by host"),
		};
		assert.match(words(board.render(width)), /compromised.*validation failed by host/u);
	});
}
