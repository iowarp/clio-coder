import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import typesafeJevRuntime from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import openAICompatRuntime from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import systemOneRuntime from "../../src/domains/providers/runtimes/protocol/systemone.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { judgeFit, judgeHoldout, type KeySpec } from "../../src/domains/system-one/calibrate.js";
import { batchRequestKey, createLlmEngine } from "../../src/domains/system-one/engines/llm.js";
import { createSystemOneEngine } from "../../src/domains/system-one/engines/systemone.js";
import { createSystemOne } from "../../src/domains/system-one/factory.js";
import {
	indexMeasurements,
	LABEL_POLICY_VERSION,
	MEASURED_SITE_VERSIONS,
	type Measurement,
} from "../../src/domains/system-one/measurement.js";
import { pick, yesNo } from "../../src/domains/system-one/questions.js";
import { probability } from "../../src/domains/system-one/sites/bounds.js";
import { TURN_SITE } from "../../src/domains/system-one/sites/turn.js";
import type { Question } from "../../src/domains/system-one/types.js";

/**
 * Both engine kinds against in-process servers on 127.0.0.1: a fake
 * `/v1/systemone` and a fake OpenAI-compatible chat server. Nothing here
 * touches Clio state or a real endpoint.
 */

type Body = Record<string, unknown>;
type Reply = { status?: number; body: unknown };

interface Served {
	url: string;
	requests: Body[];
	close(): Promise<void>;
}

function serve(handle: (body: Body, seen: number) => Reply): Promise<Served> {
	const requests: Body[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw || "{}") as Body;
			requests.push(body);
			const reply = handle(body, requests.length);
			res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
			res.end(JSON.stringify(reply.body));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				requests,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

const servers: Served[] = [];
after(async () => {
	await Promise.all(servers.map((server) => server.close()));
});
async function started(handle: (body: Body, seen: number) => Reply): Promise<Served> {
	const server = await serve(handle);
	servers.push(server);
	return server;
}

const host = { auth: undefined, credentialsPresent: () => new Set<string>() };
const state = { task: "refund my last invoice" };

function signal(): AbortSignal {
	return new AbortController().signal;
}

/** The option letters of a prompt, in the order the model reads them. */
function options(body: Body): Array<{ letter: string; text: string }> {
	const messages = body.messages as Array<{ content: string }>;
	const user = messages[1]?.content ?? "";
	return [...user.matchAll(/^([A-Z])\) (.*)$/gmu)].map((match) => ({ letter: match[1] ?? "", text: match[2] ?? "" }));
}

