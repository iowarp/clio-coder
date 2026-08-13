import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { forkParentLine, formatTreeRow, TreeOverlayView } from "../../src/interactive/overlays/tree-selector.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = "\x1b";
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const snapshot: TreeSnapshot = {
	sessionId: "session-1",
	meta: {
		id: "session-1",
		cwd: "/tmp/project",
		createdAt: "2026-06-11T00:00:00.000Z",
		endedAt: null,
		model: null,
		target: null,
	},
	leafId: "turn-2",
	rootIds: ["turn-1"],
	nodesById: {
		"turn-1": {
			id: "turn-1",
			parentId: null,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			preview: "first",
			children: ["turn-2"],
		},
		"turn-2": {
			id: "turn-2",
			parentId: "turn-1",
			at: "2026-06-11T00:00:01.000Z",
			kind: "assistant",
			preview: "reply",
			children: [],
		},
	},
};

function session(): SessionContract {
	return {
		current: () => ({ id: "session-1" }) as SessionMeta,
		create: () => ({ id: "session-1" }) as SessionMeta,
		append: () => ({ id: "turn-x", parentId: null, at: "2026-06-11T00:00:00.000Z", kind: "user", payload: {} }),
		appendEntry: (entry) => entry as never,
		replaceEntries: () => {},
		recordSkillActivation: (activation) => activation,
		checkpoint: async () => {},
		resume: () => ({ id: "session-1" }) as SessionMeta,
		fork: () => ({ id: "session-1" }) as SessionMeta,
		tree: () => snapshot,
		switchBranch: () => ({ id: "session-1" }) as SessionMeta,
		switchTurn: () => ({ id: "session-1" }) as SessionMeta,
		editLabel: () => {},
		deleteSession: () => {},
		history: () => [],
		close: async () => {},
	};
}

describe("contracts/tree-selector", () => {
	it("Enter switches by highlighted turn id instead of session id", () => {
		const switched: string[] = [];
		let closed = false;
		const view = new TreeOverlayView(
			{
				session: session(),
				onSwitchTurn: (turnId) => switched.push(turnId),
				onClose: () => {
					closed = true;
				},
			},
			snapshot,
		);

		view.handleInput("\u001b[B");
		view.handleInput("\n");

		deepStrictEqual(switched, ["turn-2"]);
		strictEqual(closed, true);
	});

	it("points the focused row with the accent chevron and styles rows on the system", () => {
		const view = new TreeOverlayView(
			{
				session: session(),
				onSwitchTurn: () => {},
				onClose: () => {},
			},
			snapshot,
		);
		const theme = clioTheme();
		const lines = view.render(60);

		const focused = lines[0];
		ok(focused?.includes(GLYPH.cursor), focused);
		ok(focused?.includes(theme.fgSequence("accent")), focused);
		// The kind is dim scaffolding and the id and preview are muted content.
		ok(focused?.includes(theme.fgSequence("dim")), focused);
		ok(focused?.includes(theme.fgSequence("muted")), focused);
		// No rendered row overflows the overlay content width.
		for (const line of lines) ok(visibleWidth(line) <= 60, `${visibleWidth(line)}: ${line}`);
	});

	it("aligns the timestamp column on visible width, not escape bytes", () => {
		const node = { ...snapshot.nodesById["turn-2"], label: "checkpoint" };
		const line = formatTreeRow({ depth: 1, node, sessionId: "session-1" } as never, { showTimestamps: true, width: 80 });

		strictEqual(visibleWidth(line), 80);
		ok(stripAnsi(line).includes(`label:"checkpoint"`), stripAnsi(line));
		ok(stripAnsi(line).trimEnd().endsWith("2026-06-11 00:00:01"), stripAnsi(line));
	});

	// A session is a chain: every message is a child of the one before it. The
	// walk indented per child, so depth equalled message count and a seventeen
	// message session rendered as a seventeen-level staircase, taking two
	// columns off the preview every row. Measured live on a real session where
	// the deepest rows had lost 34 columns of label.
	it("keeps a linear conversation flat and indents only at a fork", () => {
		const chain = (count: number): TreeSnapshot =>
			({
				sessionId: "s",
				meta: snapshot.meta,
				leafId: `n-${count - 1}`,
				rootIds: ["n-0"],
				nodesById: Object.fromEntries(
					Array.from({ length: count }, (_, index) => [
						`n-${index}`,
						{
							id: `n-${index}`,
							parentId: index === 0 ? null : `n-${index - 1}`,
							at: "2026-06-11T00:00:00.000Z",
							kind: index % 2 === 0 ? "user" : "assistant",
							preview: `row ${index}`,
							label: null,
							children: index === count - 1 ? [] : [`n-${index + 1}`],
						},
					]),
				),
			}) as unknown as TreeSnapshot;

		const view = new TreeOverlayView({ session: session(), onSwitchTurn: () => {}, onClose: () => {} }, chain(17));
		const lines = stripAnsi(view.render(88).join("\n")).split("\n");
		const rows = lines.filter((line) => line.includes("row "));
		ok(rows.length > 8, `expected most of the chain to render, got ${rows.length}`);
		// The glyph column is where the staircase showed. Every row in a chain
		// starts at the same one.
		const kindColumn = (row: string): number => row.search(/\b(?:user|assistant)\b/u);
		const columns = new Set(rows.map(kindColumn));
		deepStrictEqual([...columns], [kindColumn(rows[0] ?? "")], "a chain has one column, not one per message");

		// A fork is what indentation is for, so it still steps right.
		const forked = chain(4) as unknown as { nodesById: Record<string, { children: string[] }> };
		const branchPoint = forked.nodesById["n-1"];
		const branchLeaf = forked.nodesById["n-3"];
		if (branchPoint) branchPoint.children = ["n-2", "n-3"];
		if (branchLeaf) branchLeaf.children = [];
		const forkView = new TreeOverlayView(
			{ session: session(), onSwitchTurn: () => {}, onClose: () => {} },
			forked as unknown as TreeSnapshot,
		);
		const forkRows = stripAnsi(forkView.render(88).join("\n"))
			.split("\n")
			.filter((line) => line.includes("row "));
		const forkColumns = forkRows.map(kindColumn);
		strictEqual(new Set(forkColumns).size, 2, `a fork adds exactly one level, got ${forkColumns.join(",")}`);
	});

	it("footer advertises only working /tree actions", () => {
		const view = new TreeOverlayView(
			{
				session: session(),
				onSwitchTurn: () => {},
				onClose: () => {},
			},
			snapshot,
		);

		strictEqual(view.getHint(), "[↑↓] move · [Enter] switch · [e] label · [Shift+T] ts:off · [Esc] close");
		view.handleInput("d");
		strictEqual(view.getHint(), "[↑↓] move · [Enter] switch · [e] label · [Shift+T] ts:off · [Esc] close");
	});
});

