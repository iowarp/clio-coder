import assert from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { ClioSettings } from "../../src/core/config.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/index.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { toolResultSummary } from "../../src/interactive/chat-loop-messages.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildReplayAgentMessagesFromTurns, rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { appendOperatorCommand } from "../../src/interactive/command-output.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import type { ChatTurnState } from "../../src/interactive/turn-state.js";
import type { WorkerRunEntryFields, WorkerSettledFields } from "../../src/interactive/worker-replay.js";
import type { WorkerEntryState, WorkerReceiptFacts } from "../../src/interactive/worker-stream.js";

const usage = {
	input: 7,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function replay(items: Array<{ role: "user" | "assistant"; payload: unknown } | { retry: true }>): string {
	const entries: SessionEntry[] = items.map((item, index) => ({
		turnId: `turn-${index}`,
		parentTurnId: index === 0 ? null : `turn-${index - 1}`,
		timestamp: "2026-09-17T00:00:00Z",
		...("retry" in item
			? {
					kind: "custom" as const,
					customType: "retryStatus",
					data: { phase: "scheduled", attempt: 1, maxAttempts: 1, errorMessage: "HTTP 503 Unavailable" },
				}
			: { kind: "message" as const, ...item }),
	}));
	const panel = createChatPanel();
	rehydrateChatPanelFromTurns(panel, entries);
	return panel.render(120).map(stripTerminalSequences).join("\n");
}
const toolCall = {
	role: "assistant" as const,
	payload: {
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } }],
		usage,
	},
};
const success = {
	role: "assistant" as const,
	payload: { stopReason: "stop", content: [{ type: "text", text: "Recovered answer" }], usage },
};

for (const stopReason of ["error", "aborted"] as const) {
	test(`a later tool-use turn cannot stamp Done on a previous ${stopReason} replay`, () => {
		const output = replay([
			{ role: "user", payload: { text: "First request" } },
			{
				role: "assistant",
				payload: {
					stopReason,
					errorMessage: "HTTP 503 Request ended",
					content: [],
					usage: { ...usage, input: 0, output: 0, totalTokens: 0 },
				},
			},
			{ role: "user", payload: { text: "Second request" } },
			toolCall,
			success,
		]);
		const [first, second] = output.split("▌ Second request");
		assert.ok(first !== undefined && second !== undefined);
		assert.match(first, /503/);
		assert.doesNotMatch(first, /\bDone\b/);
		assert.match(second, /Recovered answer/);
		assert.match(second, /\bDone\b/);
	});
}

test("transient error followed by tool use and recovery retains one final success receipt", () => {
	const output = replay([
		{ role: "user", payload: { text: "One request" } },
		{ role: "assistant", payload: { stopReason: "error", errorMessage: "HTTP 503 Unavailable", content: [] } },
		{ retry: true },
		toolCall,
		success,
	]);
	assert.match(output, /503/);
	assert.match(output, /Recovered answer/);
	assert.equal((output.match(/\bDone\b/g) ?? []).length, 1);
	assert.ok(output.indexOf("Done") > output.indexOf("Recovered answer"));
});

test("actual final failure after tool use retains a failed outcome while success remains Done", () => {
	for (const stopReason of ["error", "aborted", "stop"] as const) {
		const output = replay([
			{ role: "user", payload: { text: "One request" } },
			toolCall,
			{
				role: "assistant",
				payload: { stopReason, errorMessage: "Request ended", content: [{ type: "text", text: "Final response" }], usage },
			},
		]);
		assert.match(output, stopReason === "error" ? /Failed/ : stopReason === "aborted" ? /Cancelled/ : /Done/);
		if (stopReason !== "stop") assert.doesNotMatch(output, /\bDone\b/);
	}
});

test("a replay ending at an intermediate tool-use message does not invent completion", () => {
	const output = replay([{ role: "user", payload: { text: "Incomplete request" } }, toolCall]);
	assert.doesNotMatch(output, /\bDone\b/);
});

