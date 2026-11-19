import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import type { BudgetInspection } from "../../src/domains/context/budget/inspection.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { LOCAL_CONTEXT_OVERFLOW_PREFIX } from "../../src/engine/apis/output-budget.js";
import { sessionCurrentPath } from "../../src/engine/session.js";
import type { Model } from "../../src/engine/types.js";
import { createProductionAutoCompact } from "../../src/entry/orchestrator.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { replayCurrentSession } from "../../src/session-control/session-restore.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	registerClioApiProviders();
	env = await isolateClioEnv("overflow-fit-pin-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

/** drv-cf3a: a 32768-token window, four station logs of about 8.6 KB, then a 40 KB manual. */
const WINDOW = 32_768;
const OUTPUT_SAFETY = 4_096;
const body = (title: string, chars: number): string => {
	const head = `# ${title}\n\n`;
	let text = head;
	for (let line = 1; text.length < chars; line += 1)
		text += `- entry ${String(line).padStart(3, "0")}: reading ${(line * 7919) % 100_000} on sensor kernel mesh latency\n`;
	return text.slice(0, chars);
};
const FILES: Record<string, string> = {
	"notes/station-1.md": body("Station ALDER maintenance log", 8_643),
	"notes/station-2.md": body("Station BIRCH maintenance log", 8_520),
	"notes/station-3.md": body("Station CEDAR maintenance log", 8_610),
	"notes/station-4.md": body("Station DOGWOOD maintenance log", 8_655),
	"bignotes/manual.md": body("Operations manual", 40_008),
};
const READS = Object.keys(FILES);

const target = {
	id: "litellm",
	runtime: "litellm",
	url: "http://fixture.invalid:4000",
	cache: { retention: "none" as const },
};
const model = litellm.synthesizeModel(target, "cf3a-model", null) as Model<"openai-completions">;

interface WireRequest {
	maxTokens: number;
	chars: number;
	body: string;
}

/** One read per scripted path, then an answer; each request's `max_tokens` and size are kept. */
function transport(
	paths: ReadonlyArray<string>,
	{ recalls = 0, charsPerToken = 3.3 }: { recalls?: number; charsPerToken?: number } = {},
) {
	const requests: WireRequest[] = [];
	const called: string[] = [];
	let reads = 0;
	let recalled = false;
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		const raw = String(init?.body);
		const parsed = JSON.parse(raw) as { max_tokens?: number; max_completion_tokens?: number };
		requests.push({ maxTokens: parsed.max_completion_tokens ?? parsed.max_tokens ?? -1, chars: raw.length, body: raw });
		const encoder = new TextEncoder();
		const chunk = (payload: Record<string, unknown>) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
		const choice = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
			id: "fixture",
			object: "chat.completion.chunk",
			model: model.id,
			choices: [{ index: 0, delta, finish_reason }],
		});
		const next = paths[reads];
		// drv-f1r: after the reads, one batch recalls r1..rN, as Haiku did on the reruns.
		const batch = next === undefined && recalls > 0 && !recalled;
		if (batch) recalled = true;
		const tool = next !== undefined || batch;
		if (next !== undefined) reads += 1;
		if (next !== undefined) called.push(next);
		// A provider tokenizer near 3.3 characters a token, as drv-cf3a's measured about 27.2k for this request.
		const prompt = Math.ceil(raw.length / charsPerToken);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (tool)
					controller.enqueue(
						chunk(
							choice({
								role: "assistant",
								reasoning_content: `The next file in the operator's order is ${next}; one read, in full. `.repeat(4),
							}),
						),
					);
				controller.enqueue(
					chunk(
						choice(
							tool
								? {
										role: "assistant",
										tool_calls: batch
											? Array.from({ length: recalls }, (_, index) => ({
													index,
													id: `recall_${index + 1}`,
													type: "function",
													function: {
														name: ToolNames.Context,
														arguments: JSON.stringify({ scope: "recall", ref: `r${index + 1}` }),
													},
												}))
											: [
													{
														index: 0,
														id: `call_${called.length}`,
														type: "function",
														function: {
															name: "read",
															arguments: JSON.stringify({ path: next }),
														},
													},
												],
									}
								: { role: "assistant", content: "done" },
						),
					),
				);
				controller.enqueue(chunk(choice({}, tool ? "tool_calls" : "stop")));
				controller.enqueue(
					chunk({
						id: "fixture",
						object: "chat.completion.chunk",
						model: model.id,
						choices: [],
						usage: { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 },
					}),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requests, called };
}

