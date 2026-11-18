import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModelTier } from "../../src/core/model-tier.js";
import { subscribeExtensionObservations } from "../../src/domains/extensions/bus-observations.js";
import type { ExtensionObservationV2 } from "../../src/domains/extensions/public-api-v2.js";
import type { MiddlewareContract, MiddlewareHookInput } from "../../src/domains/middleware/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { hostCheckpoint } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import { type SessionEntry, SKILL_CONTEXT_STATE } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createStepStartTracker } from "../../src/session-control/step-start.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// WTF-P 0.8.3 C5: under `turnPolicy: step` every step turn resent the whole
// conversation. On a small or uncached route each step turn after the first now
// starts from a step-boundary checkpoint: the previous step's final summary and
// the template body, with every earlier message kept in the ledger only. A cached
// frontier route keeps the full history.

const STEP = "extension_wtfp__next_step";
const BODY = "Advance the paper one step: call extension_wtfp__next_step, run the step it returns, then summarize.";
const MARKER = "TOOL-RESULT-MARKER section intro: 412 words";
const SKILL_BODY = "SKILL-BODY-MARKER: every figure in the paper is a labelled diagram.";

/** A resumed session whose earlier turn loaded a skill through the tool, with its full receipt (as compaction verifies it). */
function skillLoad(): { entries: SessionEntry[]; leaf: string } {
	const timestamp = new Date().toISOString();
	const message = (turnId: string, role: string, payload: unknown, parentTurnId: string | null) =>
		({ kind: "message", turnId, parentTurnId, timestamp, role, payload }) as SessionEntry;
	const activation = {
		name: "diagram",
		filePath: "/skills/diagram/SKILL.md",
		hash: "a".repeat(64),
		source: "clio-coder",
		sourceOrigin: "project",
		triggeredBy: "tool" as const,
		turnId: "skill-request",
		drift: "match" as const,
	};
	const args = { scope: "skills", name: "diagram" };
	const bytes = Buffer.byteLength(SKILL_BODY);
	return {
		leaf: "skill-selected",
		entries: [
			message("skill-request", "user", { text: "[Skill request] diagram", operatorText: "" }, null),
			message(
				"skill-assistant",
				"assistant",
				{ content: [{ type: "toolCall", id: "load", name: "context", arguments: args }] },
				"skill-request",
			),
			message("skill-call", "tool_call", { toolCallId: "load", name: "context", args }, "skill-assistant"),
			{ kind: "skillActivation", turnId: "skill-activation", parentTurnId: "skill-request", timestamp, activation },
			message(
				"skill-result",
				"tool_result",
				{
					toolCallId: "load",
					toolName: "context",
					isError: false,
					outcome: "ok",
					resultSummary: { bytes, truncated: false },
					result: {
						content: [{ type: "text", text: SKILL_BODY }],
						details: {
							kind: "ok",
							name: "diagram",
							path: activation.filePath,
							hash: activation.hash,
							source: activation.source,
							sourceOrigin: "project",
							scope: "project",
							sourceInfo: { path: activation.filePath, scope: "project", source: "project" },
							drift: "match",
							observation: { truncated: false, shownBytes: bytes, totalBytes: bytes },
						},
					},
				},
				"skill-call",
			),
			{
				kind: "custom",
				turnId: "skill-selected",
				parentTurnId: "skill-result",
				timestamp,
				customType: SKILL_CONTEXT_STATE,
				data: { version: 1, activationRefs: ["skill-activation"] },
			} as SessionEntry,
		],
	};
}

interface Run {
	histories: string[];
	/** The text each request adds after its history: the turn's reminders and its prompt. */
	texts: string[];
	entries: SessionEntry[];
	continued: string[];
	hooks: MiddlewareHookInput[];
	observations: ExtensionObservationV2[];
	close(): Promise<void>;
}

interface Drive {
	model: string;
	tier: ModelTier;
	uncached?: boolean;
	/** How the first step turn stops: its step policy (the default), or a loop-guard tool lockout. */
	firstStop?: "step" | "loop_guard";
	/** Resume a session that already loaded a skill. */
	skill?: boolean;
}