test("a legacy replayed prompt drops the skill-request preamble the model received", () => {
	const composed = [
		"[Skill request]",
		"- test-hygiene (installed, source=slash-command) — task: pin the timers",
		'First call context with scope="skills" and name for: test-hygiene. Only these pending skill names are allowed this turn. After the skill loads, follow the loaded workflow.',
		"",
		"/skill test-hygiene pin the timers",
	].join("\n");
	const output = replay([{ role: "user", payload: { text: composed } }]);
	assert.doesNotMatch(output, /\[Skill request\]|Only these pending skill names/u);
	assert.match(output, /▌ \/skill test-hygiene pin the timers/u);
});

test("an unknown dynamic tool reads by its persisted action class, live and on replay", () => {
	const persisted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	const session = {
		append(turn: { kind: string; payload: Record<string, unknown> }) {
			persisted.push(turn);
			return { id: `persisted-${persisted.length}` };
		},
		current: () => null,
	} as unknown as SessionContract;
	const persistence = createTurnPersistence({
		state: { lastTurnId: null } as ChatTurnState,
		session,
		getSettings: () => ({}) as ClioSettings,
		middlewareToolChoice: {} as MiddlewareToolChoiceControl,
		consumePersistedEcho: () => false,
		removeQueuedMirrorEntry: () => {},
		promptCachePayloadForAssistant: () => ({}),
		promptSideTokens: () => 0,
	});
	const args = { stage: "staging" };
	// Enriched the way the turn runtime enriches every end event it forwards.
	const result = { content: [{ type: "text", text: "preview deployed" }], details: {} };
	const end = {
		type: "tool_execution_end" as const,
		toolCallId: "deploy-1",
		toolName: "deploy_preview",
		result,
		isError: false,
		durationMs: 1_200,
		resultSummary: toolResultSummary(result),
		actionClass: "execute",
	};
	persistence.appendToolResultTurn(end);
	assert.equal(persisted[0]?.payload.actionClass, "execute");

	const rowOf = (lines: string[]) => lines.map(stripTerminalSequences).find((line) => line.includes("deploy_preview"));
	const live = createChatPanel();
	live.applyEvent({
		type: "tool_execution_start",
		toolCallId: "deploy-1",
		toolName: "deploy_preview",
		args,
	} as ChatLoopEvent);
	live.applyEvent(end as ChatLoopEvent);
	const liveRow = rowOf(live.render(120));
	assert.equal(liveRow, "$ ran deploy_preview · stage staging · 16B ✓ · 1.2s");

	const replayed = createChatPanel();
	rehydrateChatPanelFromTurns(replayed, [
		{
			turnId: "turn-0",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "message",
			role: "tool_call",
			payload: { name: "deploy_preview", toolCallId: "deploy-1", args },
		},
		{
			turnId: "turn-1",
			parentTurnId: "turn-0",
			timestamp: "2026-09-17T00:00:01Z",
			kind: "message",
			role: "tool_result",
			payload: persisted[0]?.payload,
		},
	] as SessionEntry[]);
	assert.equal(rowOf(replayed.render(120)), liveRow);
});

