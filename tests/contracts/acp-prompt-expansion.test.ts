import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { type AcpPromptExpansion, type ClioAcpServerOptions, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

// ACP prompts reached chat.submit as raw text: `@path` references, prompt templates and `/skill`
// requests meant one thing in the terminal and another in the GUI, and image blocks were dropped.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function serve(expandPrompt?: ClioAcpServerOptions["expandPrompt"]) {
	const requests = new Map<string, (params: unknown) => unknown>();
	const submitted: Array<{ text: string; options: unknown }> = [];
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onRequest: (method, handler) => {
			requests.set(method, handler);
			return () => requests.delete(method);
		},
		onNotification: () => () => {},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const served = serveClioAcpAgent({
		transport,
		chat: {
			submit: async (text, options) => {
				submitted.push({ text, options });
			},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => null,
		},
		cwd: process.cwd(),
		...(expandPrompt ? { expandPrompt } : {}),
	});
	const call = async (method: string, params: unknown) => {
		const handler = requests.get(method);
		assert.ok(handler, method);
		return handler(params);
	};
	const start = async () => {
		const init = (await call("initialize", { protocolVersion: 1, clientCapabilities: {} })) as {
			agentCapabilities: { promptCapabilities: { image: boolean } };
		};
		const session = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		return { image: init.agentCapabilities.promptCapabilities.image, sessionId: session.sessionId };
	};
	return { call, start, submitted, stop: async () => (transport.close(), await served) };
}

const invalid = (pattern: RegExp) => (error: unknown) =>
	error instanceof AcpRequestError && error.detail?.code === "invalid_params" && pattern.test(error.message);

test("an expanding host receives the text and images and submits what the terminal would", async () => {
	const seen: Array<{ text: string; images: number }> = [];
	const expansion: AcpPromptExpansion = {
		text: "expanded body",
		images: [{ type: "image", mimeType: "image/png", data: PNG }],
		workingContextPaths: ["/repo/README.md"],
		pendingSkillRequests: [{ name: "review" }],
		display: { text: "/review:quick", note: "expanded prompt template review:quick (3 lines)" },
	};
	const agent = serve(async (text, images) => {
		seen.push({ text, images: images.length });
		return expansion;
	});
	const { image, sessionId } = await agent.start();
	assert.equal(image, true, "image blocks are announced only when prompts are expanded");
	await agent.call("session/prompt", {
		sessionId,
		prompt: [
			{ type: "text", text: "@README.md summarize" },
			{ type: "image", mimeType: "image/png", data: PNG },
		],
	});
	assert.deepEqual(seen, [{ text: "@README.md summarize", images: 1 }]);
	assert.deepEqual(agent.submitted, [
		{
			text: "expanded body",
			options: {
				images: expansion.images,
				workingContextPaths: expansion.workingContextPaths,
				pendingSkillRequests: expansion.pendingSkillRequests,
				display: expansion.display,
			},
		},
	]);
	await agent.stop();
});

test("image blocks are refused without an expander, over the bound, or when they are not base64", async () => {
	const plain = serve();
	const { image, sessionId } = await plain.start();
	assert.equal(image, false);
	await assert.rejects(
		async () =>
			plain.call("session/prompt", {
				sessionId,
				prompt: [
					{ type: "text", text: "look" },
					{ type: "image", mimeType: "image/png", data: PNG },
				],
			}),
		invalid(/does not accept image blocks/),
	);
	await plain.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "@README.md as typed" }] });
	assert.deepEqual(plain.submitted, [{ text: "@README.md as typed", options: undefined }]);
	await plain.stop();

	const expanding = serve(async (text) => ({ text, images: [], workingContextPaths: [], pendingSkillRequests: [] }));
	const started = await expanding.start();
	const images = (count: number, data = PNG) =>
		Array.from({ length: count }, () => ({ type: "image", mimeType: "image/png", data }));
	await assert.rejects(
		async () =>
			expanding.call("session/prompt", {
				sessionId: started.sessionId,
				prompt: [{ type: "text", text: "many" }, ...images(5)],
			}),
		invalid(/at most 4 images/),
	);
	await assert.rejects(
		async () =>
			expanding.call("session/prompt", {
				sessionId: started.sessionId,
				prompt: [{ type: "text", text: "bad" }, ...images(1, "not base64!")],
			}),
		invalid(/base64/),
	);
	assert.equal(expanding.submitted.length, 0);
	await expanding.stop();
});

test("an expansion failure is the client's error, and nothing is submitted", async () => {
	const agent = serve(async () => {
		throw new Error("An attached file is not a PNG, JPEG, GIF or WebP image.");
	});
	const { sessionId } = await agent.start();
	await assert.rejects(
		async () => agent.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] }),
		invalid(/not a PNG/),
	);
	assert.equal(agent.submitted.length, 0);
	await agent.stop();
});
