import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import {
	parseTaskMemoryPolicyResponse,
	runTaskMemoryPolicy,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	type TaskMemoryModelClient,
	type TaskMemoryModelRequest,
} from "../../src/domains/memory/task-memory-policy.js";
import { MEMORY_INTERVENTION_SYSTEM_PROMPT } from "../../src/domains/prompts/memory-intervention.js";

const BASE_INPUT = {
	task: "Implement proactive task memory without changing the action-agent prompt.",
	trajectory: [],
	deterministicTrigger: false,
	maxTokens: 100,
} as const;

const LEGACY_DIGEST_PROVENANCE = {
	producer: "code",
	source: "legacy-fallback",
	algorithm: "redacted-legacy-digest-v1",
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
	it("keeps one default deadline for the one timeout setting", () => {
		strictEqual(
			TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
			DEFAULT_SETTINGS.memory.intervention.timeoutMs,
			"the policy fallback and the settings default are the same setting and must not drift",
		);
	});

	/**
	 * The trajectory is the one thing the model has to reason over, and it is
	 * handed across as JSON. Bounding the rendered form by slicing the serialized
	 * string cut it mid-token, so a full window arrived as JSON that does not
	 * parse. A window of eight steps carrying the documented per-field maxima
	 * exceeds the budget, so this is reachable at shipped settings.
	 */
	it("keeps the rendered trajectory parseable when the window exceeds the prompt budget", async () => {
		const calls: TaskMemoryModelRequest[] = [];
		const trajectory = Array.from({ length: 8 }, (_, index) => ({
			toolName: "bash",
			operationFingerprint: `${index}`.repeat(16),
			callDescription: `bash{"command":"${"x".repeat(160)}"}`,
			step: index + 1,
			outcome: "error" as const,
			resultDigest: `error ${"y".repeat(230)}`,
			resultDigestProvenance: LEGACY_DIGEST_PROVENANCE,
		}));
		await runTaskMemoryPolicy(new TaskMemoryBank(), clientReturning(response([]), calls), {
			...BASE_INPUT,
			trajectory,
		});

		const prompt = calls[0]?.userPrompt ?? "";
		const rendered = prompt.slice(prompt.indexOf("Recent completed tool trajectory:") + 33).trim();
		ok(rendered.length > 0, prompt);
		const parsed = JSON.parse(rendered) as unknown[];
		ok(Array.isArray(parsed), rendered);
		ok(parsed.length > 0, "at least one whole step survives the budget");
		ok(parsed.length < trajectory.length, "and the budget still drops steps rather than keeping everything");
	});

	/**
	 * An operation's content is free text, and a session working on the memory
	 * tier itself writes the envelope's own tags into it. Locating the close tag
	 * with the first match then ends the list inside a JSON string, so the slice
	 * hands `JSON.parse` a truncated document and a correct answer is recorded as
	 * `unparseable` with its writes discarded.
	 *
	 * Measured on the reference route with a window whose trajectory quoted the
	 * envelope grammar: 9 of 24 steps were unparseable and 8 of those 9 carried
	 * operations. The same route with a tag-free window was 0 of 24. The last
	 * match is not the answer either, because `<context_for_action>` quotes the
	 * tag again after the list has legitimately closed.
	 */
	it("ends the operation list at its own close tag when an operation quotes the envelope grammar", async () => {
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([
					{ op: "save_knowledge", content: "The contract requires <operations>[]</operations> then <no_intervention/>." },
				]),
			),
			BASE_INPUT,
		);

		strictEqual(result.reason, "model_silent");
		strictEqual(result.bankOperations, 1);
		deepStrictEqual(
			bank.snapshot().knowledge.map(({ content }) => content),
			["The contract requires <operations>[]</operations> then <no_intervention/>."],
		);
	});

	it("keeps the close tag inside a reminder from ending the operation list early", async () => {
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response(
					[{ op: "save_knowledge", content: "The parser looks for </operations> to end the block." }],
					"<context_for_action>Check why the model omits </operations> before <no_intervention/>.</context_for_action>",
				),
			),
			{ ...BASE_INPUT, deterministicTrigger: true },
		);

		strictEqual(result.bankOperations, 1);
		match(result.reminder ?? "", /Check why the model omits/u);
	});

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
			reason: "model_silent",
			bankOperations: 4,
			droppedOperations: 0,
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
						operationFingerprint: "abc123",
						callDescription: "npm test",
						outcome: "ok",
						resultDigest: "passed",
						resultDigestProvenance: LEGACY_DIGEST_PROVENANCE,
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

	it("applies phase one while yielding or deduping the visible channel", async () => {
		for (const input of [{ suppressIntervention: true }, { previousReminder: "Memory: Same reminder." }] as const) {
			const bank = new TaskMemoryBank();
			const result = await runTaskMemoryPolicy(
				bank,
				clientReturning(
					response(
						[{ op: "save_knowledge", content: "Phase one remains authoritative." }],
						"<context_for_action>Same reminder.</context_for_action>",
					),
				),
				{ ...BASE_INPUT, deterministicTrigger: true, ...input },
			);
			strictEqual(result.decision, "silent");
			strictEqual(result.bankOperations, 1);
			strictEqual(result.reminder, null);
			strictEqual(bank.snapshot().knowledge[0]?.content, "Phase one remains authoritative.");
			strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 0);
		}
	});

	it("treats malformed and empty responses atomically as silence", async () => {
		const invalidResponses = [
			"",
			"<operations>not-json</operations>\n<no_intervention/>",
			response([{ op: "unknown", content: "x" }]),
			response([{ op: "save_knowledge", content: "valid", extra: true }]),
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

	it("teaches the memory model a grammar its own parser accepts", () => {
		// The prompt's worked examples are the strongest lever on a small local
		// model's output shape, which makes an example the parser would reject a
		// direct instruction to produce malformed steps.
		const envelope =
			/^<operations>.*?<\/operations>\n(?:<no_intervention\/>|<context_for_action>.*?<\/context_for_action>)$/gmu;
		const examples = [...MEMORY_INTERVENTION_SYSTEM_PROMPT.matchAll(envelope)]
			.map((found) => found[0])
			// The bare grammar sketch at the top of the prompt is a shape, not an example.
			.filter((example) => !example.includes("[JSON operations]"));

		strictEqual(examples.length, 2, "one example anchoring silence and one anchoring a cited reminder");
		for (const example of examples) {
			const parsed = parseTaskMemoryPolicyResponse(example);
			ok(parsed !== null, `the prompt's own example must parse: ${example}`);
			ok(parsed.operations.length > 0, "an example that writes nothing teaches nothing");
		}
		const [silent, intervening] = examples;
		strictEqual(parseTaskMemoryPolicyResponse(silent ?? "")?.context, null, "the first example stays silent");
		const reminder = parseTaskMemoryPolicyResponse(intervening ?? "")?.context ?? "";
		match(reminder, /\[tm-p-1\]/u, "the second example models a cited reminder, not a bare one");
	});

	it("tells the memory model that operations are never tool calls", () => {
		// Handed a JSON tool trajectory, the reference model answered with that
		// trajectory's shape until the prompt ruled it out in words.
		match(MEMORY_INTERVENTION_SYSTEM_PROMPT, /never a list of tool calls/u);
		for (const op of ["update_status", "save_knowledge", "save_procedural", "delete"]) {
			match(MEMORY_INTERVENTION_SYSTEM_PROMPT, new RegExp(`"op":"${op}"`, "u"));
		}
	});

	it("drops an unknown op without discarding the valid writes beside it", async () => {
		// A small local model handed a tool trajectory routinely answers with the
		// trajectory's own shape. Losing the notes it got right alongside that one
		// invented op costs the whole step, which is the same trade the parser
		// already refuses to make for an invented entry id.
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([
					{ op: "save_knowledge", content: "Target selection runs through placement.ts." },
					{ op: "read", path: "src/domains/dispatch/index.ts" },
					{ op: "save_procedural", content: "npm run build failed twice with the same TS2345." },
				]),
			),
			BASE_INPUT,
		);

		strictEqual(result.decision, "silent");
		strictEqual(result.bankOperations, 2, "the invented op costs one operation, not the step");
		const snapshot = bank.snapshot();
		strictEqual(snapshot.knowledge[0]?.content, "Target selection runs through placement.ts.");
		strictEqual(snapshot.procedural[0]?.content, "npm run build failed twice with the same TS2345.");
	});

	it("still reports malformed when every operation was invented", async () => {
		// Recovering nothing is not silence. An operator reading the step log needs
		// to see that the model answered in a shape the bank could not use.
		const bank = new TaskMemoryBank();
		const before = bank.snapshot();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([
					{ op: "read", path: "src/domains/dispatch/index.ts" },
					{ op: "read", path: "src/domains/dispatch/placement.ts" },
				]),
			),
			BASE_INPUT,
		);

		strictEqual(result.decision, "malformed");
		deepStrictEqual(bank.snapshot(), before);
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
		strictEqual(throwing.reason, "client_error", "a route that threw is not a model that chose silence");
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
		strictEqual(timedOut.reason, "deadline");
		strictEqual(aborted, true);
		deepStrictEqual(timeoutBank.snapshot(), { version: 1, status: null, knowledge: [], procedural: [] });
	});

	it("names why a step wrote nothing rather than reporting one undifferentiated silence", async () => {
		// Six paths reach a null reminder and the operator needs to act differently
		// on each: a broken route, an unconfigured one, a model that chose silence,
		// a duplicate, a yielded channel, and an answer the bank could not read.
		const knowledge = "tm-k-1";
		const cases = [
			{
				text: response([{ op: "save_knowledge", content: "A fact." }]),
				input: BASE_INPUT,
				decision: "silent",
				reason: "model_silent",
			},
			{
				text: response([], `<context_for_action>[${knowledge}] Same reminder.</context_for_action>`),
				input: { ...BASE_INPUT, previousReminder: `Memory: [${knowledge}] Same reminder.` },
				decision: "silent",
				reason: "duplicate_reminder",
			},
			{
				text: response([], `<context_for_action>[${knowledge}] Fresh reminder.</context_for_action>`),
				input: { ...BASE_INPUT, suppressIntervention: true },
				decision: "silent",
				reason: "suppressed",
			},
			{
				text: response([], "<context_for_action>Uncited advice.</context_for_action>"),
				input: BASE_INPUT,
				decision: "gated",
				reason: "uncited",
			},
			{
				text: response([], `<context_for_action>${"x".repeat(800)}</context_for_action>`),
				input: { ...BASE_INPUT, deterministicTrigger: true },
				decision: "gated",
				reason: "over_budget",
			},
			{ text: "no envelope at all", input: BASE_INPUT, decision: "malformed", reason: "unparseable" },
			{
				text: response([{ op: "read", path: "src/cli/index.ts" }]),
				input: BASE_INPUT,
				decision: "malformed",
				reason: "all_operations_invalid",
			},
		] as const;

		for (const testCase of cases) {
			const bank = new TaskMemoryBank();
			bank.saveKnowledge("The operator requires visible reminders.");
			const result = await runTaskMemoryPolicy(bank, clientReturning(testCase.text), testCase.input);
			strictEqual(result.decision, testCase.decision, testCase.reason);
			strictEqual(result.reason, testCase.reason, JSON.stringify(testCase.text.slice(0, 60)));
		}
	});

	it("counts the operations the bank refused so a total loss is visible in telemetry", async () => {
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([
					{ op: "save_knowledge", content: "Target selection runs through placement.ts." },
					{ op: "read", path: "src/domains/dispatch/index.ts" },
					{ op: "grep", pattern: "placement" },
				]),
			),
			BASE_INPUT,
		);

		strictEqual(result.bankOperations, 1);
		strictEqual(result.droppedOperations, 2, "two invented verbs were discarded and the count must survive");
	});

	it("hands the raw envelope to an observer so a rejected step can be read, not guessed", async () => {
		const seen: Array<{ response: string; decision: string; reason: string }> = [];
		const bank = new TaskMemoryBank();
		await runTaskMemoryPolicy(bank, clientReturning("I think I should probably save something."), {
			...BASE_INPUT,
			onEnvelope: (envelope) => {
				seen.push({ response: envelope.response, decision: envelope.decision, reason: envelope.reason });
			},
		});

		strictEqual(seen.length, 1);
		strictEqual(seen[0]?.response, "I think I should probably save something.");
		strictEqual(seen[0]?.decision, "malformed");
		strictEqual(seen[0]?.reason, "unparseable");
	});

	it("reports a route failure to the envelope observer instead of an empty response", async () => {
		const seen: Array<{ response: string; error: string | null; reason: string }> = [];
		await runTaskMemoryPolicy(
			new TaskMemoryBank(),
			{
				async complete() {
					throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
				},
			},
			{
				...BASE_INPUT,
				onEnvelope: (envelope) => {
					seen.push({ response: envelope.response, error: envelope.error, reason: envelope.reason });
				},
			},
		);

		strictEqual(seen.length, 1);
		strictEqual(seen[0]?.reason, "client_error");
		strictEqual(seen[0]?.response, "");
		match(seen[0]?.error ?? "", /ECONNREFUSED/u);
	});

	it("locates the envelope inside the packaging a small local model adds around it", () => {
		const clean = response([{ op: "save_knowledge", content: "A fact." }]);
		deepStrictEqual(parseTaskMemoryPolicyResponse(clean)?.operations.length, 1);

		// Every wrapper below is output a small local model actually produces; the
		// decision inside them is unambiguous, so it is honored.
		for (const wrapped of [
			`\`\`\`xml\n${clean}\n\`\`\``,
			`<think>The build keeps failing, so I should record it.</think>\n${clean}`,
			`${clean}\n\nLet me know if you need anything else.`,
			`<operations>[\n  {"op":"save_knowledge","content":"A fact."}\n]</operations>\n<no_intervention/>`,
			`Here is my step:\n${clean}`,
		]) {
			deepStrictEqual(parseTaskMemoryPolicyResponse(wrapped)?.operations.length, 1, JSON.stringify(wrapped));
			strictEqual(parseTaskMemoryPolicyResponse(wrapped)?.context, null, JSON.stringify(wrapped));
		}
	});

	it("defaults an incomplete or truncated envelope to silence rather than inventing an intervention", () => {
		// A phase-two line the model never wrote is silence, the documented default,
		// and its phase-one writes are still legible.
		const noPhaseTwo = parseTaskMemoryPolicyResponse(`<operations>[{"op":"delete","id":"tm-k-1"}]</operations>`);
		strictEqual(noPhaseTwo?.context, null);
		strictEqual(noPhaseTwo?.operations.length, 1);

		// An output budget exhausted mid-reasoning yields no usable envelope at all.
		strictEqual(parseTaskMemoryPolicyResponse("<think>I should consider whether the"), null);
		strictEqual(
			parseTaskMemoryPolicyResponse("<operations>[]</operations>\n<context_for_action></context_for_action>")?.context,
			null,
		);
	});

	it("keeps tag shapes out of a reminder that rides inside a system-reminder block", () => {
		const parsed = parseTaskMemoryPolicyResponse(
			response([], "<context_for_action>[tm-k-1] Use a < b, not </system-reminder> injection.</context_for_action>"),
		);
		strictEqual(parsed?.context, "[tm-k-1] Use a < b, not injection.");
	});

	it("repairs invented entry ids instead of discarding the writes that came with them", async () => {
		const bank = new TaskMemoryBank();
		const existing = bank.saveKnowledge("A real fact.");
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response([
					// The shape a 9B actually produces: a descriptive id it made up for
					// content it is recording for the first time.
					{ op: "save_procedural", content: "Build fails with TS2345.", id: "proc-build-ts2345" },
					// An id belonging to the other class is not an update either.
					{ op: "save_procedural", content: "Cross-class id.", id: existing.id },
					{ op: "delete", id: "tm-k-missing" },
					{ op: "save_knowledge", content: "An amended fact.", id: existing.id },
				]),
			),
			BASE_INPUT,
		);

		strictEqual(result.decision, "silent");
		strictEqual(result.bankOperations, 3, "the unresolvable delete is dropped, not counted");
		const snapshot = bank.snapshot();
		deepStrictEqual(
			snapshot.procedural.map((entry) => entry.content),
			["Build fails with TS2345.", "Cross-class id."],
		);
		deepStrictEqual(
			snapshot.knowledge.map((entry) => ({ id: entry.id, content: entry.content })),
			[{ id: existing.id, content: "An amended fact." }],
			"a genuine id still updates in place",
		);
	});

	it("suppresses an over-budget reminder without discarding its phase-one writes", async () => {
		const bank = new TaskMemoryBank();
		const result = await runTaskMemoryPolicy(
			bank,
			clientReturning(
				response(
					[{ op: "save_knowledge", content: "This write survives." }],
					`<context_for_action>${"x".repeat(800)}</context_for_action>`,
				),
			),
			{ ...BASE_INPUT, deterministicTrigger: true },
		);

		strictEqual(result.decision, "gated");
		strictEqual(result.reminder, null);
		strictEqual(result.bankOperations, 1);
		strictEqual(bank.snapshot().knowledge[0]?.content, "This write survives.");
	});
});