test("a refused skill load reads the same live and on replay, from its persisted refusal", () => {
	const persisted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	const session = {
		append(turn: { kind: string; payload: Record<string, unknown> }) {
			persisted.push(turn);
			return { id: `persisted-${persisted.length}` };
		},
		current: () => null,
	} as unknown as SessionContract;
	const persistence = createTurnPersistence({
		state: { lastTurnId: null } as ChatTurnState,
		session,
		getSettings: () => ({}) as ClioSettings,
		middlewareToolChoice: {} as MiddlewareToolChoiceControl,
		consumePersistedEcho: () => false,
		removeQueuedMirrorEntry: () => {},
		promptCachePayloadForAssistant: () => ({}),
		promptSideTokens: () => 0,
	});
	const args = { scope: "skills", name: "tech-spec" };
	const result = {
		content: [{ type: "text", text: 'context: skill "tech-spec" requires explicit operator activation.' }],
		details: { refusal: { subject: "skill", name: "tech-spec", kind: "manual-only" } },
	};
	const end = {
		type: "tool_execution_end" as const,
		toolCallId: "load-1",
		toolName: "context",
		result,
		isError: true,
		resultSummary: toolResultSummary(result),
	};
	persistence.appendToolResultTurn(end);

	// A fixed clock keeps the live row's optional duration out of this replay
	// parity check, even when the suite pauses between start and end events.
	const live = createChatPanel({ now: () => Date.parse("2026-09-17T00:00:00Z") });
	live.applyEvent({ type: "tool_execution_start", toolCallId: "load-1", toolName: "context", args } as ChatLoopEvent);
	live.applyEvent(end as ChatLoopEvent);
	const plain = (lines: string[]) => lines.map(stripTerminalSequences).filter((line) => line.length > 0);
	assert.deepEqual(plain(live.render(120)), ["§ skill tech-spec not loaded · manual-only: /skill tech-spec ✗"]);

	const replayed = createChatPanel();
	rehydrateChatPanelFromTurns(replayed, [
		{
			turnId: "turn-0",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "message",
			role: "tool_call",
			payload: { name: "context", toolCallId: "load-1", args },
		},
		{
			turnId: "turn-1",
			parentTurnId: "turn-0",
			timestamp: "2026-09-17T00:00:01Z",
			kind: "message",
			role: "tool_result",
			payload: persisted[0]?.payload,
		},
	] as SessionEntry[]);
	assert.deepEqual(plain(replayed.render(120)), plain(live.render(120)));
});

