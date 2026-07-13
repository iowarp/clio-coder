import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import {
	parseTaskMemoryPolicyResponse,
	runTaskMemoryPolicy,
	type TaskMemoryModelClient,
	type TaskMemoryModelRequest,
} from "../../src/domains/memory/task-memory-policy.js";

const BASE_INPUT = {
	task: "Implement proactive task memory without changing the action-agent prompt.",
	trajectory: [],
	deterministicTrigger: false,
	maxTokens: 100,
} as const;

function response(operations: ReadonlyArray<unknown>, phaseTwo = "<no_intervention/>"): string {
	return `<operations>${JSON.stringify(operations)}</operations>\n${phaseTwo}`;
}

function clientReturning(text: string, calls: TaskMemoryModelRequest[] = []): TaskMemoryModelClient {
	return {
		async complete(request) {
			calls.push(request);
			return { text, inputTokens: 17, outputTokens: 9 };
		},
	};
}

describe("contracts/task memory prompted policy", () => {
	it("applies a valid operation list in source order before explicit silence", async () => {
		const bank = new TaskMemoryBank();
		const oldKnowledge = bank.saveKnowledge("Old fact");
		const oldProcedure = bank.saveProcedural("Old attempt");
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([
					{ op: "update_status", content: "Inspecting the failing contract." },
					{ op: "save_knowledge", content: "The suite uses node:test." },
					{ op: "save_procedural", content: "A narrow contract run passed." },
					{ op: "delete", id: oldProcedure.id },
				]),
			),
			BASE_INPUT,
		);

		deepStrictEqual(result, {
			decision: "silent",
			bankOperations: 4,
			reminder: null,
			inputTokens: 17,
			outputTokens: 9,
		});
		const snapshot = bank.snapshot();
		strictEqual(snapshot.status?.id, "tm-s-3", "status was the first allocating operation");
		deepStrictEqual(
			snapshot.knowledge.map(({ id, content }) => ({ id, content })),
			[
				{ id: oldKnowledge.id, content: "Old fact" },
				{ id: "tm-k-4", content: "The suite uses node:test." },
			],
		);
		deepStrictEqual(
			snapshot.procedural.map(({ id, content }) => ({ id, content })),
			[{ id: "tm-p-5", content: "A narrow contract run passed." }],
		);
	});

	it("passes cited spontaneous reminders and records their attribution", async () => {
		const bank = new TaskMemoryBank();
		const knowledge = bank.saveKnowledge("The operator requires visible reminders.");
		const calls: TaskMemoryModelRequest[] = [];
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([], `<context_for_action>[${knowledge.id}] Keep the reminder visible.</context_for_action>`),
				calls,
			),
			{
				...BASE_INPUT,
				trajectory: [
					{
						step: 2,
						toolName: "bash",
						fingerprint: "abc123",
						callDescription: "npm test",
						outcome: "ok",
						resultDigest: "passed",
					},
				],
			},
		);

		strictEqual(result.decision, "injected");
		strictEqual(result.reminder, `Memory: [${knowledge.id}] Keep the reminder visible.`);
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 1);
		strictEqual(calls.length, 1);
		match(calls[0]?.systemPrompt ?? "", /Default to <no_intervention\/>/u);
		match(calls[0]?.userPrompt ?? "", /Implement proactive task memory/u);
		match(calls[0]?.userPrompt ?? "", new RegExp(knowledge.id, "u"));
		match(calls[0]?.userPrompt ?? "", /abc123/u);
		ok(!calls[0]?.userPrompt.includes("status:"), "private status is absent from the model prompt bank render");
	});

	it("gates uncited spontaneous reminders but still permits phase-one writes", async () => {
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response(
					[{ op: "save_knowledge", content: "The package manager is npm." }],
					"<context_for_action>Run the entire suite now.</context_for_action>",
				),
			),
			BASE_INPUT,
		);

		strictEqual(result.decision, "gated");
		strictEqual(result.bankOperations, 1);
		strictEqual(result.reminder, null);
		strictEqual(bank.snapshot().knowledge[0]?.content, "The package manager is npm.");
	});

	it("allows an uncited reminder when a deterministic trigger fired", async () => {
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(response([], "<context_for_action>Avoid repeating the failed command.</context_for_action>")),
			{ ...BASE_INPUT, deterministicTrigger: true },
		);

		strictEqual(result.decision, "injected");
		strictEqual(result.reminder, "Memory: Avoid repeating the failed command.");
	});

	it("treats malformed and empty responses atomically as silence", async () => {
		const invalidResponses = [
			"",
			"```xml\n<operations>[]</operations>\n<no_intervention/>\n```",
			"<operations>not-json</operations>\n<no_intervention/>",
			response([{ op: "unknown", content: "x" }]),
			response([{ op: "save_knowledge", content: "valid", extra: true }]),
			response([
				{ op: "save_knowledge", content: "would otherwise mutate" },
				{ op: "delete", id: "tm-k-missing" },
			]),
			response(new Array(9).fill({ op: "update_status", content: "too many" })),
		];
		for (const text of invalidResponses) {
			const bank = new TaskMemoryBank();
			bank.saveKnowledge("baseline");
			const before = bank.snapshot();
			const result = await runTaskMemoryPolicy(bank, clientReturning(text), BASE_INPUT);
			strictEqual(result.decision, "malformed", JSON.stringify(text));
			deepStrictEqual(bank.snapshot(), before, JSON.stringify(text));
		}
	});

	it("turns client failures and hard timeouts into silence without mutation", async () => {
		const throwingBank = new TaskMemoryBank();
		const throwing = await runTaskMemoryPolicy(
			throwingBank,
			{
				async complete() {
					throw new Error("provider unavailable");
				},
			},
			BASE_INPUT,
		);
		strictEqual(throwing.decision, "silent");
		deepStrictEqual(throwingBank.snapshot(), { version: 1, status: null, knowledge: [], procedural: [] });

		const timeoutBank = new TaskMemoryBank();
		let aborted = false;
		const timedOut = await runTaskMemoryPolicy(
			timeoutBank,
			{
				complete(request) {
					request.signal.addEventListener("abort", () => {
						aborted = true;
					});
					return new Promise(() => undefined);
				},
			},
			{ ...BASE_INPUT, timeoutMs: 5 },
		);
		strictEqual(timedOut.decision, "timeout");
		strictEqual(aborted, true);
		deepStrictEqual(timeoutBank.snapshot(), { version: 1, status: null, knowledge: [], procedural: [] });
	});

	it("requires the strict two-line grammar and enforces the reminder budget before mutation", () => {
		ok(parseTaskMemoryPolicyResponse(response([]), 20));
		strictEqual(parseTaskMemoryPolicyResponse(`${response([])}\ntrailing`, 20), null);
		strictEqual(
			parseTaskMemoryPolicyResponse(
				response(
					[{ op: "update_status", content: "would mutate" }],
					`<context_for_action>${"x".repeat(80)}</context_for_action>`,
				),
				20,
			),
			null,
		);
	});
});
