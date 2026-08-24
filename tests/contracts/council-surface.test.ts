import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import {
	buildCouncilDispatchArgs,
	COUNCIL_DEFAULT_ROSTER,
	COUNCIL_NO_ROSTER_NOTICE,
	resolveCouncilRoster,
} from "../../src/interactive/council.js";
import { dispatchCouncilThroughRegistry } from "../../src/interactive/council-dispatch.js";
import {
	COUNCIL_COLUMN_GUTTER,
	COUNCIL_COLUMN_MIN_WIDTH,
	type CouncilGroupView,
	type CouncilMemberView,
	councilGridLayout,
	councilMemberLines,
} from "../../src/interactive/council-grid.js";
import {
	type DispatchBoardRow,
	dispatchBoardItems,
	formatDispatchBoardLines,
	formatTaskIslandLines,
	renderCouncilCard,
	TASK_ISLAND_WIDTH,
} from "../../src/interactive/dispatch-board.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { clioTheme } from "../../src/interactive/theme/index.js";
import type { WorkerEntryState } from "../../src/interactive/worker-stream.js";

const ESC = String.fromCharCode(27);

/** Assertions read the text an operator sees, not the color it is painted in. */
function plain(lines: string | string[]): string {
	return stripTerminalSequences(Array.isArray(lines) ? lines.join("\n") : lines);
}

function rosters(...names: string[]): Record<string, { members: unknown[] }> {
	return Object.fromEntries(names.map((name) => [name, { members: [{ label: "alpha" }, { label: "beta" }] }]));
}

describe("/council command spec", () => {
	it("parses the flags, keeps the task greedy, and reports usage for what it cannot accept", () => {
		const parsed = parseSlashCommand("/council --roster design --rounds 2 --synthesis vote weigh the storage layout");
		strictEqual(parsed.kind, "council");
		if (parsed.kind !== "council") return;
		strictEqual(parsed.task, "weigh the storage layout");
		deepStrictEqual(parsed.options, { roster: "design", rounds: 2, synthesis: "vote" });

		// The rest is greedy, so flag-shaped words inside the task stay in the task.
		const greedy = parseSlashCommand("/council compare --roster style options for the reader");
		strictEqual(greedy.kind, "council");
		if (greedy.kind === "council") {
			strictEqual(greedy.task, "compare --roster style options for the reader");
			deepStrictEqual(greedy.options, {});
		}

		const usages: Array<[string, RegExp | null]> = [
			["/council", null],
			["/council --rounds 4 assess the plan", /--rounds must be an integer 1\.\.3/],
			["/council --rounds two assess the plan", /--rounds must be an integer 1\.\.3/],
			["/council --synthesis maybe assess the plan", /Invalid value for --synthesis/],
			["/council --roster", /requires a value/],
		];
		for (const [line, reason] of usages) {
			const usage = parseSlashCommand(line);
			strictEqual(usage.kind, "council-usage", line);
			if (usage.kind === "council-usage" && reason !== null) match(usage.reason ?? "", reason, line);
		}
	});

	it("names the flags and the task in its usage line", () => {
		const notices: string[] = [];
		const ctx = {
			notice: (_level: string, text: string) => notices.push(text),
			render: () => undefined,
		} as unknown as SlashCommandContext;
		dispatchSlashCommand(parseSlashCommand("/council"), ctx);
		match(
			notices.join("\n"),
			/\/council \[--roster <name>\] \[--rounds <n>\] \[--synthesis <judge\|vote\|none>\] <task>/,
		);
	});
});

