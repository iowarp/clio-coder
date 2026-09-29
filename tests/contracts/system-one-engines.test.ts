import { rejects, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import systemOneRuntime from "../../src/domains/providers/runtimes/protocol/systemone.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { createLlmEngine } from "../../src/domains/system-one/engines/llm.js";
import { createSystemOneEngine } from "../../src/domains/system-one/engines/systemone.js";
import { pick, yesNo } from "../../src/domains/system-one/questions.js";
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
});

describe("LLM engine over an OpenAI-compatible chat server", () => {
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
