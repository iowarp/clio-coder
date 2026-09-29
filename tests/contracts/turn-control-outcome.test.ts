import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import type { TurnOutcomeInput } from "../../src/domains/turn-control/index.js";
import {
	conversationShape,
	dispatchKeysFromArgs,
	nextClarificationStreak,
	reduceTurnOutcome,
} from "../../src/domains/turn-control/index.js";
import { runBoundaryCheck } from "../boundaries/check-boundaries.js";

it("normalizes dispatch keys and excludes control and review calls", () => {
	deepStrictEqual(dispatchKeysFromArgs({ agent: "scout", task: "  Inspect\n  THE source " }), [
		{ agentId: "scout", task: "inspect the source" },
	]);
	deepStrictEqual(dispatchKeysFromArgs({ agent: "coder", tasks: ["Fix A", { agent: "scout", task: "READ B" }] }), [
		{ agentId: "coder", task: "fix a" },
		{ agentId: "scout", task: "read b" },
	]);
	for (const controls of [{ list: true }, { from_scout: {} }, { apply_winner: "branch" }, { review: {} }]) {
		deepStrictEqual(dispatchKeysFromArgs({ agent: "coder", task: "Do work", ...controls }), []);
	}
	deepStrictEqual(dispatchKeysFromArgs(undefined), []);
});

it("recognizes questions and at least two option lines", () => {
	deepStrictEqual(conversationShape("Which?  \n"), { endedWithQuestion: true, offeredOptions: false });
	for (const text of ["- one\n* two", "1. one\n2) two"]) {
		deepStrictEqual(conversationShape(text), { endedWithQuestion: false, offeredOptions: true });
	}
	deepStrictEqual(conversationShape("- one\nAn explanation."), { endedWithQuestion: false, offeredOptions: false });
});

it("advances clarification streaks only for tool-free questions or options", () => {
	strictEqual(nextClarificationStreak(2, { toolCalls: 0, asks: true }), 3);
	strictEqual(nextClarificationStreak(2, { toolCalls: 0, asks: true }), 3);
	strictEqual(nextClarificationStreak(2, { toolCalls: 1, asks: true }), 0);
	strictEqual(nextClarificationStreak(2, { toolCalls: 0, asks: false }), 0);
});

it("reduces a question, a duplicate dispatch, and a canceled turn without mutating their facts", () => {
	const unused = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, provenance: "none" as const };
	const base: TurnOutcomeInput = {
		turnId: "user-1",
		turnIndex: 0,
		continuation: false,
		toolNames: [],
		readOnlyCallsBeforeFirstDispatch: 0,
		dispatches: [],
		duplicateDispatch: false,
		harness: { runIds: [], reads: 0 },
		finalAssistantText: "Which approach?",
		taskEstablished: false,
		previousClarificationStreak: 2,
		completion: { decision: "not-assessed", mutatedPaths: 0, evidenceKinds: [] },
		canceled: false,
		tokens: { coordinator: unused, decisionModel: unused, workers: unused },
		stopReason: "stop",
		durationMs: 10,
	};
	const control = {
		producer: "system-one" as const,
		decision: "orientation" as const,
		decisionHash: "hash",
		executed: true,
	};
	deepStrictEqual(reduceTurnOutcome({ ...base, control }).control, control);
	const question = reduceTurnOutcome(base);
	strictEqual(question.version, 1);
	strictEqual(question.control, null);
	deepStrictEqual(question.conversation, {
		endedWithQuestion: true,
		offeredOptions: false,
		asksOperator: null,
		taskEstablished: false,
		clarificationStreak: 3,
	});
	deepStrictEqual(question.coordinator, {
		toolCalls: 0,
		byTool: {},
		readOnlyCallsBeforeFirstDispatch: 0,
		dispatches: [],
		duplicateDispatch: false,
	});
	const input = {
		...base,
		toolNames: ["read", "dispatch", "read"],
		readOnlyCallsBeforeFirstDispatch: 1,
		dispatches: [{ mode: "parallel", agentIds: ["scout"], runIds: ["run-1"] }],
		duplicateDispatch: true,
		taskEstablished: true,
		finalAssistantText: "Done.",
		completion: { decision: "ok" as const, mutatedPaths: 1, evidenceKinds: ["verification"] },
	};
	const dispatch = reduceTurnOutcome(input);
	deepStrictEqual(dispatch.coordinator, {
		toolCalls: 3,
		byTool: { read: 2, dispatch: 1 },
		readOnlyCallsBeforeFirstDispatch: 1,
		dispatches: input.dispatches,
		duplicateDispatch: true,
	});
	strictEqual(dispatch.conversation.clarificationStreak, 0);
	deepStrictEqual(dispatch.completion, input.completion);
	const canceled = reduceTurnOutcome({
		...base,
		canceled: true,
		stopReason: "aborted",
		finalAssistantText: "Canceled.",
		durationMs: 20,
	});
	deepStrictEqual(canceled.operator, { canceled: true });
	strictEqual(canceled.stopReason, "aborted");
	strictEqual(canceled.durationMs, 20);
	strictEqual(base.previousClarificationStreak, 2);
	deepStrictEqual(base.toolNames, []);
});

it("turn-control boundary rejects surface imports and domain internals, including erased types", (t) => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-turn-control-boundary-"));
	try {
		for (const [specifier, target, refused] of [
			["../../interactive/control.js", "src/interactive/control.ts", true],
			["../../engine/types.js", "src/engine/types.ts", true],
			["../../tools/read.js", "src/tools/read.ts", true],
			["../../worker/spec.js", "src/worker/spec.ts", true],
			["../providers/private.js", "src/domains/providers/private.ts", true],
			["../providers/index.js", "src/domains/providers/index.ts", false],
			["./local.js", "src/domains/turn-control/local.ts", false],
		] as const) {
			mkdirSync(dirname(join(root, target)), { recursive: true });
			writeFileSync(join(root, target), "export type Value = string;\n");
			const source = join(root, "src/domains/turn-control/outcome.ts");
			mkdirSync(dirname(source), { recursive: true });
			writeFileSync(source, `import type { Value } from "${specifier}";\nexport type Outcome = Value;\n`);
			strictEqual(
				runBoundaryCheck(root).violations.some((line) => line.startsWith("rule7:")),
				refused,
				specifier,
			);
		}
		ok(!runBoundaryCheck(process.cwd()).violations.some((line) => line.startsWith("rule7:")));
		t.diagnostic(
			"boundaries: turn-control: ok (surface imports and domain internals refused; barrels and local imports allowed)",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