/** A chat reply whose first token is `want` at `p`, with `other` taking the rest. */
function firstToken(want: string, other: string, p: number): Reply {
	const top = [
		{ token: want, logprob: Math.log(p) },
		{ token: other, logprob: Math.log(1 - p) },
	];
	return {
		body: {
			choices: [
				{
					message: { content: want },
					logprobs: { content: [{ token: want, logprob: Math.log(p), top_logprobs: top }] },
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 1 },
		},
	};
}

function llmTarget(url: string): TargetDescriptor {
	return { id: "local", runtime: "llamacpp", url, defaultModel: "m" };
}

describe("System One engine over a /v1/systemone server", () => {
	const questions: Record<string, Question> = {
		urgent: yesNo("Urgent?", "it is", "it is not"),
		team: pick("Which team?", { billing: "money", tech: "bugs" }),
		lost: pick("Which other team?", { a: "one", b: "two" }),
		gone: pick("Which third team?", { a: "one", b: "two" }),
	};

	it("normalizes answers to the contract and drops the malformed or missing ones", async () => {
		const server = await started(() => ({
			body: {
				model: "jev-9.9.9",
				answers: {
					urgent: { type: "noul", noul: 0.9 },
					// The server's own confidence is deliberately wrong: certainty is recomputed from mass.
					team: { type: "choice", choice: "billing", probabilities: { billing: 0.6, tech: 0.4 }, confidence: 0.99 },
					// Mass that does not sum to 1 is not a distribution.
					lost: { type: "choice", choice: "a", probabilities: { a: 0.3, b: 0.3 }, confidence: 0.5 },
				},
				usage: { input_tokens: 12, output_tokens: 3 },
			},
		}));
		const engine = createSystemOneEngine({
			name: "jev",
			target: { id: "so", runtime: "systemone", url: server.url },
			runtime: systemOneRuntime,
			model: null,
			host,
		});
		const reply = await engine.decide({ state, questions, signal: signal() });
		strictEqual(reply.build, "jev-9.9.9");
		strictEqual(
			reply.answers.urgent?.certainty !== undefined && Math.abs(reply.answers.urgent.certainty - 0.8) < 1e-9,
			true,
		);
		strictEqual(reply.answers.team?.choice, "billing");
		strictEqual(Math.abs((reply.answers.team?.certainty ?? 0) - 0.2) < 1e-9, true);
		strictEqual(reply.answers.team?.calibrated, true);
		strictEqual(Object.keys(reply.answers).sort().join(), "team,urgent");
		strictEqual(reply.usage?.input, 12);
	});

	it("surfaces the server's error body in the failure", async () => {
		const server = await started(() => ({ status: 422, body: { detail: "criteria for 'team' has no options" } }));
		const engine = createSystemOneEngine({
			name: "jev",
			target: { id: "so", runtime: "systemone", url: server.url },
			runtime: systemOneRuntime,
			model: null,
			host,
		});
		await rejects(engine.decide({ state, questions, signal: signal() }), /HTTP 422.*criteria for 'team' has no options/u);
	});

	it("caps a strands-decider engine at 4096 tokens and sends it every option a pointer head reads", async () => {
		const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`o${i}`, `option ${i}`]));
		const server = await started((body) => {
			const asked = body.questions as Record<string, Question>;
			const keys = Object.keys((asked.wide as { criteria: Record<string, string> }).criteria);
			const probabilities = Object.fromEntries(keys.map((key) => [key, 1 / keys.length]));
			return {
				body: {
					model: "strands-decider-2B-test",
					answers: { wide: { type: "choice", choice: keys[0], probabilities, confidence: 0 } },
				},
			};
		});
		const engine = createSystemOneEngine({
			name: "decider",
			target: { id: "so", runtime: "systemone", url: server.url, capabilities: { contextWindow: 8192 } },
			runtime: systemOneRuntime,
			model: null,
			host,
			profile: "strands-decider",
		});
		strictEqual(engine.windowTokens, 4096);
		const wide = pick("Which option?", many);
		const only = pick("Which team?", { billing: "money" });
		strictEqual(engine.unsupported("recipe", wide), null);
		strictEqual(engine.unsupported("turnEnd", only), null);
		const reply = await engine.decide({
			state,
			questions: { wide, only },
			tasks: { wide: "recipe", only: "consult" },
			signal: signal(),
		});
		strictEqual(Object.keys((server.requests[0]?.questions as Body) ?? {}).join(), "wide");
		strictEqual(reply.answers.only?.choice, "billing");
		strictEqual(reply.answers.wide?.readout, "softmax-exclusive");
	});
});

describe("TypeSafe Jev runtime", () => {
	it("asks for the build the cuts were measured on, and accepts that pin though /models lists only the moving names", async () => {
		const server = await started(() => ({
			body: {
				models: [{ name: "jev-latest" }, { name: "jev-preview" }],
				model: "jev-1.14.0",
				answers: { q: { type: "noul", noul: 0.5 } },
			},
		}));
		const target = { id: "jev", runtime: "typesafe-jev", url: server.url };
		const ctx = { httpTimeoutMs: 2000, credentialsPresent: new Set<string>() };
		await typesafeJevRuntime.decide?.(
			target,
			{ state, questions: { q: { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } } } },
			ctx,
		);
		strictEqual(server.requests[0]?.model, "jev-1.14.0");
		strictEqual((await typesafeJevRuntime.probe?.({ ...target, defaultModel: "jev-1.14.0" }, ctx))?.ok, true);
		strictEqual((await typesafeJevRuntime.probe?.({ ...target, defaultModel: "jev-1.13.0" }, ctx))?.ok, false);
		strictEqual((await typesafeJevRuntime.probe?.({ ...target, defaultModel: "jev-0.0.1" }, ctx))?.ok, false);
	});
});

