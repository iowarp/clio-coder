/**
 * ContextFold CF-0 capture fixtures.
 *
 * Adapter capture: a local HTTP provider that records the body each provider adapter serialized, per API family, and
 * answers with a scripted SSE reply in that family's dialect. Nothing between the session and the socket is stubbed,
 * so turn-runtime's attempt seam, Clio's engine wrappers and Pi's serializer all run. `wireElements` projects a body to
 * a family-neutral element list, which is what cross-family and cross-surface equality compares.
 *
 * Session capture: `tapEngineApi` wraps one API family's registered provider and records the finalized context the
 * attempt seam handed to the engine (turn-runtime's `sent`), then delegates to the real provider. `contextElements`
 * projects such a context to the same element vocabulary as `wireElements`.
 *
 * The chat harness drives an in-process chat loop over a real session bundle against the capture server, across route
 * facts (tier, caching, known or unknown window, image input). Subprocess surfaces (headless, ACP, worker) reach the
 * same server through `seedOpenAICompatToolOrchestrator(configDir, server.url)`: the server routes on the path suffix.
 * `tappedCli` runs the built CLI with the session capture installed in that process.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Context } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModelTier } from "../../src/core/model-tier.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { createEngineAgent } from "../../src/engine/agent.js";
import { type EngineRegisteredApiProvider, registerEngineApiProvider } from "../../src/engine/api-registry.js";
import type { Model } from "../../src/engine/types.js";
import { createProductionAutoCompact } from "../../src/entry/orchestrator.js";
import { type ChatLoopEvent, type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { replayCurrentSession } from "../../src/session-control/session-restore.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { syntheticCompactionSummary } from "./compaction-summary.js";
import { dispatchStubContext } from "./dispatch-stub-context.js";
import { closeServer, readRequestBody } from "./openai-compat-fixture.js";

export type WireFamily = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface CapturedRequest {
	family: WireFamily;
	path: string;
	body: Record<string, unknown>;
}

export interface ScriptedCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * One reply: plain text, tool calls (with leading text on chat completions only), a reasoning-only reply cut by the
 * output cap (chat completions only), an HTTP error with that status and message, or a connection dropped before any
 * response. `reasoning` streams as `reasoning_content` ahead of the reply, on chat completions only.
 */
export type CaptureReply =
	| { text: string; reasoning?: string }
	| { calls: ScriptedCall[]; text?: string; reasoning?: string }
	| { thinkingOnlyLength: string }
	| { status: number; error: string }
	| { drop: true };
type StreamReply = { text: string; reasoning?: string } | { calls: ScriptedCall[]; text?: string; reasoning?: string };

export type CaptureScript = (request: CapturedRequest, index: number) => CaptureReply;

export interface CaptureServer {
	/** Base URL without a version segment; every family routes on the path suffix. */
	url: string;
	requests: CapturedRequest[];
	close(): Promise<void>;
}

function familyFor(path: string): WireFamily | null {
	if (path.endsWith("/chat/completions")) return "openai-completions";
	if (path.endsWith("/responses")) return "openai-responses";
	if (path.endsWith("/messages")) return "anthropic-messages";
	return null;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

function completionsFrames(reply: StreamReply | { thinkingOnlyLength: string }, model: string): unknown[] {
	const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
		id: "capture",
		object: "chat.completion.chunk",
		model,
		choices: [{ index: 0, delta, finish_reason }],
	});
	if ("thinkingOnlyLength" in reply)
		return [
			chunk({ role: "assistant", reasoning_content: reply.thinkingOnlyLength }),
			{ ...chunk({}, "length"), usage: USAGE },
		];
	const reasoning =
		reply.reasoning === undefined ? [] : [chunk({ role: "assistant", reasoning_content: reply.reasoning })];
	if (!("calls" in reply))
		return [...reasoning, chunk({ role: "assistant", content: reply.text }), { ...chunk({}, "stop"), usage: USAGE }];
	return [
		...reasoning,
		chunk({
			role: "assistant",
			...(reply.text === undefined ? {} : { content: reply.text }),
			tool_calls: reply.calls.map((call, index) => ({
				index,
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: JSON.stringify(call.arguments) },
			})),
		}),
		{ ...chunk({}, "tool_calls"), usage: USAGE },
	];
}

