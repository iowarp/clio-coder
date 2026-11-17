import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModelTier } from "../../src/core/model-tier.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
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

interface Run {
	histories: string[];
	/** The text each request adds after its history: the turn's reminders and its prompt. */
	texts: string[];
	entries: SessionEntry[];
	continued: string[];
	close(): Promise<void>;
}

async function stepDrive(route: { model: string; tier: ModelTier; uncached?: boolean }): Promise<Run> {
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
	const entries: SessionEntry[] = [];
	let leaf: string | null = null;
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
		pinnedContext: () => [{ extensionId: "wtfp", text: "Milestone 2: methods. Next: plan-section" }],
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
							state.messages.push({
								role: "assistant",
								content: [{ type: "toolCall", id: "call-1", name: STEP, arguments: { after: "start" } }],
								stopReason: "toolUse",
								timestamp: Date.now(),
							} as unknown as AgentMessage);
							state.messages.push({
								role: "toolResult",
								toolCallId: "call-1",
								toolName: STEP,
								content: [{ type: "text", text: MARKER }],
								isError: false,
								timestamp: Date.now(),
							} as unknown as AgentMessage);
							// A second step-tool call was refused: the step policy ended the turn.
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
		close: async () => {
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
			strictEqual(run.continued[0], "tool_budget");
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
});
