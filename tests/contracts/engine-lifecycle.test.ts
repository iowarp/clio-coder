/**
 * Engine lifecycle contracts for the pi 0.84.4 agent loop.
 *
 * These lock the ordering Clio's turn runtime relies on after the 0.84.4
 * `prepareNextTurn` change: preparation runs only when the loop is about to
 * start another assistant turn, never after a final or terminating turn;
 * steering and follow-up messages queued while preparation runs are delivered
 * before that next assistant call; a preparation failure still closes the run
 * through the `agent_end` path Clio finalizes ledgers on; `Agent.reset()` is
 * refused while a run is active, which is why every Clio session reset settles
 * the run first. The remaining cases cover the inherited tool-argument
 * normalization, the widened pi-tui keybinding table, and the alternate-screen
 * render seams Clio instruments.
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CLIO_APP_KEYBINDINGS, CLIO_KEYBINDINGS } from "../../src/domains/config/keybindings.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { StringEnum, validateEngineToolArguments } from "../../src/engine/ai.js";
import {
	InstrumentedTuiAltScreen,
	type TuiRenderObserver,
	type TuiRenderPhase,
} from "../../src/engine/instrumented-tui.js";
import { Text, TUI_KEYBINDINGS } from "../../src/engine/tui.js";
import type { AgentEvent, AgentTool, EngineModel } from "../../src/engine/types.js";

const MODEL: EngineModel = {
	id: "stub-model",
	name: "stub-model",
	api: "openai-completions",
	provider: "stub",
	baseUrl: "https://stub.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
} as Model<"openai-completions">;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "stub",
		model: "stub-model",
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason,
		timestamp: Date.now(),
	};
}

function toolTurn(id: string, args: Record<string, unknown>): AssistantMessage {
	return assistant([{ type: "toolCall", id, name: "echo", arguments: args }], "toolUse");
}

function finalTurn(text = "done"): AssistantMessage {
	return assistant([{ type: "text", text }], "stop");
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function roleOf(message: unknown): string {
	return typeof message === "object" && message !== null && "role" in message ? String(message.role) : "?";
}

function userText(message: unknown): string {
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
			.join("");
	}
	return String(content);
}

function userTexts(messages: ReadonlyArray<unknown>): string[] {
	return messages.filter((message) => roleOf(message) === "user").map(userText);
}

/**
 * A scripted provider: each call answers with the next scripted assistant
 * message and records the context it was handed plus a timeline entry, so a
 * test can assert what ran before which provider call.
 */
function scriptedProvider(script: AssistantMessage[], timeline: string[]) {
	const calls: Context[] = [];
	const streamFn = (_model: Model<"openai-completions">, context: Context, _options?: SimpleStreamOptions) => {
		const next = script.shift();
		if (!next) throw new Error(`scripted provider exhausted after ${calls.length} call(s)`);
		calls.push({ ...context, messages: [...context.messages] });
		timeline.push(`llm:${calls.length}`);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: next.stopReason === "toolUse" ? "toolUse" : "stop", message: next });
		});
		return stream;
	};
	return { calls, streamFn: streamFn as unknown as StreamFn };
}

const echoSchema = Type.Object({
	value: Type.String(),
	terminate: Type.Optional(Type.Boolean()),
});

function echoTool(timeline: string[], onExecute?: () => void): AgentTool<typeof echoSchema, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "echo",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			timeline.push(`tool:${params.value}`);
			onExecute?.();
			return {
				content: [{ type: "text", text: `echoed ${params.value}` }],
				details: { value: params.value },
				...(params.terminate === true ? { terminate: true } : {}),
			};
		},
	};
}

interface RunFixture {
	timeline: string[];
	events: AgentEvent[];
	prepareTails: string[];
	provider: ReturnType<typeof scriptedProvider>;
	agent: ReturnType<typeof createEngineAgent>["agent"];
}

