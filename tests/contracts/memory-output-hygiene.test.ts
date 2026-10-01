import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import {
	runTaskMemoryPolicy,
	type TaskMemoryEnvelope,
	type TaskMemoryPolicyInput,
} from "../../src/domains/memory/task-memory-policy.js";

const input: TaskMemoryPolicyInput = {
	task: "Implement duration helper",
	trajectory: [],
	deterministicTrigger: true,
	maxTokens: 2000,
};
const validOps =
	'<operations>[{"op":"save_procedural","content":"coder dispatch denied: scope not a subset."}]</operations>';
const leakedReminder =
	'The exact narrow write scope was denied because coder scope is not a subset; adjust admission/scope configuration rather than retrying unchanged. "}<|im_end|> 娱乐主管 We need must exactly two lines. We did operations save procedural, cite tm-p-4 in reminder. But task asks dispatch, memory agent reminder should prevent repeat known failure. Good. [{"op":"save_procedural","content":"Dispatching the coder was denied."}] the exact narrow write scope was denied because coder scope is not a subset; adjust admission/scope configuration rather than retrying unchanged.';

function client(text: string) {
	return { complete: async () => ({ text }) };
}

test("a leaked completion in the reminder is dropped whole while valid operations still apply", async () => {
	const bank = new TaskMemoryBank();
	let envelope: TaskMemoryEnvelope | undefined;
	const result = await runTaskMemoryPolicy(
		bank,
		client(`${validOps}\n<context_for_action>${leakedReminder}</context_for_action>`),
		{ ...input, onEnvelope: (value) => (envelope = value) },
	);
	strictEqual(result.reason, "invalid_reminder");
	strictEqual(result.reminder, null);
	strictEqual(bank.snapshot().procedural.length, 1);
	strictEqual(envelope?.reminder, null);
});

test("a trailing stop token on a clean reminder still injects", async () => {
	const bank = new TaskMemoryBank();
	const result = await runTaskMemoryPolicy(
		bank,
		client(
			`${validOps}\n<context_for_action>Change the write scope before retrying the dispatch.</context_for_action><|im_end|>`,
		),
		input,
	);
	strictEqual(result.reason, "intervened");
	strictEqual(result.reminder, "Memory: Change the write scope before retrying the dispatch.");
});

test("a stored operation carrying a control token is dropped and the others are kept", async () => {
	const bank = new TaskMemoryBank();
	const result = await runTaskMemoryPolicy(
		bank,
		client(
			'<operations>[{"op":"save_knowledge","content":"fact<|im_end|> more"},{"op":"save_knowledge","content":"clean fact"}]</operations><no_intervention/>',
		),
		input,
	);
	strictEqual(result.droppedOperations, 1);
	deepStrictEqual(
		bank.snapshot().knowledge.map((entry) => entry.content),
		["clean fact"],
	);
});