describe("LLM engine over an OpenAI-compatible chat server", () => {
	it("turns thinking off on openai-compat, and drops the switch for a server that refuses it", async () => {
		const answerFirst = (body: Body): Reply =>
			firstToken(options(body).find((option) => option.text.startsWith("true:"))?.letter ?? "A", "B", 0.9);
		const ask = (url: string) =>
			createLlmEngine({
				name: "compat",
				target: { id: "compat", runtime: "openai-compat", url, defaultModel: "m" },
				runtime: openAICompatRuntime,
				model: null,
				mode: "auto",
				host,
			}).decide({ state, questions: { urgent: yesNo("Urgent?", "it is", "it is not") }, signal: signal() });
		const lenient = await started(answerFirst);
		strictEqual((await ask(lenient.url)).answers.urgent?.calibrated, true);
		strictEqual(lenient.requests[0]?.reasoning_effort, "none");
		deepStrictEqual(lenient.requests[0]?.chat_template_kwargs, { enable_thinking: false });
		const strict = await started((body) =>
			"chat_template_kwargs" in body || "reasoning_effort" in body
				? { status: 400, body: { error: "Unrecognized request argument" } }
				: answerFirst(body),
		);
		strictEqual((await ask(strict.url)).answers.urgent?.calibrated, true);
		// One refused warm request and its plain retry, then the second order goes plain at once.
		strictEqual(strict.requests.length, 3);
	});

	it("averages both option orders, so a position-biased model reads as undecided and flips", async () => {
		// Always favors letter A. Forward, A is `false`; reversed, A is `true`.
		const server = await started(() => firstToken("A", " B", 0.7));
		const engine = createLlmEngine({
			name: "local",
			target: llmTarget(server.url),
			runtime: llamacppRuntime,
			model: null,
			mode: "logprobs",
			host,
		});
		const reply = await engine.decide({
			state,
			questions: { urgent: yesNo("Urgent?", "it is", "it is not") },
			signal: signal(),
		});
		const answer = reply.answers.urgent;
		strictEqual(Math.abs((answer?.noul ?? 0) - 0.5) < 1e-9, true);
		strictEqual(answer?.flags?.includes("flip"), true);
		strictEqual(answer?.calibrated, true);
		strictEqual(reply.build.endsWith("#logprobs:p1"), true);
		strictEqual(server.requests.length, 2);
		const first = server.requests[0] ?? {};
		strictEqual(first.logprobs, true);
		strictEqual(first.max_tokens, 1);
		// The state leads the prompt so the server's prefix cache is shared across questions.
		strictEqual(((first.messages as Array<{ content: string }>)[1]?.content ?? "").startsWith("STATE:\n"), true);
	});

	it("drops to answer mode when the server returns no logprobs, and keeps a 3-vote answer uncalibrated", async () => {
		const server = await started((body, seen) => {
			if (body.logprobs === true) return { body: { choices: [{ message: { content: "B" } }] } };
			// Requests 2 to 4 vote for `true`; the last two votes are unreadable.
			const truth = options(body).find((option) => option.text.startsWith("true:"))?.letter ?? "A";
			return { body: { choices: [{ message: { content: seen <= 4 ? truth : "I cannot say" } }] } };
		});
		const engine = createLlmEngine({
			name: "local",
			target: llmTarget(server.url),
			runtime: llamacppRuntime,
			model: null,
			mode: "auto",
			host,
		});
		const reply = await engine.decide({
			state,
			questions: { urgent: yesNo("Urgent?", "it is", "it is not") },
			signal: signal(),
		});
		strictEqual(reply.answers.urgent?.noul, 1);
		strictEqual(reply.answers.urgent?.calibrated, false);
		strictEqual(reply.build.endsWith("#answer:p1"), true);
		// One warm request that found no logprobs, then five votes.
		strictEqual(server.requests.length, 6);
		strictEqual(reply.note, "downgraded: no-logprobs");
	});

	it("keeps the option order that arrived as a partial, uncalibrated answer, and flips a chronically partial binding to votes", async () => {
		const server = await started((body) => {
			if (body.logprobs !== true) {
				const truth = options(body).find((option) => option.text.startsWith("true:"))?.letter ?? "A";
				return { body: { choices: [{ message: { content: truth } }] } };
			}
			// Only the forward order, where A is `false`, comes back with logprobs.
			if (options(body)[0]?.text.startsWith("false:")) return firstToken("B", " A", 0.9);
			return { body: { choices: [{ message: { content: "A" } }] } };
		});
		const engine = createLlmEngine({
			name: "local",
			target: llmTarget(server.url),
			runtime: llamacppRuntime,
			model: null,
			mode: "auto",
			host,
		});
		const ask = () =>
			engine.decide({ state, questions: { urgent: yesNo("Urgent?", "it is", "it is not") }, signal: signal() });
		for (let call = 0; call < 3; call += 1) {
			const reply = await ask();
			const answer = reply.answers.urgent;
			strictEqual(Math.abs((answer?.noul ?? 0) - 0.9) < 1e-9, true);
			strictEqual(answer?.calibrated, false);
			strictEqual(answer?.flags?.includes("partial"), true);
			strictEqual(reply.note, "partial: 1 of 2 logprob orders unreadable");
			strictEqual(reply.build.endsWith("#logprobs:p1"), true);
		}
		// The missing order was never filled in with votes.
		strictEqual(server.requests.length, 6);
		strictEqual(
			server.requests.every((body) => body.logprobs === true),
			true,
		);
		const flipped = await ask();
		strictEqual(flipped.build.endsWith("#answer:p1"), true);
		strictEqual(flipped.note, "downgraded: partial-logprobs");
		strictEqual(flipped.answers.urgent?.calibrated, false);
		// Five votes and no warm probe: the verdict already said votes.
		strictEqual(server.requests.length, 11);
	});

	it("abstains when fewer than 3 votes are readable", async () => {
		const server = await started((body, seen) => {
			if (body.logprobs === true) return { body: { choices: [{ message: { content: "B" } }] } };
			return { body: { choices: [{ message: { content: seen <= 3 ? "B" : "no idea" } }] } };
		});
		const engine = createLlmEngine({
			name: "local",
			target: llmTarget(server.url),
			runtime: llamacppRuntime,
			model: null,
			mode: "auto",
			host,
		});
		await rejects(
			engine.decide({ state, questions: { urgent: yesNo("Urgent?", "it is", "it is not") }, signal: signal() }),
			/no usable answer/u,
		);
	});

	it("reads more than 26 options as a two-round tournament and flags it approximate", async () => {
		const server = await started((body) => {
			const all = options(body);
			const winner = all.find((option) => option.text.includes("billing"))?.letter ?? "A";
			return firstToken(winner, winner === "A" ? "B" : "A", 0.8);
		});
		const catalog: Record<string, string> = {};
		for (let index = 0; index < 60; index += 1) catalog[`opt${index}`] = index === 40 ? "billing" : `misc ${index}`;
		const engine = createLlmEngine({
			name: "local",
			target: llmTarget(server.url),
			runtime: llamacppRuntime,
			model: null,
			mode: "logprobs",
			host,
		});
		const reply = await engine.decide({ state, questions: { team: pick("Which?", catalog) }, signal: signal() });
		const answer = reply.answers.team;
		strictEqual(answer?.choice, "opt40");
		strictEqual(answer?.flags?.includes("approximate"), true);
		strictEqual(answer?.calibrated, false);
		strictEqual(Object.keys(answer?.probabilities ?? {}).length, 60);
		const total = Object.values(answer?.probabilities ?? {}).reduce((sum, mass) => sum + mass, 0);
		strictEqual(Math.abs(total - 1) < 1e-9, true);
		// Three groups of at most 25, both orders each, then the finalists in both orders.
		strictEqual(server.requests.length, 8);
		strictEqual(
			server.requests.every((body) => options(body).length <= 25),
			true,
		);
	});
});

