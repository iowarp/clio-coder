import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { MuxDetection } from "../../src/domains/mux/detect.js";
import { createDockController, type DockState } from "../../src/domains/mux/dock-controller.js";
import type { MuxClient, MuxPaneMoveRequest } from "../../src/domains/mux/socket-client.js";
import type { MuxPaneRecord } from "../../src/domains/mux/types.js";
import { describePanesLeftBehind } from "../../src/interactive/panes-runtime.js";

function record(paneId: string, label: string, purpose: MuxPaneRecord["purpose"] = "utility"): MuxPaneRecord {
	return { ref: { paneId, tabId: "t1", workspaceId: "w1" }, purpose, label, openedAt: 1 };
}

const userHost = { socketPath: "/run/user/1000/herdr.sock" } as MuxDetection;

function dock(paneId: string, slot: DockState["slot"]): DockState {
	return { slot, paneId, tabId: "t1", targetShare: 0.3, lastAppliedShare: 0.3, hidden: false };
}

describe("contracts/panes /quit names the utility panes it leaves open (#272)", () => {
	it("says nothing when only docks were open, because shutdown closes those", () => {
		const files = record("p1", "files", "utility");
		const watch = record("p2", "workers", "watch");
		const left = describePanesLeftBehind({
			list: () => [files, watch],
			docks: () => [dock("p1", "files"), dock("p2", "workers")],
			detection: () => userHost,
		});
		strictEqual(left, null);
	});

	it("names each utility pane with its id, the pre-quit command, and the herdr command that closes it now", () => {
		const shell = record("wK:p2A", "bash in panes");
		const files = record("p1", "files");
		const left = describePanesLeftBehind({
			list: () => [files, shell],
			docks: () => [dock("p1", "files")],
			detection: () => userHost,
		});
		strictEqual(
			left,
			"Clio left 1 pane open in herdr: bash in panes (wK:p2A). Utility panes stay when a session ends; the docks closed with it. Next time run `/panes close all` before `/quit` to take them with you, or close it now with `herdr pane close <paneId>`.",
		);
	});

	it("counts more than one pane and lists them in the order they were opened", () => {
		const left = describePanesLeftBehind({
			list: () => [record("p3", "bash in panes"), record("p4", "logs: run-1")],
			docks: () => [],
			detection: () => userHost,
		});
		match(left ?? "", /^Clio left 2 panes open in herdr: bash in panes \(p3\), logs: run-1 \(p4\)\./);
		match(left ?? "", /close them now with `herdr pane close <paneId>`\.$/);
	});

	it("says nothing in Clio's own host, because the launcher closes that whole workspace on quit", () => {
		for (const socketPath of [
			"/run/user/1000/clio-coder/clio-coder-0123456789ab.sock",
			"C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\clio-coder-0123456789ab\\herdr.sock",
		]) {
			const left = describePanesLeftBehind({
				list: () => [record("w1:p3", "logs: run-1")],
				docks: () => [],
				detection: () => ({ socketPath }) as MuxDetection,
			});
			strictEqual(left, null);
		}
	});
});

describe("the workers dock gives Clio its width back (bt-11)", () => {
	it("resizes the anchor's tab by nothing after the dock moves out and back in", async () => {
		const calls: string[] = [];
		const pane = (paneId: string, tabId: string) => ({ paneId, tabId, workspaceId: "w1" });
		const client = {
			async paneMove(request: MuxPaneMoveRequest) {
				calls.push(`move ${request.destination.type}`);
				const tabId = request.destination.type === "tab" ? request.destination.tabId : "t-parked";
				return { changed: true, reason: null, previousPaneId: request.paneId, pane: pane("p2", tabId) };
			},
			async paneLayout() {
				const rect = (x: number, width: number) => ({ x, y: 0, width, height: 40 });
				return {
					tabId: "t1",
					workspaceId: "w1",
					panes: [
						{ paneId: "p1", rect: rect(0, 160) },
						{ paneId: "p2", rect: rect(160, 80) },
					],
				};
			},
			async paneResize(request: { paneId: string; amount: number }) {
				calls.push(`resize ${request.paneId} by ${request.amount}`);
				return { changed: false };
			},
		} as unknown as MuxClient;
		const docks = createDockController({ client, anchorPaneId: "p1" });
		docks.adopt("workers", pane("p2", "t1"));
		strictEqual(await docks.hide("workers"), true);
		deepStrictEqual(calls, ["move new_tab", "resize p1 by 0"]);
		calls.length = 0;
		ok(await docks.show("workers"));
		deepStrictEqual(calls, ["move tab", "resize p1 by 0"]);
	});
});