test("a replayed receipt states the duration and cold-cache reasons the live one did", () => {
	const plainRows = (panel: ReturnType<typeof createChatPanel>) =>
		panel
			.render(120)
			.map(stripTerminalSequences)
			.filter((line) => line.length > 0);
	const final = {
		role: "assistant" as const,
		content: [{ type: "text", text: "Answer" }],
		stopReason: "stop",
		usage,
	};
	// Live: the run measures its own clock, and the chat loop's footer cache
	// notice hands the transcript the reasons it expected a cold cache for.
	let clock = 1_000;
	const live = createChatPanel({ now: () => clock, getOutputStyle: () => "detailed" });
	live.applyEvent({ type: "agent_start" } as ChatLoopEvent);
	live.applyEvent({
		type: "notice",
		level: "info",
		surface: "footer",
		text: "cache may be cold: prompt recompiled",
		key: "context.cache.cold",
		coldReasons: ["prompt_recompiled"],
	} as ChatLoopEvent);
	live.applyEvent({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as ChatLoopEvent);
	live.applyEvent({ type: "message_end", message: final } as unknown as ChatLoopEvent);
	clock += 5_000;
	live.applyEvent({ type: "agent_end", messages: [final] } as unknown as ChatLoopEvent);
	const liveRows = plainRows(live);
	assert.equal(liveRows.at(-1), "✓ Done · 5.0s · in 7 · out 5 · cold: prompt recompiled");
	assert.doesNotMatch(liveRows.join("\n"), /cache may be cold/u, "the notice itself stays in the footer");

	// Replay: the same facts from the ledger's timestamps and prompt-cache record.
	const replayed = createChatPanel({ getOutputStyle: () => "detailed" });
	rehydrateChatPanelFromTurns(replayed, [
		{
			turnId: "u",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00.000Z",
			kind: "message",
			role: "user",
			payload: { text: "Question" },
		},
		{
			turnId: "a",
			parentTurnId: "u",
			timestamp: "2026-09-17T00:00:05.000Z",
			kind: "message",
			role: "assistant",
			payload: {
				...final,
				promptCache: { input: 7, cacheRead: 0, cacheWrite: 0, expectedColdReasons: ["prompt_recompiled"] },
			},
		},
	] as SessionEntry[]);
	assert.equal(plainRows(replayed).at(-1), liveRows.at(-1));

	// A cache that served tokens was not cold: the receipt states the reuse instead.
	const warm = createChatPanel({ getOutputStyle: () => "detailed" });
	const cached = { ...final, usage: { ...usage, cacheRead: 68_608 } };
	rehydrateChatPanelFromTurns(warm, [
		{
			turnId: "u",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "message",
			role: "user",
			payload: { text: "Q" },
		},
		{
			turnId: "a",
			parentTurnId: "u",
			timestamp: "2026-09-17T00:01:36Z",
			kind: "message",
			role: "assistant",
			payload: { ...cached, promptCache: { expectedColdReasons: ["dispatch"] } },
		},
	] as SessionEntry[]);
	assert.equal(plainRows(warm).at(-1), "✓ Done · 1m36s · in 7 · out 5 · cached 68.6k");
});

test("a middleware reminder reads the same live and on replay, and a skill activation adds no line", () => {
	const message = "[Clio Coder] This turn used 9+ read-only exploration calls without a successful Scout dispatch.";
	const rows = (panel: ReturnType<typeof createChatPanel>) =>
		panel
			.render(60)
			.map(stripTerminalSequences)
			.filter((line) => line.length > 0);
	const live = createChatPanel();
	live.applyEvent({ type: "notice", level: "info", surface: "transcript", text: message } as ChatLoopEvent);
	const replayed = createChatPanel();
	rehydrateChatPanelFromTurns(replayed, [
		{
			turnId: "r",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "custom",
			customType: "middlewareReminder",
			display: true,
			data: { message, severity: "advisory" },
		},
		{
			turnId: "s",
			parentTurnId: "r",
			timestamp: "2026-09-17T00:00:01Z",
			kind: "skillActivation",
			activation: {
				name: "tdd",
				filePath: "/skills/tdd/SKILL.md",
				hash: "a".repeat(64),
				source: "clio-coder",
				triggeredBy: "tool",
				turnId: "s",
				drift: "match",
			},
		},
	] as SessionEntry[]);
	assert.equal(rows(live)[0], "ℹ This turn used 9+ read-only exploration calls without a");
	assert.deepEqual(rows(replayed), rows(live));
	assert.doesNotMatch(rows(replayed).join("\n"), /\[skill\]/u);
});

test("a replayed act states the age its ledger entry records in /view, not the age of the resume", () => {
	const entries = [
		{
			turnId: "turn-0",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "message",
			role: "user",
			payload: { text: "run the tests" },
		},
		{
			turnId: "turn-1",
			parentTurnId: "turn-0",
			timestamp: "2026-09-17T00:01:00Z",
			kind: "message",
			role: "tool_call",
			payload: { name: "bash", toolCallId: "b1", args: { command: "npm test" } },
		},
		{
			turnId: "turn-2",
			parentTurnId: "turn-1",
			timestamp: "2026-09-17T00:01:02Z",
			kind: "message",
			role: "tool_result",
			payload: { toolCallId: "b1", toolName: "bash", result: "ok", isError: false },
		},
		{
			turnId: "turn-3",
			parentTurnId: "turn-2",
			timestamp: "2026-09-17T00:05:00Z",
			kind: "modelChange",
			provider: "dynamo",
			modelId: "qwopus",
			target: "blade",
		},
	] as SessionEntry[];
	let clock = Date.parse("2026-09-23T12:00:00Z");
	const panel = createChatPanel({ now: () => clock });
	rehydrateChatPanelFromTurns(panel, entries);
	const stamps = panel
		.inspectionArtifacts()
		.map((artifact) => [artifact.title, new Date(artifact.timestamp).toISOString()]);
	assert.deepEqual(stamps, [
		["$ ran `npm test`", "2026-09-17T00:01:00.000Z"],
		["ℹ [model] blade/dynamo/qwopus", "2026-09-17T00:05:00.000Z"],
	]);
	// Live acts after the resume carry the live clock again.
	clock += 1_000;
	panel.applyEvent({ type: "notice", level: "info", surface: "transcript", text: "back live" } as never);
	assert.equal(panel.inspectionArtifacts().at(-1)?.timestamp, clock);
});

test("an operator /run resumes with its command above its card and the spend its live card stated", () => {
	const noop = (): void => undefined;
	const receipt: WorkerReceiptFacts = {
		outcome: "succeeded",
		durationMs: 42_000,
		tokenCount: 18_200,
		toolCalls: 7,
		text: "Documented the retry options.",
	};
	// Live: the host records the run as it starts and what its stream knew as it settles.
	const bus = createSafeEventBus();
	const runs: WorkerRunEntryFields[] = [];
	const settled: WorkerSettledFields[] = [];
	let liveState: WorkerEntryState | undefined;
	const subscriptions = createInteractiveSubscriptions({
		bus,
		refreshFooter: noop,
		renderTaskIsland: noop,
		renderContextIsland: noop,
		requestRender: noop,
		notify: noop,
		applyWorkerState: (state) => {
			liveState = state;
		},
		recordWorkerRun: (fields) => runs.push(fields),
		recordWorkerSettled: (fields) => settled.push(fields),
		readWorkerReceipt: () => receipt,
	});
	const identity = {
		agentId: "documenter",
		requestOrigin: "user" as const,
		targetId: "blade",
		wireModelId: "dynamo/qwopus",
		runtimeId: "blade",
		runtimeKind: "http" as const,
	};
	bus.emit(BusChannels.DispatchStarted, {
		...identity,
		runId: "run-d",
		pid: null,
		assignmentId: "run-d",
		attempt: 0,
	} as never);
	bus.emit(BusChannels.DispatchProgress, {
		...identity,
		runId: "run-d",
		event: {
			type: "message_end",
			message: { role: "assistant", usage: { input: 5_000, output: 1_000, cacheRead: 0, cacheWrite: 200 } },
		},
	} as never);
	bus.emit(BusChannels.DispatchCompleted, { ...identity, runId: "run-d", outcome: "succeeded" } as never);
	subscriptions.dispose();
	assert.deepEqual(settled, [{ runId: "run-d", contextTokens: 6_200 }]);
	const command = "/run documenter --target blade --model dynamo/qwopus document the retry options";
	const live = createChatPanel();
	appendOperatorCommand(command, { appendReplayBlock: (block) => live.appendReplayBlock(block), requestRender: noop });
	assert.ok(liveState);
	live.applyWorkerState(liveState);
	// Resume: the ledger holds the echo, the run and the settled fact, in that order.
	const timestamp = "2026-09-23T10:00:00Z";
	const entries = [
		{
			turnId: "c",
			parentTurnId: null,
			timestamp,
			kind: "custom",
			customType: "operatorCommand",
			data: { text: command },
		},
		{ ...runs[0], turnId: "w", parentTurnId: null, timestamp },
		{
			turnId: "s",
			parentTurnId: null,
			timestamp,
			kind: "custom",
			customType: "workerSettled",
			display: false,
			data: settled[0],
		},
	] as SessionEntry[];
	const replayed = createChatPanel();
	rehydrateChatPanelFromTurns(replayed, entries, { readWorkerReceipt: () => receipt });
	const plain = (panel: ReturnType<typeof createChatPanel>) => panel.render(100).map(stripTerminalSequences).join("\n");
	assert.match(plain(replayed), /^▌ \/run documenter --target blade/u);
	assert.match(plain(replayed), /context 6\.2k/u);
	assert.equal(plain(replayed), plain(live));
	// The echo is a display record: the model's replayed context never carries it.
	assert.doesNotMatch(JSON.stringify(buildReplayAgentMessagesFromTurns(entries)), /document the retry options/u);
});

test("the TUI echoes an operator command and hands the host the same line to record", () => {
	const blocks: Array<(width: number) => string[]> = [];
	const recorded: string[] = [];
	const runtime = createInteractiveSlashRuntime({
		io: { stdout() {}, stderr() {} },
		chatPanel: { appendReplayBlock: (block: (width: number) => string[]) => blocks.push(block), appendUser() {} },
		requestRender() {},
		refreshFooter() {},
		recordSubmittedTurn() {},
		recordOperatorCommand: (text: string) => recorded.push(text),
	} as unknown as InteractiveSlashRuntimeDeps);
	runtime.context.echoOperatorCommand?.("/run documenter document the retry options");
	assert.deepEqual(recorded, ["/run documenter document the retry options"]);
	assert.deepEqual(blocks.flatMap((block) => block(80)).map(stripTerminalSequences), [
		"▌ /run documenter document the retry options",
	]);
});