describe("LLM engine in batch mode", () => {
	const questions: Record<string, Question> = {
		direct: yesNo("Direct?", "It is direct", "It is not"),
		shape: pick("Which shape?", { single: "One worker", parallel: "Several" }),
		only: pick("Only one?", { one: "The only option" }),
		missing: yesNo("Missing?", "Yes", "No"),
	};
	const batchEngine = (url: string, measuredBuilds?: (key: string) => ReadonlyArray<string>) =>
		createLlmEngine({
			name: "main",
			target: { id: "chat", runtime: "llamacpp", url } as TargetDescriptor,
			runtime: llamacppRuntime,
			model: "small",
			mode: "batch",
			host,
			...(measuredBuilds ? { measuredBuilds } : {}),
		});

	it("sends one schema-bound request and names the build by what the response reported", async () => {
		const server = await started(() => ({
			body: {
				model: "small-q4",
				system_fingerprint: "b1234",
				choices: [{ message: { content: '{"direct":"yes","shape":"parallel","missing":"unsure"}' } }],
				usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
			},
		}));
		const reply = await batchEngine(server.url).decide({ state, questions, signal: signal() });
		strictEqual(server.requests.length, 1);
		const body = server.requests[0] as { temperature: number; response_format: { schema: { required: string[] } } };
		strictEqual(body.temperature, 0);
		// The question with one option costs no words.
		deepStrictEqual(body.response_format.schema.required, ["direct", "shape", "missing"]);
		strictEqual(reply.build, `llm:llamacpp@${new URL(server.url).host}/small-q4~b1234#batch:b1`);
		strictEqual(reply.answers.direct?.noul, 1);
		strictEqual(reply.answers.direct?.calibrated, false);
		strictEqual(reply.answers.direct?.readout, "categorical");
		strictEqual(probability(reply.answers.direct), 1);
		strictEqual(reply.answers.shape?.choice, "parallel");
		strictEqual(reply.answers.only?.choice, "one");
		// The abstention is no answer, which no reader takes for a no.
		strictEqual(reply.answers.missing, undefined);
	});

	it("refuses a response that names no model and a reply with no JSON", async () => {
		const unnamed = await started(() => ({ body: { choices: [{ message: { content: '{"direct":"yes"}' } }] } }));
		await rejects(batchEngine(unnamed.url).decide({ state, questions, signal: signal() }), /no identity/u);
		const prose = await started(() => ({ body: { model: "small", choices: [{ message: { content: "I think yes" } }] } }));
		await rejects(batchEngine(prose.url).decide({ state, questions, signal: signal() }), /no JSON/u);
	});

	it("expects only the build a measurement names, so an unmeasured route is never called to learn it", async () => {
		const target = { id: "chat", runtime: "llamacpp", url: "http://h:1" } as TargetDescriptor;
		const key = batchRequestKey(target, "llamacpp", "small");
		const engine = batchEngine("http://h:1", (asked) => (asked === key ? ["measured-build"] : []));
		deepStrictEqual(engine.expectedBuilds(), ["measured-build"]);
		deepStrictEqual(batchEngine("http://h:1").expectedBuilds(), []);
	});
});