describe("/council roster resolution", () => {
	it("takes the named roster, falls back to the default one, and refuses when neither exists", () => {
		deepStrictEqual(resolveCouncilRoster("design", rosters("design", "default")), { ok: true, roster: "design" });
		deepStrictEqual(resolveCouncilRoster(undefined, rosters("design", "default")), {
			ok: true,
			roster: COUNCIL_DEFAULT_ROSTER,
		});

		const unknown = resolveCouncilRoster("missing", rosters("design", "default"));
		strictEqual(unknown.ok, false);
		if (!unknown.ok) match(unknown.reason, /no roster named "missing".*default, design/s);

		// One roster that is not called `default` is not a default: seating a
		// council from the only roster present would run models nobody chose.
		const noDefault = resolveCouncilRoster(undefined, rosters("design"));
		strictEqual(noDefault.ok, false);
		if (!noDefault.ok) strictEqual(noDefault.reason, COUNCIL_NO_ROSTER_NOTICE);
	});

	it("dispatches council arguments through the tool path and refuses without a roster", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const notices: string[] = [];
		const settled: Array<Promise<void>> = [];
		const makeCtx = (available: Record<string, { members: unknown[] }>, inFlight = false): SlashCommandContext =>
			({
				notice: (_level: string, text: string) => notices.push(text),
				render: () => undefined,
				isTurnInFlight: () => inFlight,
				getWorkerRosters: () => available,
				runCouncilDispatch: (args: Record<string, unknown>) => {
					calls.push(args);
					const done = Promise.resolve({ status: "ok" as const });
					settled.push(done.then(() => undefined));
					return done;
				},
			}) as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/council weigh the plan"), makeCtx(rosters("default")));
		await Promise.all(settled);
		deepStrictEqual(calls, [{ mode: "council", task: "weigh the plan", roster: "default" }]);

		calls.length = 0;
		notices.length = 0;
		dispatchSlashCommand(parseSlashCommand("/council weigh the plan"), makeCtx(rosters("design")));
		await Promise.all(settled);
		strictEqual(calls.length, 0, "a council with no roster never reaches admission");
		strictEqual(notices[0], COUNCIL_NO_ROSTER_NOTICE);

		notices.length = 0;
		dispatchSlashCommand(parseSlashCommand("/council weigh the plan"), makeCtx(rosters("default"), true));
		await Promise.all(settled);
		strictEqual(calls.length, 0, "an in-flight turn refuses the council rather than queueing it");
		match(notices[0] ?? "", /refused rather than queued/);
	});

	it("builds only the arguments the dispatch tool declares", () => {
		deepStrictEqual(buildCouncilDispatchArgs("assess", "design", { rounds: 3, synthesis: "judge" }), {
			mode: "council",
			task: "assess",
			roster: "design",
			rounds: 3,
			synthesis: "judge",
		});
		deepStrictEqual(buildCouncilDispatchArgs("assess", "design"), {
			mode: "council",
			task: "assess",
			roster: "design",
		});
	});

	it("reports an admission refusal as a refusal rather than as a run", async () => {
		deepStrictEqual(
			await dispatchCouncilThroughRegistry(
				{ invoke: async () => ({ kind: "blocked" as const, reason: "operator declined", decision: {} as never }) },
				{ mode: "council" },
			),
			{ status: "blocked", reason: "operator declined" },
		);
		deepStrictEqual(
			await dispatchCouncilThroughRegistry(
				{
					invoke: async () => ({
						kind: "ok" as const,
						result: { kind: "error" as const, message: "council_roster_unknown: design" },
						decision: {} as never,
					}),
				},
				{ mode: "council" },
			),
			{ status: "error", message: "council_roster_unknown: design" },
		);
	});
});

function makeMember(overrides: Partial<CouncilMemberView> = {}): CouncilMemberView {
	return {
		runId: "run-1",
		label: "alpha",
		round: 1,
		route: "local/example-model",
		status: { glyph: "●", label: "running", token: "action" },
		tailText: "the storage layout holds",
		droppedLines: 0,
		...overrides,
	};
}

describe("council grid layout", () => {
	it("keeps every column readable or stacks the whole group", () => {
		for (const count of [2, 3, 5]) {
			const exact = COUNCIL_COLUMN_MIN_WIDTH * count + COUNCIL_COLUMN_GUTTER * (count - 1);
			strictEqual(councilGridLayout(count, exact).mode, "grid", `${count} members at ${exact}`);
			strictEqual(councilGridLayout(count, exact + 1).mode, "grid", `${count} members at ${exact + 1}`);
			strictEqual(councilGridLayout(count, exact - count).mode, "stack", `${count} members at ${exact - count}`);
		}
		// One member is never a grid; it is a column with nothing beside it.
		strictEqual(councilGridLayout(1, 200).mode, "stack");
	});

	it("divides the width evenly and lays the columns out at that width", () => {
		const layout = councilGridLayout(3, 120);
		strictEqual(layout.mode, "grid");
		strictEqual(layout.columnWidth, Math.floor((120 - COUNCIL_COLUMN_GUTTER * 2) / 3));
		for (const line of councilMemberLines(clioTheme(), makeMember(), layout.columnWidth)) {
			strictEqual(visibleWidth(line), layout.columnWidth);
		}
	});

	it("paints the member label in its roster color and falls back to the accent", () => {
		const theme = clioTheme();
		const accent = theme.style("accent", "alpha", { bold: true });
		const [plain] = councilMemberLines(theme, makeMember(), 40);
		ok(plain?.includes(accent), "a member with no color takes the accent");

		const [tokenColored] = councilMemberLines(theme, makeMember({ color: "info" }), 40);
		ok(tokenColored?.includes(theme.style("info", "alpha", { bold: true })), "a theme color is painted as that token");
		ok(!tokenColored?.includes(accent), "and does not also carry the fallback");

		const [hexColored] = councilMemberLines(theme, makeMember({ color: "#12abcd" }), 40);
		ok(hexColored?.includes(`${ESC}[38;2;18;171;205m`) || hexColored?.includes(`${ESC}[38;5;`), hexColored);

		const [bogus] = councilMemberLines(theme, makeMember({ color: "chartreuse" }), 40);
		ok(bogus?.includes(accent), "a color the theme cannot read falls back rather than dropping the label");
	});
});