function responsesFrames(reply: StreamReply, model: string): unknown[] {
	const items: Record<string, unknown>[] = !("calls" in reply)
		? [
				{
					type: "message",
					id: "msg_capture",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: reply.text, annotations: [] }],
				},
			]
		: reply.calls.map((call, index) => ({
				type: "function_call",
				id: `fc_capture_${index}`,
				call_id: call.id,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
				status: "completed",
			}));
	const frames: unknown[] = [
		{ type: "response.created", response: { id: "resp_capture", model, status: "in_progress", output: [] } },
	];
	items.forEach((item, output_index) => {
		frames.push({ type: "response.output_item.added", output_index, item: { ...item, content: [], arguments: "" } });
		if (item.type === "message")
			frames.push({
				type: "response.output_text.delta",
				output_index,
				content_index: 0,
				delta: (reply as { text: string }).text,
			});
		else frames.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
		frames.push({ type: "response.output_item.done", output_index, item });
	});
	frames.push({
		type: "response.completed",
		response: {
			id: "resp_capture",
			model,
			status: "completed",
			output: items,
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
		},
	});
	return frames;
}

function anthropicFrames(reply: StreamReply, model: string): unknown[] {
	const frames: unknown[] = [
		{
			type: "message_start",
			message: {
				id: "msg_capture",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
	];
	if (!("calls" in reply)) {
		frames.push(
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } },
			{ type: "content_block_stop", index: 0 },
		);
	} else {
		reply.calls.forEach((call, index) => {
			frames.push(
				{
					type: "content_block_start",
					index,
					content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
				},
				{
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
				},
				{ type: "content_block_stop", index },
			);
		});
	}
	frames.push(
		{
			type: "message_delta",
			delta: { stop_reason: !("calls" in reply) ? "end_turn" : "tool_use", stop_sequence: null },
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	);
	return frames;
}

/** Starts the capture provider. Every POST is recorded before the script answers it. */
export async function startCaptureServer(script: CaptureScript): Promise<CaptureServer> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		const family = familyFor(path);
		if (req.method !== "POST" || !family) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `capture: no route for ${req.method} ${path}` } }));
			return;
		}
		const body = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
		const captured: CapturedRequest = { family, path, body };
		const index = requests.push(captured) - 1;
		const reply = script(captured, index);
		if ("drop" in reply) {
			req.socket.destroy();
			return;
		}
		if ("status" in reply) {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error" } }));
			return;
		}
		const model = typeof body.model === "string" ? body.model : "capture";
		if (
			("thinkingOnlyLength" in reply || ("reasoning" in reply && reply.reasoning !== undefined)) &&
			family !== "openai-completions"
		)
			throw new Error("capture: a reasoning reply is scripted for chat completions only");
		const frames =
			family === "openai-completions"
				? completionsFrames(reply, model)
				: family === "openai-responses"
					? responsesFrames(reply as StreamReply, model)
					: anthropicFrames(reply as StreamReply, model);
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const frame of frames) {
			const type = (frame as { type?: unknown }).type;
			res.write(
				`${family !== "openai-completions" && typeof type === "string" ? `event: ${type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`,
			);
		}
		if (family === "openai-completions") res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, requests, close: () => closeServer(server) };
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const parts = (content: unknown): Json[] =>
	typeof content === "string"
		? [{ type: "text", text: content }]
		: Array.isArray(content)
			? content.filter(isRecord)
			: [];
const args = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? {}));

function partText(part: Json): string {
	switch (part.type) {
		case "text":
		case "input_text":
		case "output_text":
			return String(part.text ?? "");
		case "image":
		case "image_url":
		case "input_image":
			return "[image]";
		default:
			return `[${String(part.type)}]`;
	}
}
const joined = (content: unknown): string => parts(content).map(partText).join("");

/**
 * The logical element sequence a body carries: the system text first, then one element per message, call and
 * result, in order. Wire ids are left out so two families, or two surfaces, can be compared element for element.
 */
export function wireElements(request: CapturedRequest): string[] {
	const { body } = request;
	const out: string[] = [];
	if (request.family === "openai-completions") {
		for (const message of (body.messages as Json[] | undefined) ?? []) {
			const role = String(message.role);
			if (role === "system" || role === "developer") out.push(`system:${joined(message.content)}`);
			else if (role === "tool") out.push(`result:${joined(message.content)}`);
			else if (role === "assistant") {
				const text = joined(message.content);
				if (text) out.push(`assistant:${text}`);
				for (const call of (message.tool_calls as Json[] | undefined) ?? []) {
					const fn = call.function as Json;
					out.push(`call:${String(fn.name)}(${args(fn.arguments)})`);
				}
			} else out.push(`${role}:${joined(message.content)}`);
		}
		return out;
	}
	if (request.family === "openai-responses") {
		if (typeof body.instructions === "string") out.push(`system:${body.instructions}`);
		for (const item of (body.input as Json[] | undefined) ?? []) {
			if (item.type === "function_call") out.push(`call:${String(item.name)}(${args(item.arguments)})`);
			else if (item.type === "function_call_output")
				out.push(`result:${typeof item.output === "string" ? item.output : joined(item.output)}`);
			else if (item.role === "system" || item.role === "developer") out.push(`system:${joined(item.content)}`);
			else if (typeof item.role === "string") out.push(`${item.role}:${joined(item.content)}`);
			else out.push(`opaque:${String(item.type)}`);
		}
		return out;
	}
	const system = body.system;
	if (system !== undefined) out.push(`system:${joined(system)}`);
	for (const message of (body.messages as Json[] | undefined) ?? []) {
		const role = String(message.role);
		let text = "";
		const flush = () => {
			if (text) out.push(`${role}:${text}`);
			text = "";
		};
		for (const part of parts(message.content)) {
			if (part.type === "tool_use") {
				flush();
				out.push(`call:${String(part.name)}(${args(part.input)})`);
			} else if (part.type === "tool_result") {
				flush();
				out.push(`result:${joined(part.content)}`);
			} else text += partText(part);
		}
		flush();
	}
	return out;
}

/**
 * The same element list for a finalized context the tap recorded, so a request the engine was handed and the body its
 * adapter serialized compare element for element.
 */
export function contextElements(context: Context): string[] {
	const out: string[] = context.systemPrompt ? [`system:${context.systemPrompt}`] : [];
	for (const message of context.messages as ReadonlyArray<Json>) {
		const role = String(message.role);
		if (role === "system" || role === "developer") out.push(`system:${joined(message.content)}`);
		else if (role === "toolResult") out.push(`result:${joined(message.content)}`);
		else if (role === "assistant") {
			const blocks = parts(message.content);
			const text = blocks
				.filter((block) => block.type === "text")
				.map(partText)
				.join("");
			if (text) out.push(`assistant:${text}`);
			for (const call of blocks.filter((block) => block.type === "toolCall"))
				out.push(`call:${String(call.name)}(${args(call.arguments)})`);
		} else out.push(`${role}:${joined(message.content)}`);
	}
	return out;
}

const ROOT = new URL("../..", import.meta.url);
/** The call in the built bundle's dispatch that hands a context to the registered provider, where `tapEngineApi` taps. */
const DISPATCH_SEAM = "resolved(model.api).streamSimple(model,normalizeContext(context),";

/**
 * Session capture in the built CLI as a subprocess (`clio-coder run`, `clio-coder acp`). The bundle inlines Pi and the
 * engine registry, so no import can reach them; a preload's load hook rewrites the one dispatch call above to pass the
 * context through a recorder that appends it to `file`, one JSON line per request in send order. A bundle without that
 * call text throws at load, so a moved seam fails the case instead of capturing nothing.
 */
export function tappedCli(file: string): { node: string[]; cli: string } {
	const preload = `
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
const seam = ${JSON.stringify(DISPATCH_SEAM)};
globalThis.__clioSessionCapture = (context) => (appendFileSync(${JSON.stringify(file)}, JSON.stringify(context) + "\\n"), context);
registerHooks({
	load(url, context, nextLoad) {
		const loaded = nextLoad(url, context);
		if (!url.startsWith(${JSON.stringify(new URL("dist/", ROOT).href)})) return loaded;
		const source = String(loaded.source);
		if (!source.includes("function dispatchEngineStreamSimple(")) return loaded;
		if (!source.includes(seam)) throw new Error("session capture: the dispatch seam moved in " + url);
		const tapped = seam.replace("normalizeContext(context)", "globalThis.__clioSessionCapture(normalizeContext(context))");
		return { ...loaded, source: source.replace(seam, tapped) };
	},
});`;
	return {
		node: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`],
		cli: new URL("dist/cli/index.js", ROOT).pathname,
	};
}

