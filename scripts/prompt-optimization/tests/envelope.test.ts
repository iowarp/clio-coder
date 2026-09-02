/**
 * Offline contract tests for the first-turn envelope probe.
 *
 *   npm run test:file -- scripts/prompt-optimization/tests/envelope.test.ts
 *
 * No model and no external network. The proxy and probe tests bind loopback
 * stubs, because a recording proxy that silently mangles a body is exactly the
 * failure this harness has already been bitten by twice: it would produce a
 * plausible token number rather than an error.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
	attributeExact,
	firstTurnRequest,
	inventoryFrom,
	messageText,
	probePromptTokens,
	splitInjectedReminders,
	splitSystemSections,
	startRecordingProxy,
	withoutComponent,
} from "../envelope.js";

function toolEntry(name: string, description: string, parameters: unknown): Record<string, unknown> {
	return { type: "function", function: { name, description, parameters } };
}

function samplePayload(): Record<string, unknown> {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "lead in\n# Alpha\nalpha body\n# Beta\nbeta body" },
			{
				role: "user",
				content: [{ type: "text", text: "<system-reminder>\nrouting rules\n</system-reminder>\n\nreal question" }],
			},
		],
		tools: [
			toolEntry("alpha", "alpha description", { type: "object", properties: { a: { type: "string" } } }),
			toolEntry("beta", "beta description", { type: "object", properties: { b: { type: "number" } } }),
		],
		tool_choice: "auto",
	};
}

test("splitSystemSections keeps the preamble and splits on top-level headers", () => {
	const sections = splitSystemSections("lead in\n# Alpha\nalpha body\n## Beta\nbeta body");
	deepStrictEqual(
		sections.map((section) => section.id),
		["preamble", "Alpha", "Beta"],
	);
	ok(sections[1]?.text.startsWith("# Alpha"));
});

test("messageText reads content parts, not their JSON encoding", () => {
	strictEqual(messageText([{ type: "text", text: "hello" }, { type: "image" }, "!"]), "hello!");
	strictEqual(messageText("plain"), "plain");
	strictEqual(messageText(undefined), "");
});

test("splitInjectedReminders separates harness instruction from operator text", () => {
	const { reminders, remainder } = splitInjectedReminders("<system-reminder>x</system-reminder>\nask");
	deepStrictEqual(reminders, ["<system-reminder>x</system-reminder>"]);
	strictEqual(remainder.trim(), "ask");
});

test("inventoryFrom charges an injected reminder to Clio and the rest to variable content", () => {
	const inventory = inventoryFrom(samplePayload(), false);
	const reminder = inventory.components.find((entry) => entry.kind === "injected-reminder");
	const user = inventory.components.find((entry) => entry.kind === "message");
	ok(reminder !== undefined, "the reminder must be its own component");
	strictEqual(reminder?.owner, "clio");
	strictEqual(user?.owner, "variable");
	ok(!(user?.chars ?? 0) || !inventory.components.some((c) => c.id === user?.id && c.chars > 20));
	deepStrictEqual(inventory.toolNames, ["alpha", "beta"]);
	strictEqual(inventory.toolCount, 2);
});

test("deep inventory addresses each tool's description and schema separately", () => {
	const ids = inventoryFrom(samplePayload(), true).components.map((entry) => entry.id);
	ok(ids.includes("tool:alpha"));
	ok(ids.includes("tool:alpha#description"));
	ok(ids.includes("tool:alpha#schema"));
});

test("withoutComponent removes exactly one tool", () => {
	const next = withoutComponent(samplePayload(), "tool:alpha");
	const names = (next.tools as Array<Record<string, unknown>>).map((tool) => (tool.function as { name: string }).name);
	deepStrictEqual(names, ["beta"]);
});

test("withoutComponent empties a description and a schema without changing the entry's shape", () => {
	const noDescription = withoutComponent(samplePayload(), "tool:alpha#description");
	const alpha = (noDescription.tools as Array<Record<string, unknown>>)[0]?.function as Record<string, unknown>;
	strictEqual(alpha.description, "");
	ok("parameters" in alpha, "the parameters key must survive so the diff measures text, not shape");

	const noSchema = withoutComponent(samplePayload(), "tool:alpha#schema");
	const stripped = (noSchema.tools as Array<Record<string, unknown>>)[0]?.function as Record<string, unknown>;
	deepStrictEqual(stripped.parameters, { type: "object", properties: {} });
	strictEqual(stripped.description, "alpha description");
});

test("withoutComponent drops one system section and leaves the others", () => {
	const next = withoutComponent(samplePayload(), "system[0]/Alpha");
	const system = (next.messages as Array<Record<string, unknown>>)[0]?.content as string;
	ok(!system.includes("alpha body"));
	ok(system.includes("beta body"));
	ok(system.includes("lead in"));
});

test("withoutComponent drops one reminder and preserves the content-parts shape", () => {
	const next = withoutComponent(samplePayload(), "message[1]#reminder[0]");
	const content = (next.messages as Array<Record<string, unknown>>)[1]?.content;
	ok(Array.isArray(content), "a parts array must stay a parts array");
	const text = messageText(content);
	ok(!text.includes("routing rules"));
	ok(text.includes("real question"));
});

test("removing the operator's text keeps the reminder, so the two never double-count", () => {
	const next = withoutComponent(samplePayload(), "message[1]:user");
	const text = messageText((next.messages as Array<Record<string, unknown>>)[1]?.content);
	ok(text.includes("routing rules"));
	ok(!text.includes("real question"));
});

test("withoutComponent('*tools') removes the whole tool block including tool_choice", () => {
	const next = withoutComponent(samplePayload(), "*tools");
	ok(!("tools" in next));
	ok(!("tool_choice" in next));
});

test("firstTurnRequest picks the first JSON chat completion and ignores everything else", () => {
	const at = (index: number, method: string, path: string, body: Record<string, unknown> | null) => ({
		index,
		method,
		path,
		body,
		raw: body === null ? "" : JSON.stringify(body),
		responseUsage: null,
		responseTimings: null,
		at: "2026-09-01T00:00:00.000Z",
	});
	const picked = firstTurnRequest([
		at(0, "GET", "/v1/models", null),
		at(1, "POST", "/v1/embeddings", { model: "e" }),
		at(2, "POST", "/v1/chat/completions", { model: "first" }),
		at(3, "POST", "/v1/chat/completions", { model: "second" }),
	]);
	strictEqual(picked?.body?.model, "first");
});

async function listen(server: Server): Promise<string> {
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

test("the recording proxy keeps the body verbatim and passes the response through", async () => {
	const seen: string[] = [];
	const upstream = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, usage: { prompt_tokens: 123 } }));
		});
	});
	const upstreamUrl = await listen(upstream);
	const proxy = await startRecordingProxy(upstreamUrl);
	try {
		const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
		const response = await fetch(`${proxy.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		deepStrictEqual(await response.json(), { ok: true, usage: { prompt_tokens: 123 } });
		strictEqual(seen[0], body, "the upstream must receive the bytes the client sent");
		strictEqual(proxy.requests.length, 1);
		strictEqual(proxy.requests[0]?.raw, body);
		strictEqual(proxy.requests[0]?.responseUsage?.prompt_tokens, 123);
	} finally {
		await proxy.close();
		await new Promise<void>((done) => upstream.close(() => done()));
	}
});

test("a probe reports null rather than a number when the answer would be invented", async () => {
	const refusing = createServer((req, res) => {
		req.resume();
		res.writeHead(400, { "content-type": "application/json" });
		res.end('{"error":"context overflow"}');
	});
	const url = await listen(refusing);
	try {
		const result = await probePromptTokens(url, { model: "m", messages: [] });
		strictEqual(result.tokens, null);
		strictEqual(result.status, 400);
		ok(result.detail.includes("context overflow"));
	} finally {
		await new Promise<void>((done) => refusing.close(() => done()));
	}

	const silent = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"choices":[]}');
	});
	const silentUrl = await listen(silent);
	try {
		const result = await probePromptTokens(silentUrl, { model: "m", messages: [] });
		strictEqual(result.tokens, null, "a 200 with no usage is still not a measurement");
	} finally {
		await new Promise<void>((done) => silent.close(() => done()));
	}
});

test("attributeExact subtracts against the baseline and names what it could not measure", async () => {
	// A stub that charges four tokens per 100 characters of payload, so every
	// marginal is a known quantity and the arithmetic is checkable.
	const upstream = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ usage: { prompt_tokens: Math.floor(raw.length / 25) } }));
		});
	});
	const url = await listen(upstream);
	try {
		const payload = samplePayload();
		const inventory = inventoryFrom(payload, false);
		const attribution = await attributeExact(url, payload, inventory);
		ok((attribution.totalTokens ?? 0) > 0);
		ok((attribution.noToolsTokens ?? 0) < (attribution.totalTokens ?? 0));
		deepStrictEqual(attribution.unmeasured, []);
		for (const entry of attribution.components) {
			ok(entry.tokens !== null, `${entry.id} must carry a measured marginal`);
		}
		const alpha = attribution.components.find((entry) => entry.id === "tool:alpha");
		ok((alpha?.tokens ?? 0) > 0, "removing a tool must reduce the count");
	} finally {
		await new Promise<void>((done) => upstream.close(() => done()));
	}
});
