/**
 * The one decision function for opening a run-watching pane.
 *
 * This is the contract the dispatch reshape rests on: panes are pulled by the
 * operator, never pushed by the fleet. If a future change wants a dispatch to
 * open a pane on its own, it has to change this function and this test, not
 * add a setting.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { paneWatchDecision } from "../../src/interactive/pane-policy.js";

describe("pane watch policy", () => {
	it("refuses every dispatch-side trigger, whatever the run is doing", () => {
		for (const runStatus of ["running", "enqueued", "stale", "retrying", "completed", "failed"]) {
			const decision = paneWatchDecision({ source: "dispatch", runStatus });
			strictEqual(decision.open, false, runStatus);
			if (!decision.open) ok(decision.reason.includes("headless"), decision.reason);
		}
	});

	it("opens for operator pull on any run with a live process behind it", () => {
		for (const source of ["workers-view", "slash", "tool"] as const) {
			for (const runStatus of ["running", "stale", "cancelling", "enqueued", "retrying"]) {
				deepStrictEqual(paneWatchDecision({ source, runStatus }), { open: true }, `${source}/${runStatus}`);
			}
		}
	});

	it("refuses a terminal run and points at the post-mortem surface", () => {
		for (const runStatus of ["completed", "failed", "dead", "aborted", "made-up-status"]) {
			const decision = paneWatchDecision({ source: "workers-view", runStatus });
			strictEqual(decision.open, false, runStatus);
			if (!decision.open) ok(decision.reason.includes("fleet view"), decision.reason);
		}
	});
});