function harness(
	wire: ReturnType<typeof transport>,
	files: Record<string, string> = FILES,
	{
		window = WINDOW,
		protectLastSteps = 3,
		api,
		recall = false,
	}: { window?: number; protectLastSteps?: number; api?: "copilot-sdk"; recall?: boolean } = {},
) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "low";
	settings.context.workingSet.protectLastSteps = protectLastSteps;
	settings.context.workingSet.target = 0.6;
	settings.context.compaction.threshold = 0.8;
	settings.targets = [
		{ ...target, defaultModel: model.id, capabilities: { contextWindow: window } },
	] as typeof settings.targets;
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: window, maxTokens: window },
		synthesizeModel: () => ({
			...model,
			...(api ? { api, provider: api } : {}),
			reasoning: true,
			input: ["text"],
			contextWindow: window,
			maxTokens: window,
		}),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	registry.register({
		name: ToolNames.Read,
		description: "Reads a fixture file in full",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
		}),
		baseActionClass: "read",
		// The production read's own ceiling, about 192 KB.
		metadata: {
			objective: "Read a fixture file.",
			uiLabel: "Read",
			resultSizePolicy: { kind: "bounded", maxBytes: 196_608 },
		},
		run: async (args) => {
			const text = files[String(args.path)] ?? "missing";
			if (typeof args.offset !== "number") return { kind: "ok", output: text };
			const start = args.offset - 1;
			return {
				kind: "ok",
				output: text
					.split("\n")
					.slice(start, start + Number(args.limit))
					.join("\n"),
			};
		},
	});
	let inspectLiveBudget: (() => BudgetInspection) | undefined;
	if (recall)
		registry.register({
			...createContextTool({
				getContextBudget: () => inspectLiveBudget?.() ?? { status: "unavailable", reason: "no loop yet" },
				session: {
					hasSession: () => session.current() !== null,
					readEntries: () => session.readEntries(),
					activeLeafTurnId: () => {
						const meta = session.current();
						return meta ? (session.leafId(meta.id) ?? undefined) : undefined;
					},
					appendEntry: (entry) => session.appendEntry(entry),
				},
			}),
			metadata: {
				objective: "Recall an evicted body.",
				uiLabel: "Context",
				resultSizePolicy: { kind: "bounded", maxBytes: 196_608 },
			},
		});
	const events: ChatLoopEvent[] = [];
	const piCounts: number[] = [];
	const published: Array<number | null> = [];
	let publishedInput: () => number | null = () => null;
	let summaries = 0;
	const providers = context.getContract("providers") as ProvidersContract;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set([target.id]),
		session,
		readSessionEntries: () => (session.current() ? session.readEntries() : []),
		toolRegistry: registry,
		bus: context.bus,
		autoCompact: createProductionAutoCompact(
			session,
			() => settings,
			providers,
			undefined,
			async () => {
				summaries += 1;
				return { text: syntheticCompactionSummary("checkpoint") };
			},
		),
		createAgent: (options) =>
			createEngineAgent({
				...options,
				transcriptStreamFn: (requestModel, requestContext, requestOptions) => {
					piCounts.push(requestContext.messages.reduce((sum, m) => sum + estimateMessageTokens(m as never), 0));
					published.push(publishedInput());
					return (
						options?.transcriptStreamFn ??
						(() => {
							throw new Error("no transcript stream");
						})
					)(requestModel, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args: Parameters<typeof globalThis.fetch>) => wire.fetch(...args),
					});
				},
			}),
	});
	publishedInput = () => loop.liveBudget().inputTokens;
	inspectLiveBudget = () => loop.inspectLiveBudget();
	loop.onEvent((event) => {
		events.push(event);
	});
	const notices = () =>
		events.flatMap((event) => (event.type === "notice" ? [(event as { text?: string }).text ?? ""] : []));
	const close = async () => {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	};
	return { settings, session, loop, events, notices, close, piCounts, published, summaries: () => summaries };
}

const A1_ASK = `Read ${READS.join(", ")} in order, one read per round, each in full, then say done.\n\n${"Read guidance for the station fixture. ".repeat(700)}`;
// drv-cf3a's b1 was a dispatch brief of about this size.
const B1_ASK = [
	"Call the dispatch tool exactly once with a fork-mode worker and this task.",
	'Step 1: call the context tool with scope "recall" and ref "r1" and copy its full result text verbatim into your report.',
	"Step 2: using only the read tool, one read call per round, each in full with no offset or limit, read bignotes/pump-1.md, then bignotes/pump-2.md, then bignotes/pump-3.md.",
	"Step 3: read notes/station-5.md with offset 1 and limit 30, then in the next round read notes/station-5.md again with exactly the same offset 1 and limit 30.",
	'Step 4: call the grep tool with pattern "ALDER" and path "notes/station-5.md", then in the next round call the grep tool again with the identical pattern and path.',
	"Step 5: report (a) the verbatim result of step 1, (b) the seal serial for pump 1, (c) the grep result. Do not write any files and do not call the artifact tool.",
	"Do not read files yourself. When the worker returns, reply with its full report verbatim.",
].join("\n");

/**
 * Every request the provider saw left the 4096-token output floor, the last one is the request Pi counts, and the
 * published view priced it on that same figure (CF-6 r2 item 2).
 */
