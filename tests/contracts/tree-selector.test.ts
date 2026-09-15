import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { TreeOverlayView } from "../../src/interactive/overlays/tree-selector.js";

function fixture(cwd = "/workspace") {
	const snapshot: TreeSnapshot = {
		sessionId: "session",
		meta: { id: "session", cwd, createdAt: "2026-09-01T00:00:00Z", endedAt: null, model: null, target: null },
		leafId: "newest",
		rootIds: ["oldest"],
		nodesById: {
			oldest: { id: "oldest", parentId: null, at: "2026-09-01T00:00:00Z", kind: "user", children: ["branch", "newest"] },
			branch: { id: "branch", parentId: "oldest", at: "2026-09-02T00:00:00Z", kind: "assistant", children: ["marker"] },
			marker: { id: "marker", parentId: "branch", at: "2026-09-02T00:00:00Z", kind: "compaction", children: [] },
			newest: { id: "newest", parentId: "oldest", at: "2026-09-03T00:00:00Z", kind: "assistant", children: [] },
		},
	};
	const switched: string[] = [];
	const edits: unknown[] = [];
	let closed = 0;
	const view = new TreeOverlayView(
		{
			cwd: "/workspace/./",
			session: {
				tree: () => snapshot,
				editLabel: (id, label, sessionId) => {
					edits.push([id, label, sessionId]);
					const node = snapshot.nodesById[id];
					if (node) node.label = label;
				},
			},
			onSwitchTurn: (id) => {
				switched.push(id);
			},
			onClose: () => {
				closed++;
			},
		},
		snapshot,
	);
	const text = () => stripTerminalSequences(view.render(86).join("\n"));
	const order = () =>
		[...text().matchAll(/(?:user|assistant|compaction)\s+(oldest|branch|marker|newest)\b/gu)].map((entry) => entry[1]);
	return { snapshot, view, text, order, switched, edits, closed: () => closed };
}

it("toggles the cwd filter and can recover from an empty filtered list", () => {
	const f = fixture("/another-workspace");
	f.view.handleInput("p");
	match(f.text(), /no turns match the current cwd/u);
	doesNotMatch(f.text(), /oldest/u);
	match(stripTerminalSequences(f.view.getHint()), /cwd:current/u);
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, []);
	f.view.handleInput("s");
	f.view.handleInput("p");
	deepStrictEqual(f.order(), ["newest", "branch", "marker", "oldest"]);
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, ["newest"]);
	strictEqual(f.closed(), 1);
});

it("keeps nodes from a session whose normalized cwd matches", () => {
	const f = fixture();
	f.view.handleInput("p");
	deepStrictEqual(f.order(), ["oldest", "branch", "marker", "newest"]);
});

it("cycles sort order with stable timestamp ties and preserves the selected turn", () => {
	const f = fixture();
	f.view.handleInput("\u001b[B");
	f.view.handleInput("s");
	deepStrictEqual(f.order(), ["newest", "branch", "marker", "oldest"]);
	match(f.text(), /❯.*branch/u);
	f.view.handleInput("s");
	deepStrictEqual(f.order(), ["oldest", "branch", "marker", "newest"]);
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, ["branch"]);
});

it("treats p and s as label text while editing and retains filtering and sorting after refresh", () => {
	const f = fixture();
	f.view.handleInput("p");
	f.view.handleInput("s");
	f.view.handleInput("e");
	f.view.handleInput("p");
	f.view.handleInput("s");
	f.view.handleInput("\r");
	deepStrictEqual(f.edits, [["oldest", "ps", "session"]]);
	deepStrictEqual(f.order(), ["newest", "branch", "marker", "oldest"]);
	match(stripTerminalSequences(f.view.getHint()), /cwd:current.*recent/u);
	match(f.text(), /label:.*ps/u);
});

it("keeps structural rows inert after sorting", () => {
	const f = fixture();
	f.view.handleInput("s");
	f.view.handleInput("\u001b[A");
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, []);
	strictEqual(f.closed(), 0);
	match(f.text(), /not a place to switch/u);
});
