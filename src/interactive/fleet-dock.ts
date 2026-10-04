import type { UsageSnapshot } from "../domains/quota/types.js";
import type { Component } from "../engine/tui.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { formatTaskIslandLines } from "./dispatch-board.js";

export interface FleetDockDeps {
	getRows: () => ReadonlyArray<DispatchBoardRow>;
	getQuotaSnapshots?: () => ReadonlyArray<UsageSnapshot>;
}

/** BT-007: normal-flow rows reserve space rather than covering transcript words. */
export function createFleetDock(deps: FleetDockDeps): Component {
	return {
		render(width) {
			const rows = deps.getRows().filter((row) => !isHelperRun(row));
			if (rows.length === 0) return [];
			// One card keeps the composer reachable; the summary names the remaining
			// cards, all of which are inspectable in Fleet Runs.
			return formatTaskIslandLines(rows, 1, deps.getQuotaSnapshots?.() ?? [], Math.max(1, width - 4));
		},
		invalidate() {},
	};
}
