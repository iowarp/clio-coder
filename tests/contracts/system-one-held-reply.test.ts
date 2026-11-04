import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
	isResponseSchemaRejection,
	responseSchemaDialectFor,
	runtimeSpeaksResponseSchemaDialect,
	speaksOutputConfigFormat,
} from "../../src/core/response-schema.js";
import type { OneShotPort } from "../../src/domains/providers/one-shot.js";
import { oneShotRoundOptions } from "../../src/domains/providers/one-shot.js";
import anthropicMaxRuntime from "../../src/domains/providers/runtimes/cloud/anthropic-max.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { SAFETY_JUDGE_SCHEMA } from "../../src/domains/safety/safety-judge.js";
import { createLlmEngine } from "../../src/domains/system-one/engines/llm.js";
import { BATCH_PROMPT_VERSION, formBatch } from "../../src/domains/system-one/engines/llm-batch.js";
import { filterItemOf, filterQuestions, pick, yesNo } from "../../src/domains/system-one/questions.js";
import { createRunner } from "../../src/domains/system-one/runner.js";
import type { Question } from "../../src/domains/system-one/types.js";
import { createSafetyJudgeCompletion } from "../../src/entry/safety-judge-host.js";
import { runOutOfTurnRound } from "../../src/session-control/side-question.js";
import type { TriageVerdict } from "../../src/session-control/steering-triage.js";
import { runTriageRound, triageLabelsFor, triageMayInterrupt } from "../../src/session-control/steering-triage.js";

const RULE = { instructions: "This file reads quota.", whenTrue: "It meets it", whenFalse: "It does not" };

function filterOver(items: Record<string, string>): Record<string, Question> {
	return Object.fromEntries(Object.entries(filterQuestions(RULE, items)).map(([id, point]) => [id, point.question]));
}

const STATE = { source: "files" };
const ITEMS = { "src/a.ts": "src/a.ts\nreads quota", "src/b.ts": "src/b.ts\nrenders a table" };

describe("a filter question", () => {
	it("keeps the instructions a /v1/systemone server was measured on", () => {
		const question = filterOver({ one: "cache.ts" }).one as Question;
		strictEqual(question.instructions, "This file reads quota.\nItem: cache.ts");
		deepStrictEqual(filterItemOf(question), { rule: "This file reads quota.", item: "cache.ts" });
		strictEqual(filterItemOf(yesNo("Is it risky?", "It is", "It is not")), null);
		strictEqual(filterItemOf(pick("Which?\nItem: x", { a: "A", b: "B" })), null);
	});
});

