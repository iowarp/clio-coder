/**
 * A real session on disk, driven through the real compaction stage.
 *
 * The working-set unit tests are pure over entry arrays. These scenarios ask a
 * different question: does the layer hold when the ledger is the engine's own
 * JSONL writer, the projection is the one `refreshAgentMessagesFromSession`
 * installs on the agent, and the readers are the ones `/resume`, `/export`, and
 * `clio-coder evidence build` actually call. So nothing here fakes the session
 * contract: `createSessionBundle` writes through `engine/session.ts` into an
 * isolated CLIO_CODER_HOME, and every assertion reads it back the way the
 * product does.
 *
 * The one stub is the model. Compaction is triggered by pressure, and pressure
 * is `estimateAgentContextTokens` over the agent's message list, so the harness
 * seeds that list from the ledger through the same replay builder the chat loop
 * uses. No provider is contacted and no summary model runs unless a scenario
 * asks for one.
 *
 * Determinism: every seeded turn carries an explicit id and timestamp, so a
 * scenario's assertions never depend on a clock. The `contextEviction` record
 * the stage appends gets its turnId and timestamp from the session writer;
 * scenarios assert its shape, never those two fields.
 *
 * One harness at a time. `isolateClioEnv` holds a process-wide lock on the
 * CLIO_CODER_* environment for the life of the window, so a scenario that
 * builds a second harness before disposing the first deadlocks rather than
 * failing. Sequence them.
 */

