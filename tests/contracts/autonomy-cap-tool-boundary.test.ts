import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// F-C16: the yolo cap halt aborted an extension's record write in flight. A
// stop deferred to the tool boundary lets the started call finish and ends
// the turn before its next model request.

const target = { id: "cap-boundary-fixture", runtime: "litellm", url: "http://fixture.invalid:4000" };
const model = litellm.synthesizeModel(target, "cap-boundary-model", null) as Model<"openai-completions">;
const CAP_REASON = "[Clio Coder] yolo paused: the 5M-token cap was reached.";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("cap-boundary-");
	previousCwd = process.cwd();
	const project = join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

/** The first request asks for one tool call; any later request answers with text. */
function transport() {
	let calls = 0;
	const fetch: typeof globalThis.fetch = async () => {
		calls += 1;
		const encoder = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
			encoder.encode(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		const first = calls === 1;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					chunk(
						first
							? {
									role: "assistant",
									tool_calls: [{ index: 0, id: "record-1", type: "function", function: { name: "read", arguments: "{}" } }],
								}
							: { role: "assistant", content: "PONG" },
					),
				);
				controller.enqueue(chunk({}, first ? "tool_calls" : "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, calls: () => calls };
}

it("a cap halt during a tool call lets the call finish and sends no further model request", {
	timeout: 10_000,
}, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [{ ...target, defaultModel: model.id }];
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 131072, maxTokens: 4096 },
		synthesizeModel: () => ({ ...model, input: ["text"], contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	const wire = transport();
	let loop: ReturnType<typeof createChatLoop> | null = null;
	const tool = { started: false, completed: false, sawAbort: false };
	registry.register({
		name: ToolNames.Read,
		description: "Stands in for an extension record write the cap crosses during",
		parameters: Type.Object({}),
		baseActionClass: "read",
		async run(_args, options) {
			tool.started = true;
			// The window latches inside the call that crossed the line, as the orchestrator's onHalt does.
			loop?.cancel({ reason: CAP_REASON, source: "autonomy", auditReason: "autonomous-cap", atToolBoundary: true });
			await new Promise((resolve) => setTimeout(resolve, 20));
			tool.sawAbort = options?.signal?.aborted === true;
			tool.completed = true;
			return { kind: "ok", output: "recorded" };
		},
	});
	const events: ChatLoopEvent[] = [];
	const journals = createSessionJournals(clioStateDir(), () => {
		throw new Error("fixture journal unavailable");
	});
	loop = createChatLoop({
		telemetry: { acquireTelemetrySession: journals.acquire } as unknown as TelemetryContract,
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		toolRegistry: registry,
		bus: context.bus,
		createAgent: (options) =>
			createEngineAgent({
				...options,
				streamFn: (requestModel, requestContext, requestOptions) =>
					openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args) => wire.fetch(...args),
					}),
			}),
	});
	loop.onEvent((event) => {
		events.push(event);
	});
	try {
		await loop.submit("Record the section.");
		await loop.whenSettled();
		ok(tool.started);
		ok(tool.completed);
		strictEqual(tool.sawAbort, false);
		const ended = events.find(
			(event) => event.type === "tool_execution_end" && (event as { toolCallId?: string }).toolCallId === "record-1",
		) as { isError?: boolean } | undefined;
		strictEqual(ended?.isError, false);
		strictEqual(wire.calls(), 1);
		ok(
			events.some((event) => event.type === "notice" && (event as { text?: string }).text === CAP_REASON),
			"the turn closes with the cap's notice",
		);
		// The cap is the harness's own stop, named on the turn's settlement (bt-26 N2d).
		await journals.flush();
		const sessionId = session.current()?.id;
		ok(sessionId);
		const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), sessionId));
		const turns = journal.records.flatMap(({ record }) => (record.k === "turn.settled" ? [record.data] : []));
		deepStrictEqual(
			turns.map((turn) => [turn.stopReason, turn.terminal.cause]),
			[["toolUse", "autonomy_stop"]],
		);
	} finally {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	}
});
