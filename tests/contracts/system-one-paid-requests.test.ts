import { match, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import type { UsageBreakdown } from "../../src/domains/observability/cost.js";
import anthropicRuntime from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { SessionCostCeilingError } from "../../src/domains/scheduling/budget.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { createLlmEngine } from "../../src/domains/system-one/engines/llm.js";
import type { OneShotPort } from "../../src/domains/system-one/index.js";
import { yesNo } from "../../src/domains/system-one/questions.js";
import { createRunner } from "../../src/domains/system-one/runner.js";
import type { DecisionEngine, DecisionRecord, SiteDefinition } from "../../src/domains/system-one/types.js";
import { createSystemOneRequestAdmission } from "../../src/entry/system-one-host.js";
import { runOutOfTurnRound } from "../../src/interactive/side-question.js";

/**
 * Every System One request to a priced target passes the host's admission,
 * and whatever usage it reports is charged to the session. The real admission
 * from the composition root runs over fake scheduling and observability, and
 * `fetch` is faked, so nothing reaches a network or the operator's state.
 */

type Body = Record<string, unknown>;

/** USD per million tokens; cached input is priced at a tenth of fresh input. */
const PRICING = { input: 3, output: 15, cacheRead: 0.3 };
/** 100 prompt tokens, 60 of them served from the provider's cache. */
const REPORTED = {
	prompt_tokens: 100,
	completion_tokens: 5,
	total_tokens: 105,
	prompt_tokens_details: { cached_tokens: 60 },
};
const EXPECTED_COST_USD = (40 * PRICING.input + 5 * PRICING.output + 60 * PRICING.cacheRead) / 1_000_000;
const COST_TOLERANCE_USD = 1e-12;
const SCHEMA_REJECTION = { error: { message: "response_format json_schema is not supported by this server" } };

function paidTarget(runtime: string, url?: string): TargetDescriptor {
	return { id: "paid", runtime, ...(url !== undefined ? { url } : {}), defaultModel: "m", pricing: PRICING };
}

const directories: string[] = [];
afterEach(() => {
	mock.restoreAll();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Charge {
	tokens: number;
	costUsd: number | undefined;
	breakdown: Partial<UsageBreakdown> | undefined;
	provenance: string | undefined;
	label: string | undefined;
}

/** The host admission over a target priced at {@link PRICING}; `gate` runs inside each paid admission, numbered from 1. */
function ledger(target: TargetDescriptor, gate?: (admission: number) => Promise<void>) {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-system-one-paid-"));
	directories.push(stateDir);
	const charges: Charge[] = [];
	let admitted = 0;
	const scheduling: Pick<SchedulingContract, "admitPaidRequest"> = {
		async admitPaidRequest() {
			admitted += 1;
			await gate?.(admitted);
		},
	};
	const observability: Pick<ObservabilityContract, "recordTokens"> = {
		recordTokens(_provider, _model, tokens, costUsd, breakdown, provenance, _facts, label) {
			charges.push({ tokens, costUsd, breakdown, provenance, label });
		},
	};
	const admit = createSystemOneRequestAdmission({
		providers: { getTarget: (id) => (id === target.id ? target : null) },
		scheduling: scheduling as SchedulingContract,
		observability: observability as ObservabilityContract,
		getCeilingUsd: () => 1,
		currentSession: () => "session-1",
		repoIdentity: () => null,
		stateDir,
	});
	const rows = (): unknown[] => {
		const file = join(stateDir, "usage", "out-of-turn.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
	};
	return { admit, charges, admitted: () => admitted, rows };
}

function assertCharged(charge: Charge | undefined): void {
	ok(charge);
	strictEqual(charge.tokens, 105);
	strictEqual(charge.breakdown?.input, 40, "fresh input excludes the cached tokens");
	strictEqual(charge.breakdown?.cacheRead, 60);
	strictEqual(charge.breakdown?.output, 5);
	ok(
		Math.abs((charge.costUsd ?? Number.NaN) - EXPECTED_COST_USD) <= COST_TOLERANCE_USD,
		`cost ${charge.costUsd} is not ${EXPECTED_COST_USD} within ${COST_TOLERANCE_USD}`,
	);
	strictEqual(charge.provenance, "known");
	strictEqual(charge.label, "system-one");
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(chunks: ReadonlyArray<unknown>): Response {
	const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeFetch(respond: (body: Body, call: number, signal: AbortSignal | undefined) => Promise<Response>): Body[] {
	const bodies: Body[] = [];
	mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Body;
		bodies.push(body);
		return respond(body, bodies.length, init?.signal ?? undefined);
	});
	return bodies;
}

const host = { auth: undefined, credentialsPresent: () => new Set<string>() };
const urgent = { urgent: yesNo("Urgent?", "it is", "it is not") };

describe("System One paid requests: admission and accounting", () => {
	it("admits each HTTP request, the schema retry included, and charges the usage of a decision that failed", async () => {
		const target = paidTarget("llamacpp", "http://accounting.test");
		const { admit, charges, admitted, rows } = ledger(target);
		const bodies = fakeFetch(async (body) =>
			body.response_format !== undefined
				? json(400, SCHEMA_REJECTION)
				: json(200, { choices: [{ message: { content: "I cannot say" } }], usage: REPORTED }),
		);
		const engine = createLlmEngine({
			name: "paid",
			target,
			runtime: llamacppRuntime,
			model: null,
			mode: "answer",
			host: { ...host, admitLlmRequest: admit },
		});
		await rejects(
			engine.decide({ state: { task: "t" }, questions: urgent, signal: new AbortController().signal }),
			/no usable answer/u,
		);
		// Five votes; the first went out once with the schema and once without it.
		strictEqual(bodies.length, 6);
		ok(bodies[0]?.response_format !== undefined);
		strictEqual(admitted(), bodies.length, "every request was admitted, the retry included");
		// The rejected request reported no usage; every answered one is charged.
		strictEqual(charges.length, 5);
		for (const charge of charges) assertCharged(charge);
		strictEqual(rows().length, 5, "each charge also lands in the out-of-turn usage store");
	});

	it("admits each one-shot attempt, the schema retry included, and charges the answer's usage", async () => {
		const target = paidTarget("llamacpp", "http://one-shot.test");
		const { admit, charges, admitted } = ledger(target);
		const bodies = fakeFetch(async (body) =>
			body.response_format !== undefined
				? json(400, SCHEMA_REJECTION)
				: sse([
						{ id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "A" }, finish_reason: null }] },
						{ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						{ id: "c", model: "m", choices: [], usage: REPORTED },
					]),
		);
		const signal = new AbortController().signal;
		let charge: Awaited<ReturnType<typeof admit>> | undefined;
		// The composition root's one-shot port wires these two hooks to the admission the same way.
		const result = await runOutOfTurnRound({
			model: llamacppRuntime.synthesizeModel(target, "m", null) as never,
			messages: [],
			systemPrompt: "Answer with one letter.",
			userText: "A) yes\nB) no",
			apiKey: "local",
			signal,
			runtimeId: "llamacpp",
			responseSchema: { name: "system_one_vote", schema: { type: "object", properties: { answer: { type: "string" } } } },
			beforeRequest: async () => {
				charge = await admit({ targetId: target.id, model: "m", signal });
			},
			onUsage: (usage) => charge?.(usage),
		});
		strictEqual(result.text, "A");
		strictEqual(bodies.length, 2);
		ok(bodies[0]?.response_format !== undefined && bodies[1]?.response_format === undefined);
		strictEqual(admitted(), 2, "both attempts were admitted");
		strictEqual(charges.length, 1);
		assertCharged(charges[0]);
	});
});

describe("System One paid requests: a ceiling refusal", () => {
	const site: SiteDefinition<string, string> = {
		id: "turn",
		version: "test-v1",
		deadlineMs: 10_000,
		state: (object) => ({ task: object }),
		questions: () => ({ ...urgent, blocked: yesNo("Blocked?", "it is", "it is not") }),
		read: () => "read",
		summarize: (value) => ({ value }),
	};

	/**
	 * The first request is the scheduler's warm one and runs alone. After it the
	 * second is admitted and hangs, and every later admission waits for that hang
	 * before the ceiling refuses it. The hung request ignores its abort and
	 * settles only on `release`, so the decision cannot be waiting on it.
	 */
	function hangThenRefuse() {
		let inFlight!: () => void;
		const hanging = new Promise<void>((resolve) => {
			inFlight = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const state = { hung: undefined as AbortSignal | undefined, released: false, sent: 0 };
		const gate = async (admission: number): Promise<void> => {
			if (admission <= 2) return;
			await hanging;
			throw new SessionCostCeilingError(1, 1);
		};
		const hang = async (signal: AbortSignal | undefined): Promise<void> => {
			state.hung = signal;
			inFlight();
			await released;
		};
		return {
			state,
			gate,
			hang,
			release: () => {
				state.released = true;
				release();
			},
		};
	}

	const wires: Array<[string, (scenario: ReturnType<typeof hangThenRefuse>) => DecisionEngine]> = [
		[
			"HTTP",
			(scenario) => {
				const target = paidTarget("llamacpp", "http://refusal.test");
				const { admit } = ledger(target, scenario.gate);
				fakeFetch(async (_body, call, signal) => {
					scenario.state.sent = call;
					if (call > 1) await scenario.hang(signal);
					return json(200, {
						choices: [
							{
								message: { content: "A" },
								logprobs: { content: [{ token: "A", logprob: 0, top_logprobs: [{ token: "A", logprob: 0 }] }] },
							},
						],
						usage: REPORTED,
					});
				});
				return createLlmEngine({
					name: "paid",
					target,
					runtime: llamacppRuntime,
					model: null,
					mode: "logprobs",
					host: { ...host, admitLlmRequest: admit },
				});
			},
		],
		[
			"one-shot",
			(scenario) => {
				const target = paidTarget("anthropic");
				const { admit } = ledger(target, scenario.gate);
				const oneShot: OneShotPort = async (request) => {
					const charge = await admit({ targetId: request.targetId, model: "m", signal: request.signal });
					scenario.state.sent += 1;
					if (scenario.state.sent > 1) await scenario.hang(request.signal);
					charge(null);
					return { text: "A" };
				};
				return createLlmEngine({
					name: "paid",
					target,
					runtime: anthropicRuntime,
					model: null,
					mode: "answer",
					host,
					oneShot,
				});
			},
		],
	];

	for (const [wire, build] of wires) {
		it(`fails the ${wire} decision without throwing and cancels the sibling request still in flight`, async () => {
			const scenario = hangThenRefuse();
			const engine = build(scenario);
			const records: DecisionRecord[] = [];
			const runner = createRunner({
				recorder: () => ({ decision: (record) => records.push(record), outcome: () => {} }),
				cutOverrides: () => ({}),
			});
			try {
				const verdict = await runner.run(
					{ routes: [{ name: "paid", engine, digest: `refusal-${wire}`, tasks: null }] },
					site,
					"task",
					{},
				);
				strictEqual(verdict, null);
				strictEqual(records.length, 1);
				strictEqual(records[0]?.outcome, "failed");
				match(records[0]?.error ?? "", /ceiling/u);
				strictEqual(scenario.state.sent, 2, "refused requests never went out");
				strictEqual(scenario.state.released, false, "the decision ended while its sibling still hung");
				strictEqual(scenario.state.hung?.aborted, true, "the hung sibling was cancelled");
			} finally {
				scenario.release();
			}
		});
	}
});
