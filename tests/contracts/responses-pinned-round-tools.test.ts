import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
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
