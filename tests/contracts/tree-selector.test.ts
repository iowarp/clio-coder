import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import { TreeOverlayView } from "../../src/interactive/overlays/tree-selector.js";

const snapshot: TreeSnapshot = {
	sessionId: "session-1",
	meta: {
		id: "session-1",
		cwd: "/tmp/project",
		createdAt: "2026-06-11T00:00:00.000Z",
		endedAt: null,
		model: null,
		endpoint: null,
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
