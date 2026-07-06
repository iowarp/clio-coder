import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type ReduceContext, reduceStatus, type StatusInputEvent } from "../../src/interactive/status/state-machine.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";
import { resolveFooterVerb, resolveInlineVerb } from "../../src/interactive/status/verbs.js";

function ctx(now: number): ReduceContext {
	return { now, localRuntime: true, modelId: "m", targetId: "t", runId: "r" };
}

function drive(events: Array<[StatusInputEvent, number]>) {
	let status = { ...INITIAL_STATUS };
	for (const [event, now] of events) status = reduceStatus(status, event, ctx(now));
	return status;
}

describe("status running-tool timer keys on the call's own start", () => {
	it("counts elapsed from tool_execution_start, not from turn start", () => {
		// Turn starts at 0; the tool starts at 10s; we render at 12s. The footer
		// must show 2.0s (this call's runtime under ten seconds now carries one
		// decimal from formatCompactMs), never 12s (turn elapsed), which is the
		// exact phantom the incident showed as `running tool: grep · 19s`.
		const status = drive([
			[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
			[
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: { pattern: "x" } } as StatusInputEvent,
				10_000,
			],
		]);
		strictEqual(status.phase, "tool_running");
		strictEqual(status.toolStartedAt, 10_000, "the call's own start is stamped");
		const footer = resolveFooterVerb(status, 12_000, 120);
		ok(footer?.text.includes("running tool: grep"), "names the running tool");
		ok(footer?.text.includes("· 2.0s"), `footer shows the call's own 2.0s elapsed, got: ${footer?.text}`);
		ok(!footer?.text.includes("12s"), "never shows turn-elapsed as tool-elapsed");
		const inline = resolveInlineVerb(status, 12_000, 120);
		ok(inline?.text.includes("· 2.0s"), `inline verb also shows the call's own elapsed, got: ${inline?.text}`);
	});

	it("stops showing a tool as running once the model resumes generating", () => {
		// A tool_execution_start whose end never lands (admission block, id reuse)
		// must not leave the spinner claiming a tool is running: the first token of
		// model output clears the running-tool display.
		const status = drive([
			[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
			[{ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: {} } as StatusInputEvent, 5_000],
			[{ type: "text_delta", contentIndex: 0, delta: "here", partialText: "here" } as unknown as StatusInputEvent, 6_000],
		]);
		strictEqual(status.phase, "writing", "the model is writing, not running a tool");
		strictEqual(status.tool, undefined, "the running-tool overlay is cleared");
		strictEqual(status.toolStartedAt, undefined, "the tool timer is cleared");
		const footer = resolveFooterVerb(status, 6_500, 120);
		ok(!footer?.text.includes("running tool"), `no phantom running tool, got: ${footer?.text}`);
	});

	it("clears the tool timer on tool_execution_end so a later phase never reuses it", () => {
		const status = drive([
			[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
			[
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } } as StatusInputEvent,
				3_000,
			],
			[
				{
					type: "tool_execution_end",
					toolCallId: "c1",
					toolName: "read",
					result: "ok",
					isError: false,
				} as StatusInputEvent,
				3_100,
			],
		]);
		strictEqual(status.phase, "preparing");
		strictEqual(status.toolStartedAt, undefined, "the timer is dropped when the call ends");
	});
});

describe("status tool end settles overlays without resurrecting running-tool state", () => {
	it("clears a blocked tool frame before the overlay pops", () => {
		const status = drive([
			[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
			[
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: ".env" } } as StatusInputEvent,
				1_000,
			],
			[{ type: "overlay_push", overlay: "tool_blocked" } as StatusInputEvent, 1_100],
			[
				{
					type: "tool_execution_end",
					toolCallId: "c1",
					toolName: "read",
					result: "blocked",
					isError: true,
				} as StatusInputEvent,
				1_200,
			],
			[{ type: "overlay_pop", overlay: "tool_blocked" } as StatusInputEvent, 1_300],
		]);

		strictEqual(status.phase, "preparing");
		strictEqual(status.tool, undefined);
		strictEqual(status.toolStartedAt, undefined);
	});

	it("scrubs every stacked overlay frame so either pop order restores preparing", () => {
		const sequence = (popOrder: Array<"tool_blocked" | "dispatching">) =>
			drive([
				[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
				[
					{ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: { pattern: "x" } } as StatusInputEvent,
					1_000,
				],
				[{ type: "overlay_push", overlay: "tool_blocked" } as StatusInputEvent, 1_100],
				[
					{ type: "overlay_push", overlay: "dispatching", data: { agentName: "tester" } } as StatusInputEvent,
					1_200,
				],
				[
					{
						type: "tool_execution_end",
						toolCallId: "c1",
						toolName: "grep",
						result: "done",
						isError: false,
					} as StatusInputEvent,
					1_300,
				],
				...popOrder.map(
					(overlay, index) =>
						[{ type: "overlay_pop", overlay } as StatusInputEvent, 1_400 + index * 100] as [
							StatusInputEvent,
							number,
						],
				),
			]);

		for (const status of [
			sequence(["dispatching", "tool_blocked"]),
			sequence(["tool_blocked", "dispatching"]),
		]) {
			strictEqual(status.phase, "preparing");
			strictEqual(status.tool, undefined);
			strictEqual(status.toolStartedAt, undefined);
			strictEqual(status.resumePhase, undefined);
			strictEqual(status.overlayStack?.length ?? 0, 0);
		}
	});

	it("keeps the direct and stuck-over-tool-running settlement paths intact", () => {
		const direct = drive([
			[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
			[{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} } as StatusInputEvent, 1_000],
			[
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "ok", isError: false } as StatusInputEvent,
				1_100,
			],
		]);
		strictEqual(direct.phase, "preparing");
		strictEqual(direct.tool, undefined);
		strictEqual(direct.toolStartedAt, undefined);

		const stuck = drive([
			[{ type: "agent_start", messages: [] } as unknown as StatusInputEvent, 0],
			[{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } as StatusInputEvent, 1_000],
			[{ type: "watchdog_tick" } as StatusInputEvent, 181_000],
			[
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "ok", isError: false } as StatusInputEvent,
				181_100,
			],
		]);
		strictEqual(stuck.phase, "preparing");
		strictEqual(stuck.resumePhase, undefined);
		strictEqual(stuck.tool, undefined);
		strictEqual(stuck.toolStartedAt, undefined);
	});
});