function buildRun(
	script: AssistantMessage[],
	options: {
		prepare?: (fixture: RunFixture) => Promise<void> | void;
		onExecute?: (fixture: RunFixture) => void;
	} = {},
): RunFixture {
	const timeline: string[] = [];
	const events: AgentEvent[] = [];
	const prepareTails: string[] = [];
	const provider = scriptedProvider(script, timeline);
	const fixture = { timeline, events, prepareTails, provider } as RunFixture;
	const handle = createEngineAgent({
		streamFn: provider.streamFn,
		initialState: {
			systemPrompt: "system",
			model: MODEL,
			thinkingLevel: "off",
			tools: [echoTool(timeline, () => options.onExecute?.(fixture))],
			messages: [],
		},
	});
	fixture.agent = handle.agent;
	// Mirrors src/interactive/turn-runtime.ts: the continuation guard installs as
	// `prepareNextTurn` and inspects the agent-state tail exactly as
	// postToolContinuationGuard does.
	handle.agent.prepareNextTurn = async () => {
		const messages = handle.agent.state.messages;
		prepareTails.push(roleOf(messages[messages.length - 1]));
		timeline.push("prepare");
		await options.prepare?.(fixture);
		return undefined;
	};
	handle.agent.subscribe((event) => {
		events.push(event);
	});
	return fixture;
}

function eventTypes(events: ReadonlyArray<AgentEvent>): string[] {
	return events.map((event) => event.type);
}

describe("engine lifecycle: prepareNextTurn runs only before another assistant turn", () => {
	it("prepares once between a tool batch and its continuation, never after the final turn", async () => {
		const run = buildRun([toolTurn("call-1", { value: "one" }), finalTurn()]);
		await run.agent.prompt("go");

		deepStrictEqual(run.timeline, ["llm:1", "tool:one", "prepare", "llm:2"]);
		deepStrictEqual(run.prepareTails, ["toolResult"], "the guard only ever sees a tool-result tail");
		strictEqual(run.provider.calls.length, 2);
		const types = eventTypes(run.events);
		strictEqual(types.filter((type) => type === "turn_start").length, 2, "the opening turn and one continuation");
		strictEqual(types.filter((type) => type === "turn_end").length, 2);
		strictEqual(types[types.length - 1], "agent_end");
		// The continuation's turn_start is emitted after preparation returns, so
		// the first turn_end precedes the second turn_start and nothing from the
		// second turn is observable while the guard runs.
		const secondTurnStart = types.indexOf("turn_start", types.indexOf("turn_start") + 1);
		const firstTurnEnd = types.indexOf("turn_end");
		ok(firstTurnEnd < secondTurnStart, "turn_end of the tool turn precedes the continuation turn_start");
	});

	it("skips preparation entirely after a terminating tool batch", async () => {
		const run = buildRun([toolTurn("call-1", { value: "artifact", terminate: true })]);
		await run.agent.prompt("write it");

		deepStrictEqual(run.timeline, ["llm:1", "tool:artifact"]);
		deepStrictEqual(run.prepareTails, [], "no continuation is coming, so the guard never runs");
		strictEqual(run.provider.calls.length, 1, "no follow-up provider call after a terminating batch");
		const types = eventTypes(run.events);
		strictEqual(types[types.length - 1], "agent_end", "the run still closes through agent_end");
		const end = run.events.find((event) => event.type === "tool_execution_end");
		ok(end && end.type === "tool_execution_end");
		strictEqual(
			(end.result as { terminate?: boolean }).terminate,
			true,
			"terminate reaches the event Clio persists from",
		);
		strictEqual(roleOf(run.agent.state.messages[run.agent.state.messages.length - 1]), "toolResult");
		strictEqual(run.agent.state.isStreaming, false);
	});

	it("delivers a steer queued during preparation before the next assistant call", async () => {
		const run = buildRun([toolTurn("call-1", { value: "one" }), finalTurn()], {
			prepare: async (fixture) => {
				fixture.agent.steer(user("steer while compacting"));
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
		});
		await run.agent.prompt("go");

		deepStrictEqual(run.timeline, ["llm:1", "tool:one", "prepare", "llm:2"]);
		const second = run.provider.calls[1];
		ok(second);
		deepStrictEqual(userTexts(second.messages), ["go", "steer while compacting"]);
		deepStrictEqual(
			second.messages.slice(-2).map(roleOf),
			["toolResult", "user"],
			"the steer lands after the tool result and before the continuation",
		);
		// The steer's message_end (Clio's queue-to-transcript moment) fires before
		// the second provider call starts.
		const steerEnd = run.events.findIndex(
			(event) =>
				event.type === "message_end" &&
				roleOf(event.message) === "user" &&
				userText(event.message) === "steer while compacting",
		);
		const assistantStarts = run.events
			.map((event, index) => (event.type === "message_start" && roleOf(event.message) === "assistant" ? index : -1))
			.filter((index) => index >= 0);
		ok(steerEnd >= 0 && assistantStarts[1] !== undefined && steerEnd < assistantStarts[1]);
	});

	it("prepares once before a follow-up turn that continues a terminated batch", async () => {
		const run = buildRun([toolTurn("call-1", { value: "artifact", terminate: true }), finalTurn("answered follow-up")], {
			onExecute: (fixture) => fixture.agent.followUp(user("and then?")),
		});
		await run.agent.prompt("write it");

		deepStrictEqual(run.timeline, ["llm:1", "tool:artifact", "prepare", "llm:2"]);
		deepStrictEqual(run.prepareTails, ["toolResult"], "the guard sees the terminated batch as the tail it must protect");
		const second = run.provider.calls[1];
		ok(second);
		deepStrictEqual(userTexts(second.messages), ["write it", "and then?"]);
		strictEqual(eventTypes(run.events).filter((type) => type === "agent_end").length, 1, "one run, one agent_end");
	});

	it("closes a run through agent_end when preparation throws", async () => {
		const run = buildRun([toolTurn("call-1", { value: "one" }), finalTurn()], {
			prepare: () => {
				throw new Error("[Clio Coder] post-tool context guard stopped continuation before provider call");
			},
		});
		await run.agent.prompt("go");

		deepStrictEqual(run.timeline, ["llm:1", "tool:one", "prepare"], "no provider call follows a failed guard");
		const types = eventTypes(run.events);
		deepStrictEqual(types.slice(-4), ["message_start", "message_end", "turn_end", "agent_end"]);
		const failure = run.agent.state.messages[run.agent.state.messages.length - 1] as AssistantMessage;
		strictEqual(failure.role, "assistant");
		strictEqual(failure.stopReason, "error");
		ok(failure.errorMessage?.includes("post-tool context guard"));
		strictEqual(run.agent.state.isStreaming, false);
	});
});

describe("engine lifecycle: transcript resets wait for the run to settle", () => {
	it("refuses Agent.reset() while a run is active and accepts it once idle", async () => {
		const timeline: string[] = [];
		const provider = scriptedProvider([finalTurn()], timeline);
		const handle = createEngineAgent({
			streamFn: (async (model: Model<"openai-completions">, context: Context, options?: SimpleStreamOptions) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return provider.streamFn(model, context, options);
			}) as unknown as StreamFn,
			initialState: { systemPrompt: "system", model: MODEL, thinkingLevel: "off", tools: [], messages: [] },
		});
		const run = handle.agent.prompt("go");
		throws(() => handle.agent.reset(), /already processing/, "0.84.1+: reset is rejected mid-run");
		strictEqual(handle.agent.state.isStreaming, true, "the rejected reset left the run untouched");

		// Clio's resetForSession callers cancel and await settlement first
		// (session-switch-settlement.ts). After that the same reset is accepted.
		handle.agent.abort();
		await handle.agent.waitForIdle();
		await run;
		handle.agent.reset();
		deepStrictEqual(handle.agent.state.messages, []);
		strictEqual(handle.agent.state.isStreaming, false);
	});
});