function makeCouncilRow(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "coder",
		runtimeKind: "http",
		runtimeId: "rt-1",
		targetId: "local",
		wireModelId: "example-model",
		status: "running",
		elapsedMs: 4200,
		tokenCount: 100,
		costUsd: 0,
		inputTokens: 60,
		outputTokens: 40,
		ttftMs: 120,
		...overrides,
	};
}

function councilRows(count: number, round = 1): DispatchBoardRow[] {
	return Array.from({ length: count }, (_, index) =>
		makeCouncilRow({ runId: `member-${index}`, council: { group: "g1", label: `member${index}`, round } }),
	);
}

describe("council on the fleet runs board", () => {
	it("folds a group into one item wherever its first row sits", () => {
		const rows = [
			...councilRows(2),
			makeCouncilRow({ runId: "solo" }),
			makeCouncilRow({ runId: "synth", council: { group: "g1", label: "synthesis", round: 1 } }),
		];
		const items = dispatchBoardItems(rows);
		strictEqual(items.length, 2);
		strictEqual(items[0]?.kind, "council");
		strictEqual(items[1]?.kind, "run");
		if (items[0]?.kind === "council") {
			strictEqual(items[0].group.members.length, 2);
			ok(items[0].group.synthesis !== null, "the synthesis run belongs to the group, not beside it");
		}
	});

	it("keeps one column per member when a later round replaces an earlier one", () => {
		const rows = [
			makeCouncilRow({ runId: "a1", council: { group: "g1", label: "alpha", round: 1 }, status: "completed" }),
			makeCouncilRow({ runId: "b1", council: { group: "g1", label: "beta", round: 1 }, status: "completed" }),
			makeCouncilRow({ runId: "a2", council: { group: "g1", label: "alpha", round: 2 } }),
			makeCouncilRow({ runId: "b2", council: { group: "g1", label: "beta", round: 2 } }),
		];
		const [item] = dispatchBoardItems(rows);
		ok(item?.kind === "council");
		if (item?.kind !== "council") return;
		deepStrictEqual(
			item.group.members.map((member) => [member.label, member.runId, member.round]),
			[
				["alpha", "a2", 2],
				["beta", "b2", 2],
			],
		);
		strictEqual(item.group.round, 2);
	});

	it("renders a grid at width and a stack when a column would be unreadable", () => {
		const [wide] = dispatchBoardItems(councilRows(3));
		ok(wide?.kind === "council");
		if (wide?.kind !== "council") return;
		const group: CouncilGroupView = wide.group;

		const gridWidth = COUNCIL_COLUMN_MIN_WIDTH * 3 + COUNCIL_COLUMN_GUTTER * 2 + 4;
		const grid = renderCouncilCard(group, gridWidth);
		ok(
			grid.some((line) => ["member0", "member1", "member2"].every((label) => line.includes(label))),
			"every member shares one row when the columns are wide enough",
		);
		for (const line of grid) strictEqual(visibleWidth(line), gridWidth);

		const stack = renderCouncilCard(group, 60);
		ok(
			!stack.some((line) => line.includes("member0") && line.includes("member1")),
			"a narrow board stacks the members instead of squeezing them",
		);
		ok(
			stack.some((line) => line.includes("member2")),
			"and still shows every member",
		);
	});

	it("gives the synthesis run the full width under the members", () => {
		const rows = [
			...councilRows(2),
			makeCouncilRow({
				runId: "synth",
				council: { group: "g1", label: "synthesis", round: 1 },
				status: "completed",
				progress: {
					revision: 1,
					phase: "settled",
					tailText: "the council agrees the layout holds",
					droppedLines: 0,
					droppedBytes: 0,
					currentAction: null,
					recentActions: [],
					toolNames: [],
					settled: true,
				},
			}),
		];
		const [item] = dispatchBoardItems(rows);
		ok(item?.kind === "council");
		if (item?.kind !== "council") return;
		const width = COUNCIL_COLUMN_MIN_WIDTH * 2 + COUNCIL_COLUMN_GUTTER + 4;
		const lines = renderCouncilCard(item.group, width);
		const synthesisIndex = lines.findIndex((line) => line.includes("synthesis"));
		ok(synthesisIndex > 0, "the synthesis row sits under the grid");
		ok(
			lines.slice(synthesisIndex).some((line) => line.includes("the council agrees")),
			"and carries the council's own answer",
		);
	});

	it("shows one compact card with the member count and round, and the grid only in the board", () => {
		const rows = [...councilRows(3, 2), makeCouncilRow({ runId: "solo", agentId: "scout" })];
		const island = plain(formatTaskIslandLines(rows));
		match(island, /council g1/);
		match(island, /3 members/);
		match(island, /r2/);
		ok(!island.includes("example-model"), "the compact card is one card, not three columns");
		for (const line of formatTaskIslandLines(rows)) ok(visibleWidth(line) <= TASK_ISLAND_WIDTH + 4, line);
		match(island, /scout/, "runs beside the council keep their own cards");

		const board = plain(formatDispatchBoardLines(rows, 120));
		match(board, /council g1/);
		match(board, /local\/example-model/, "the expanded board shows each member's route");
	});
});