import { readFileSync } from "node:fs";
import { BusChannels, type ContextPrunedPayload } from "../../src/core/bus-events.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, type WorkingSetPolicyId } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { createTurnContext, type TurnContext } from "../../src/interactive/turn-context.js";
import { type AgentRuntime, type ChatTurnState, createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "./scratch-env.js";

/** First seeded timestamp. Every later entry is this plus one second per step. */
const CLOCK_START = Date.parse("2026-08-21T00:00:00.000Z");

export function scenarioTimestamp(step: number): string {
	return new Date(CLOCK_START + step * 1000).toISOString();
}

export interface ScenarioToolCall {
	callId: string;
	tool: string;
	args: Record<string, unknown>;
	/** The tool-result body, verbatim. Scenarios assert on these bytes. */
	body: string;
	isError?: boolean;
	/** Present on `write` and `edit` results the path index reads as mutations. */
	details?: Record<string, unknown>;
}

export interface ScenarioTurn {
	/** Turn id prefix; entries are `<id>-user`, `<id>-call-<n>`, `<id>-result-<n>`, `<id>-assistant`. */
	id: string;
	user: string;
	calls?: ReadonlyArray<ScenarioToolCall>;
	/** An assistant turn closing the turn. `thinking` becomes a thinking content block. */
	assistant?: { text?: string; thinking?: string };
}

/** Bodies large enough to matter, stable enough to assert on byte-for-byte. */
export function scenarioBody(label: string, lines: number): string {
	return Array.from(
		{ length: lines },
		(_, index) => `${label} line ${String(index + 1).padStart(4, "0")} :: deterministic working-set scenario payload`,
	).join("\n");
}

function toolResultPayload(call: ScenarioToolCall): Record<string, unknown> {
	return {
		toolCallId: call.callId,
		toolName: call.tool,
		result: {
			content: [{ type: "text", text: call.body }],
			details: {
				resultSize: { bytes: call.body.length, shownBytes: call.body.length, truncated: false },
				...(call.details ?? {}),
			},
		},
		isError: call.isError === true,
		resultSummary: { bytes: call.body.length, truncated: false },
	};
}

function assistantPayload(assistant: { text?: string; thinking?: string }): Record<string, unknown> {
	const content: unknown[] = [];
	if (assistant.thinking !== undefined) content.push({ type: "thinking", thinking: assistant.thinking });
	content.push({ type: "text", text: assistant.text ?? "ok" });
	return { content, stopReason: "stop" };
}

export interface SeedResult {
	/** Turn id of the last appended message: the session leaf. */
	leafTurnId: string;
	/** Every tool-result turn id, in ledger order. */
	resultTurnIds: string[];
	/** Body by tool-result turn id, so a scenario can assert bytes without re-deriving them. */
	bodyByRef: Map<string, string>;
}

/**
 * Append a scripted conversation through the real session writer. Every append
 * chains onto the previous one, which is the invariant `session.append`
 * enforces, so this is the same sequence a live turn would produce.
 */
export function seedScenarioTurns(
	session: SessionContract,
	turns: ReadonlyArray<ScenarioTurn>,
	startStep = 1,
	/** Chain onto an existing turn, e.g. the pin a `/tree` switch just set. Null starts a root. */
	parentTurnId: string | null = null,
): SeedResult {
	let parentId: string | null = parentTurnId;
	let step = startStep;
	const resultTurnIds: string[] = [];
	const bodyByRef = new Map<string, string>();
	const next = (): string => scenarioTimestamp(step++);

	for (const turn of turns) {
		parentId = session.append({
			id: `${turn.id}-user`,
			parentId,
			at: next(),
			kind: "user",
			payload: { text: turn.user },
		}).id;
		let callIndex = 0;
		for (const call of turn.calls ?? []) {
			callIndex += 1;
			parentId = session.append({
				id: `${turn.id}-call-${callIndex}`,
				parentId,
				at: next(),
				kind: "tool_call",
				payload: { toolCallId: call.callId, toolName: call.tool, name: call.tool, args: call.args },
			}).id;
			const resultId = `${turn.id}-result-${callIndex}`;
			parentId = session.append({
				id: resultId,
				parentId,
				at: next(),
				kind: "tool_result",
				payload: toolResultPayload(call),
			}).id;
			resultTurnIds.push(resultId);
			bodyByRef.set(resultId, call.body);
		}
		if (turn.assistant !== undefined) {
			parentId = session.append({
				id: `${turn.id}-assistant`,
				parentId,
				at: next(),
				kind: "assistant",
				payload: assistantPayload(turn.assistant),
			}).id;
		}
	}
	if (parentId === null) throw new Error("seedScenarioTurns: no turns seeded");
	return { leafTurnId: parentId, resultTurnIds, bodyByRef };
}

export interface ScenarioHarnessOptions {
	prefix: string;
	contextWindow?: number;
	threshold?: number;
	policy?: WorkingSetPolicyId;
	workingSetEnabled?: boolean;
	protectLastTurns?: number;
	minEvictableTokens?: number;
	target?: number;
	/** Present means the summary stage has somewhere to go; absent means it is a no-op. */
	autoCompact?: () => Promise<null>;
}

export interface ScenarioHarness {
	/** Isolated workspace root; also the session cwd the path index resolves against. */
	cwd: string;
	session: SessionContract;
	settings: ClioSettings;
	state: ChatTurnState;
	runtime: AgentRuntime;
	context: TurnContext;
	bus: SafeEventBus;
	notices: string[];
	hookStages: string[];
	pruned: ContextPrunedPayload[];
	summaryCalls: () => number;
	/** Entries as the product reads them: the engine's turn reader over current.jsonl. */
	entries: () => SessionEntry[];
	/** The ledger file verbatim, for byte-for-byte survival checks. */
	rawLedger: () => string;
	sessionId: () => string;
	/** Rebuild the agent's message list from the ledger, so the pressure check is real. */
	syncRuntimeFromLedger: (leafTurnId: string) => void;
	dispose: () => Promise<void>;
}

function scenarioSettings(options: ScenarioHarnessOptions): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	settings.compaction.threshold = options.threshold ?? 0.8;
	settings.compaction.excludeLastTurns = 1;
	settings.context.workingSet.enabled = options.workingSetEnabled ?? true;
	settings.context.workingSet.policy = options.policy ?? "age-horizon";
	if (options.protectLastTurns !== undefined) settings.context.workingSet.protectLastTurns = options.protectLastTurns;
	if (options.minEvictableTokens !== undefined) {
		settings.context.workingSet.minEvictableTokens = options.minEvictableTokens;
	}
	if (options.target !== undefined) settings.context.workingSet.target = options.target;
	return settings;
}

/**
 * The agent the turn context drives. Only the four fields the pressure
 * estimator and the snapshot capture read are real; nothing here contacts a
 * provider, and `messages` is always rebuilt from the ledger by the same
 * builder the chat loop uses.
 */
