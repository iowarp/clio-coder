import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import { TraceReader, TraceStore } from "../../src/domains/observability/trace-store.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { TurnOutcomeRecord } from "../../src/domains/turn-control/index.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import type { CreateChatLoopDeps } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createTurnOutcomeCollector } from "../../src/session-control/turn-outcome-collector.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const continuation of [false, true])
	it(
		continuation
			? "a collect continuation persists the controller block in its user turn"
			: "a faux tool-free turn writes one outcome after assessment and mirrors it onto the finished trace",
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
			const tracePath = join(scratch.dir, "trace.sqlite");
			const store = new TraceStore(tracePath);
			const loop = createChatLoop({
				getSettings: () => settings,
				providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
				knownTargets: () => new Set([target.id]),
				session,
				readSessionEntries: () => entries,
				middleware,
				turnOutcomeCollector: collector,
				...(continuation
					? {
							turnControl: {
								seedOrientation() {},
								controllerActed: () => true,
								async run(input) {
									strictEqual(input.continuation, true);
									const block = "[Collected]\nfinished batch results";
									return {
										block,
										record: {
											version: 1,
											turnId: input.userTurnId,
											producer: null,
											interpretation: null,
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
				observability: {
					recordSessionTurn: (trace: Parameters<ObservabilityContract["recordSessionTurn"]>[0]) =>
						store.recordSessionTurn(trace),
					recordTokens() {},
					recordTokenThroughput() {},
				} as unknown as ObservabilityContract,
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
								await listener({ type: "agent_start" });
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
				deepStrictEqual(outcome.tokens.coordinator, {
					inputTokens: 7,
					outputTokens: 5,
					cacheReadTokens: 0,
					totalTokens: 12,
					provenance: "reported",
				});
				strictEqual(outcome.completion.decision, "ok");
				strictEqual(outcome.conversation.clarificationStreak, 1);
				const reader = new TraceReader(tracePath);
				try {
					const runId = `session:${outcome.turnId}`;
					strictEqual(reader.run(runId)?.status, "success");
					const mirrored = reader.events(runId).filter((event) => event.type === "turn_outcome");
					strictEqual(mirrored.length, 1);
					deepStrictEqual(JSON.parse(mirrored[0]?.payload_json ?? "null"), outcome);
				} finally {
					reader.close();
				}
			} finally {
				loop.dispose();
				await loop.whenSettled();
				store.close();
				scratch.restore();
			}
		},
	);

interface CancelledRun {
	entries: SessionEntry[];
	recorded: Array<{ ref: string; source: string; facts: Record<string, unknown> }>;
	reservedId: string;
}

/** Cancels a turn during the orientation act, before admission, with the Scout's receipt sealing `sealAfterMs` later. */
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
	const recorded: CancelledRun["recorded"] = [];
	const session = {
		current: () => ({ id: "outcome-session", cwd: scratch.dir, cwdHash: "outcome-repo" }),
		tree: () => ({ leafId: null }),
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
	const receiptPath = join(scratch.dir, "scout-receipt.json");
	const loop = createChatLoop({
		outcomeDispatch: { getRun: () => ({ receiptPath }) as unknown as ReturnType<DispatchContract["getRun"]> },
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		readSessionEntries: () => entries,
		recordOutcome: (outcome) => recorded.push({ ...outcome, facts: outcome.facts as Record<string, unknown> }),
		turnControl: {
			seedOrientation() {},
			controllerActed: () => false,
			async run(input: { userTurnId: string; signal: AbortSignal }) {
				reservedId = input.userTurnId;
				started();
				await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
				return {
					block: null,
					record: {
						version: 1,
						turnId: input.userTurnId,
						producer: "system-one",
						interpretation: null,
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
	try {
		const submitted = loop.submit("Give me a tour of this codebase.");
		await runStarted;
		loop.cancel();
		setTimeout(
			() =>
				writeFileSync(
					receiptPath,
					JSON.stringify({ runId: "scout-1", inputTokenCount: 40, outputTokenCount: 2, tokenCount: 42 }),
				),
			sealAfterMs,
		);
		await submitted;
		await check({ entries, recorded, reservedId });
	} finally {
		loop.dispose();
		await loop.whenSettled();
		scratch.restore();
	}
}

const SCOUT_TOKENS = { inputTokens: 40, outputTokens: 2, cacheReadTokens: 0, totalTokens: 42, provenance: "reported" };

it("a cancel during the orientation act before admission still yields one cancelled outcome row", async () => {
	await cancelBeforeAdmission(60, async ({ entries, recorded, reservedId }) => {
		const rows = entries.filter((entry) => entry.kind === "custom" && entry.customType === "turnOutcome");
		strictEqual(rows.length, 1);
		const row = rows[0];
		ok(row?.kind === "custom");
		const outcome = row.data as TurnOutcomeRecord;
		strictEqual(outcome.turnId, reservedId);
		strictEqual(outcome.operator.canceled, true);
		strictEqual(outcome.stopReason, "aborted");
		deepStrictEqual(outcome.tokens.workers, SCOUT_TOKENS);
		strictEqual(recorded.length, 1);
		strictEqual(recorded[0]?.ref, reservedId);
		strictEqual(recorded[0]?.source, "turn");
		strictEqual(recorded[0]?.facts.canceled, true);
		deepStrictEqual(recorded[0]?.facts.workerTokens, SCOUT_TOKENS);
	});
});

// The settle wait gives up after 2 s; the Scout seals at 2.5 s, so the count arrives as an amend.
it("worker tokens that seal after the settle wait amend the cancelled outcome, in the ledger and the dataset", async () => {
	await cancelBeforeAdmission(2500, async ({ entries, recorded, reservedId }) => {
		const outcome = entries.find((entry) => entry.kind === "custom" && entry.customType === "turnOutcome");
		ok(outcome?.kind === "custom");
		strictEqual((outcome.data as TurnOutcomeRecord).tokens.workers.provenance, "partial");
		strictEqual(recorded[0]?.source, "turn");
		strictEqual((recorded[0]?.facts.workerTokens as { provenance: string }).provenance, "partial");
		const amended = () => entries.find((entry) => entry.kind === "custom" && entry.customType === "turnOutcomeTokens");
		for (let waited = 0; amended() === undefined && waited < 5000; waited += 50) {
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		const amend = amended();
		ok(amend?.kind === "custom");
		strictEqual(amend.parentTurnId, outcome.parentTurnId);
		strictEqual(amend.display, false);
		const data = amend.data as { turnId: string; ref: string; workers: unknown };
		strictEqual(data.turnId, reservedId);
		strictEqual(data.ref, reservedId);
		deepStrictEqual(data.workers, SCOUT_TOKENS);
		strictEqual(recorded.length, 2);
		strictEqual(recorded[1]?.source, "turn-tokens");
		strictEqual(recorded[1]?.ref, reservedId);
		deepStrictEqual(recorded[1]?.facts.workerTokens, SCOUT_TOKENS);
	});
});
