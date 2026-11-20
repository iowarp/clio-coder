import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newCallId } from "../../src/core/telemetry/ids.js";
import { factKnownValue } from "../../src/core/telemetry/known.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { createUnbackedWorkerClaimRegistration } from "../../src/domains/middleware/dispatch-nudge.js";
import { createExplorationNudgeRegistrations, createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { callChangesTree } from "../../src/domains/safety/check-classifier.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import type { TurnOutcomeRecord } from "../../src/domains/turn-control/index.js";
import { callRepeatsAsRead } from "../../src/engine/loop-guard.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createThrashOutcome } from "../../src/engine/worker-thrash-outcome.js";
import type { CreateChatLoopDeps } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createTurnOutcomeCollector } from "../../src/session-control/turn-outcome-collector.js";
import { ContinuationState, type TurnQueuesState } from "../../src/session-control/turn-state.js";
import { checkTurnStateOwnership } from "../boundaries/check-boundaries.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

for (const continuation of [false, true])
	it(
		continuation
			? "a collect continuation persists the controller block in its user turn"
			: "a faux tool-free turn writes one outcome after assessment",
		async () => {
			const scratch = await isolateClioEnv("clio-coder-turn-outcome-");
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.chat.prewarm = false;
			const context = dispatchStubContext({ settings });
			const target = settings.targets[0];
			ok(target);
			settings.chat.target = target.id;
			settings.chat.model = target.defaultModel ?? "gpt-4o";
			const entries: SessionEntry[] = [];
			let leaf: string | null = null;
			const session = {
				current: () => ({ id: "outcome-session", cwd: scratch.dir, cwdHash: "outcome-repo" }),
				tree: () => ({ leafId: leaf }),
				leafId: () => leaf,
				append(turn: TurnInput) {
					const id = continuation ? (turn.id ?? `turn-${entries.length + 1}`) : `turn-${entries.length + 1}`;
					leaf = id;
					entries.push({
						kind: "message",
						turnId: id,
						parentTurnId: turn.parentId,
						timestamp: new Date().toISOString(),
						role: turn.kind,
						payload: turn.payload,
					} as SessionEntry);
					return { id };
				},
				appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
					const row = {
						...entry,
						turnId: `entry-${entries.length + 1}`,
						timestamp: new Date().toISOString(),
					} as SessionEntry;
					entries.push(row);
					return row;
				},
			} as unknown as SessionContract;
			const collector = createTurnOutcomeCollector();
			const middleware = createMiddlewareBundle({
				registrations: [
					collector,
					{
						id: "fixture.completion",
						description: "record a settled completion",
						hooks: ["turn_end"],
						evaluate(input) {
							collector.recordCompletion(input.turnId ?? null, "ok", 0, []);
							return [];
						},
					},
				],
			}).contract;
			const journals = createSessionJournals(clioStateDir(), () => {
				throw new Error("fixture journal unavailable");
			});
			const loop = createChatLoop({
				getSettings: () => settings,
				providers: context.getContract("providers") as ProvidersContract,
				knownTargets: () => new Set([target.id]),
				session,
				readSessionEntries: () => entries,
				middleware,
				turnOutcomeCollector: collector,
				...(continuation
					? {
							turnControl: {
								async run(input) {
									const block = "[Collected]\nfinished batch results";
									return {
										block,
										record: {
											version: 1,
											turnId: input.userTurnId,
											factsDigest: "fixture",
											decision: { kind: "collect", batchIds: ["finished"] },
											decisionHash: "fixture",
											executed: { runIds: ["run-finished"], blockChars: block.length, durationMs: 1 },
										},
									};
								},
							} as NonNullable<CreateChatLoopDeps["turnControl"]>,
						}
					: {}),
				telemetry: {
					acquireTelemetrySession: journals.acquire,
				} as unknown as TelemetryContract,
				createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
					// The generic dispatch stub omits the API; a journal target needs the scripted protocol (#434).
					Object.assign(options?.initialState?.model ?? {}, { api: "openai-responses" });
					let listener: (event: AgentEvent) => unknown = () => {};
					const state = { ...options?.initialState, messages: [] as AgentMessage[] };
					return {
						requestCorrelationId: () => undefined,
						agent: {
							state,
							subscribe: (next: typeof listener) => {
								listener = next;
								return () => {};
							},
							abort() {},
							async prompt() {
								await listener({ type: "agent_start" });
								await listener({ type: "turn_start" });
								const message = {
									role: "assistant",
									content: [{ type: "text", text: "Which approach?" }],
									stopReason: "stop",
									timestamp: Date.now(),
									usage: {
										input: 7,
										output: 5,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 12,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
								} as AgentMessage;
								state.messages.push(message);
								await listener({ type: "message_end", message });
								await listener({ type: "agent_end", messages: [message] });
							},
						},
					};
				}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
			});
			try {
				await loop.submit("Summarize the fixture", { requestContinuation: continuation });
				const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), "outcome-session"));
				const calls = journal.records.filter(({ record }) => record.k === "call.settled");
				strictEqual(calls.length, 1, JSON.stringify(journal));
				const call = calls[0]?.record;
				ok(call?.k === "call.settled");
				strictEqual(call.data.disposition, "settled");
				deepStrictEqual(call.data.usage?.input, { kind: "measured", value: 7, source: "provider" });
				const assistant = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
				ok(assistant?.kind === "message");
				strictEqual((assistant.payload as { callId: string }).callId, call.data.callId);
				if (continuation) {
					const user = entries.find((entry) => entry.kind === "message" && entry.role === "user");
					ok(user?.kind === "message");
					ok(JSON.stringify(user.payload).includes("[Collected]"));
					strictEqual((user.payload as { operatorText: string }).operatorText, "Summarize the fixture");
				}
				const rows = entries.filter((entry) => entry.kind === "custom" && entry.customType === "turnOutcome");
				strictEqual(rows.length, 1);
				const row = rows[0];
				ok(row?.kind === "custom");
				const outcome = row.data as TurnOutcomeRecord;
				strictEqual(
					outcome.turnId,
					continuation ? entries.find((entry) => entry.kind === "message" && entry.role === "user")?.turnId : "turn-1",
				);
				strictEqual(outcome.turnIndex, 0);
				strictEqual(row.parentTurnId, continuation ? "turn-3" : "turn-2");
				strictEqual(row.display, false);
				strictEqual(outcome.coordinator.toolCalls, 0);
				const { coordinator } = outcome.tokens;
				deepStrictEqual(
					[coordinator.input, coordinator.output, coordinator.cacheRead, coordinator.total].map(factKnownValue),
					[7, 5, 0, 12],
				);
				strictEqual(coordinator.total.unknownCount, 0);
				strictEqual(outcome.completion.decision, "ok");
				strictEqual(outcome.conversation.clarificationStreak, 1);
			} finally {
				loop.dispose();
				await loop.whenSettled();
				// The writer stays open between calls; the next iteration reuses this session id (#434).
				await journals.closeAll();
				scratch.restore();
			}
		},
	);

