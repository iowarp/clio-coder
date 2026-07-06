import { match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { formatModelRejection, formatRejection } from "../../src/domains/safety/rejection-feedback.js";
import { createWorkerSafety, createWorkerToolRegistry, invokeWorkerTool } from "../../src/engine/worker-tools.js";

const PIVOT_LINE = "Do not retry this action through another tool; pivot or report the blocker.";

describe("formatModelRejection composes the model-facing blocked text", () => {
	it("carries reason, detail lines, hints, and the standing pivot instruction", () => {
		const rejection = formatRejection({
			tool: "read",
			actionClass: "read",
			reasons: ["path .env matches zeroAccessPaths via project-policy"],
			ruleId: "path-policy:zeroAccessPaths",
		});
		const text = formatModelRejection(rejection.short, rejection);
		const lines = text.split("\n");
		strictEqual(lines[0], "read blocked: read", "the verdict reason leads");
		ok(text.includes("path .env matches zeroAccessPaths"), "the policy reason reaches the model");
		ok(text.includes("rule: path-policy:zeroAccessPaths"), "the rule id reaches the model");
		ok(text.includes("This is a hard block; confirmation cannot override it."), "the hard-block hint is included");
		strictEqual(lines[lines.length - 1], PIVOT_LINE, "the pivot instruction closes the message");
	});

	it("deduplicates lines the reason already carries, including bulleted duplicates", () => {
		const rejection = formatRejection({
			tool: "bash",
			actionClass: "execute",
			reasons: ["bash blocked: execute"],
		});
		// The verdict reason equals the short label AND the single detail reason.
		const text = formatModelRejection("bash blocked: execute", rejection);
		const occurrences = text.split("bash blocked: execute").length - 1;
		strictEqual(occurrences, 1, `the duplicate reason renders once, got: ${text}`);
	});

	it("keeps a loop-guard reason as the head when it replaced the generic reason", () => {
		const rejection = formatRejection({ tool: "grep", actionClass: "read", reasons: ["repeated identical call"] });
		const text = formatModelRejection("loop guard: identical call repeated 5 times, stop and change approach", rejection);
		ok(text.startsWith("loop guard: identical call repeated 5 times"), "the guard feedback stays first");
		ok(text.endsWith(PIVOT_LINE));
	});

	it("degrades to reason plus pivot when no rejection is attached", () => {
		const text = formatModelRejection("tool not registered: nope");
		strictEqual(text, `tool not registered: nope\n${PIVOT_LINE}`);
	});
});

describe("blocked tool errors surface recovery guidance to the model", () => {
	it("a zero-access read rejects with the policy reason, not just the short label", async () => {
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: process.cwd() }),
			undefined,
			[],
			"full-auto",
		);
		await rejects(
			invokeWorkerTool(registry, ToolNames.Read, { path: ".env" }),
			(err: unknown) => {
				ok(err instanceof Error);
				match(err.message, /read blocked/, "the terse label still leads");
				ok(err.message.includes("\n"), `the model text carries more than the one-line label, got: ${err.message}`);
				ok(err.message.includes(PIVOT_LINE), "the pivot instruction reaches the model");
				return true;
			},
			"a blocked read must reject with composed model guidance",
		);
	});
});