function assertAdmitted(
	wire: ReturnType<typeof transport>,
	piCounts: ReadonlyArray<number>,
	published: ReadonlyArray<number | null>,
): number {
	for (const request of wire.requests) ok(request.maxTokens >= OUTPUT_SAFETY, `max_tokens ${request.maxTokens}`);
	const last = wire.requests.at(-1);
	ok(last);
	// Below the model ceiling the wire's max_tokens is the window less the input Pi's clamp read and its 4096 margin.
	const pinned = WINDOW - OUTPUT_SAFETY - last.maxTokens;
	// A4 pins max(fold count, Pi's count): after a fold the fold's carried anchor can be the larger of the two.
	ok(pinned >= (piCounts.at(-1) ?? Number.POSITIVE_INFINITY), `Pi's clamp read ${pinned}, below Pi's own count`);
	strictEqual(published.at(-1), pinned, "the published view showed the figure admission and Pi's clamp read");
	ok(pinned + 8_192 <= WINDOW, `admitted input ${pinned} fits the window with the reserve`);
	return pinned;
}

/**
 * S1 and then the one requireFit summary clear the manual's overflow (no protected read is cut, maintainer ruling),
 * and the request after it carries the manual in full.
 */
function assertSummaryFit(live: ReturnType<typeof harness>, wire: ReturnType<typeof transport>): void {
	strictEqual(live.summaries(), 1, "the requireFit summary ends the overflow");
	const next = wire.requests.at(-1)?.body ?? "";
	ok(next.includes(JSON.stringify(FILES["bignotes/manual.md"]).slice(1, -1)), "the next request carries the manual");
}

const refusals = (notices: ReadonlyArray<string>) =>
	notices.filter((text) => /refused this request|overflow persisted|exceeds the available context window/.test(text));

it("drv-cf3a D-A: an overflow fit admits the next request on the figure it fitted, live (bt-47)", {
	timeout: 30_000,
}, async () => {
	const wire = transport(READS);
	const live = harness(wire);
	try {
		await live.loop.submit(A1_ASK);
		await live.loop.whenSettled();
		deepStrictEqual(refusals(live.notices()), [], "no refusal and no retry");
		ok(live.notices().some((text) => /working set: \d+ items evicted/.test(text)));
		assertSummaryFit(live, wire);
		strictEqual(wire.requests.length, READS.length + 1);
		assertAdmitted(wire, live.piCounts, live.published);
		const entries = live.session.readEntries();
		strictEqual(entries.filter((entry) => JSON.stringify(entry).includes("admission_refused")).length, 0);
		const answer = entries.at(-2);
		strictEqual(answer?.kind === "message" ? (answer.payload as { text?: string }).text : undefined, "done");
		// b1: the next ask, refused twice on the old build, goes out on the same session.
		await live.loop.submit(B1_ASK);
		await live.loop.whenSettled();
		deepStrictEqual(refusals(live.notices()), [], "the next ask is not refused");
		strictEqual(wire.requests.length, READS.length + 2);
		for (const request of wire.requests) ok(request.maxTokens >= OUTPUT_SAFETY, `max_tokens ${request.maxTokens}`);
	} finally {
		await live.close();
	}
});

it("drv-cf3a A4 addendum: the format 7 ledger reopens after the overflow summary and sends the same next request (bt-47)", {
	timeout: 30_000,
}, async () => {
	const first = transport(READS);
	const live = harness(first);
	let id: string | undefined;
	try {
		await live.loop.submit(A1_ASK);
		await live.loop.whenSettled();
		assertSummaryFit(live, first);
		id = live.session.current()?.id;
	} finally {
		await live.close();
	}
	ok(id);
	const header = JSON.parse(readFileSync(sessionCurrentPath(id), "utf8").split("\n")[0] as string) as Row;
	strictEqual(header.version, 7);

	const wire = transport([]);
	const second = harness(wire);
	try {
		second.session.resume(id);
		replayCurrentSession(
			{ session: second.session, chat: second.loop, readEntries: () => second.session.readEntries() },
			id,
		);
		await second.loop.submit("Say done.");
		await second.loop.whenSettled();
		strictEqual(second.summaries(), 0);
		deepStrictEqual(refusals(second.notices()), []);
		strictEqual(wire.requests.length, 1, "one request, nothing refused or retried");
		const toolMessages = (body: string) =>
			(JSON.parse(body) as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === "tool");
		const before = toolMessages(first.requests.at(-1)?.body ?? "{}");
		const after = toolMessages(wire.requests[0]?.body ?? "{}");
		deepStrictEqual(after, before, "the resumed request replays the observations the live one sent");
	} finally {
		await second.close();
	}
});

type Row = Record<string, unknown>;