describe("a batch over a filter", () => {
	it("holds the items in the state, asks the rule once and agrees with the state in its reply line", () => {
		for (const shape of ["by-id", "list"] as const) {
			const { prompt } = formBatch(STATE, filterOver(ITEMS), shape);
			strictEqual(prompt.user.match(/This file reads quota\./gu)?.length, 1);
			const state = JSON.parse(prompt.user.slice("STATE:\n".length, prompt.user.indexOf("\n\nQUESTIONS:")));
			strictEqual(state.source, "files");
			deepStrictEqual(Object.values(state.items), Object.values(ITEMS));
			ok(!prompt.system.includes("the STATE does not decide"));
		}
	});

	it("keeps real ids by id, for a route whose grammar already measured them", () => {
		const batch = formBatch(STATE, filterOver(ITEMS), "by-id");
		ok(batch.prompt.user.includes('"src/a.ts"'));
		deepStrictEqual((batch.schema as { required: string[] }).required, Object.keys(ITEMS));
		deepStrictEqual(batch.read('{"src/a.ts":"yes","src/b.ts":"no"}'), {
			"src/a.ts": { type: "noul", noul: 1 },
			"src/b.ts": { type: "noul", noul: 0 },
		});
	});

	it("reads a list by position back to real ids, and one small schema serves any length", () => {
		const batch = formBatch(STATE, filterOver(ITEMS), "list");
		ok(batch.prompt.user.includes('"q1"') && batch.prompt.user.includes('"q2"'));
		deepStrictEqual(batch.read('{"answers":[{"id":"q2","label":"yes"},{"id":"q1","label":"no"}]}'), {
			"src/a.ts": { type: "noul", noul: 0 },
			"src/b.ts": { type: "noul", noul: 1 },
		});
		const many = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`src/f${index}.ts`, `file ${index}`]));
		deepStrictEqual(formBatch(STATE, filterOver(many), "list").schema, batch.schema);
	});

	it("gives a list reply room for every line, at 14 tokens measured per item", () => {
		const many = Object.fromEntries(Array.from({ length: 94 }, (_, index) => [`src/f${index}.ts`, `file ${index}`]));
		ok(formBatch(STATE, filterOver(many), "list").maxTokens >= 94 * 14);
	});

	it("leaves an abstention, an unknown label and a missing id unanswered, never a no", () => {
		const items = { a: "one", b: "two", c: "three", d: "four" };
		const batch = formBatch(STATE, filterOver(items), "list");
		const reply =
			'{"answers":[{"id":"q1","label":"unsure"},{"id":"q2","label":"maybe"},{"id":"q3","label":"yes"},{"id":"q9","label":"yes"}]}';
		deepStrictEqual(batch.read(reply), { c: { type: "noul", noul: 1 } });
		strictEqual(batch.read("no object here"), null);
	});

	it("reads a by-id reply under a list, from a round that fell back to no schema", () => {
		const batch = formBatch(STATE, filterOver({ a: "one" }), "list");
		deepStrictEqual(batch.read('Here: {"q1":"yes"}'), { a: { type: "noul", noul: 1 } });
	});
});

describe("a batch over typed questions", () => {
	const questions: Record<string, Question> = {
		risky: yesNo("Is it risky?", "It is", "It is not"),
		which: pick("Which file?", { a: "cache.ts", b: "store.ts" }),
	};

	it("keeps its own ids and state, and a list holds every label its questions accept", () => {
		const batch = formBatch({ task: "t" }, questions, "list");
		ok(batch.prompt.user.includes("risky: Is it risky?"));
		ok(batch.prompt.user.includes('"task": "t"'));
		const entry = (batch.schema as { properties: { answers: { items: { properties: { label: { enum: string[] } } } } } })
			.properties.answers.items;
		deepStrictEqual(entry.properties.label.enum.sort(), ["a", "b", "no", "unsure", "yes"]);
		deepStrictEqual(batch.read('{"answers":[{"id":"risky","label":"yes"}]}'), { risky: { type: "noul", noul: 1 } });
	});

	it("does not read two filters with different rules as one", () => {
		const mixed = { ...filterOver({ a: "one" }), b: yesNo("Other rule\nItem: two", RULE.whenTrue, RULE.whenFalse) };
		const { prompt } = formBatch(STATE, mixed, "by-id");
		ok(prompt.user.includes("a: This file reads quota.\nItem: one"));
		ok(prompt.user.includes("b: Other rule\nItem: two"));
	});
});

describe("the LLM engine", () => {
	const target: TargetDescriptor = { id: "max", runtime: "anthropic-max", defaultModel: "claude-haiku-5-5" };

	it("asks a held-reply route for a list and names the build under the current prompt", async () => {
		const seen: Array<{ schema?: object; user: string }> = [];
		const engine = createLlmEngine({
			name: "main",
			target,
			runtime: anthropicMaxRuntime,
			model: null,
			host: {} as never,
			oneShot: async (request) => {
				seen.push({ user: request.user, ...(request.schema !== undefined ? { schema: request.schema } : {}) });
				return { text: '{"answers":[{"id":"q1","label":"yes"},{"id":"q2","label":"unsure"}]}', model: "claude-haiku-5-5" };
			},
		});
		const reply = await engine.decide({
			state: STATE,
			questions: filterOver(ITEMS),
			signal: new AbortController().signal,
		});
		deepStrictEqual(reply.answers, { "src/a.ts": { type: "noul", noul: 1 } });
		ok(reply.build.endsWith(`#batch:${BATCH_PROMPT_VERSION}`));
		strictEqual(BATCH_PROMPT_VERSION, "b2");
		ok((seen[0]?.schema as { required: string[] }).required.includes("answers"));
		// What keeps the judge screen off this route and a triage label from interrupting.
		strictEqual(engine.capabilities.probabilities, false);
		deepStrictEqual(engine.capabilities.readout, {
			boolean: "categorical",
			exclusive: "categorical",
			ordinal: "categorical",
			independent: "categorical",
		});
	});
});

