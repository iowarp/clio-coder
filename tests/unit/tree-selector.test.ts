import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import {
	createTreeOverlayViewForTesting,
	formatTreeDeleteError,
	TREE_OVERLAY_WIDTH,
} from "../../src/interactive/overlays/tree-selector.js";

const CURRENT_SESSION_GUARD = new Error(
	"session.deleteSession: refusing to delete the currently open session; close() first",
);

function buildSnapshot(sessionId: string): TreeSnapshot {
	return {
		sessionId,
		meta: {
			id: sessionId,
			cwd: "/tmp",
			createdAt: "2024-01-01T00:00:00.000Z",
			endedAt: null,
			model: null,
			endpoint: null,
		},
		leafId: "n1",
		nodesById: {
			n1: { id: "n1", parentId: null, at: "2024-01-01T00:00:00.000Z", kind: "user", children: [] },
		},
		rootIds: ["n1"],
	};
}

function fakeSession(snapshot: TreeSnapshot, onDelete: () => void): SessionContract {
	const session: Partial<SessionContract> = {
		tree: () => snapshot,
		deleteSession: () => {
			onDelete();
		},
	};
	return session as SessionContract;
}

describe("formatTreeDeleteError", () => {
	it("rewrites the current-session guard into a friendly sentence", () => {
		const msg = formatTreeDeleteError(CURRENT_SESSION_GUARD);
		strictEqual(msg, "[tree] cannot delete the currently-open session");
		ok(!msg.includes("refusing"), "friendly message must not leak the guard text");
		ok(!msg.includes("deleteSession"), "friendly message must not leak the contract name");
	});

	it("surfaces unrelated failures with a neutral prefix", () => {
		const msg = formatTreeDeleteError(new Error("ENOENT: session directory missing"));
		strictEqual(msg, "[tree] could not delete session: ENOENT: session directory missing");
	});

	it("handles non-Error throws", () => {
		const msg = formatTreeDeleteError("boom");
		strictEqual(msg, "[tree] could not delete session: boom");
	});
});

describe("tree-selector delete submode rendering", () => {
	it("renders the friendly shape when the guard fires and hides the raw tail", () => {
		const snapshot = buildSnapshot("s1");
		const view = createTreeOverlayViewForTesting(
			{
				session: fakeSession(snapshot, () => {
					throw CURRENT_SESSION_GUARD;
				}),
				onSwitchBranch: () => {},
				onClose: () => {},
			},
			snapshot,
		);
		view.handleInput("d");
		view.handleInput("y");
		const rendered = view.render(TREE_OVERLAY_WIDTH).join("\n");
		ok(
			rendered.includes("[tree] cannot delete the currently-open session"),
			`friendly status missing; rendered:\n${rendered}`,
		);
		ok(!rendered.includes("deleteSession failed"), "raw failed-prefix must not render");
		ok(!rendered.includes("refusing to delete the current"), "raw guard tail must not render");
	});

	it("renders the success message on a clean delete", () => {
		const snapshot = buildSnapshot("s1");
		let called = false;
		const view = createTreeOverlayViewForTesting(
			{
				session: fakeSession(snapshot, () => {
					called = true;
				}),
				onSwitchBranch: () => {},
				onClose: () => {},
			},
			snapshot,
		);
		view.handleInput("d");
		view.handleInput("y");
		strictEqual(called, true);
		const rendered = view.render(TREE_OVERLAY_WIDTH).join("\n");
		ok(rendered.includes("deleted"), `rendered:\n${rendered}`);
	});
});
