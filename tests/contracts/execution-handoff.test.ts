import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionHandoff } from "../../src/domains/dispatch/execution-handoff.js";
import {
	abbreviateHandoffText,
	EXECUTION_HANDOFF_MAX_ITEMS,
	EXECUTION_HANDOFF_MAX_TEXT_BYTES,
	executionHandoffTextBytes,
	projectExecutionHandoffs,
} from "../../src/domains/dispatch/execution-handoff.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";

function handoff(stepId: string, output: string): ExecutionHandoff {
	return {
		stepId,
		assignmentId: `assignment-${stepId}`,
		terminalRunId: `run-${stepId}`,
		receiptDigest: "a".repeat(64),
		output,
	};
}

describe("execution handoff projection", () => {
	it("gives a large JSON report the remainder beside a verbatim two-byte output", () => {
		const report = JSON.stringify({
			kind: "code-report",
			outputExcerpt: "x".repeat(EXECUTION_HANDOFF_MAX_TEXT_BYTES * 2),
			lateFinding: "the final check failed",
		});
		const large = handoff("large", report);
		const tiny = handoff("tiny", "ok");
		const projected = projectExecutionHandoffs(
			["large", "tiny"],
			new Map([
				["tiny", tiny],
				["large", large],
			]),
		);
		const [excerpt, small] = projected;
		ok(excerpt);
		deepStrictEqual(small, tiny);
		strictEqual(Buffer.byteLength(excerpt.output, "utf8"), EXECUTION_HANDOFF_MAX_TEXT_BYTES - 2);
		ok(excerpt.output.startsWith('{"kind":"code-report","outputExcerpt":"'));
		ok(excerpt.output.endsWith('"lateFinding":"the final check failed"}'));
		match(
			excerpt.output,
			/\n\[clio: \d+ of \d+ bytes omitted from this handoff excerpt; the coordinator retains the full output of run run-large\]\n/u,
		);
		strictEqual(executionHandoffTextBytes(projected), EXECUTION_HANDOFF_MAX_TEXT_BYTES);
		strictEqual(large.output, report);
	});

	it("keeps an output at the cap verbatim and marks one byte over the cap", () => {
		const exact = handoff("exact", "x".repeat(EXECUTION_HANDOFF_MAX_TEXT_BYTES));
		deepStrictEqual(projectExecutionHandoffs([exact.stepId], new Map([[exact.stepId, exact]])), [exact]);
		const over = handoff("over", `${exact.output}x`);
		const projected = projectExecutionHandoffs([over.stepId], new Map([[over.stepId, over]]));
		ok(projected[0]);
		match(projected[0].output, /\[clio: \d+ of 12001 bytes omitted/u);
		ok(executionHandoffTextBytes(projected) <= EXECUTION_HANDOFF_MAX_TEXT_BYTES);
	});

	it("bounds and marks all sixteen oversized predecessors at their fair share", () => {
		const sources = Array.from({ length: EXECUTION_HANDOFF_MAX_ITEMS }, (_, index) =>
			handoff(`step-${index}`, "x".repeat(EXECUTION_HANDOFF_MAX_TEXT_BYTES + 1)),
		);
		const projected = projectExecutionHandoffs(
			sources.map((source) => source.stepId),
			new Map(sources.map((source) => [source.stepId, source])),
		);
		strictEqual(projected.length, EXECUTION_HANDOFF_MAX_ITEMS);
		for (const excerpt of projected) {
			ok(Buffer.byteLength(excerpt.output, "utf8") <= EXECUTION_HANDOFF_MAX_TEXT_BYTES / EXECUTION_HANDOFF_MAX_ITEMS);
			match(excerpt.output, /\[clio: \d+ of 12001 bytes omitted/u);
		}
		ok(executionHandoffTextBytes(projected) <= EXECUTION_HANDOFF_MAX_TEXT_BYTES);
	});

	it("cuts multibyte content at an odd byte offset without replacement characters", () => {
		const source = handoff("unicode", `x${"😀é中".repeat(EXECUTION_HANDOFF_MAX_TEXT_BYTES)}`);
		const projected = projectExecutionHandoffs([source.stepId], new Map([[source.stepId, source]]));
		ok(projected[0]);
		strictEqual(projected[0].output.includes("\uFFFD"), false);
		ok(Buffer.byteLength(projected[0].output, "utf8") <= EXECUTION_HANDOFF_MAX_TEXT_BYTES);
		strictEqual(executionHandoffTextBytes(projected), Buffer.byteLength(projected[0].output, "utf8"));
		ok(projected[0].output.startsWith("x😀é中"));
		ok(projected[0].output.endsWith("😀é中"));
		match(projected[0].output, /\[clio: \d+ of \d+ bytes omitted/u);
	});

	it("keeps pipeline input's head and tail and names the previous step when its run is unknown", () => {
		const text = `head finding\n${"x".repeat(EXECUTION_HANDOFF_MAX_TEXT_BYTES)}\nverdict: revise`;
		const excerpt = abbreviateHandoffText(text, EXECUTION_HANDOFF_MAX_TEXT_BYTES, null);
		ok(excerpt.startsWith("head finding\n"));
		ok(excerpt.endsWith("\nverdict: revise"));
		ok(Buffer.byteLength(excerpt, "utf8") <= EXECUTION_HANDOFF_MAX_TEXT_BYTES);
		match(excerpt, /the coordinator retains the full output of the previous step\]\n/u);
		strictEqual(abbreviateHandoffText("short", EXECUTION_HANDOFF_MAX_TEXT_BYTES, null), "short");
	});

	it("rejects seventeen predecessors during compilation and projection", () => {
		const sources = Array.from({ length: EXECUTION_HANDOFF_MAX_ITEMS + 1 }, (_, index) => handoff(`step-${index}`, "ok"));
		throws(
			() =>
				compileExecutionPlan({
					topology: "fleet",
					rootTask: "Inspect predecessor reports",
					maxWorkers: 1,
					onFailure: "stop",
					steps: [
						...sources.map(({ stepId }) => ({
							kind: "code" as const,
							id: stepId,
							commandId: "inspect",
							scope: "readonly" as const,
							dependencies: [],
						})),
						{
							kind: "code",
							id: "collect",
							commandId: "inspect",
							scope: "readonly",
							dependencies: sources.map(({ stepId }) => stepId),
						},
					],
				}),
			/execution plan: step 'collect' has 17 dependencies; at most 16 predecessors are allowed/u,
		);
		throws(
			() =>
				projectExecutionHandoffs(
					sources.map((source) => source.stepId),
					new Map(sources.map((source) => [source.stepId, source])),
				),
			/at most 16 predecessors are allowed/u,
		);
	});

	it("rejects a missing predecessor", () => {
		throws(() => projectExecutionHandoffs(["missing"], new Map()), /missing successful predecessor 'missing'/u);
	});

	it("validates projected escape-heavy output using its text bytes", () => {
		const source = handoff("escaped", '"\\'.repeat(EXECUTION_HANDOFF_MAX_TEXT_BYTES / 2));
		const projected = projectExecutionHandoffs([source.stepId], new Map([[source.stepId, source]]));
		deepStrictEqual(projected, [source]);
		strictEqual(executionHandoffTextBytes(projected), EXECUTION_HANDOFF_MAX_TEXT_BYTES);
		ok(Buffer.byteLength(JSON.stringify(projected), "utf8") > EXECUTION_HANDOFF_MAX_TEXT_BYTES * 2);
		const validated = validateJobSpec({
			agentId: "scout",
			task: "Inspect the predecessor output",
			predecessorHandoffs: projected,
		});
		ok(validated.ok);
		deepStrictEqual(validated.spec.predecessorHandoffs, projected);
	});
});
