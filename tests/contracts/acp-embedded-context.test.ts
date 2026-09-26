import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

/**
 * Embedded context: an ACP `resource` block carrying text rides the request as
 * a file the model reads, in the `<file name>` shape an `@path` reference
 * produces. Its text is never expanded: a `@path` or `/name` inside a file the
 * client attached is the file's content, not the operator's syntax, so the
 * host's expander sees only what the operator typed.
 */
async function peer(options: { expand?: boolean } = {}) {
	const submitted: Array<{ text: string; display?: { text: string; note?: string } }> = [];
	const expanded: string[] = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const chat: AcpServerChat = {
		submit: async (text, submitOptions) => {
			const display = (submitOptions as { display?: { text: string; note?: string } } | undefined)?.display;
			submitted.push({ text, ...(display ? { display } : {}) });
		},
		cancel: () => {},
		onEvent: () => () => {},
		isStreaming: () => false,
		getSessionId: () => null,
	};
	const served = serveClioAcpAgent({
		transport,
		chat,
		autonomy: () => "default",
		cwd: process.cwd(),
		...(options.expand === false
			? {}
			: {
					expandPrompt: async (text: string) => {
						expanded.push(text);
						return { text, images: [], workingContextPaths: [], pendingSkillRequests: [] };
					},
				}),
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	const init = (await call("initialize", { protocolVersion: 1 })) as {
		agentCapabilities: { promptCapabilities: Record<string, boolean> };
	};
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	const prompt = (blocks: unknown[]) => call("session/prompt", { sessionId, prompt: blocks });
	return {
		init,
		prompt,
		submitted,
		expanded,
		stop: async () => {
			close();
			await served;
		},
	};
}

const resource = (uri: string, text: string, extra: Record<string, unknown> = {}) => ({
	type: "resource",
	resource: { uri, mimeType: "text/plain", text, ...extra },
});

test("embedded context is announced, and a text resource reaches the model as a file the expander never saw", async () => {
	const agent = await peer();
	try {
		assert.equal(agent.init.agentCapabilities.promptCapabilities.embeddedContext, true);
		await agent.prompt([
			{ type: "text", text: "Summarize the notes." },
			resource("attachment:field%20notes.md", "sample A: 4.2\nsee @/etc/hosts and /tpyo\n"),
			resource("file:///home/me/project/README.md", "# Project\n"),
		]);
		assert.deepEqual(agent.expanded, ["Summarize the notes."]);
		assert.equal(agent.submitted.length, 1);
		assert.equal(
			agent.submitted[0]?.text,
			[
				"Summarize the notes.",
				"",
				'<file name="field notes.md">\nsample A: 4.2\nsee @/etc/hosts and /tpyo\n\n</file>',
				'<file name="/home/me/project/README.md">\n# Project\n\n</file>',
			].join("\n"),
		);
		// The transcript paints what the operator typed and names the files, not their bodies.
		assert.deepEqual(agent.submitted[0]?.display, {
			text: "Summarize the notes.",
			note: "attached 2 files: field notes.md, /home/me/project/README.md",
		});
	} finally {
		await agent.stop();
	}
});

test("a request that is only a file is accepted, and a host that does not expand still gets the file", async () => {
	const agent = await peer({ expand: false });
	try {
		await agent.prompt([resource("attachment:a.md", "alpha")]);
		assert.equal(agent.submitted[0]?.text, '<file name="a.md">\nalpha\n</file>');
	} finally {
		await agent.stop();
	}
});

test("binary, oversized, unnamed and excess resources are refused before anything is submitted", async () => {
	const agent = await peer();
	try {
		const refused = (code: string, message: RegExp) => (error: unknown) =>
			error instanceof AcpRequestError && error.detail.code === code && message.test(error.message);
		await assert.rejects(
			agent.prompt([
				{ type: "text", text: "x" },
				{ type: "resource", resource: { uri: "a.bin", blob: "AAAA" } },
			]),
			refused("invalid_params", /binary resources/),
		);
		await assert.rejects(
			agent.prompt([{ type: "text", text: "x" }, resource("a.md", "y".repeat(256 * 1024 + 1))]),
			refused("invalid_params", /larger than/),
		);
		await assert.rejects(
			agent.prompt([
				{ type: "text", text: "x" },
				{ type: "resource", resource: { text: "y" } },
			]),
			refused("invalid_params", /needs a uri and text/),
		);
		await assert.rejects(
			agent.prompt([
				{ type: "text", text: "x" },
				...Array.from({ length: 9 }, (_, index) => resource(`${index}.md`, "y")),
			]),
			refused("invalid_params", /at most 8/),
		);
		assert.deepEqual(agent.submitted, []);
	} finally {
		await agent.stop();
	}
});