/**
 * What the pre-fix build appended after the manual read (drv-cf3a rows 22-36): the fold that fit on Clio's count,
 * its operation record, the admission refusal, one more thinking eviction and a second refusal, the failed turn's
 * outcome, then the next ask (b1) refused the same way twice. Written from that ledger, not by this build.
 */
function oldBuildTail(sliced: ReadonlyArray<Row>, sessionId: string, cwd: string): Row[] {
	const rows: Row[] = [];
	let clock = Date.parse(String(sliced.at(-1)?.timestamp)) + 1_000;
	let serial = 0;
	const next = (): { turnId: string; timestamp: string } => {
		clock += 37;
		serial += 1;
		return {
			turnId: `01a1ef3b-0000-7000-8000-${String(serial).padStart(12, "0")}`,
			timestamp: new Date(clock).toISOString(),
		};
	};
	const messages = sliced.filter((row) => row.kind === "message");
	const assistants = messages.filter((row) => row.role === "assistant");
	const results = messages.filter((row) => row.role === "tool_result");
	const userTurn = String(messages.find((row) => row.role === "user")?.turnId);
	let parent = String(sliced.at(-1)?.turnId);
	const thinking = (row: Row | undefined, tokensFreed: number) => ({
		ref: { entry: String(row?.turnId) },
		reason: "thinking_turn_closed",
		tokensFreed,
		marker: "",
	});
	const aged = (alias: string, index: number, tokensFreed: number) => {
		const pathName = READS[index] as string;
		const text = FILES[pathName] as string;
		const preview = text.replace(/\s+/g, " ").slice(0, 120);
		return {
			alias,
			ref: { entry: String(results[index]?.turnId) },
			reason: "age_horizon",
			tokensFreed,
			marker: `[evicted ref=${alias} reason=age_horizon tool=read path=${pathName} size=${text.split("\n").length} lines/${(text.length / 1024).toFixed(1)}KB recall=context(scope="recall", ref="${alias}") preview="${preview}"]`,
			contentHash: createHash("sha256").update(text).digest("hex"),
		};
	};
	const eviction = (evicted: ReadonlyArray<Row>, before: number, after: number) => {
		const id = next();
		rows.push({
			kind: "contextEviction",
			basis: "request-context",
			policyId: "structural-v2",
			trigger: "pressure",
			evicted,
			tokensBefore: before,
			tokensAfter: after,
			pressureBefore: before / 26_998,
			snapshotIdBefore: `snap-${clock}-${serial}-cf3a`,
			parentTurnId: parent,
			...id,
		});
		rows.push({
			kind: "custom",
			customType: "clio-coder.context-operation",
			parentTurnId: parent,
			data: {
				kind: "compaction",
				sessionId,
				cwd,
				origin: "automatic",
				reason: "request overflow",
				version: 1,
				id: `op-${serial}`,
				startedAt: id.timestamp,
				facts: [{ kind: "omitted", unit: "observations", count: evicted.length }],
				tokens: { before, after, basis: "runtime-estimate" },
				warnings: [],
				outcome: "completed",
				elapsedMs: 38,
			},
			...next(),
		});
	};
	const failure = {
		invoked: false,
		stage: "admission",
		httpStatus: null,
		errorClass: "admission_refused",
		retryAttempts: 0,
	};
	const refusal = (leave: number, input: number) => {
		const id = next();
		rows.push({
			kind: "message",
			parentTurnId: parent,
			role: "assistant",
			payload: {
				text: "",
				content: [],
				responseModelIdObservation: { state: "not-observed" },
				usage: null,
				callId: `cal_${id.turnId}`,
				attemptId: `att_${id.turnId}`,
				callInvoked: false,
				failure,
				api: "openai-completions",
				provider: "litellm",
				model: model.id,
				stopReason: "error",
				errorMessage: `Context window exceeded before the provider call: the request would leave ${leave} output tokens of a ${WINDOW}-token window (estimated input ${input}), below the usable minimum of 4096.\n\nLiteLLM route '${model.id}' on target 'litellm' failed. Clio did not substitute another model; select a different route with /model, then resend.`,
				failureRoute: {
					targetId: "litellm",
					url: target.url,
					stage: "admission",
					errorClass: "admission_refused",
					partialReply: false,
				},
			},
			...id,
		});
		parent = id.turnId;
	};
	const outcome = (turnId: string, turnIndex: number, toolCalls: number) =>
		rows.push({
			kind: "custom",
			customType: "turnOutcome",
			parentTurnId: parent,
			display: false,
			data: {
				version: 1,
				turnId,
				turnIndex,
				continuation: false,
				control: null,
				coordinator: {
					toolCalls,
					byTool: toolCalls > 0 ? { read: toolCalls } : {},
					readOnlyCallsBeforeFirstDispatch: toolCalls,
					dispatches: [],
					duplicateDispatch: false,
				},
				failure,
				stopReason: "error",
			},
			...next(),
		});

	// a1: rows 22-28.
	eviction(
		[thinking(assistants[1], 96), thinking(assistants[0], 127), aged("r1", 1, 2887), aged("r2", 0, 2910)],
		30_311,
		24_291,
	);
	refusal(3_013, 22_651);
	eviction([thinking(assistants[2], 26)], 24_291, 24_265);
	refusal(3_043, 22_651);
	outcome(userTurn, 0, READS.length);
	// b1: rows 29-36.
	const b1 = next();
	rows.push({
		kind: "message",
		parentTurnId: parent,
		role: "user",
		payload: { text: B1_ASK, operatorText: B1_ASK },
		...b1,
	});
	parent = b1.turnId;
	refusal(2_324, 23_271);
	eviction([thinking(assistants[4], 10), thinking(assistants[3], 17)], 23_271, 23_244);
	refusal(2_355, 23_244);
	outcome(b1.turnId, 1, 0);
	return rows;
}

