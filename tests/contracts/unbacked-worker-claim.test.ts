import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	buildUnbackedWorkerClaimMessage,
	claimsWorkerResults,
	createUnbackedWorkerClaimRegistration,
} from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { formatToolTally } from "../../src/interactive/footer/widgets.js";

const ACTIVE_TOOLS = "read,grep,find,ls,bash,dispatch";

function afterDispatch(turnId: string): MiddlewareHookInput {
	return { hook: "after_tool", turnId, toolName: ToolNames.Dispatch, metadata: { resultKind: "ok" } };
}

function turnEnd(
	turnId: string,
	text: string,
	overrides: { activeToolNames?: string; stopReason?: string; sharedWorkerNote?: boolean } = {},
): MiddlewareHookInput {
	return {
		hook: "turn_end",
		turnId,
		text,
		metadata: {
			stopReason: overrides.stopReason ?? "stop",
			activeToolNames: overrides.activeToolNames ?? ACTIVE_TOOLS,
			userTurnId: turnId,
			...(overrides.sharedWorkerNote === undefined ? {} : { sharedWorkerNote: overrides.sharedWorkerNote }),
		},
	};
}

// The exact prose from the contaminated-context session in the ticket.
const CONTAMINATED_REPORT = [
	"Now let me dispatch a scout shadow agent to investigate.",
	"## Scout Shadow Report",
	"The scout investigation is complete. The scout found three call sites.",
].join("\n\n");

describe("worker-result claim detection", () => {
	it("recognizes the contaminated-session claim shapes", () => {
		ok(claimsWorkerResults("The scout investigation is complete."));
		ok(claimsWorkerResults("The scout found three call sites."));
		ok(claimsWorkerResults("## Scout Shadow Report"));
		ok(claimsWorkerResults("Two workers came back with matching answers."));
		ok(claimsWorkerResults("The boundary was confirmed by the scout."));
	});

	it("treats an intention as an intention, not a result", () => {
		ok(!claimsWorkerResults("Now let me dispatch a scout shadow agent."));
		ok(!claimsWorkerResults("I will dispatch two scouts in parallel."));
		ok(!claimsWorkerResults(""));
		ok(!claimsWorkerResults(undefined));
	});
});

describe("unbacked worker claim rail", () => {
	it("contradicts a worker claim when no dispatch ran in the turn", () => {
		const registration = createUnbackedWorkerClaimRegistration();
		const effects = registration.evaluate(turnEnd("turn-1", CONTAMINATED_REPORT));
		strictEqual(effects.length, 1);
		strictEqual(effects[0]?.kind, "inject_reminder");
		ok(buildUnbackedWorkerClaimMessage().includes("no dispatch ran this turn"));
		strictEqual(effects[0]?.kind === "inject_reminder" ? effects[0].message : null, buildUnbackedWorkerClaimMessage());
	});

	it("stays silent when the turn actually dispatched", () => {
		const registration = createUnbackedWorkerClaimRegistration();
		deepStrictEqual(registration.evaluate(afterDispatch("turn-2")), []);
		deepStrictEqual(registration.evaluate(turnEnd("turn-2", CONTAMINATED_REPORT)), []);
	});

	it("stays silent when the turn relays a [worker result] note the operator shared", () => {
		// The operator ran the worker with /run and handed the answer over with
		// /share; the model never dispatched it, and relaying it is honest (#73).
		const registration = createUnbackedWorkerClaimRegistration();
		const relay = "The worker found the call site at a.ts:1, per the shared run r1.";
		deepStrictEqual(registration.evaluate(turnEnd("turn-share", relay, { sharedWorkerNote: true })), []);
		strictEqual(registration.evaluate(turnEnd("turn-plain", relay, { sharedWorkerNote: false })).length, 1);
	});

	it("does not carry one turn's dispatch over to the next", () => {
		const registration = createUnbackedWorkerClaimRegistration();
		registration.evaluate(afterDispatch("turn-3"));
		deepStrictEqual(registration.evaluate(turnEnd("turn-3", CONTAMINATED_REPORT)), []);
		strictEqual(registration.evaluate(turnEnd("turn-4", CONTAMINATED_REPORT)).length, 1);
	});

	it("stays silent on ordinary prose, aborted turns, and surfaces without dispatch", () => {
		const registration = createUnbackedWorkerClaimRegistration();
		deepStrictEqual(registration.evaluate(turnEnd("t-a", "I read the file and fixed the off-by-one.")), []);
		deepStrictEqual(registration.evaluate(turnEnd("t-b", CONTAMINATED_REPORT, { stopReason: "aborted" })), []);
		deepStrictEqual(registration.evaluate(turnEnd("t-c", CONTAMINATED_REPORT, { activeToolNames: "read,grep" })), []);
	});
});

describe("tool availability surface", () => {
	it("reports the registered tool set even when only dispatch has been called", () => {
		// dispatch is excluded from the per-tool tally, so a dispatch-only session
		// used to read "none": the model looked like it held no tools at all.
		const dispatchOnly = { tools: { dispatch: 2 }, errors: 0 };
		strictEqual(formatToolTally(dispatchOnly), "none · 0✗");
		ok(formatToolTally(dispatchOnly, 14).startsWith("14 avail"));
		ok(!formatToolTally(dispatchOnly, 14).includes("none"));
	});

	it("keeps the call tally alongside the registered count", () => {
		const tally = formatToolTally({ tools: { read: 3 }, errors: 1 }, 14);
		ok(tally.includes("14 avail"));
		ok(tally.includes("read 3"));
		ok(tally.includes("1✗"));
	});

	it("falls back to the old shape when the registered count is unknown", () => {
		strictEqual(formatToolTally({ tools: {}, errors: 0 }, null), "none · 0✗");
		strictEqual(formatToolTally(null, 0), "none · 0✗");
	});
});