const BUILTIN: Partial<Record<Api, () => ReturnType<typeof openAICompletionsApi>>> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
};

export interface EngineTap {
	/** The finalized context of every request, in send order, deep-copied at dispatch. */
	contexts: Context[];
	restore(): void;
}

/**
 * Session capture for one API family. It wraps Pi's builtin provider for that family, or `base` where the surface
 * registers its own (the native worker registers Clio's), and restores the provider it wrapped.
 */
export function tapEngineApi(api: WireFamily, base?: EngineRegisteredApiProvider): EngineTap {
	const builtin = BUILTIN[api];
	const real = base ?? builtin?.();
	if (!real) throw new Error(`no builtin to restore for ${api}`);
	const contexts: Context[] = [];
	registerEngineApiProvider({
		api,
		stream: (model, context, options) => {
			contexts.push(structuredClone(context));
			return real.stream(model, context, options);
		},
		streamSimple: (model, context, options) => {
			contexts.push(structuredClone(context));
			return real.streamSimple(model, context, options);
		},
	});
	return { contexts, restore: () => registerEngineApiProvider({ ...real, api }) };
}

/** Route facts every CF-0 fixture varies; see SPEC §3.1. */
export interface RouteFacts {
	tier?: ModelTier;
	/** False sets `cache.retention: none`, which is how an uncached route reads. */
	caching?: boolean;
	/** A known window; omitted, the window is the runtime default and the target declares none. */
	window?: number;
	/** The model accepts images. */
	image?: boolean;
}