it("drv-cf3a D-A: a session the old build wedged resumes and is admitted on the fold's figure (bt-47)", {
	timeout: 30_000,
}, async () => {
	// The rows up to the manual read are what either build writes; the run past it is replaced by the old build's.
	const first = harness(transport(READS));
	let id: string | undefined;
	try {
		await first.loop.submit(A1_ASK);
		await first.loop.whenSettled();
		id = first.session.current()?.id;
	} finally {
		await first.close();
	}
	ok(id);
	const file = sessionCurrentPath(id);
	const lines = readFileSync(file, "utf8").trim().split("\n");
	const header = JSON.parse(lines[0] as string) as Row;
	const rows = lines.slice(1).map((line) => JSON.parse(line) as Row);
	const manual = rows.findIndex(
		(row) => row.role === "tool_result" && (row.payload as { toolCallId?: string }).toolCallId === `call_${READS.length}`,
	);
	ok(manual > 0);
	const sliced = rows.slice(0, manual + 1);
	const tail = oldBuildTail(sliced, id, String(header.cwd));
	writeFileSync(file, `${[header, ...sliced, ...tail].map((row) => JSON.stringify(row)).join("\n")}\n`);

	const wire = transport([]);
	const second = harness(wire);
	try {
		second.session.resume(id);
		replayCurrentSession(
			{ session: second.session, chat: second.loop, readEntries: () => second.session.readEntries() },
			id,
		);
		await second.loop.submit("Reply with the first entry of station BIRCH, then say done.");
		await second.loop.whenSettled();
		deepStrictEqual(refusals(second.notices()), [], "the resumed turn is not refused");
		ok(
			second.notices().some((text) => /working set: \d+ items? evicted/.test(text)),
			"the overflow fold ran before the request",
		);
		strictEqual(wire.requests.length, 1, "one request, no retry");
		assertAdmitted(wire, second.piCounts, second.published);
		const added = second.session.readEntries().slice(sliced.length + tail.length);
		strictEqual(added.filter((entry) => JSON.stringify(entry).includes("admission_refused")).length, 0);
	} finally {
		await second.close();
	}
});

// Astra #1: at 65,536 with a 32,768 ceiling, 160,000 characters cost 40,000 tokens in Clio and 45,715 in Pi. At
// Pi's count the wire reserve is 15,725 and the request fits; the reserve read at Clio's count (21,440) refused it.
for (const via of ["submit", "post-tool guard"] as const) {
	it(`Astra #1: the ${via} fit check resolves the output reserve at the count it chose`, {
		timeout: 30_000,
	}, async () => {
		const text = body("Field survey", 160_000);
		const wire = transport(via === "submit" ? [] : ["notes/survey.md"]);
		const live = harness(wire, { "notes/survey.md": text }, { window: 65_536 });
		live.settings.context.toolResultMaxBytes = 262_144;
		try {
			await live.loop.submit(via === "submit" ? text : "Read notes/survey.md in full, then say done.");
			await live.loop.whenSettled();
			deepStrictEqual(refusals(live.notices()), []);
			strictEqual(live.summaries(), 0, "nothing compacts a request that fits");
			strictEqual(wire.requests.length, via === "submit" ? 1 : 2);
			ok(wire.requests.at(-1)?.body.includes(JSON.stringify(text).slice(1, -1)), "the last request carries the text");
		} finally {
			await live.close();
		}
	});
}

