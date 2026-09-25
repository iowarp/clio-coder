import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { ClioToken } from "../../src/core/theme-token-hex.js";
import { tokenHex } from "../../src/core/theme-token-hex.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { type CouncilGroupView, councilGroupBody, councilIslandLines } from "../../src/interactive/council-grid.js";
import {
	createDispatchBoardView,
	type DispatchBoardRow,
	formatTaskIslandLines,
} from "../../src/interactive/dispatch-board.js";
import { clioTheme, frame, GLYPH } from "../../src/interactive/theme/index.js";
import { buildWelcomeDashboardLines, type WelcomeDashboardStats } from "../../src/interactive/welcome-dashboard.js";

const WIDTHS = [60, 80, 120, 200] as const;
const ESC = String.fromCharCode(27);

// A Record forces this list to name every token, so a new token cannot slip
// past the palette check below.
const PALETTE: Record<ClioToken, true> = {
	editor: true,
	editorDanger: true,
	editorAction: true,
	accent: true,
	accentDeep: true,
	action: true,
	tool: true,
	agent: true,
	success: true,
	warning: true,
	error: true,
	info: true,
	reason: true,
	dim: true,
	muted: true,
	title: true,
	frame: true,
	frameStrong: true,
};
const PALETTE_HEX: ReadonlySet<string> = new Set<string>(
	Object.keys(PALETTE).map((token) => tokenHex(token as ClioToken)),
);

const hex = (channels: readonly string[]): string =>
	`#${channels.map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;

/**
 * Every escape is an SGR, and every truecolor SGR paints a palette token. A
 * 256-color or NO_COLOR run carries no truecolor codes, so it passes on shape.
 */
function assertTokensOnly(lines: readonly string[]): void {
	for (const line of lines) {
		for (const sequence of line.split(ESC).slice(1)) {
			match(sequence, /^\[[0-9;]*m/u, `non-SGR escape ${JSON.stringify(sequence)}`);
			for (const color of sequence.matchAll(/[34]8;2;(\d+);(\d+);(\d+)/gu)) {
				const value = hex(color.slice(1, 4));
				ok(PALETTE_HEX.has(value), `color ${value} is not a theme token`);
			}
		}
	}
}

function assertFits(lines: readonly string[], width: number): void {
	for (const line of lines) {
		ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripTerminalSequences(line)}`);
	}
}

/** The one island recipe from theme/rules.ts: square corners, side rails, exact width. */
function assertIsland(lines: readonly string[], width: number, title: string): void {
	const plain = lines.map(stripTerminalSequences);
	ok(plain.length >= 3);
	match(plain[0] ?? "", new RegExp(`^┌─ ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} ─+.*┐$`, "u"));
	match(plain.at(-1) ?? "", /^└─+┘$/u);
	for (const row of plain.slice(1, -1)) match(row, /^│ .* │$/u);
	for (const row of plain) strictEqual(visibleWidth(row), width, row);
	assertTokensOnly(lines);
}

const stats: WelcomeDashboardStats = {
	cwd: "/work/clio",
	workspace: null,
	targetLabel: "blade",
	modelLabel: "dynamo/qwopus3.8-27b-flash@q5_k_m",
	route: "ready",
	routeReason: null,
	projectContext: "ok",
	submitKeyLabel: "Enter",
	autonomy: "default",
	targets: "2 configured · 2 ready · blade, mini-vision",
	fleet: "8 agent recipes · 2 profiles",
	quota: "Claude 5h 23% used · Codex wk 21% used",
};

test("the launchpad is a standard island at every width and keeps its action row", () => {
	for (const width of WIDTHS) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.6", width, "launchpad");
		assertIsland(lines, width, "Clio Coder v0.5.6");
		const plain = lines.map(stripTerminalSequences);
		// The action row sits under an inner divider, as in every other island.
		match(plain.at(-3) ?? "", new RegExp(`^│ ${GLYPH.innerDivider}+ │$`, "u"));
		match(plain.at(-2) ?? "", /Enter/u);
		ok(!plain.some((row) => /[╭╮╰╯├┤]/u.test(row)), "no bespoke corners or tees");
	}
});

test("the collapsed session header is one row that never exceeds the width", () => {
	for (const width of WIDTHS) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.6", width, "session");
		strictEqual(lines.length, 1);
		assertFits(lines, width);
		assertTokensOnly(lines);
	}
});

const member = (runId: string, label: string) => ({
	runId,
	label,
	round: 2,
	route: "local/example-model",
	status: { glyph: GLYPH.running, label: "running", token: "action" as const },
	tailText: "weighing the render budget against the prefix cache",
	droppedLines: 0,
});

const council: CouncilGroupView = {
	group: "c1",
	members: [member("r1", "fable"), member("r2", "astra"), member("r3", "sol")],
	synthesis: null,
	status: { glyph: GLYPH.running, label: "running", token: "action" },
	round: 2,
	elapsed: "1m 04s",
};

test("the council card frames its grid or stack inside the width at every width", () => {
	for (const width of WIDTHS) {
		const lines = frame(clioTheme(), "council c1", councilGroupBody(clioTheme(), council, width - 4), width, {
			rightMeta: council.elapsed,
		});
		assertIsland(lines, width, "council c1");
		const island = councilIslandLines(clioTheme(), council, 44);
		strictEqual(island.length, 2);
		assertFits(island, 44);
	}
});

const run: DispatchBoardRow = {
	runId: "run-1",
	agentId: "scout",
	agentAudience: "base",
	origin: "agent",
	runtimeId: "native",
	endpointId: "blade",
	wireModelId: "dynamo/qwopus3.8-27b-flash@q5_k_m",
	status: "running",
	elapsed: "12s",
	elapsedMs: 12_000,
	startedAtMs: 0,
	tokenCount: 1200,
	costUsd: 0,
	task: "map the render path of the fleet island",
} as unknown as DispatchBoardRow;

test("the fleet island is a fixed-width island and fits the narrowest terminal that shows it", () => {
	const empty = formatTaskIslandLines([]);
	assertIsland(empty, 48, "Fleet runs");
	const busy = formatTaskIslandLines([run]);
	assertIsland(busy, 48, "Fleet runs");
	deepStrictEqual(
		busy.map((line) => visibleWidth(line)),
		busy.map(() => 48),
	);
});

test("a dispatch card spends the hollow diamond on origin only, never on a trust verdict", () => {
	for (const verdict of ["grounded", "unverified"] as const) {
		const row = {
			...run,
			origin: "operator",
			status: "completed",
			trust: { version: 1, verdict, text: `${verdict} by worker prose`, axes: {}, claimant: "worker" },
		} as unknown as DispatchBoardRow;
		for (const width of WIDTHS) {
			const lines = createDispatchBoardView(
				() => [row],
				() => undefined,
			).render(width);
			assertFits(lines, width);
			assertTokensOnly(lines);
			const plain = lines.map(stripTerminalSequences).join("\n");
			match(plain, new RegExp(`(?<!${GLYPH.scoped} )${verdict}; `, "u"), `${width}: ${verdict} has no glyph`);
		}
	}
});