describe("a typed triage ask on anthropic-max", () => {
	it("is a System One round that holds its reply, and its labels mark without interrupting", async () => {
		const target: TargetDescriptor = { id: "max", runtime: "anthropic-max", defaultModel: "claude-haiku-5-5" };
		const asked: Array<Parameters<OneShotPort>[0]> = [];
		const engine = createLlmEngine({
			name: "main",
			target,
			runtime: anthropicMaxRuntime,
			model: null,
			host: {} as never,
			oneShot: async (request) => {
				asked.push(request);
				// Every id answers with a label of the block under it, "stop" where it is offered.
				const answers: Array<{ id: string; label: string }> = [];
				for (const block of request.user
					.slice(request.user.indexOf("QUESTIONS:"))
					.split(/\n(?=[^\s:]+: )/u)
					.slice(1)) {
					const id = block.slice(0, block.indexOf(":"));
					const labels = [...block.matchAll(/^ {2}([^:\n]+):/gmu)].map((match) => match[1] as string);
					answers.push({ id, label: labels.includes("stop") ? "stop" : (labels[0] as string) });
				}
				return { text: JSON.stringify({ answers }), model: "claude-haiku-5-5" };
			},
		});
		const runner = createRunner({});
		const route = { name: engine.name, engine, digest: engine.name, timeoutMs: 5_000 };
		const applied: TriageVerdict[] = [];
		let side = 0;
		await runTriageRound({
			triage: { target: null, minQueued: 1, timeoutMs: 5_000 },
			systemOne: {
				bound: () => true,
				ask: (point, object, options) => runner.ask([route], point, object, options ?? {}),
			},
			asked: [{ id: "m1", text: "stop, wrong branch", kind: "steer" }],
			task: () => "fix the cache",
			previous: () => "working on it",
			current: () => true,
			apply: (verdicts) => {
				applied.push(...verdicts);
			},
			side: async () => {
				side += 1;
			},
		});
		strictEqual(side, 0);
		strictEqual(oneShotRoundOptions(asked[0] as Parameters<OneShotPort>[0]).holdReply, true);
		const verdict = applied[0] as TriageVerdict;
		strictEqual(verdict.relation, "stop");
		strictEqual(verdict.confidence, undefined);
		strictEqual(triageLabelsFor(verdict).readout, "label");
		strictEqual(triageMayInterrupt(verdict, { enqueuedAt: 1_000, pinned: false }, 1_000), false);
	});
});

describe("the output_config dialect", () => {
	it("stays out of the response_format table a worker refuses from", () => {
		strictEqual(speaksOutputConfigFormat("anthropic-max"), true);
		strictEqual(speaksOutputConfigFormat("anthropic"), true);
		strictEqual(speaksOutputConfigFormat("anthropic-compat"), false);
		strictEqual(responseSchemaDialectFor("anthropic"), null);
		strictEqual(responseSchemaDialectFor("anthropic-max"), null);
		strictEqual(runtimeSpeaksResponseSchemaDialect(anthropicMaxRuntime), false);
	});

	it("reads what the API answers to a schema it will not compile as a rejection", () => {
		ok(
			isResponseSchemaRejection(
				'400 {"error":{"type":"invalid_request_error","message":"The compiled grammar is too large"}}',
			),
		);
		ok(isResponseSchemaRejection('400 {"error":{"message":"output_config.format.schema: unsupported"}}'));
		ok(!isResponseSchemaRejection('400 {"error":{"message":"max_tokens: too large"}}'));
	});
});