describe("engine tool boundary: inherited argument normalization", () => {
	const artifactLike = {
		name: "artifact",
		description: "artifact",
		parameters: Type.Object({
			kind: StringEnum(["plan", "review"] as const),
			content: Type.String(),
			title: Type.Optional(Type.String()),
		}),
	};

	it("treats null for an optional non-nullable argument as omitted (pi-ai 0.84.2)", () => {
		const validated = validateEngineToolArguments(artifactLike, {
			type: "toolCall",
			id: "call-1",
			name: "artifact",
			arguments: { kind: "plan", content: "body", title: null },
		}) as Record<string, unknown>;
		deepStrictEqual(validated, { kind: "plan", content: "body" });
		ok(!("title" in validated), "the null optional is dropped rather than rejected");
	});

	it("keeps rejecting null where the schema requires a value", () => {
		// Only optional properties are normalized; a required enum still fails
		// validation exactly as it did on 0.84.0.
		throws(
			() =>
				validateEngineToolArguments(artifactLike, {
					type: "toolCall",
					id: "call-2",
					name: "artifact",
					arguments: { kind: null, content: "body" },
				}),
			/Validation failed/,
		);
	});
});

describe("engine TUI: keybinding table and alternate-screen render seams", () => {
	it("carries pi-tui 0.84.4 alt-screen actions without colliding with Clio app defaults", () => {
		const added = [
			"tui.altScreen.halfPageUp",
			"tui.altScreen.halfPageDown",
			"tui.altScreen.lineUp",
			"tui.altScreen.lineDown",
			"tui.altScreen.search",
			"tui.altScreen.searchNext",
			"tui.altScreen.searchPrevious",
			"tui.altScreen.searchClose",
		] as const;
		for (const id of added) ok(id in CLIO_KEYBINDINGS, `${id} is routable through Clio's table`);

		const keysOf = (definition: { defaultKeys: string | readonly string[] }): string[] =>
			typeof definition.defaultKeys === "string" ? [definition.defaultKeys] : [...definition.defaultKeys];
		// searchNext/searchPrevious/searchClose only fire while the transcript
		// search overlay is focused (tui-alt-screen.ts handleViewportInput), so
		// they are scoped; every other alt-screen chord is consumed by pi-tui's
		// viewport listener before Clio's router sees the key.
		const scoped = new Set(["tui.altScreen.searchNext", "tui.altScreen.searchPrevious", "tui.altScreen.searchClose"]);
		const upstreamAltScreenKeys = new Set(
			Object.entries(TUI_KEYBINDINGS)
				.filter(([id]) => id.startsWith("tui.altScreen.") && !scoped.has(id))
				.flatMap(([, definition]) => keysOf(definition)),
		);
		// 0.84.2 added ctrl+up / ctrl+down prompt jumps and ctrl+shift+f search;
		// Clio's own bindings (alt+up dequeue, ctrl+g leader, ctrl+p/ctrl+n
		// history) must stay disjoint from every unscoped alt-screen chord.
		ok(upstreamAltScreenKeys.has("ctrl+up") && upstreamAltScreenKeys.has("ctrl+shift+f"));
		for (const [id, definition] of Object.entries(CLIO_APP_KEYBINDINGS)) {
			for (const key of keysOf(definition)) {
				ok(!upstreamAltScreenKeys.has(key), `${id} default ${key} collides with an upstream alt-screen default`);
			}
		}
		for (const key of ["ctrl+p", "ctrl+n"]) ok(!upstreamAltScreenKeys.has(key), `history key ${key} stays free`);
		// Known scoped overlap, recorded deliberately: while the search overlay is
		// focused, ctrl+g advances the match and the leader chord is unavailable.
		ok(keysOf(TUI_KEYBINDINGS["tui.altScreen.searchNext"]).includes("ctrl+g"));
		strictEqual(CLIO_APP_KEYBINDINGS["clio-coder.leader"].defaultKeys, "ctrl+g");
		strictEqual(CLIO_KEYBINDINGS["tui.editor.historyPrevious"].defaultKeys, "ctrl+p");
		strictEqual(CLIO_KEYBINDINGS["tui.editor.historyNext"].defaultKeys, "ctrl+n");
	});

	it("still measures overlay, normalization, and cursor phases inside one fullscreen frame", () => {
		class FakeTerminal implements Terminal {
			readonly writes: string[] = [];
			columns = 60;
			rows = 12;
			kittyProtocolActive = false;
			start(): void {}
			stop(): void {}
			async drainInput(): Promise<void> {}
			write(data: string): void {
				this.writes.push(data);
			}
			moveBy(): void {}
			hideCursor(): void {}
			showCursor(): void {}
			clearLine(): void {}
			clearFromCursor(): void {}
			clearScreen(): void {}
			setTitle(): void {}
			setProgress(): void {}
		}
		const frames: Array<{ mode: string; phases: TuiRenderPhase[] }> = [];
		const observer: TuiRenderObserver = {
			beginFrame(fields) {
				const frame = { mode: fields.mode, phases: [] as TuiRenderPhase[] };
				frames.push(frame);
				return frame;
			},
			endFrame() {},
			beginPhase(frame, phase) {
				(frame as { phases: TuiRenderPhase[] }).phases.push(phase);
				return phase;
			},
			endPhase() {},
		};
		const terminal = new FakeTerminal();
		const tui = new InstrumentedTuiAltScreen(terminal, observer);
		tui.addChild(new Text("hello fullscreen", 0, 0));
		tui.start();
		try {
			tui.renderNow(true);
		} finally {
			tui.stop();
		}
		strictEqual(frames.length, 1, "one doRender is one frame");
		strictEqual(frames[0]?.mode, "fullscreen");
		// 0.84.2 paints full-width rows as direct line references; the three
		// protected seams Clio measures must still run inside that frame.
		deepStrictEqual(frames[0]?.phases, ["overlay", "cursor", "normalization"]);
		ok(
			terminal.writes.some((chunk) => chunk.includes("hello fullscreen")),
			"the frame reached the terminal",
		);
	});
});