// bt3 drv-rv5: mini measured 36,228 input for turn 1's prose (about 5 characters a token); the resumed turn added
// 51,872 characters and was refused at 65,768 + 12,288, though the anchored request (about 50k) fit 65,536.
it("bt3 drv-rv5: a resumed turn is admitted on the route's measured anchor, not chars/3.5 over the whole request", {
	timeout: 30_000,
}, async () => {
	const prose = (title: string, chars: number) => {
		let text = `${title}. `;
		while (text.length < chars) text += "The survey crew logged the pump hall readings and noted every valve in order. ";
		return text.slice(0, chars);
	};
	const first = transport([], { charsPerToken: 5 });
	const live = harness(first, FILES, { window: 65_536 });
	let id: string | undefined;
	try {
		await live.loop.submit(prose("Field notes part one", 142_000));
		await live.loop.whenSettled();
		deepStrictEqual(refusals(live.notices()), []);
		id = live.session.current()?.id;
	} finally {
		await live.close();
	}
	ok(id);
	const wire = transport([], { charsPerToken: 5 });
	const second = harness(wire, FILES, { window: 65_536 });
	try {
		second.session.resume(id);
		replayCurrentSession(
			{ session: second.session, chat: second.loop, readEntries: () => second.session.readEntries() },
			id,
		);
		await second.loop.submit(prose("Field notes part two", 51_872));
		await second.loop.whenSettled();
		deepStrictEqual(refusals(second.notices()), [], "the resumed turn is not refused");
		strictEqual(second.summaries(), 0, "nothing compacts a request that fits");
		strictEqual(wire.requests.length, 1, "the request goes out");
		ok((wire.requests[0]?.maxTokens ?? 0) >= OUTPUT_SAFETY, `max_tokens ${wire.requests[0]?.maxTokens}`);
	} finally {
		await second.close();
	}
});

it("drv-cf3a D-A: a protected read larger than the window ends the turn once, naming it, and the session goes on (bt-47)", {
	timeout: 30_000,
}, async () => {
	const files = { ...FILES, "bignotes/manual.md": body("Operations manual", 140_000) };
	const wire = transport(["notes/station-1.md", "bignotes/manual.md"]);
	const live = harness(wire, files);
	// The default 64 KB result cap would shape the read below the window; an operator can raise it.
	live.settings.context.toolResultMaxBytes = 262_144;
	try {
		await live.loop.submit("Read notes/station-1.md, then bignotes/manual.md in full, then say done.");
		await live.loop.whenSettled();
		const stops = live.events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error"
				? [event.message.errorMessage ?? ""]
				: [],
		);
		strictEqual(stops.length, 1, "one stop, no retry");
		ok(
			/^\[Clio Coder\] This turn stopped: .*The read bignotes\/manual\.md result alone is 140000 characters/.test(
				stops[0] ?? "",
			),
			stops[0],
		);
		strictEqual(wire.requests.length, 2, "the oversized request never reaches the provider, and nothing retries it");
		deepStrictEqual(refusals(live.notices()), []);

		await live.loop.submit("Say done.");
		await live.loop.whenSettled();
		strictEqual(wire.requests.length, 3, "the next ask reaches the provider");
		for (const request of wire.requests) ok(request.maxTokens >= OUTPUT_SAFETY);
		const answer = [...live.events]
			.reverse()
			.find((event) => event.type === "message_end" && event.message.role === "assistant");
		strictEqual(
			answer?.type === "message_end" ? (answer.message as { stopReason?: string }).stopReason : undefined,
			"stop",
		);
	} finally {
		await live.close();
	}
});

/**
 * drv-m3a: one turn at a 28000-token window reads 8 or 12 design notes of about 8.1 KB, one per round, every read
 * inside the protected window (protectLastSteps 8). The ask's guidance stands in for the copilot route's system
 * prompt and tools, so the automatic pass first sees about 16.9k, as the run did. At 64000 the notes are 1.5 times
 * as large and the guidance longer, so the reads cross the fit line mid-turn there too.
 */
