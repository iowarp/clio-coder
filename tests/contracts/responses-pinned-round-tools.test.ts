import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { engineModels } from "../../src/engine/models.js";
import { applyToolRounds, streamToolRound, type ToolRound } from "../../src/engine/provider-payload.js";
import type { EngineModel } from "../../src/engine/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const tool = (name: string) => ({
	name,
	description: `Fixture ${name}`,
	parameters: Type.Object({ path: Type.String() }),
});
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function context(model: EngineModel) {
	return {
		systemPrompt: "Pinned round protocol.",
		tools: [tool("read"), tool("write"), tool("extension_desk__next_step")],
		messages: [
			{ role: "user" as const, content: "inspect", timestamp: 1 },
			{
				role: "assistant" as const,
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse" as const,
				timestamp: 2,
				usage: { ...usage, cost: zeroCost },
				content: [{ type: "toolCall" as const, id: "call_1", name: "read", arguments: { path: "a" } }],
			},
			{
				role: "toolResult" as const,
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text" as const, text: "ok" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

/** The body Pi's own serializer builds for one round; the payload hook throws before any network I/O. */
async function wire(model: EngineModel, rounds: ToolRound[], apiKey: string, targetId?: string) {
	const controlled = applyToolRounds(model, context(model), { apiKey, sessionId: "pinned-fixture" }, rounds, targetId);
	let body: Record<string, unknown> = {};
	await engineStreamSimple(model, controlled.context, {
		...controlled.options,
		onPayload: async (payload, current) => {
			body = structuredClone((await controlled.options?.onPayload?.(payload, current)) ?? payload) as Record<
				string,
				unknown
			>;
			throw new Error("captured before network I/O");
		},
	}).result();
	return { body, record: controlled.toolRounds?.[0] };
}

/**
 * Everything a prefix cache reads, serialized: the instructions, any top-level tools and the input, whose head item
 * carries the tool declarations on models that take additional_tools.
 */
const prefix = (body: Record<string, unknown>) =>
	JSON.stringify({ instructions: body.instructions, tools: body.tools, input: body.input });

const catalog = (provider: string, id: string): EngineModel => {
	const model = engineModels.getModel(provider as never, id) as EngineModel | undefined;
	ok(model, `${provider}/${id} must exist in the Pi catalog`);
	return model;
};
const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
const routes = [
	{ label: "codex", model: catalog("openai-codex", "gpt-6-luna"), apiKey: `e30.${account.toString("base64url")}.sig` },
	{ label: "responses", model: catalog("openai", "gpt-5.6-luna"), apiKey: "fixture" },
];
const pinned: ToolRound = { kind: "required", toolName: "extension_desk__next_step" };

for (const { label, model, apiKey } of routes) {
	test(`${label}: a pinned round sends the unpinned round's tool list byte for byte with a named choice`, async (t) => {
		const env = await isolateClioEnv("clio-coder-pinned-round-");
		t.after(() => env.restore());
		const plain = await wire(model, [], apiKey);
		const pin = await wire(model, [pinned], apiKey);
		ok(prefix(plain.body).includes("extension_desk__next_step"), "the fixture tool list reaches the body");
		strictEqual(prefix(pin.body), prefix(plain.body));
		deepStrictEqual(pin.body.tool_choice, { type: "function", name: "extension_desk__next_step" });
		deepStrictEqual(pin.record, {
			kind: "required",
			toolName: "extension_desk__next_step",
			choice: { type: "function", name: "extension_desk__next_step" },
			attempt: 0,
		});
		// A terminal handoff also keeps the list; only its single-call flag differs.
		const handoff = await wire(model, [{ ...pinned, handoff: true }], apiKey);
		strictEqual(prefix(handoff.body), prefix(plain.body));
		strictEqual(handoff.body.parallel_tool_calls, false);
	});
}

test("codex: a rejected named choice falls back to auto over the same full tool list", async (t) => {
	const env = await isolateClioEnv("clio-coder-pinned-reject-");
	t.after(() => env.restore());
	const codex = routes[0];
	ok(codex);
	const { model, apiKey } = codex;
	const targetId = "pinned-reject";
	const sent: unknown[] = [];
	const reply = (stopReason: "stop" | "error", errorMessage?: string) => ({
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...usage, cost: zeroCost },
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: 4,
	});
	const rejection = "400 Tool choice 'function' must be specified with 'tools' parameter.";
	const controlled = applyToolRounds(model, context(model), { apiKey }, [pinned], targetId);
	const result = await streamToolRound(
		model,
		controlled,
		(request) => {
			sent.push(request.options?.toolChoice);
			const events = createAssistantMessageEventStream();
			const message = sent.length === 1 ? reply("error", rejection) : reply("stop");
			events.push(
				message.stopReason === "error"
					? { type: "error", reason: "error", error: message }
					: { type: "done", reason: "stop", message },
			);
			events.end(message);
			return events;
		},
		targetId,
	).result();
	strictEqual(result.stopReason, "stop");
	deepStrictEqual(sent, [{ type: "function", name: "extension_desk__next_step" }, "auto"]);
	// The rejection is remembered, so the next pinned round starts on auto and still keeps every tool.
	const plain = await wire(model, [], apiKey, targetId);
	const after = await wire(model, [pinned], apiKey, targetId);
	strictEqual(after.body.tool_choice, "auto");
	strictEqual(prefix(after.body), prefix(plain.body));
	deepStrictEqual([after.record?.choice, after.record?.downgradeReason], ["auto", rejection]);
});

test("completions: a terminal handoff names its tool over the full list and narrows only after a rejection", async (t) => {
	const env = await isolateClioEnv("clio-coder-completions-handoff-");
	t.after(() => env.restore());
	const model = catalog("openrouter", "google/gemini-2.5-flash");
	const targetId = "completions-handoff";
	const handoff: ToolRound = { ...pinned, handoff: true };
	const named = { type: "function", function: { name: "extension_desk__next_step" } };
	const plain = await wire(model, [], "fixture", targetId);
	const first = await wire(model, [handoff], "fixture", targetId);
	strictEqual(JSON.stringify(first.body.tools), JSON.stringify(plain.body.tools));
	deepStrictEqual(first.body.tool_choice, named);
	strictEqual(first.body.parallel_tool_calls, false);
	const sent: unknown[] = [];
	const rejection = "400 Invalid tool_choice type: 'object'. Supported string values: none, auto, required";
	const controlled = applyToolRounds(model, context(model), { apiKey: "fixture" }, [handoff], targetId);
	const result = await streamToolRound(
		model,
		controlled,
		(request) => {
			sent.push([request.options?.toolChoice, request.context.tools?.map((entry) => entry.name)]);
			const events = createAssistantMessageEventStream();
			const message = {
				role: "assistant" as const,
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { ...usage, cost: zeroCost },
				stopReason: sent.length === 1 ? ("error" as const) : ("stop" as const),
				...(sent.length === 1 ? { errorMessage: rejection } : {}),
				timestamp: 4,
			};
			events.push(
				message.stopReason === "error"
					? { type: "error", reason: "error", error: message }
					: { type: "done", reason: "stop", message },
			);
			events.end(message);
			return events;
		},
		targetId,
	).result();
	strictEqual(result.stopReason, "stop");
	deepStrictEqual(sent, [
		[named, ["read", "write", "extension_desk__next_step"]],
		["required", ["extension_desk__next_step"]],
	]);
	// The rejection is remembered: later handoffs on the route narrow from the start, as before row 158.
	const after = await wire(model, [handoff], "fixture", targetId);
	deepStrictEqual(
		(after.body.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
		["extension_desk__next_step"],
	);
	strictEqual(after.body.tool_choice, "required");
	deepStrictEqual([after.record?.choice, after.record?.downgradeReason], ["required", rejection]);
	// The mark is kept in the state root, so a fresh process on the same target, endpoint and model narrows at once.
	ok(readFileSync(join(env.dir, "state", "tool-choice-routes.json"), "utf8").includes("Invalid tool_choice"));
	const script = `
		const { applyToolRounds } = await import(${JSON.stringify(new URL("../../src/engine/provider-payload.ts", import.meta.url).href)});
		const { engineModels } = await import(${JSON.stringify(new URL("../../src/engine/models.ts", import.meta.url).href)});
		const model = engineModels.getModel("openrouter", "google/gemini-2.5-flash");
		const context = { messages: [], tools: ["read", "extension_desk__next_step"].map((name) => ({ name, description: name, parameters: {} })) };
		const controlled = applyToolRounds(model, context, {}, [${JSON.stringify(handoff)}], ${JSON.stringify(targetId)});
		process.stdout.write(JSON.stringify([controlled.options?.toolChoice, controlled.context.tools.map((entry) => entry.name), controlled.toolRounds[0].downgradeReason, controlled.fallback === undefined]));
	`;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", script],
		{
			env: process.env,
		},
	);
	deepStrictEqual(JSON.parse(stdout), ["required", ["extension_desk__next_step"], rejection, true]);
});
