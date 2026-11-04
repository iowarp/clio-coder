import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { factKnownValue } from "../../src/core/telemetry/known.js";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { usageCallsFromJournal } from "../../src/domains/session/journal-usage.js";
import { createLlmEngine } from "../../src/domains/system-one/engines/llm.js";
import { yesNo } from "../../src/domains/system-one/questions.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createSideRequestAdmission } from "../../src/entry/side-request-admission.js";
import { runOutOfTurnRound } from "../../src/session-control/side-question.js";

/**
 * Every System One request to a priced target passes the host's admission,
 * and whatever usage it reports is charged to the session. The real admission
 * from the composition root runs over fake scheduling and telemetry, and
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
const flushers: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(flushers.splice(0).map((flush) => flush()));
	mock.restoreAll();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Charge {
	facts: NonNullable<ReturnType<typeof usageCallsFromJournal>[number]["facts"]>;
	pricedBy: string | undefined;
}

/** The host admission over a target priced at {@link PRICING}; `gate` runs inside each paid admission, numbered from 1. */
function ledger(target: TargetDescriptor, gate?: (admission: number) => Promise<void>) {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-system-one-paid-"));
	directories.push(stateDir);
	let admitted = 0;
	const scheduling: Pick<SchedulingContract, "admitPaidRequest"> = {
		async admitPaidRequest() {
			admitted += 1;
			await gate?.(admitted);
		},
	};
	const journals = createSessionJournals(stateDir, () => {
		throw new Error("journal unavailable");
	});
	flushers.push(journals.closeAll);
	const telemetry: Pick<TelemetryContract, "acquireTelemetrySession"> = {
		acquireTelemetrySession: journals.acquire,
	};
	const admit = createSideRequestAdmission({
		providers: { getTarget: (id) => (id === target.id ? target : null) },
		scheduling: scheduling as SchedulingContract,
		telemetry: telemetry as unknown as TelemetryContract,
		getCeilingUsd: () => 1,
		currentSession: () => "session-1",
		repoIdentity: () => "repo",
	});
	const calls = async () => {
		await journals.flush();
		return (await readCallJournal(telemetrySessionDirectory(stateDir, "session-1"))).records
			.map(({ record }) => record)
			.filter((record) => record.k === "call.settled");
	};
	return {
		admit,
		admitted: () => admitted,
		calls,
		/** Each journaled call's spend, as the read model's journal fold books it (#434). */
		async charges(): Promise<Charge[]> {
			const settled = await calls();
			return usageCallsFromJournal(settled).flatMap((call) => {
				const record = settled.find((row) => row.data.attemptId === call.attemptId);
				return call.facts ? [{ facts: call.facts, pricedBy: record?.data.pricing.pricedBy }] : [];
			});
		},
	};
}

function assertCharged(charge: Charge | undefined): void {
	ok(charge);
	const { facts } = charge;
	strictEqual(factKnownValue(facts.totalTokens), 105);
	strictEqual(factKnownValue(facts.usage.input), 40, "fresh input excludes the cached tokens");
	strictEqual(factKnownValue(facts.usage.cacheRead), 60);
	strictEqual(factKnownValue(facts.usage.output), 5);
	const usd = factKnownValue(facts.usd);
	ok(
		Math.abs(usd - EXPECTED_COST_USD) <= COST_TOLERANCE_USD,
		`cost ${usd} is not ${EXPECTED_COST_USD} within ${COST_TOLERANCE_USD}`,
	);
	// Declared target rates price the call as measured (#434).
	strictEqual(facts.usd.coverage.measured, 1);
	strictEqual(charge.pricedBy, "target-rates");
}

/**
 * A request that reported no usage is still recorded as one call with unknown
 * cost, so the session's spend shows it as missing instead of free (5996f82c6).
 */
function assertUnmetered(charge: Charge | undefined): void {
	ok(charge);
	strictEqual(charge.facts.totalTokens.unknownCount, 1);
	strictEqual(charge.facts.usd.unknownCount, 1);
	strictEqual(charge.facts.settled + charge.facts.settledNoUsage + charge.facts.sentUnsettled, 1);
	strictEqual(charge.pricedBy, "none");
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
	it("journals measured zero, missing usage, duplicate callbacks and admission cancellation separately", async () => {
		const { admit, calls } = ledger(paidTarget("llamacpp"));
		const signal = new AbortController().signal;
		const zero = await admit({ targetId: "paid", model: "m", signal });
		zero({ input: 0, output: 0, providerReported: true }, { callOutcome: "success" });
		zero(null);
		const missing = await admit({ targetId: "paid", model: "m", signal });
		missing(null, { callOutcome: "success" });
		await rejects(admit({ targetId: "paid", model: "m", signal: AbortSignal.abort() }));
		const settled = await calls();
		strictEqual(settled.length, 3);
		const measured = settled.find((row) => row.data.disposition === "settled");
		strictEqual(measured?.data.usage?.output.kind, "measured");
		strictEqual(measured?.data.usage?.cacheRead.kind, "unknown");
		strictEqual(
			measured?.data.usage?.input.kind,
			"unknown",
			"a prompt total without cache coverage is not uncached input",
		);
		strictEqual(settled.filter((row) => row.data.disposition === "settled_no_usage").length, 1);
		strictEqual(settled.find((row) => row.data.disposition === "never_sent")?.data.usage, null);
	});

	it("admits each HTTP request, the schema retry included, and charges the usage of a decision that failed", async () => {
		const target = paidTarget("llamacpp", "http://accounting.test");
		const { admit, charges: journaled, admitted, calls } = ledger(target);
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
			host: { ...host, admitLlmRequest: admit },
		});
		await rejects(
			engine.decide({ state: { task: "t" }, questions: urgent, signal: new AbortController().signal }),
			/names no model/u,
		);
		// Five votes; the first went out once with the schema and once without it.
		strictEqual(bodies.length, 6);
		ok(bodies[0]?.response_format !== undefined);
		strictEqual(admitted(), bodies.length, "every request was admitted, the retry included");
		// The rejected request reported no usage and is recorded as unmetered; every answered one is charged.
		const charges = await journaled();
		strictEqual(charges.length, 6);
		const unmetered = charges.filter((charge) => charge.pricedBy === "none");
		strictEqual(unmetered.length, 1);
		assertUnmetered(unmetered[0]);
		for (const charge of charges.filter((charge) => charge.pricedBy !== "none")) assertCharged(charge);
		const settled = await calls();
		strictEqual(settled.length, bodies.length);
		strictEqual(settled.filter((row) => row.data.disposition === "settled_no_usage").length, 1);
		strictEqual(settled.filter((row) => row.data.disposition === "settled").length, 5);
		ok(settled.every((row) => row.ctx.sessionId === "session-1" && row.ctx.agent.role === "system-one"));
	});

	it("admits each one-shot attempt, the schema retry included, and charges the answer's usage", async () => {
		const target = paidTarget("llamacpp", "http://one-shot.test");
		const { admit, charges: journaled, admitted } = ledger(target);
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
			thinkingLevel: "off",
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
		const charges = await journaled();
		strictEqual(charges.length, 2);
		assertUnmetered(charges[0]);
		assertCharged(charges[1]);
	});
});