export const CAPTURE_MODEL = "capture-model";
const DEFAULT_WINDOW = 131_072;

export interface ChatHarnessOptions {
	server: CaptureServer;
	route?: RouteFacts;
	/** Extra tools; a `read` that echoes `read <path>` is always registered. */
	tools?: ToolSpec[];
	/** Production auto-compaction with a scripted summarizer. */
	autoCompact?: boolean;
	pinnedContext?: () => ReadonlyArray<{ extensionId: string; text: string }>;
	/** Facts that differ on `CAPTURE_TARGET_B`, so a target switch also changes the route. */
	routeB?: RouteFacts;
	/** The middleware tool-choice control the loop reads each round. */
	middlewareToolChoice?: MiddlewareToolChoiceControl;
	/** Builds each agent the loop asks for, so a case can hold the live agent. */
	createAgent?: typeof createEngineAgent;
	/** Journals the loop's calls, so a case can read the session's telemetry as the verifier does. */
	telemetry?: CreateChatLoopDeps["telemetry"];
}

/**
 * One process's chat loop over a real session bundle, sending to the capture server through the real provider path.
 * Two targets share the model: switching `settings.chat.target` to `TARGET_B` rebuilds the agent.
 */
export function chatHarness(options: ChatHarnessOptions) {
	const route = options.route ?? {};
	const contextWindow = route.window ?? DEFAULT_WINDOW;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = CAPTURE_TARGET_A;
	settings.chat.model = CAPTURE_MODEL;
	settings.chat.thinkingLevel = "off";
	const factsFor = (id: string): RouteFacts => (id === CAPTURE_TARGET_B ? { ...route, ...options.routeB } : route);
	const target = (id: string) => {
		const facts = factsFor(id);
		return {
			id,
			runtime: "litellm",
			url: options.server.url,
			defaultModel: CAPTURE_MODEL,
			...(facts.caching === false ? { cache: { retention: "none" as const } } : {}),
			capabilities: {
				vision: facts.image === true,
				...(facts.window !== undefined ? { contextWindow: facts.window } : {}),
			},
		};
	};
	settings.targets = [target(CAPTURE_TARGET_A), target(CAPTURE_TARGET_B)] as typeof settings.targets;
	if (route.tier)
		settings.models = { ...settings.models, [CAPTURE_MODEL]: { tier: route.tier } } as typeof settings.models;
	const base = litellm.synthesizeModel(target(CAPTURE_TARGET_A), CAPTURE_MODEL, null) as Model<"openai-completions">;
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: {
			...EMPTY_CAPABILITIES,
			chat: true,
			tools: true,
			contextWindow,
			maxTokens: 4096,
		},
		synthesizeModel: (synthesized) => {
			const facts = factsFor(synthesized.id);
			return {
				...base,
				input: facts.image ? ["text", "image"] : ["text"],
				contextWindow: facts.window ?? DEFAULT_WINDOW,
				maxTokens: 4096,
			};
		},
	};
	const context = dispatchStubContext({ settings, runtime });
	const stubProviders = context.getContract("providers") as ProvidersContract;
	// The stub reports the runtime defaults for every target; each target's own facts win here, as a probe would.
	const statuses = stubProviders
		.list()
		.map((status) => ({ ...status, capabilities: { ...status.capabilities, ...status.target.capabilities } }));
	const providers: ProvidersContract = {
		...stubProviders,
		list: () => statuses,
		probeTarget: async (id) => statuses.find((status) => status.target.id === id) ?? stubProviders.probeTarget(id),
		modelTierOverride: (id) => (id === CAPTURE_MODEL ? (route.tier ?? null) : null),
	};
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	if (!safety) throw new Error("dispatch stub has no safety contract");
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	registry.register({
		name: ToolNames.Read,
		description: "Returns a fixed body for a path",
		parameters: Type.Object({ path: Type.String() }),
		baseActionClass: "read",
		run: async (input) => ({ kind: "ok", output: `read ${String((input as { path?: unknown }).path)}` }),
	});
	for (const tool of options.tools ?? []) registry.register(tool);
	const events: ChatLoopEvent[] = [];
	const counter = { summaries: 0 };
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set([CAPTURE_TARGET_A, CAPTURE_TARGET_B]),
		session,
		readSessionEntries: () => (session.current() ? session.readEntries() : []),
		toolRegistry: registry,
		bus: context.bus,
		...(options.pinnedContext ? { pinnedContext: options.pinnedContext } : {}),
		...(options.middlewareToolChoice ? { middlewareToolChoice: options.middlewareToolChoice } : {}),
		...(options.createAgent ? { createAgent: options.createAgent } : {}),
		...(options.telemetry ? { telemetry: options.telemetry } : {}),
		...(options.autoCompact
			? {
					autoCompact: createProductionAutoCompact(
						session,
						() => settings,
						providers,
						undefined,
						async () => ({
							text: syntheticCompactionSummary(`checkpoint ${++counter.summaries}`),
						}),
					),
				}
			: {}),
	});
	loop.onEvent((event) => {
		events.push(event);
	});
	const close = async () => {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	};
	/** Resumes `id` in this harness the way a new process restores it. */
	const reopen = (id: string) => {
		session.resume(id);
		replayCurrentSession({ session, chat: loop, readEntries: () => session.readEntries() }, id);
	};
	const submit = async (text: string) => {
		await loop.submit(text);
		await loop.whenSettled();
	};
	return { settings, context, session, loop, events, counter, submit, reopen, close };
}

export const CAPTURE_TARGET_A = "capture-a";
export const CAPTURE_TARGET_B = "capture-b";