function makeEntry(overrides: Partial<WorkerEntryState> = {}): WorkerEntryState {
	return {
		assignmentId: "run-1",
		runId: "run-1",
		origin: "user",
		agentId: "coder",
		runtime: { kind: "clio", targetId: "local", wireModelId: "example-model" },
		text: "an answer",
		droppedLines: 0,
		tools: [],
		attempts: [{ runId: "run-1", targetLabel: "local/example-model" }],
		pending: false,
		receipt: { outcome: "succeeded" },
		...overrides,
	};
}

describe("/share of a council run", () => {
	const report = {
		members: [
			{ label: "alpha", runId: "m-1", round: 1, answer: "keep the tuple key", verdict: "pass" },
			{ label: "beta", runId: "m-2", round: 1, answer: "key by node instead", verdict: "fail" },
		],
		synthesis: { kind: "vote", verdict: "pass", tally: { pass: 1, fail: 1 } },
	};

	function shared(entry: WorkerEntryState, runId: string): string[] {
		const notes: string[] = [];
		const ctx = {
			notice: () => undefined,
			render: () => undefined,
			submitOperatorNote: (text: string) => notes.push(text),
			listWorkerRuns: () => [entry],
		} as unknown as SlashCommandContext;
		const command: SlashCommand = parseSlashCommand(`/share ${runId}`);
		dispatchSlashCommand(command, ctx);
		return notes;
	}

	it("brings the whole council report in for a synthesis run id", () => {
		const entry = makeEntry({
			assignmentId: "synth",
			runId: "synth",
			agentId: "council-synthesis",
			attempts: [{ runId: "synth", targetLabel: "local/example-model" }],
			council: { group: "g1", label: "synthesis", round: 1 },
			text: JSON.stringify(report),
		});
		const [note] = shared(entry, "synth");
		ok(note !== undefined);
		match(note ?? "", /^\[worker result] council-synthesis · run synth · ok · shared by the operator/);
		match(note ?? "", /\[alpha] \(verdict pass\) keep the tuple key/);
		match(note ?? "", /\[beta] \(verdict fail\) key by node instead/);
		match(note ?? "", /\[synthesis vote] verdict pass · tally pass=1 fail=1/);
		ok(!(note ?? "").includes('"members"'), "the report reaches the model as prose, never as its raw payload");
	});

	it("labels a member run with its roster label", () => {
		const entry = makeEntry({
			assignmentId: "m-1",
			runId: "m-1",
			attempts: [{ runId: "m-1", targetLabel: "local/example-model" }],
			council: { group: "g1", label: "alpha", round: 2 },
			text: "keep the tuple key",
		});
		const [note] = shared(entry, "m-1");
		match(note ?? "", /\[worker result] coder · run m-1 · ok · shared by the operator\n\[alpha] keep the tuple key/);
	});

	it("shares a synthesis run whose text is not a report verbatim rather than dropping it", () => {
		const entry = makeEntry({
			assignmentId: "synth",
			runId: "synth",
			attempts: [{ runId: "synth", targetLabel: "local/example-model" }],
			council: { group: "g1", label: "synthesis", round: 1 },
			text: "the judge could not answer",
		});
		const [note] = shared(entry, "synth");
		match(note ?? "", /the judge could not answer/);
	});
});
