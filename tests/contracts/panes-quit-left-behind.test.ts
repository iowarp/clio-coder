import { match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DockState } from "../../src/domains/mux/dock-controller.js";
import type { MuxPaneRecord } from "../../src/domains/mux/types.js";
import { describePanesLeftBehind } from "../../src/interactive/panes-runtime.js";

function record(paneId: string, label: string, purpose: MuxPaneRecord["purpose"] = "utility"): MuxPaneRecord {
	return { ref: { paneId, tabId: "t1", workspaceId: "w1" }, purpose, label, openedAt: 1 };
}

function dock(paneId: string, slot: DockState["slot"]): DockState {
	return { slot, paneId, tabId: "t1", targetShare: 0.3, lastAppliedShare: 0.3 };
}

describe("contracts/panes /quit names the utility panes it leaves open (#272)", () => {
	it("says nothing when only docks were open, because shutdown closes those", () => {
		const files = record("p1", "files", "utility");
		const watch = record("p2", "workers", "watch");
		const left = describePanesLeftBehind({
			list: () => [files, watch],
			docks: () => [dock("p1", "files"), dock("p2", "workers")],
		});
		strictEqual(left, null);
	});

	it("names each utility pane with its id, the pre-quit command, and the herdr command that closes it now", () => {
		const shell = record("wK:p2A", "bash in panes");
		const files = record("p1", "files");
		const left = describePanesLeftBehind({ list: () => [files, shell], docks: () => [dock("p1", "files")] });
		strictEqual(
			left,
			"Clio left 1 pane open in herdr: bash in panes (wK:p2A). Utility panes stay when a session ends; the docks closed with it. Next time run `/panes close all` before `/quit` to take them with you, or close it now with `herdr pane close <paneId>`.",
		);
	});

	it("counts more than one pane and lists them in the order they were opened", () => {
		const left = describePanesLeftBehind({
			list: () => [record("p3", "bash in panes"), record("p4", "logs: run-1")],
			docks: () => [],
		});
		match(left ?? "", /^Clio left 2 panes open in herdr: bash in panes \(p3\), logs: run-1 \(p4\)\./);
		match(left ?? "", /close them now with `herdr pane close <paneId>`\.$/);
	});
});