const M3A_SIZES = [8_102, 8_066, 8_010, 8_097, 8_006, 8_104, 8_109, 8_053, 8_084, 8_133, 8_086, 8_173];
const M3A_PAD = 1_550;
const M3A_LARGE = { pad: 2_700, scale: 1.5 };
// The 12-read rows are drv-f1's F1b shape. The drv-f1r rows rerun both, and after the reads the model recalls r1..rN
// in one batch, as Haiku did on r8b and r12b. A summary leaves no rN alias, so these protect one step and S1 mints them.
for (const [count, recalls, window] of [
	[8, 0, 28_000],
	[12, 0, 28_000],
	[8, 4, 64_000],
	[12, 9, 64_000],
] as const) {
	const small = window < 52_428;
	const protectLastSteps = recalls > 0 ? 1 : 8;
	const title =
		recalls > 0
			? `drv-f1r: a ${count}-read turn at ${window} then one batch of ${recalls} recalls readmits only what fits`
			: `drv-f1x: a ${count}-read turn at ${window} cuts no protected read`;
	it(`${title} (bt-47)`, {
		timeout: 60_000,
	}, async () => {
		const files: Record<string, string> = {};
		M3A_SIZES.slice(0, count).forEach((size, index) => {
			files[`docs/part${index + 1}.md`] = body(
				`Design note part ${index + 1}`,
				small ? size : Math.round(size * M3A_LARGE.scale),
			);
		});
		const reads = Object.keys(files);
		const wire = transport(reads, { recalls });
		const live = harness(wire, files, { window, protectLastSteps, recall: recalls > 0 });
		try {
			await live.loop.submit(
				`Read ${reads.join(", ")} in order, one read per round, each in full, then say done.\n\n${"Read guidance for the design notes. ".repeat(small ? M3A_PAD : M3A_LARGE.pad)}`,
			);
			await live.loop.whenSettled();
			// cf-x6 r2's m3a residual: an unpinned request admitted at 20310 met Pi's anchor clamp at 20575, whose answer
			// room fell below the usable floor; the local refusal's reactive retry paid one summary per row. Admission now
			// hands Pi's clamp its own figure on every main request (CF-6 r2 item 2).
			const refusals = live.events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					(event.message.errorMessage ?? "").startsWith(LOCAL_CONTEXT_OVERFLOW_PREFIX),
			);
			strictEqual(refusals.length, 0, "no local context-window refusal");
			const guardStops = [
				...live.notices(),
				...live.events.flatMap((event) =>
					event.type === "message_end" && event.message.role === "assistant" ? [event.message.errorMessage ?? ""] : [],
				),
			].filter((text) => text.includes("post-tool context guard"));
			deepStrictEqual(guardStops, [], "no guard stop");
			deepStrictEqual([...new Set(wire.called)], reads, "every part read, in order");
			strictEqual(
				wire.requests.length,
				wire.called.length + (recalls > 0 ? 2 : 1),
				"every read and the recall batch answered, then the answer",
			);
			const entries = live.session.readEntries();
			// Protected reads overflow into the requireFit summary; the oversized-read stop never fires on these reads.
			if (protectLastSteps === 8) ok(live.summaries() > 0, "the requireFit summary clears each overflow");
			strictEqual(
				entries.filter((entry) => entry.kind === "message" && entry.role === "tool_result").length,
				count + recalls,
			);
			if (recalls > 0) {
				// drv-f1r: the batch readmitted about 2020 tokens a recall past the fit line, and the guard stopped the run.
				const results = entries.flatMap((entry) =>
					entry.kind === "message" &&
					entry.role === "tool_result" &&
					String((entry.payload as { toolCallId?: string }).toolCallId).startsWith("recall_")
						? [JSON.stringify(entry.payload)]
						: [],
				);
				strictEqual(results.length, recalls);
				const stubbed = results.filter((text) => text.includes("not recalled: no room in the context window now"));
				ok(stubbed.length > 0, "the recalls past the room return the stub");
				strictEqual(
					entries.filter((entry) => entry.kind === "contextRecall").length,
					recalls - stubbed.length,
					"a stubbed recall appends no contextRecall entry",
				);
				// Siblings share one room: no summary follows the batch, and the next request carries every admitted body.
				const last =
					entries.length -
					1 -
					[...entries]
						.reverse()
						.findIndex(
							(entry) =>
								entry.kind === "message" &&
								entry.role === "tool_result" &&
								String((entry.payload as { toolCallId?: string }).toolCallId).startsWith("recall_"),
						);
				ok(!entries.slice(last).some((entry) => entry.kind === "compactionSummary"), "the admitted recalls fit");
				const sent = (
					JSON.parse(wire.requests.at(-1)?.body ?? "{}") as {
						messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>;
					}
				).messages.filter((message) => message.role === "tool" && message.tool_call_id?.startsWith("recall_"));
				strictEqual(sent.length, recalls);
				strictEqual(
					sent.filter((message) => !/not recalled|^\[evicted/.test(JSON.stringify(message.content).slice(1))).length,
					recalls - stubbed.length,
					"the next request carries every admitted body",
				);
			}
			const answer = entries.at(-2);
			strictEqual(answer?.kind === "message" ? (answer.payload as { text?: string }).text : undefined, "done");
		} finally {
			await live.close();
		}
	});
}

/**
 * A stand-in for @github/copilot-sdk whose sessions keep, as the live server does, every prompt and tool result
 * they were handed. Each model call reports that held history at 3.3 characters a token, reads the next path of
 * the script and ends with "done"; `__clioCopilotHeld` records what each call saw.
 */