describe("an out-of-turn round on the subscription", () => {
	let server: Server;
	let bodies: Array<Record<string, unknown>> = [];
	let refuse = 0;
	const sse = (events: unknown[]) =>
		events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

	before(async () => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += String(chunk);
			});
			req.on("end", () => {
				bodies.push(JSON.parse(raw) as Record<string, unknown>);
				if (refuse > 0) {
					refuse -= 1;
					res.writeHead(400, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "The compiled grammar is too large" },
						}),
					);
					return;
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					sse([
						{
							type: "message_start",
							message: { id: "m", model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 0 } },
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"ok":true}' } },
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
						{ type: "message_stop" },
					]),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	});
	after(() => new Promise((resolve) => server.close(resolve)));

	function input() {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const target: TargetDescriptor = { id: "max", runtime: "anthropic-max", url, defaultModel: "claude-haiku-5-5" };
		return {
			model: anthropicMaxRuntime.synthesizeModel(target, "claude-haiku-5-5", null),
			messages: [],
			systemPrompt: "side",
			userText: "ask",
			maxTokens: 64,
			thinkingLevel: "off" as const,
			runtimeId: "anthropic-max",
			apiKey: "test-key",
			responseSchema: { name: "answer", schema: { type: "object", additionalProperties: false, properties: {} } },
		};
	}

	const ask = () => ({ ...input(), holdReply: true });

	it("holds a System One ask through output_config.format", async () => {
		bodies = [];
		strictEqual((await runOutOfTurnRound(ask())).text, '{"ok":true}');
		strictEqual(bodies.length, 1);
		deepStrictEqual((bodies[0]?.output_config as { format: unknown }).format, {
			type: "json_schema",
			schema: { type: "object", additionalProperties: false, properties: {} },
		});
		strictEqual(bodies[0]?.response_format, undefined);
	});

	it("sends the plain request after a schema the API will not compile", async () => {
		bodies = [];
		refuse = 1;
		strictEqual((await runOutOfTurnRound(ask())).text, '{"ok":true}');
		strictEqual(bodies.length, 2);
		ok(bodies[0]?.output_config !== undefined);
		strictEqual(bodies[1]?.output_config, undefined);
	});

	it("sends nothing extra without a schema", async () => {
		bodies = [];
		const { responseSchema: _unused, ...plain } = ask();
		await runOutOfTurnRound(plain);
		strictEqual(bodies[0]?.output_config, undefined);
	});

	it("keeps a round that is no ask plain, as /handoff and triage's side model send it", async () => {
		bodies = [];
		await runOutOfTurnRound(input());
		strictEqual(bodies[0]?.output_config, undefined);
	});

	it("sends a judge request on anthropic-max with no output_config", async () => {
		const seen: Array<Parameters<OneShotPort>[0]> = [];
		const complete = createSafetyJudgeCompletion({
			providers: { getTarget: () => ({ id: "max", runtime: "anthropic-max", defaultModel: "claude-haiku-5-5" }) },
			flowRefusal: () => null,
			oneShot: () => async (request) => {
				seen.push(request);
				return { text: "{}" };
			},
		});
		await complete({
			targetId: "max",
			model: "claude-haiku-5-5",
			system: "judge",
			user: "ls",
			schema: SAFETY_JUDGE_SCHEMA,
			maxTokens: 64,
			signal: new AbortController().signal,
		});
		const request = seen[0] as Parameters<OneShotPort>[0];
		strictEqual(request.engine, undefined);
		strictEqual(oneShotRoundOptions(request).holdReply, undefined);
		bodies = [];
		const { responseSchema: _own, ...round } = input();
		await runOutOfTurnRound({ ...round, ...oneShotRoundOptions(request) });
		ok(bodies[0] !== undefined);
		strictEqual(bodies[0]?.output_config, undefined);
	});
});
