import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { runTaskMemoryPolicy } from "../../src/domains/memory/task-memory-policy.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";

test("convention guidance reaches a session even when no memory record exists", () => {
	const prompt = compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.read-only",
		sessionInputs: { providerSupportsTools: true, toolNames: ["read"], memorySection: "" },
	}).systemPrompt;
	match(prompt, /inspect and cite its sources/u);
	match(prompt, /If the entry is absent, report that limit/u);
	match(prompt, /Promotion persists an unapproved proposal/u);
	match(prompt, /Do not treat a general request to remember as approval of an unseen record/u);
	match(prompt, /transcript recovery, or unrelated memory/u);
	match(prompt, /clio-coder memory approve <memoryId>/u);
});

test("successful source inspection does not bypass the repeated-failure gate", () => {
	const bank = new TaskMemoryBank();
	const registration = createMemoryInterventionRegistration({
		bank,
		getSettings: () => ({ enabled: true, everyNTools: 2, windowSteps: 8, maxTokens: 2000, timeoutMs: 1000 }),
	});
	try {
		registration.evaluate({ hook: "turn_start", text: "Remember the source-grounded numerical convention." });
		registration.evaluate({
			hook: "after_tool",
			toolName: "read",
			toolCallId: "source-read",
			toolArgs: { path: "tests/test_coefs.py" },
			metadata: { resultKind: "ok" },
		});
		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), []);
		strictEqual(registration.recentActivity().at(-1)?.reason, "no_repeated_failure");
		deepStrictEqual(bank.snapshot().knowledge, []);
	} finally {
		registration.dispose();
	}
});

test("source citations do not replace bank-entry citations for spontaneous reminders", async () => {
	const bank = new TaskMemoryBank();
	const input = { task: "Remember numerical controls", trajectory: [], deterministicTrigger: false, maxTokens: 2000 };
	const uncited = await runTaskMemoryPolicy(
		bank,
		{
			complete: async () => ({
				text:
					'<operations>[{"op":"save_knowledge","content":"tests/test_coefs.py:1: retain polynomial controls."}]</operations><context_for_action>Use the convention from tests/test_coefs.py:1.</context_for_action>',
			}),
		},
		input,
	);
	strictEqual(uncited.reason, "uncited");
	strictEqual(uncited.reminder, null);
	strictEqual(bank.snapshot().knowledge.length, 1, "phase-one capture survives the reminder gate");
	const entry = bank.snapshot().knowledge[0];
	strictEqual(entry?.injectionCount, 0);
	const cited = await runTaskMemoryPolicy(
		bank,
		{
			complete: async () => ({
				text: `<operations>[]</operations><context_for_action>[${entry?.id}] Use the polynomial control.</context_for_action>`,
			}),
		},
		input,
	);
	strictEqual(cited.reason, "intervened");
	strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 1);
});