async function stepDrive(route: Drive): Promise<Run> {
	const scratch = await isolateClioEnv("clio-coder-step-compact-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.targets = [
		{
			id: `route-${route.model}`,
			runtime: "openai",
			defaultModel: route.model,
			...(route.uncached === true ? { cache: { retention: "none" as const } } : {}),
		},
	];
	const context = dispatchStubContext({ settings });
	settings.chat.target = `route-${route.model}`;
	settings.chat.model = route.model;
	const providers = {
		...(context.getContract("providers") as ProvidersContract),
		modelTierOverride: () => route.tier,
	} as ProvidersContract;
	const seed = route.skill === true ? skillLoad() : null;
	const entries: SessionEntry[] = seed?.entries ?? [];
	let leaf: string | null = seed?.leaf ?? null;
	const session = {
		current: () => ({ id: "step-session", cwd: scratch.dir, cwdHash: "step-repo" }),
		tree: () => ({ leafId: leaf }),
		leafId: () => leaf,
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
			const row = {
				...entry,
				turnId: entry.turnId ?? `entry-${entries.length + 1}`,
				timestamp: new Date().toISOString(),
			} as SessionEntry;
			entries.push(row);
			return row;
		},
	} as unknown as SessionContract;
	const continued: string[] = [];
	context.bus.subscribe("turn.continued", (payload) => {
		continued.push((payload as { cause: string }).cause);
	});
	const hooks: MiddlewareHookInput[] = [];
	const middleware: MiddlewareContract = {
		runHook(input) {
			hooks.push(input);
			return { hook: input.hook, input, effects: [], ruleIds: [] };
		},
		snapshot: () => ({ version: 1, rules: [] }),
	};
	const observations: ExtensionObservationV2[] = [];
	const unobserve = subscribeExtensionObservations(context.bus, (observation) => observations.push(observation));
	const histories: string[] = [];
	const texts: string[] = [];
	let prompts = 0;
	const loop = createChatLoop({
		getSettings: () => settings,
		getAutonomy: () => "yolo",
		providers,
		knownTargets: () => new Set([`route-${route.model}`]),
		session,
		bus: context.bus,
		readSessionEntries: () => entries,
		middleware,
		pinnedContext: () => [{ extensionId: "wtfp", text: "Milestone 2: methods. Next: plan-section" }],
		createAgent: ((agentOptions: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...agentOptions?.initialState, messages: [] as AgentMessage[] };
			// The engine appends a message and then emits its message_end, which the run evidence log records.
			const settle = async (...messages: AgentMessage[]) => {
				for (const message of messages) {
					state.messages.push(message);
					await listener({ type: "message_end", message });
				}
			};
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
						histories.push(JSON.stringify(state.messages));
						texts.push(text);
						prompts++;
						state.messages.push({
							role: "user",
							content: [{ type: "text", text }],
							timestamp: Date.now(),
						} as unknown as AgentMessage);
						await listener({ type: "agent_start" });
						await listener({ type: "turn_start" });
						let reply = "Step two ran: drafted methods; after=methods-done.";
						if (prompts === 1) {
							// The step's tool round lives only in this turn's context.
							await settle({
								role: "assistant",
								content: [{ type: "toolCall", id: "call-1", name: STEP, arguments: { after: "start" } }],
								stopReason: "toolUse",
								timestamp: Date.now(),
							} as unknown as AgentMessage);
							await settle({
								role: "toolResult",
								toolCallId: "call-1",
								toolName: STEP,
								content: [{ type: "text", text: MARKER }],
								isError: false,
								timestamp: Date.now(),
							} as unknown as AgentMessage);
							if (route.firstStop === "loop_guard")
								// A repeated call locked the turn's tools mid-step.
								context.bus.emit("safety.loop_blocked", {
									tool: STEP,
									repeatCount: 3,
									blocksThisTurn: 3,
									budget: 3,
									interrupted: false,
									disposition: "lockout",
									at: Date.now(),
								});
							// A second step-tool call was refused: the step policy ended the turn.
							else
								context.bus.emit("safety.tool_budget_exceeded", {
									tool: STEP,
									callsThisTurn: 2,
									softBudget: 2,
									hardCeiling: 17,
									interrupted: false,
									at: Date.now(),
									template: "wtfp:advance",
									stepTool: STEP,
								});
							reply = "Step one ran: drafted intro; after=intro-done.";
						} else {
							// The second step is the pipeline's last, so the chain ends after it.
							await settle(
								{
									role: "assistant",
									content: [{ type: "toolCall", id: `call-${prompts}`, name: STEP, arguments: { after: "intro-done" } }],
									stopReason: "toolUse",
									timestamp: Date.now(),
								} as unknown as AgentMessage,
								{
									role: "toolResult",
									toolCallId: `call-${prompts}`,
									toolName: STEP,
									content: [{ type: "text", text: "step: draft methods; pipeline complete" }],
									details: { pipelineDone: true },
									isError: false,
									timestamp: Date.now(),
								} as unknown as AgentMessage,
							);
						}
						const message = {
							role: "assistant",
							content: [{ type: "text", text: reply }],
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
	if (seed !== null) loop.resetForSession(seed.leaf);
	await loop.submit(BODY, {
		constraints: { turnPolicy: { mode: "step", stepTool: STEP, template: "wtfp:advance" } },
		display: { text: "/wtfp:advance" },
	});
	await loop.whenSettled();
	return {
		histories,
		texts,
		entries,
		continued,
		hooks,
		observations,
		close: async () => {
			unobserve();
			loop.dispose();
			await loop.whenSettled();
			scratch.restore();
		},
	};
}

describe("step turns start from a compact state on small or uncached routes", () => {
	it("a small-tier route's second step turn carries the compact state and not the earlier tool results", async () => {
		const run = await stepDrive({ model: "step-small-model", tier: "small" });
		try {
			strictEqual(run.histories.length, 2, "the step stop continues into one more step turn");
			strictEqual(run.continued[0], "step");
			ok(run.histories[0]?.length !== undefined);
			const second = run.histories[1] ?? "";
			ok(second.includes("Step checkpoint."), second);
			ok(second.includes("Previous step's final summary:\\nStep one ran: drafted intro; after=intro-done."), second);
			ok(second.includes("Template instructions for this step (verbatim):"), second);
			ok(second.includes("Advance the paper one step"), second);
			ok(!second.includes("TOOL-RESULT-MARKER"), second);
			// The checkpoint dropped the pinned block's earlier copy, so this request carries it again.
			ok(run.texts[1]?.includes('<pinned-context extension="wtfp">'), run.texts[1]);
			const checkpoint = run.entries.find((entry) => entry.kind === "compactionSummary");
			ok(checkpoint?.kind === "compactionSummary");
			strictEqual(checkpoint.trigger, "step");
			strictEqual(checkpoint.firstKeptTurnId, "");
			// The ledger keeps the step turn the checkpoint cut from replay.
			ok(run.entries.some((entry) => JSON.stringify(entry).includes("Step one ran: drafted intro")));
		} finally {
			await run.close();
		}
	});

	it("an uncached route compacts the same way", async () => {
		const run = await stepDrive({ model: "step-uncached-model", tier: "frontier", uncached: true });
		try {
			const second = run.histories[1] ?? "";
			ok(second.includes("Step checkpoint."), second);
			ok(!second.includes("TOOL-RESULT-MARKER"), second);
		} finally {
			await run.close();
		}
	});

	it("a cached frontier route keeps the full history", async () => {
		const run = await stepDrive({ model: "step-frontier-model", tier: "frontier" });
		try {
			strictEqual(run.histories.length, 2);
			const second = run.histories[1] ?? "";
			ok(second.includes("TOOL-RESULT-MARKER"), second);
			ok(!second.includes("Step checkpoint."), second);
			ok(run.texts[0]?.includes('<pinned-context extension="wtfp">'), run.texts[0]);
			ok(!run.texts[1]?.includes("<pinned-context"), run.texts[1]);
			ok(!run.entries.some((entry) => entry.kind === "compactionSummary"));
		} finally {
			await run.close();
		}
	});

	it("a step turn the loop guard stopped is followed by the full history, not a checkpoint", async () => {
		const run = await stepDrive({ model: "step-guarded-model", tier: "small", firstStop: "loop_guard" });
		try {
			strictEqual(run.histories.length, 2);
			strictEqual(run.continued[0], "loop_guard");
			const second = run.histories[1] ?? "";
			ok(second.includes("TOOL-RESULT-MARKER"), second);
			ok(!second.includes("Step checkpoint."), second);
			ok(!run.entries.some((entry) => entry.kind === "compactionSummary"));
		} finally {
			await run.close();
		}
	});

	it("a step checkpoint fires on_compaction with trigger step and carries the loaded skill to the next request", async () => {
		const run = await stepDrive({ model: "step-skill-model", tier: "small", skill: true });
		try {
			const compaction = run.hooks.filter((input) => input.hook === "on_compaction");
			strictEqual(compaction.length, 1);
			strictEqual(compaction[0]?.metadata?.trigger, "step");
			strictEqual(compaction[0]?.metadata?.stage, "step_checkpoint");
			ok(
				run.observations.some(
					(observation) =>
						observation.event === "compaction_end" && observation.trigger === "step" && observation.outcome === "ok",
				),
			);
			const checkpoint = run.entries.find((entry) => entry.kind === "compactionSummary");
			ok(checkpoint?.kind === "compactionSummary");
			strictEqual(checkpoint.skillContext?.skills[0]?.activationRef, "skill-activation");
			const second = run.histories[1] ?? "";
			const at = second.indexOf("Step checkpoint.");
			ok(at >= 0, second);
			ok(second.indexOf("SKILL-BODY-MARKER", at) > at, second);
			ok(!second.includes("TOOL-RESULT-MARKER"), second);
		} finally {
			await run.close();
		}
	});

	it("a step checkpoint folds the previous checkpoint's goal and keeps its preserved request", () => {
		const timestamp = new Date().toISOString();
		const userContext = { turnId: "request", text: "Write the methods section; never touch the intro." };
		const entries = (later: boolean) =>
			[
				{
					kind: "message",
					turnId: "request",
					parentTurnId: null,
					timestamp,
					role: "user",
					payload: { text: userContext.text },
				},
				{
					kind: "compactionSummary",
					turnId: "s1",
					parentTurnId: "request",
					timestamp,
					summary:
						'## Goal\nGOAL-MARKER finish the paper\n\n<operator-notes encoding="xml">\n- NOTE-MARKER keep APA style\n</operator-notes>\n\n<recallable-refs>\nREF-MARKER\n</recallable-refs>',
					tokensBefore: 100,
					firstKeptTurnId: "",
					userContext,
				},
				{
					kind: "message",
					turnId: "next",
					parentTurnId: "s1",
					timestamp,
					role: "user",
					payload: later ? { text: "A new request." } : { text: "continue", synthetic: true },
				},
			] as SessionEntry[];
		const carried = hostCheckpoint(entries(false), "Step checkpoint.");
		ok(carried.summary.indexOf("GOAL-MARKER") < carried.summary.indexOf("Step checkpoint."), carried.summary);
		strictEqual(carried.summary.split("NOTE-MARKER").length, 2, carried.summary);
		ok(!carried.summary.includes("REF-MARKER"), carried.summary);
		deepStrictEqual(carried.userContext, userContext);
		// A later operator turn retires the old request, as native compaction does.
		strictEqual(hostCheckpoint(entries(true), "Step checkpoint.").userContext, undefined);
		// After a step checkpoint the next one carries the summarized body once and only its own lead (x2-1).
		const chained = [...entries(false)];
		chained.push({
			...(chained[1] as SessionEntry & { kind: "compactionSummary" }),
			turnId: "s2",
			parentTurnId: "next",
			summary: carried.summary,
			trigger: "step",
		});
		const next = hostCheckpoint(chained, "Step checkpoint two.");
		strictEqual(next.summary.split("GOAL-MARKER").length, 2, next.summary);
		strictEqual(next.summary.split("Step checkpoint").length, 2, next.summary);
		deepStrictEqual(next.userContext, userContext);
		// An oversized body loses its start, never the newest text.
		const long = [...entries(false)];
		long[1] = {
			...(long[1] as SessionEntry & { kind: "compactionSummary" }),
			summary: `## Goal\n${"x".repeat(80_000)}TAIL-MARKER`,
		};
		const cut = hostCheckpoint(long, "Step checkpoint.").summary;
		ok(cut.startsWith("[earlier checkpoint start truncated: "), cut.slice(0, 80));
		ok(cut.includes("TAIL-MARKER\n\n---\n\nStep checkpoint."), cut.slice(-200));
	});

	it("a settled step leads only the same session standing on the settled leaf", () => {
		const constraints = { turnPolicy: { mode: "step" as const, stepTool: STEP, template: "wtfp:advance" } };
		const a = { sessionId: "session-a", leafTurnId: "a-leaf" };
		const settled = () => {
			const tracker = createStepStartTracker();
			strictEqual(tracker.begin(constraints, BODY, false, { ...a, leafTurnId: "a-start" }), null);
			tracker.settle(constraints, "Session A finished the paper.", true, a);
			return tracker;
		};
		ok(settled().begin(constraints, BODY, true, a)?.includes("Session A finished the paper."));
		// m2b-D2: a new session is created at its first submit, after step one began; step one still seeds the chain.
		const created = createStepStartTracker();
		strictEqual(created.begin(constraints, BODY, false, { sessionId: null, leafTurnId: null }), null);
		created.settle(constraints, "Step one in the new session.", true, a);
		ok(created.begin(constraints, BODY, true, a)?.includes("Step one in the new session."));
		// A resumed session B invoking the same template never takes A's summary as its checkpoint lead.
		strictEqual(settled().begin(constraints, BODY, false, { sessionId: "session-b", leafTurnId: "a-leaf" }), null);
		// A tree navigation inside A left the settled leaf.
		strictEqual(settled().begin(constraints, BODY, false, { ...a, leafTurnId: "a-sibling" }), null);
		const reset = settled();
		reset.reset();
		strictEqual(reset.begin(constraints, BODY, true, a), null);
		// A late settlement from session A does not arm the chain session B began.
		const late = createStepStartTracker();
		late.begin(constraints, BODY, false, { sessionId: "session-b", leafTurnId: "b-leaf" });
		late.settle(constraints, "Session A finished the paper.", true, a);
		strictEqual(late.begin(constraints, BODY, true, a), null);
		strictEqual(late.begin(constraints, BODY, true, { sessionId: "session-b", leafTurnId: "b-leaf" }), null);
	});
});
