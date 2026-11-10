import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { TURN_CONTINUATION_CAP, turnContinuationDelayMs } from "../../src/core/job-types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import type { CreateChatLoopDeps } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import type { MachineTurnResult } from "../../src/session-control/job-turn-types.js";
import { subscribeLoopGuardStop } from "../../src/session-control/loop-guard-interrupt.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const RATE_LIMITED = "429 rate_limit_error: This request would exceed your rate limit";

/** What one model call does: cross the budget, lock the tools, both, finish, or throw. */
type Step = "budget" | "hard" | "lockout" | "both" | "done" | { throws: string };

interface Harness {
	loop: ReturnType<typeof createChatLoop>;
	prompts: string[];
	continued: Array<{ cause: string; attempt: number; cap: number }>;
	events: AgentEvent[] | unknown[];
	close(): Promise<void>;
}

async function harness(script: readonly Step[], options: { autonomy?: "yolo" | "default"; runtimeId?: string } = {}) {
	const scratch = await isolateClioEnv("clio-coder-yolo-continuation-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	if (options.runtimeId !== undefined)
		settings.targets = [{ id: "fixture", runtime: options.runtimeId, defaultModel: "fixture-model" }];
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	const entries: SessionEntry[] = [];
	let leaf: string | null = null;
	const session = {
		current: () => ({ id: "continuation-session", cwd: scratch.dir, cwdHash: "continuation-repo" }),
		tree: () => ({ leafId: leaf }),
		append(turn: TurnInput) {
			const id = turn.id ?? `turn-${entries.length + 1}`;
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
			const row = { ...entry, turnId: `entry-${entries.length + 1}`, timestamp: new Date().toISOString() } as SessionEntry;
			entries.push(row);
			return row;
		},
	} as unknown as SessionContract;
	const prompts: string[] = [];
	const continued: Harness["continued"] = [];
	context.bus.subscribe("turn.continued", (payload) => {
		const row = payload as Harness["continued"][number];
		continued.push({ cause: row.cause, attempt: row.attempt, cap: row.cap });
	});
	let step = 0;
	const loop = createChatLoop({
		getSettings: () => settings,
		getAutonomy: () => options.autonomy ?? "yolo",
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		bus: context.bus,
		readSessionEntries: () => entries,
		createAgent: ((agentOptions: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...agentOptions?.initialState, messages: [] as AgentMessage[] };
			return {
				requestCorrelationId: () => undefined,
				agent: {
					state,
					subscribe: (next: typeof listener) => {
						listener = next;
						return () => {};
					},
					abort() {},
					clearAllQueues() {},
					async continue() {
						throw new Error("the fixture never retries");
					},
					async prompt(text: string) {
						prompts.push(text);
						const current = script[Math.min(step, script.length - 1)] ?? "done";
						step++;
						if (typeof current === "object") throw new Error(current.throws);
						await listener({ type: "agent_start" });
						await listener({ type: "turn_start" });
						if (current === "budget" || current === "both" || current === "hard") {
							context.bus.emit("safety.tool_budget_exceeded", {
								tool: "bash",
								callsThisTurn: current === "hard" ? 75 : 60,
								softBudget: 60,
								hardCeiling: 75,
								interrupted: current === "hard",
								at: Date.now(),
							});
						}
						if (current === "lockout" || current === "both") {
							context.bus.emit("safety.loop_blocked", { disposition: "lockout" } as never);
						}
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "fixture reply" }],
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
	const unsubscribeGuard = subscribeLoopGuardStop(context.bus, loop);
	const events: unknown[] = [];
	loop.onEvent((event) => {
		events.push(event);
	});
	return {
		loop,
		prompts,
		continued,
		events,
		close: async () => {
			unsubscribeGuard();
			loop.dispose();
			await loop.whenSettled();
			scratch.restore();
		},
	} satisfies Harness;
}

const pairs = (rows: Harness["continued"]) => rows.map((row) => [row.cause, row.attempt]);

describe("yolo continuation of a stopped turn (#445)", () => {
	it("continues past every budget crossing without spending the cap", async () => {
		const crossings = TURN_CONTINUATION_CAP * 3;
		const run = await harness([...Array.from({ length: crossings }, () => "budget" as const), "done"]);
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, crossings + 1);
			ok(run.continued.every((row) => row.cause === "tool_budget" && row.attempt === 0));
			strictEqual(run.continued.length, crossings);
			const continuation = run.prompts[1] ?? "";
			ok(continuation.includes("The previous turn stopped: it reached the per-turn tool budget"), continuation);
			ok(!continuation.includes("This is continuation"), continuation);
		} finally {
			await run.close();
		}
	});

	it("continues a turn the hard tool-call ceiling stopped (#450)", async () => {
		const run = await harness(["hard", "done"]);
		try {
			await run.loop.submit("poll CI and the cluster until both are done");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 2);
			deepStrictEqual(pairs(run.continued), [["tool_budget", 0]]);
		} finally {
			await run.close();
		}
	});

	it("stops a loop guard lock at the cap and numbers each continuation", async () => {
		const run = await harness(["lockout"]);
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 1 + TURN_CONTINUATION_CAP);
			deepStrictEqual(pairs(run.continued), [
				["loop_guard", 1],
				["loop_guard", 2],
				["loop_guard", 3],
			]);
			ok((run.prompts[1] ?? "").includes("This is continuation 1 of 3."));
			ok((run.prompts[3] ?? "").includes("This is continuation 3 of 3."));
		} finally {
			await run.close();
		}
	});

	it("still continues a budget crossing once the cap is spent, until a counted stop ends it", async () => {
		const run = await harness(["lockout", "lockout", "lockout", "budget", "budget", "lockout", "done"]);
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 6);
			deepStrictEqual(pairs(run.continued), [
				["loop_guard", 1],
				["loop_guard", 2],
				["loop_guard", 3],
				["tool_budget", 3],
				["tool_budget", 3],
			]);
		} finally {
			await run.close();
		}
	});

	it("counts a turn that both locked and crossed the budget as the lock", async () => {
		const run = await harness(["both"]);
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 1 + TURN_CONTINUATION_CAP);
			ok(run.continued.every((row) => row.cause === "loop_guard"));
		} finally {
			await run.close();
		}
	});

	it("gives a new operator prompt a fresh cap", async () => {
		const run = await harness(["lockout", "lockout", "lockout", "lockout", "done", "lockout", "done"]);
		try {
			await run.loop.submit("first");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 4);
			await run.loop.submit("second");
			await run.loop.whenSettled();
			deepStrictEqual(pairs(run.continued).slice(3), []);
			strictEqual(run.prompts.length, 5);
			await run.loop.submit("third");
			await run.loop.whenSettled();
			deepStrictEqual(pairs(run.continued).slice(3), [["loop_guard", 1]]);
		} finally {
			await run.close();
		}
	});

	it("does nothing below yolo", async () => {
		const run = await harness(["budget"], { autonomy: "default" });
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 1);
			deepStrictEqual(run.continued, []);
		} finally {
			await run.close();
		}
	});

	it("stops when the turn simply finishes", async () => {
		const run = await harness(["done", "budget"]);
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			strictEqual(run.prompts.length, 1);
			deepStrictEqual(run.continued, []);
		} finally {
			await run.close();
		}
	});

	it("does not continue a machine turn itself; it reports the stop and the job decides", async () => {
		for (const [step, expected] of [
			["budget", "tool_budget"],
			["lockout", "loop_guard"],
			["both", "loop_guard"],
			["done", undefined],
		] as const) {
			const run = await harness([step]);
			try {
				const result: MachineTurnResult | undefined = await run.loop.submitMachineTurn?.({
					jobId: "job-1",
					executionId: "execution-1",
					text: "poll CI",
					origin: "job job-1",
					sessionId: run.loop.getSessionId() ?? "continuation-session",
					isAdmissionCurrent: () => true,
					signal: new AbortController().signal,
					onStarting: () => true,
				});
				await run.loop.whenSettled();
				strictEqual(result?.stoppedBy, expected, step);
				strictEqual(run.prompts.length, 1);
				deepStrictEqual(run.continued, []);
			} finally {
				await run.close();
			}
		}
	});

	const retryStatuses = (events: unknown[]): unknown[] =>
		events.filter((event) => (event as { type?: string }).type === "retry_status");

	it("sends a thrown litellm 429 to the rate-limit wait at yolo", async () => {
		const run = await harness([{ throws: RATE_LIMITED }], { runtimeId: "litellm" });
		try {
			const submitted = run.loop.submit("poll CI until green");
			for (let i = 0; i < 100 && retryStatuses(run.events).length === 0; i++)
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			const first = retryStatuses(run.events)[0] as { status?: { phase?: string } } | undefined;
			strictEqual(first?.status?.phase, "scheduled");
			run.loop.cancel();
			await submitted;
		} finally {
			await run.close();
		}
	});

	it("leaves a thrown litellm 429 terminal below yolo", async () => {
		const run = await harness([{ throws: RATE_LIMITED }], { autonomy: "default", runtimeId: "litellm" });
		try {
			await run.loop.submit("poll CI until green");
			await run.loop.whenSettled();
			deepStrictEqual(retryStatuses(run.events), []);
		} finally {
			await run.close();
		}
	});

	it("waits 1, 5, then 15 minutes, or longer when the provider asks", () => {
		deepStrictEqual(
			[1, 2, 3, 4].map((attempt) => turnContinuationDelayMs(attempt)),
			[60_000, 300_000, 900_000, 900_000],
		);
		strictEqual(turnContinuationDelayMs(1, 600_000), 600_000);
		strictEqual(turnContinuationDelayMs(1, 10 * 3_600_000), 10 * 3_600_000);
		strictEqual(turnContinuationDelayMs(3, 1000), 900_000);
	});
});
