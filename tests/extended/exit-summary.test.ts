import { deepStrictEqual, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { renderExitSummary } from "../../src/interactive/exit-summary.js";
import { createExitSummaryCollector, exitSpend } from "../../src/interactive/exit-summary-collector.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

test("the session summary counts what Clio answered while the operator was away (#421)", () => {
	const bus = createSafeEventBus();
	const telemetry = {
		subscribe: () => () => {},
		telemetry: { live: () => telemetryViewOf("session-1", []), subscribe: () => () => {} },
	} as unknown as TelemetryContract;
	const collector = createExitSummaryCollector({
		bus,
		telemetry,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map(),
		getModel: () => null,
	});
	bus.emit(BusChannels.PermissionResolved, {
		status: "denied",
		decidedBy: "unattended",
		origin: "main",
		tool: "bash",
		requestId: "apr-1",
	});
	bus.emit(BusChannels.PermissionResolved, {
		status: "denied",
		decidedBy: "operator",
		tool: "write",
		requestId: "apr-2",
	});
	collector.observeChat({
		type: "tool_execution_end",
		toolCallId: "ask-1",
		toolName: "ask_user",
		isError: false,
		result: { content: [], details: { unattended: { afterSeconds: 300, autoResolved: 2 } } },
	} as unknown as ChatLoopEvent);
	const snapshot = collector.snapshot();
	deepStrictEqual(snapshot?.unattended, { questions: 2, permissions: 1 });
	for (const style of ["brief", "standard"] as const) {
		match(
			renderExitSummary(snapshot, style, 120, false).join("\n"),
			/Unattended: 2 questions auto-resolved · 1 permission ask timed out and denied/u,
			style,
		);
	}
	ok(snapshot);
	// The card prints the read model's own session cost display for every pricing state, never a re-rendered sum.
	const call = (usd: number | null, pricedBy?: "free" | "catalog" | "target-rates") =>
		telemetryCall("session-1", { usd, ...(pricedBy ? { pricedBy } : {}) });
	for (const calls of [[], call(null), call(0, "free"), call(0.000001), [...call(0.25, "catalog"), ...call(null)]]) {
		const view = telemetryViewOf("session-1", calls);
		const spend = exitSpend(view, "1970-01-01T00:00:00.000Z");
		ok(spend.kind === "ready");
		for (const style of ["brief", "standard", "report"] as const) {
			const text = renderExitSummary({ ...snapshot, spend }, style, 120, false).join("\n");
			ok(text.includes(view.session().totals.usd.display), `${style}: ${view.session().totals.usd.display}`);
		}
	}
	match(
		renderExitSummary({ ...snapshot, spend: { kind: "unavailable" } }, "brief", 120, false).join("\n"),
		/not available/u,
	);
	collector.dispose();
});