describe("System One calibration", () => {
	it("acts only on the measured build, and any other answering identity acts on nothing", async () => {
		let fingerprint = "b1";
		const server = await started(() => ({
			body: {
				model: "small",
				system_fingerprint: fingerprint,
				choices: [
					{ message: { content: '{"direct":"yes","dispatch":"no","shape":"single","architecture":"no","direction":"no"}' } },
				],
			},
		}));
		const target = { id: "chat", runtime: "llamacpp", url: server.url, defaultModel: "small" } as TargetDescriptor;
		const build = `llm:llamacpp@${new URL(server.url).host}/small~b1#batch:b1`;
		const so = createSystemOne({
			settings: () =>
				({
					targets: [target],
					systemOne: {
						use: null,
						engines: { main: { kind: "llm", target: "chat", mode: "batch" } },
						sites: { turn: "main" },
					},
				}) as never,
			providers: { getTarget: () => target, getRuntime: () => llamacppRuntime } as never,
			credentialsPresent: () => new Set<string>(),
			measurements: () => ({
				cuts: { [build]: { "turn.direct": 1 } },
				buildsFor: () => [build],
				deadlineMs: () => 2000,
			}),
		});
		const object = { task: "hi", previous: "", previousTask: "" };
		strictEqual(so.shadowed("turn"), false);
		strictEqual(so.measuredDeadlineMs("turn"), 2000);
		const measured = await so.run(TURN_SITE, object);
		strictEqual(measured?.fitted, true);
		strictEqual(typeof measured?.value.hints.scope, "string");
		fingerprint = "b2";
		const swapped = await so.run(TURN_SITE, object);
		strictEqual(swapped?.fitted, false);
		strictEqual(swapped?.value.hints.scope, null);
		strictEqual(so.shadowed("turn"), true);
	});

	const yes = (k: 1 | 2): KeySpec => ({ key: "direct", label: "direct", k, read: "yes" });
	const tally = (hits: number, positives: number, falseFires: number, negatives: number) => ({
		hits,
		positives,
		falseFires,
		negatives,
	});

	it("holds a key to its false-fire bar, its recall and adequate cases", () => {
		strictEqual(judgeFit(yes(1), tally(10, 20, 1, 40)), null);
		strictEqual(judgeFit(yes(1), tally(10, 20, 3, 40))?.includes("false fires"), true);
		strictEqual(judgeFit(yes(2), tally(10, 20, 1, 40))?.includes("false fires"), true);
		strictEqual(judgeFit(yes(1), tally(0, 20, 0, 40)), "no hit on fit");
		strictEqual(judgeHoldout(yes(1), tally(10, 20, 0, 40), tally(5, 8, 2, 48)), null);
		strictEqual(judgeHoldout(yes(1), tally(10, 20, 0, 40), tally(1, 8, 0, 48))?.includes("recall"), true);
		strictEqual(judgeHoldout(yes(1), tally(10, 20, 0, 40), tally(5, 5, 0, 12))?.includes("too few"), true);
	});

	it("gives a measured key a cut of 1 only under the site version it was measured on", () => {
		const measurement = (version: string): Measurement => ({
			v: 1,
			requestKey: "key",
			build: "build",
			measuredAt: "2026-11-03T00:00:00.000Z",
			policy: LABEL_POLICY_VERSION,
			sites: {
				turn: {
					version,
					caseSet: "sha",
					requests: 1,
					failed: 0,
					tokens: { input: 1, output: 1 },
					latencyMs: { p50: 1, p95: 1, max: 1 },
					deadlineMs: 700,
				},
			},
			keys: {
				"turn.direct": { pass: true, k: 1, fit: tally(1, 5, 0, 20) },
				"turn.dispatch": { pass: false, k: 1, fit: tally(0, 5, 9, 20), reason: "false fires" },
			},
		});
		const current = indexMeasurements([measurement(MEASURED_SITE_VERSIONS.turn as string)]);
		deepStrictEqual(current.cuts, { build: { "turn.direct": 1 } });
		deepStrictEqual(current.buildsFor("key"), ["build"]);
		strictEqual(current.deadlineMs("turn", ["build"]), 700);
		strictEqual(current.deadlineMs("turn", ["another"]), null);
		const reworded = indexMeasurements([measurement("turn-v0")]);
		deepStrictEqual(reworded.cuts, {});
		strictEqual(reworded.deadlineMs("turn", ["build"]), null);
	});
});