it("the worker honesty rail exempts detached collection but still warns on ordinary turns", async () => {
	const scratch = await isolateClioEnv("clio-coder-collection-rail-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	let source: "injected" | "monitor" | "pending" | "ordinary" = "injected";
	const warnings: string[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		middleware: createMiddlewareBundle({ registrations: [createUnbackedWorkerClaimRegistration()] }).contract,
		turnControl: {
			async run({ userTurnId }) {
				const block = source === "injected" ? "[Collected]\nThe scout found the fixture." : null;
				return {
					block,
					record: {
						version: 1,
						turnId: userTurnId,
						factsDigest: "fixture",
						decision:
							block === null ? { kind: "none", reason: "nothing-finished" } : { kind: "collect", batchIds: ["fixture"] },
						decisionHash: "fixture",
						executed: block === null ? null : { runIds: ["scout"], blockChars: block.length, durationMs: 1 },
					},
				};
			},
		},
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...options?.initialState, messages: [] as AgentMessage[] };
			return {
				requestCorrelationId: () => undefined,
				agent: {
					state,
					subscribe: (next: typeof listener) => {
						listener = next;
						return () => {};
					},
					abort() {},
					async prompt() {
						state.tools = [{ name: "dispatch" }] as NonNullable<typeof state.tools>;
						await listener({ type: "agent_start" });
						await listener({ type: "turn_start" });
						if (source === "monitor" || source === "pending") {
							const args = { op: "call", capability: "monitor", args: { mode: "collect", batch_id: "fixture" } };
							await listener({ type: "tool_execution_start", toolName: "gateway", toolCallId: "collect", args });
							await listener({
								type: "tool_execution_end",
								toolName: "gateway",
								toolCallId: "collect",
								isError: false,
								result: {
									content: [],
									details: {
										capability: "monitor",
										mode: "collect",
										batchId: "fixture",
										complete: source === "monitor",
										collected: source === "monitor",
									},
								},
							});
						}
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "The scout found the fixture." }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						state.messages.push(message);
						await listener({ type: "message_end", message });
						await listener({ type: "agent_end", messages: [message] });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	loop.onEvent((event) => {
		if (event.type === "notice" && event.text.includes("No dispatch ran this turn")) warnings.push(event.text);
	});
	try {
		for (const mode of ["injected", "monitor", "pending", "ordinary"] as const) {
			source = mode;
			warnings.length = 0;
			await loop.submit("Summarize the fixture.");
			strictEqual(warnings.length, mode === "pending" || mode === "ordinary" ? 1 : 0, mode);
		}
	} finally {
		loop.dispose();
		await loop.whenSettled();
		scratch.restore();
	}
});

interface CancelledRun {
	entries: SessionEntry[];
	reservedId: string;
}

/** Cancels a turn during turn control, before admission, with the Scout's run settling `sealAfterMs` later. */
async function cancelBeforeAdmission(sealAfterMs: number, check: (run: CancelledRun) => Promise<void>): Promise<void> {
	const scratch = await isolateClioEnv("clio-coder-turn-outcome-cancel-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	const entries: SessionEntry[] = [];
	const session = {
		current: () => ({ id: "outcome-session", cwd: scratch.dir, cwdHash: "outcome-repo" }),
		tree: () => ({ leafId: null }),
		leafId: () => null,
		appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
			const row = { ...entry, turnId: `entry-${entries.length + 1}`, timestamp: new Date().toISOString() } as SessionEntry;
			entries.push(row);
			return row;
		},
	} as unknown as SessionContract;
	let started: () => void = () => {};
	const runStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let reservedId = "";
	const loop = createChatLoop({
		outcomeDispatch: { getRun: () => ({ id: "scout-1" }) as unknown as ReturnType<DispatchContract["getRun"]> },
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		readSessionEntries: () => entries,
		turnControl: {
			async run(input: { userTurnId: string; signal: AbortSignal }) {
				reservedId = input.userTurnId;
				started();
				await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
				return {
					block: null,
					record: {
						version: 1,
						turnId: input.userTurnId,
						factsDigest: "fixture",
						decision: { kind: "none" },
						decisionHash: "fixture",
						executed: { refused: "canceled", startedRunIds: ["scout-1"] },
					},
				};
			},
		} as unknown as NonNullable<CreateChatLoopDeps["turnControl"]>,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			requestCorrelationId: () => undefined,
			agent: {
				state: { ...options?.initialState, messages: [] as AgentMessage[] },
				subscribe: () => () => {},
				abort() {},
				clearAllQueues() {},
				async prompt() {
					throw new Error("a turn cancelled before admission must not reach the model");
				},
			},
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	let settlement = Promise.resolve();
	try {
		const submitted = loop.submit("Give me a tour of this codebase.");
		await runStarted;
		loop.cancel();
		const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
		settlement = new Promise<void>((resolve) => setTimeout(resolve, sealAfterMs)).then(() =>
			writeSettledRun(clioStateDir(), fixtureReceiptDraft(fixtureEnvelope("scout-1")), {
				usage: {
					input: measured(40),
					output: measured(2),
					cacheRead: measured(0),
					cacheWrite: measured(0),
					cacheWrite1h: measured(0),
					reasoning: measured(0),
				},
				totalTokens: measured(42),
				apiCalls: measured(1),
				pricing: { usd: measured(0), pricedBy: "none" },
			}),
		);
		await Promise.all([settlement, submitted.then(() => check({ entries, reservedId }))]);
	} finally {
		loop.dispose();
		await loop.whenSettled();
		// The settled record is readable before its seal finishes; keep the fixture home until the writer closes (#434).
		await settlement.finally(() => scratch.restore());
	}
}

const measured = (value: number) => ({
	measured: value,
	estimated: 0,
	unknownCount: 0,
	absentCount: 0,
	coverage: { measured: 1, estimated: 0, unknown: 0 },
});
const SCOUT_TOKENS = { input: measured(40), output: measured(2), cacheRead: measured(0), total: measured(42) };

it("a cancel during turn control before admission still yields one cancelled outcome row", async () => {
	await cancelBeforeAdmission(60, async ({ entries, reservedId }) => {
		const rows = entries.filter((entry) => entry.kind === "custom" && entry.customType === "turnOutcome");
		strictEqual(rows.length, 1);
		const row = rows[0];
		ok(row?.kind === "custom");
		const outcome = row.data as TurnOutcomeRecord;
		strictEqual(outcome.turnId, reservedId);
		strictEqual(outcome.operator.canceled, true);
		strictEqual(outcome.stopReason, "aborted");
		deepStrictEqual(outcome.tokens.workers, SCOUT_TOKENS);
	});
});

// The settle wait gives up after 2 s; the Scout seals at 2.5 s, so the count arrives as an amend.
it("worker tokens that seal after the settle wait amend the cancelled outcome, in the ledger", async () => {
	await cancelBeforeAdmission(2500, async ({ entries, reservedId }) => {
		const outcome = entries.find((entry) => entry.kind === "custom" && entry.customType === "turnOutcome");
		ok(outcome?.kind === "custom");
		// The Scout had not sealed when the outcome was written, so its tokens are an unknown contribution.
		strictEqual((outcome.data as TurnOutcomeRecord).tokens.workers.total.unknownCount, 1);
		const amended = () => entries.find((entry) => entry.kind === "custom" && entry.customType === "turnOutcomeTokens");
		for (let waited = 0; amended() === undefined && waited < 5000; waited += 50) {
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		const amend = amended();
		ok(amend?.kind === "custom");
		strictEqual(amend.parentTurnId, outcome.parentTurnId);
		strictEqual(amend.display, false);
		const data = amend.data as { turnId: string; workers: unknown };
		strictEqual(data.turnId, reservedId);
		deepStrictEqual(data.workers, SCOUT_TOKENS);
	});
});

it("continuation state has one owner: a nudge per prompt, carried or resubmitted once, and no outside writes", () => {
	const continuation = new ContinuationState();
	strictEqual(continuation.request(), true);
	strictEqual(continuation.request(), false, "the prompt's one nudge is spent");
	continuation.carryIntoRun();
	strictEqual(continuation.requested, false);
	strictEqual(continuation.takeInRun(), true);
	strictEqual(continuation.takeInRun(), false);
	continuation.beginPrompt({ requestContinuation: true, yoloContinuation: false });
	strictEqual(continuation.nudgeSpent, true, "a continuation prompt keeps the cap");
	strictEqual(continuation.request("verification"), true, "the verification nudge has its own cap");
	strictEqual(continuation.request("verification"), false);
	strictEqual(continuation.takeRequest(), true);
	continuation.beginPrompt({ requestContinuation: false, yoloContinuation: false });
	strictEqual(continuation.verificationNudgeSpent, false, "an operator prompt resets the verification nudge");
	strictEqual(continuation.request(), true);
	continuation.dropRequest();
	strictEqual(continuation.takeRequest(), false, "a stranded resubmit superseded the request");
	continuation.recordStop({ cause: "retries_exhausted", reason: "provider retries ran out" });
	strictEqual(continuation.countYoloContinuation(), 1);
	continuation.beginPrompt({ requestContinuation: false, yoloContinuation: true });
	strictEqual(continuation.stop, null);
	strictEqual(continuation.yoloContinuations, 1, "a yolo continuation keeps its count");

	// Type-level only, never called: tsc rejects each write the module views and the owner forbid.
	const _forbiddenWrites = (view: TurnQueuesState) => {
		// @ts-expect-error a module's view keeps the fields it only reads readonly
		view.streaming = true;
		// @ts-expect-error the owner is never replaced
		view.continuation = new ContinuationState();
		// @ts-expect-error continuation fields change only through the owner's methods
		view.continuation.requested = true;
	};
	void _forbiddenWrites;

	const module = "src/session-control/turn-queues.ts";
	deepStrictEqual(
		checkTurnStateOwnership(module, "state.continuation.takeRequest();\nif (state.streaming) run();\n"),
		[],
	);
	for (const source of [
		"state.pendingRequestContinuation = false;",
		"state.turnStop = null;",
		"state.yoloContinuations++;",
		"(state as any).continuation = other;",
		'import type { ChatTurnState } from "./turn-state.js";',
	])
		ok(checkTurnStateOwnership(module, source)[0]?.startsWith("rule16:"), source);
	deepStrictEqual(checkTurnStateOwnership("src/engine/acp/server.ts", "active.continuation = null;"), []);
	deepStrictEqual(checkTurnStateOwnership("src/session-control/turn-state.ts", "state.turnStop = null;"), []);
});

it("exploration notes settle acted, ignored and moot, and the turn records its read streak (exploration design X4)", async () => {
	const scratch = await isolateClioEnv("clio-coder-exploration-outcome-");
	const sessionId = "x4-exploration";
	const hub = telemetryHub();
	const settled = new Map<string, { surface: string; outcome: string; admittedIn: string | null; fact: unknown }>();
	const fired: Array<{ ruleId: string; firingId?: string }> = [];
	const stops = [
		hub.subscribe("middleware.fired", (payload, ctx) => {
			if (ctx?.sessionId === sessionId) fired.push(payload);
		}),
		hub.subscribe("surface.settled", (payload, ctx) => {
			if (ctx?.sessionId !== sessionId) return;
			ok(validPayload("surface.settled", payload), JSON.stringify(payload));
			ok(!settled.has(payload.firingId), `settled twice: ${payload.firingId}`);
			const { surface, outcome, admittedIn, fact } = payload;
			settled.set(payload.firingId, { surface, outcome, admittedIn, fact });
		}),
	];
	const collector = createTurnOutcomeCollector();
	const detach = collector.attachLedger(
		hub,
		() => sessionId,
		() => new Set(),
	);
	try {
		for (const area of ["alpha", "beta", "gamma"]) {
			mkdirSync(join(scratch.dir, area));
			writeFileSync(join(scratch.dir, area, "notes.md"), "notes\n");
		}
		const middleware = createMiddlewareBundle({
			registrations: [
				collector,
				...createExplorationNudgeRegistrations({
					workspaceRoot: () => scratch.dir,
					readStreak: { repeatsAsRead: callRepeatsAsRead, changesTree: callChangesTree },
					readStreakObserver: collector,
				}),
			],
		}).contract;
		const hook = (input: MiddlewareHookInput) => middleware.runHook({ sessionId, ...input });
		const areas = ["alpha", "beta", "gamma"];
		let calls = 0;
		/** One model round: its calls, then the request that carries their results; returns that request's id. */
		const round = (
			tools: ReadonlyArray<{ name: string; args?: Record<string, unknown>; details?: Record<string, unknown> }>,
		) => {
			for (const tool of tools) {
				calls += 1;
				const toolCallId = `t-${calls}`;
				const toolArgs = tool.args ?? { path: join(scratch.dir, areas[calls % 3] ?? "alpha", "notes.md") };
				hook({ hook: "before_tool", turnId: "u1", toolName: tool.name, toolCallId, toolArgs });
				hook({
					hook: "after_tool",
					turnId: "u1",
					toolName: tool.name,
					toolCallId,
					toolArgs,
					...(tool.details !== undefined ? { toolResultDetails: tool.details } : {}),
					metadata: { resultKind: "ok", batchSize: tools.length },
				});
			}
			const callId = newCallId();
			collector.requestSent(callId, []);
			return callId;
		};
		const reads = (count: number) => Array.from({ length: count }, () => ({ name: "read" }));
		const firingOf = (ruleId: string, nth = 0) => fired.filter((row) => row.ruleId === ruleId)[nth]?.firingId ?? "";
		hook({
			hook: "turn_start",
			turnId: "u1",
			metadata: { userTurnId: "u1", turnOrigin: "operator", activeToolNames: "read,edit,tasks,ask_user,dispatch" },
		});
		// Ten reads across three areas draw the scout note; the dispatch the model starts after it acts on it.
		let surveyCarried = "";
		for (let index = 0; index < 4; index += 1) surveyCarried = round(reads(3));
		round([
			{
				name: "dispatch",
				args: { agent: "scout", task: "survey" },
				details: { mode: "parallel", runs: [{ runId: "run-1", agentId: "scout" }] },
			},
		]);
		// The dispatch reset the streak. Twenty-five reads draw the first note; the edit after it acts on it.
		for (let index = 0; index < 5; index += 1) round(reads(5));
		round([{ name: "edit", args: { path: join(scratch.dir, "alpha", "notes.md") } }]);
		// The streak starts again: its first note sees four single-read rounds, which draw the serial-round note. One
		// more single read leaves that open; the next round of two reads acts on it. Ten reads after the ladder note
		// with no decision leave it ignored, at the tenth and not before.
		for (let index = 0; index < 4; index += 1) round(reads(5));
		const ladderCarried = round(reads(5));
		for (let index = 0; index < 5; index += 1) round(reads(1));
		round(reads(2));
		round(reads(2));
		strictEqual(settled.get(firingOf("nudge.read-streak", 1)), undefined, "nine reads after the note");
		round(reads(1));
		strictEqual(settled.get(firingOf("nudge.read-streak", 1))?.outcome, "ignored", "ten reads after the note");
		// Read forty draws the second note, which the turn's end leaves moot.
		const lastCarried = round(reads(5));
		hook({ hook: "turn_end", turnId: "a1", metadata: { userTurnId: "u1" } });

		const outcome = (firingId: string) => settled.get(firingId);
		deepStrictEqual(outcome(firingOf("nudge.scout-survey")), {
			surface: "nudge.scout-survey",
			outcome: "acted",
			admittedIn: surveyCarried,
			fact: { kind: "receipt", ref: "t-13" },
		});
		strictEqual(outcome(firingOf("nudge.read-streak", 0))?.outcome, "acted");
		deepStrictEqual(outcome(firingOf("nudge.read-streak", 0))?.fact, { kind: "receipt", ref: "t-39" });
		deepStrictEqual(outcome(firingOf("nudge.read-streak", 1)), {
			surface: "nudge.read-streak",
			outcome: "ignored",
			admittedIn: ladderCarried,
			fact: { kind: "none" },
		});
		deepStrictEqual(
			outcome(firingOf("nudge.read-streak", 2))?.fact,
			{ kind: "receipt", ref: "t-71" },
			"the round of two reads after a single-read round answers the serial note",
		);
		deepStrictEqual(outcome(firingOf("nudge.read-streak", 3)), {
			surface: "nudge.read-streak",
			outcome: "moot",
			admittedIn: lastCarried,
			fact: { kind: "scope-end" },
		});
		strictEqual(fired.filter((row) => row.ruleId === "nudge.read-streak").length, 4);
		strictEqual(settled.size, 5, "every exploration firing settles once");
		deepStrictEqual(collector.take("u1").exploration, { maxReadStreak: 40, serialRounds: 5, notes: 4 });

		// A worker settles its one thrash note itself, under its run: ten reads after the request that carried it.
		const run = { sessionId: "x4-parent", runId: "run-x4", agent: { role: "worker" as const, id: "run-x4" } };
		const workerSettled: unknown[] = [];
		stops.push(
			hub.subscribe("surface.settled", (payload, ctx) => {
				if (ctx?.runId !== run.runId) return;
				ok(validPayload("surface.settled", payload), JSON.stringify(payload));
				workerSettled.push(payload);
			}),
		);
		const thrash = createThrashOutcome({ context: run, mutatedPaths: () => 0 });
		const thrashFiring = thrash.fire();
		const thrashCarried = newCallId();
		const event = (value: object) => thrash.observe(value as AgentEvent);
		event({
			type: "message_end",
			message: { role: "assistant", callId: thrashCarried, content: [], stopReason: "toolUse" },
		});
		for (let index = 0; index < 10; index += 1) {
			event({ type: "tool_execution_start", toolCallId: `w-${index}`, toolName: "read", args: { path: "a.ts" } });
			event({ type: "tool_execution_end", toolCallId: `w-${index}`, toolName: "read", isError: false });
		}
		thrash.end([]);
		deepStrictEqual(workerSettled, [
			{
				firingId: thrashFiring,
				surface: "worker.thrash",
				admittedIn: thrashCarried,
				outcome: "ignored",
				fact: { kind: "none" },
			},
		]);
	} finally {
		detach();
		for (const stop of stops) stop();
		scratch.restore();
	}
});