const HELD_HISTORY_SDK = String.raw`
import { EventEmitter } from "node:events";
const state = (globalThis.__clioCopilotHeld ??= { calls: [], script: [], next: 0 });
class Session {
	constructor(config) {
		this.sessionId = config.sessionId;
		this.config = config;
		this.handlers = new Set();
		this.tools = new Map((config.tools ?? []).map((tool) => [tool.name, tool]));
		this.held = config.systemMessage?.content ?? "";
		this.held += JSON.stringify((config.tools ?? []).map((tool) => [tool.name, tool.description, tool.parameters]));
		this.rpc = { usage: { getMetrics: async () => ({ totalPremiumRequestCost: 0, totalNanoAiu: 0 }) } };
	}
	on(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
	emit(type, data) { for (const handler of [...this.handlers]) handler({ type, data, id: "e", parentId: null, timestamp: "" }); }
	async setModel() {}
	async setTools(tools) { this.tools = new Map(tools.map((tool) => [tool.name, tool])); }
	async abort() {}
	async disconnect() {}
	async send(options) {
		this.held += options.prompt;
		setTimeout(() => void this.run(), 0);
		return "m";
	}
	async run() {
		for (;;) {
			state.calls.push({ sessionId: this.sessionId, held: this.held });
			const inputTokens = Math.ceil(this.held.length / 3.3);
			const path = state.script[state.next];
			this.emit("assistant.usage", { model: "m3a", inputTokens, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
			if (path === undefined) {
				this.emit("assistant.message", { messageId: "done", content: "done" });
				this.emit("session.idle", {});
				return;
			}
			state.next += 1;
			const toolCallId = "call_" + state.next;
			this.emit("assistant.message", { messageId: toolCallId, content: "", toolRequests: [{ toolCallId, name: "read", arguments: { path } }] });
			let result;
			try {
				result = await this.tools.get("read").handler({ path }, { toolCallId, sessionId: this.sessionId, toolName: "read", arguments: { path } });
			} catch {
				return;
			}
			this.held += result.textResultForLlm;
		}
	}
}
export class CopilotClient {
	constructor(options) {
		this.options = options;
		this.state = "disconnected";
		// The private 1.0.26 layout Clio's client watches.
		const handle = () => Object.assign(new EventEmitter(), { ref() {}, unref() {} });
		this.cliProcess = Object.assign(handle(), { stdin: handle(), stdout: handle(), stderr: handle() });
		this.cliStartTimeout = null;
	}
	async start() { this.state = "connected"; }
	async stop() { this.state = "disconnected"; return []; }
	async forceStop() { this.state = "disconnected"; }
	async getAuthStatus() { return { isAuthenticated: true, login: "octo", host: "https://github.com" }; }
	async listModels() { return []; }
	async deleteSession() {}
	async createSession(config) { return new Session(config); }
	async resumeSession() { throw new Error("Session not found"); }
}
`;

it("drv-r4a: on copilot-sdk evicted reads leave the provider's held input, and the 12-read turn finishes (bt-47)", {
	timeout: 60_000,
}, async () => {
	const dir = path.join(
		resolveClioDirs().data,
		"components",
		"copilot-sdk",
		"1.0.26",
		"node_modules",
		"@github",
		"copilot-sdk",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "@github/copilot-sdk", type: "module", exports: "./index.js" }),
	);
	writeFileSync(path.join(dir, "index.js"), HELD_HISTORY_SDK);
	const files: Record<string, string> = {};
	M3A_SIZES.forEach((size, index) => {
		files[`docs/part${index + 1}.md`] = body(`Design note part ${index + 1}`, Math.round(size * M3A_LARGE.scale));
	});
	const reads = Object.keys(files);
	const held = { calls: [] as Array<{ held: string }>, script: reads, next: 0 };
	(globalThis as { __clioCopilotHeld?: unknown }).__clioCopilotHeld = held;
	// With one protected step the age horizon evicts the older reads, and the fold fits the turn without a summary.
	const live = harness(transport([]), files, { window: 64_000, protectLastSteps: 1, api: "copilot-sdk" });
	try {
		await live.loop.submit(
			`Read ${reads.join(", ")} in order, one read per round, each in full, then say done.\n\n${"Read guidance for the design notes. ".repeat(M3A_LARGE.pad)}`,
		);
		await live.loop.whenSettled();
		ok(!live.notices().some((text) => text.includes("post-tool context guard")), "no guard stop");
		strictEqual(live.summaries(), 0, "the provider honored every eviction, so no overflow summary was paid");
		strictEqual(held.calls.length, reads.length + 1, "every read answered, then the answer");
		const entries = live.session.readEntries();
		const answer = entries.at(-2);
		strictEqual(answer?.kind === "message" ? (answer.payload as { text?: string }).text : undefined, "done");
		const callIds = new Map(
			entries.flatMap((entry) =>
				entry.kind === "message" && entry.role === "tool_result"
					? [[entry.turnId, String((entry.payload as { toolCallId?: string }).toolCallId)] as const]
					: [],
			),
		);
		const taken = entries
			.flatMap((entry) => (entry.kind === "contextEviction" ? entry.evicted : []))
			.filter((item) => callIds.has(item.ref.entry));
		ok(taken.length > 0);
		// What the Copilot server holds for the answer has none of the bodies the working set took out.
		const last = held.calls.at(-1)?.held ?? "";
		for (const item of taken) {
			const part = String(callIds.get(item.ref.entry)).replace("call_", "");
			ok(!last.includes(`# Design note part ${part}\n`), `part ${part} (${item.reason}) is still held`);
		}
	} finally {
		await live.close();
	}
});