function scenarioRuntime(contextWindow: number): AgentRuntime {
	return {
		targetId: "scenario-target",
		runtimeId: "scenario-runtime",
		wireModelId: "scenario-model",
		agent: {
			sessionId: undefined,
			state: {
				systemPrompt: "",
				messages: [] as AgentMessage[],
				tools: [],
				model: undefined,
				thinkingLevel: "off",
			},
		} as never,
		runtimeResolution: {
			contextWindowDetails: {
				desiredContextWindow: contextWindow,
				effectiveContextWindow: contextWindow,
				contextWindowSource: "descriptor-default",
			},
		} as never,
	};
}

export async function createScenarioHarness(options: ScenarioHarnessOptions): Promise<ScenarioHarness> {
	const isolated: IsolatedClioEnv = await isolateClioEnv(options.prefix);
	const bus = createSafeEventBus();
	const domainContext = { bus, getContract: () => undefined } as unknown as DomainContext;
	const session = createSessionBundle(domainContext).contract;
	session.create({ cwd: isolated.dir, model: "scenario-model", target: "scenario-target" });

	const settings = scenarioSettings(options);
	const contextWindow = options.contextWindow ?? 32_000;
	const state = createTurnState("off");
	const runtime = scenarioRuntime(contextWindow);
	state.runtime = runtime;

	const notices: string[] = [];
	const hookStages: string[] = [];
	const pruned: ContextPrunedPayload[] = [];
	bus.on(BusChannels.ContextPruned, (payload) => {
		pruned.push(payload);
	});
	let summaryCalls = 0;

	const entries = (): SessionEntry[] => {
		const meta = session.current();
		if (!meta) return [];
		return collectSessionEntries(openSession(meta.id).turns(), sessionPaths(meta).current);
	};

	const context = createTurnContext({
		state,
		getSettings: () => settings,
		providers: { getRuntime: () => null } as never,
		session,
		readSessionEntries: entries,
		...(options.autoCompact
			? {
					autoCompact: async () => {
						summaryCalls += 1;
						return options.autoCompact ? await options.autoCompact() : null;
					},
				}
			: {}),
		bus,
		middleware: {
			fireCompactionHook(stage: string) {
				hookStages.push(stage);
			},
		} as never,
		emitNotice: (text: string) => notices.push(text),
	});

	return {
		cwd: isolated.dir,
		session,
		settings,
		state,
		runtime,
		context,
		bus,
		notices,
		hookStages,
		pruned,
		summaryCalls: () => summaryCalls,
		entries,
		rawLedger: () => {
			const meta = session.current();
			return meta ? readFileSync(sessionPaths(meta).current, "utf8") : "";
		},
		sessionId: () => session.current()?.id ?? "",
		syncRuntimeFromLedger: (leafTurnId: string) => {
			state.lastTurnId = leafTurnId;
			runtime.agent.state.messages = buildModelReplayAgentMessagesFromTurns(entries(), { activeLeafTurnId: leafTurnId });
		},
		dispose: async () => {
			context.dispose();
			await session.close();
			isolated.restore();
		},
	};
}

/**
 * Every string the model would actually read, joined. Walking the message tree
 * rather than stringifying it keeps newlines and quotes unescaped, so an
 * assertion can compare against the seeded body byte-for-byte.
 */
export function projectionText(runtime: AgentRuntime): string {
	const parts: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			parts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value !== null && typeof value === "object") {
			for (const item of Object.values(value)) walk(item);
		}
	};
	walk(runtime.agent.state.messages);
	return parts.join("\n");
}

export function evictionEntries(
	entries: ReadonlyArray<SessionEntry>,
): Array<Extract<SessionEntry, { kind: "contextEviction" }>> {
	return entries.filter(
		(entry): entry is Extract<SessionEntry, { kind: "contextEviction" }> => entry.kind === "contextEviction",
	);
}

export function recallEntries(
	entries: ReadonlyArray<SessionEntry>,
): Array<Extract<SessionEntry, { kind: "contextRecall" }>> {
	return entries.filter(
		(entry): entry is Extract<SessionEntry, { kind: "contextRecall" }> => entry.kind === "contextRecall",
	);
}

/** Body of one tool-result entry exactly as the ledger holds it. */
export function ledgerBody(entries: ReadonlyArray<SessionEntry>, turnId: string): string {
	const entry = entries.find((candidate) => candidate.turnId === turnId);
	if (entry === undefined || entry.kind !== "message" || entry.role !== "tool_result") return "";
	const payload = entry.payload as { result?: { content?: Array<{ type?: string; text?: string }> } };
	const parts = payload.result?.content ?? [];
	return parts
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}