/**
 * /fork wrote `parentSessionId` and `parentTurnId` into the new session's
 * meta.json and /tree showed neither, so a fork and its parent rendered as the
 * same flat list and the turns left behind had no route back. A compaction was
 * likewise invisible: the ledger holds a compactionSummary entry, and the
 * navigator drew a session that had been compacted exactly like one that had
 * not.
 */
describe("contracts/tree-selector shows the structure a session actually has", () => {
	const forked = (): TreeSnapshot => ({
		...snapshot,
		meta: { ...snapshot.meta, parentSessionId: "uie4sywnmgu2", parentTurnId: "019ffafc-bdac-75cf-9cbb-048c508db780" },
	});

	it("names the parent session a fork came from", () => {
		const line = forkParentLine(forked(), clioTheme());
		ok(line !== null, "a forked session states its lineage");
		const text = stripAnsi(line ?? "");
		ok(text.includes("uie4sywnmgu2"), text);
		ok(text.includes("019ffa"), `and the turn it split at: ${text}`);
	});

	it("says nothing about lineage for a session that was not forked", () => {
		strictEqual(forkParentLine(snapshot, clioTheme()), null);
	});

	it("renders the lineage above the turn rows", () => {
		const view = new TreeOverlayView({ session: session(), onSwitchTurn: () => {}, onClose: () => {} }, forked());
		const lines = stripAnsi(view.render(88).join("\n")).split("\n");
		ok(lines[0]?.includes("forked from uie4sywnmgu2"), lines.slice(0, 3).join(" | "));
		ok(
			lines.some((line) => line.includes("first")),
			"the turn rows still render",
		);
	});

	it("renders a compaction node as its own row", () => {
		const compacted: TreeSnapshot = {
			...snapshot,
			nodesById: {
				...snapshot.nodesById,
				"turn-2": { ...snapshot.nodesById["turn-2"], children: ["c-1"] } as never,
				"c-1": {
					id: "c-1",
					parentId: "turn-2",
					at: "2026-06-11T00:00:02.000Z",
					kind: "compaction",
					preview: "6 entries summarized, ~9901 -> ~2100 tokens",
					children: [],
				},
			},
		};
		const view = new TreeOverlayView({ session: session(), onSwitchTurn: () => {}, onClose: () => {} }, compacted);
		const rendered = stripAnsi(view.render(88).join("\n"));
		ok(rendered.includes("compaction"), rendered);
		ok(rendered.includes("6 entries summarized"), rendered);
	});

	it("labels a structural node with no preview by what it is", () => {
		const line = formatTreeRow(
			{
				depth: 0,
				sessionId: "s",
				node: { id: "c-1", parentId: null, at: "2026-06-11T00:00:02.000Z", kind: "compaction", children: [] },
			} as never,
			{ showTimestamps: false, width: 80 },
		);
		ok(stripAnsi(line).includes("(history compacted)"), stripAnsi(line));
	});
});
