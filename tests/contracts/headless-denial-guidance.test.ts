import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
	HEADLESS_PERMISSION_DENIED_MARKER,
	HEADLESS_PERMISSION_DENIED_REASON,
} from "../../src/core/headless-permission.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { formatModelRejection } from "../../src/domains/safety/rejection-feedback.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

/**
 * A headless run has no operator, so every ask below full-auto is answered with
 * one sentence saying so. That sentence names no recovery, and the policy
 * decision's reasons (which do name the recognized bash spelling) were dropped
 * when the answered park was rebuilt as a block. A headless model then retried
 * the same unrecognized shape until the run ended. These cases pin the guidance
 * onto the model-visible text, and pin the denial sentence as its prefix,
 * because the skill-eval permission-wall recognizer matches the marker there.
 */

function mockSpec(name: string, baseActionClass: ActionClass): ToolSpec {
	return {
		name: name as ToolName,
		description: "headless denial guidance test tool",
		parameters: Type.Object({}),
		baseActionClass,
		run: async () => ({ kind: "ok", output: "ran" }),
	};
}

function headlessRegistry(level: AutonomyLevel = "auto-edit"): ToolRegistry {
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: process.cwd() }),
		autonomy: () => level,
	});
	registry.register(mockSpec(ToolNames.Bash, "execute"));
	registry.register(mockSpec(ToolNames.Write, "write"));
	// What entry/orchestrator.ts wires for `clio run`: nobody can confirm, so
	// every parked ask is cancelled with the headless denial sentence.
	registry.onPermissionRequired(() => {
		registry.cancelParkedCalls(HEADLESS_PERMISSION_DENIED_REASON);
	});
	return registry;
}

function blockedRejection(verdict: Awaited<ReturnType<ToolRegistry["invoke"]>>): {
	detail: string;
	hints: ReadonlyArray<string>;
	reason: string;
} {
	ok(verdict.kind === "blocked", `expected a blocked verdict, got ${verdict.kind}`);
	ok("rejection" in verdict.decision, "an answered park is a block decision carrying a rejection");
	return {
		detail: verdict.decision.rejection.detail,
		hints: verdict.decision.rejection.hints,
		reason: verdict.reason,
	};
}

describe("contracts/headless denial teaches the recognized bash form", () => {
	it("carries the working form after the denial sentence for an unrecognized bash call", async () => {
		const registry = headlessRegistry();
		const { detail, hints, reason } = blockedRejection(
			await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "curl https://example.com" },
			}),
		);

		ok(
			detail.startsWith(HEADLESS_PERMISSION_DENIED_REASON),
			`the denial sentence stays the prefix the skill-eval recognizer matches: ${detail}`,
		);
		strictEqual(detail.indexOf(HEADLESS_PERMISSION_DENIED_MARKER), 0);
		ok(detail.includes("one command per bash call"), `names the working form: ${detail}`);
		ok(detail.includes("cwd argument"), `names the cwd argument instead of a leading cd: ${detail}`);
		strictEqual(reason, HEADLESS_PERMISSION_DENIED_REASON, "the terse verdict reason is unchanged");
		strictEqual(hints.length, 0, "no approval hints for an approval that is not coming");

		const modelText = formatModelRejection(reason, {
			short: "unused",
			detail,
			hints: [...hints],
		});
		ok(modelText.startsWith(HEADLESS_PERMISSION_DENIED_MARKER), modelText);
		ok(modelText.includes("one command per bash call"), modelText);
		const lines = modelText.split("\n");
		strictEqual(lines.length, 3, `denial, guidance, standing pivot: ${modelText}`);
		strictEqual(lines.filter((line) => line.includes("one command per bash call")).length, 1);
	});

	it("carries it for a chain whose operators defeat recognition too", async () => {
		const registry = headlessRegistry();
		const { detail } = blockedRejection(
			await registry.invoke({ tool: ToolNames.Bash, args: { command: "ls | tee out.txt" } }),
		);
		ok(detail.startsWith(HEADLESS_PERMISSION_DENIED_REASON), detail);
		ok(detail.includes("&& chain"), `the pipe case names the recognized chain form: ${detail}`);
	});

	it("adds nothing to a denial whose decision carries no recognition guidance", async () => {
		// A workspace write asks at `suggest`, and its decision is a write-class
		// pass with no execution recognition to report.
		const registry = headlessRegistry("suggest");
		const { detail } = blockedRejection(
			await registry.invoke({
				tool: ToolNames.Write,
				args: { file_path: join(".clio", "test-scratch", "headless-guidance.txt"), content: "x" },
			}),
		);
		strictEqual(detail, HEADLESS_PERMISSION_DENIED_REASON, "a write ask has no recognized form to teach");
	});

	it("leaves an interactive denial exactly as the operator answered it", async () => {
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd: process.cwd() }),
			autonomy: () => "auto-edit",
		});
		registry.register(mockSpec(ToolNames.Bash, "execute"));
		const answer = "User cancelled this tool call from the permission confirmation prompt. Wait for new instruction.";
		registry.onPermissionRequired((_call, _decision, meta) => {
			registry.cancelParkedCall(meta.requestId, answer);
		});

		const { detail } = blockedRejection(
			await registry.invoke({ tool: ToolNames.Bash, args: { command: "curl https://example.com" } }),
		);
		// The approval overlay already showed the operator the decision's reasons.
		strictEqual(detail, answer);
	});
});
