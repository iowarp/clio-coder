import { deepStrictEqual, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { aggregateCostAmounts, renderCostAggregate } from "../../src/domains/observability/cost.js";
import type { ObservabilityContract } from "../../src/domains/observability/index.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { renderExitSummary } from "../../src/interactive/exit-summary.js";
import { createExitSummaryCollector } from "../../src/interactive/exit-summary-collector.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";

test("the session summary counts what Clio answered while the operator was away (#421)", () => {
	const bus = createSafeEventBus();
	const observability = {
		costEntries: () => [],
		sessionCostSummary: () => ({ knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 0 }),
		subscribe: () => () => {},
	} as unknown as ObservabilityContract;
	const collector = createExitSummaryCollector({
		bus,
		observability,
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
	for (const amounts of [
		[],
		[{ usd: 0, provenance: "unknown" as const }],
		[{ usd: 0, provenance: "known_free" as const }],
		[{ usd: 0.000001, provenance: "known" as const }],
		[
			{ usd: 0.25, provenance: "estimated" as const },
			{ usd: 0, provenance: "unknown" as const },
		],
	]) {
		const cost = aggregateCostAmounts(amounts);
		for (const style of ["brief", "standard", "report"] as const) {
			ok(
				renderExitSummary({ ...snapshot, cost }, style, 120, false)
					.join("\n")
					.includes(renderCostAggregate(cost)),
			);
		}
	}
	collector.dispose();
});
