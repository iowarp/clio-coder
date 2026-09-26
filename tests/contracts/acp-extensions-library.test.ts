import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import type { AcpExtensionReloadOutcome, AcpInstalledExtension } from "../../src/engine/acp/extensions.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

const EXTENSION = (overrides: Partial<AcpInstalledExtension>): AcpInstalledExtension => ({
	id: "survey-tools",
	name: "Survey tools",
	version: "1.2.0",
	description: "Field survey helpers",
	scope: "project",
	enabled: true,
	valid: true,
	compatible: true,
	loadable: true,
	diagnostics: [],
	...overrides,
});

async function peer(options: {
	list: AcpInstalledExtension[];
	reload: () => AcpExtensionReloadOutcome;
	libraryReload: () => { generation: number; previousGeneration: number; changed: boolean };
}) {
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	let streaming = false;
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
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		autonomy: () => "default",
		extensions: { list: () => options.list, reload: options.reload },
		libraryReload: options.libraryReload,
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => streaming,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) =>
		(await handlers.get(method)?.(params)) as Record<string, unknown>;
	const init = await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	return {
		init,
		sessionId,
		call,
		set streaming(value: boolean) {
			streaming = value;
		},
		stop: async () => {
			close();
			await served;
		},
	};
}

const committed: AcpExtensionReloadOutcome = {
	status: "committed",
	generation: 3,
	changed: true,
	added: [{}],
	removed: [],
	modified: [{}, {}],
	hooks: { registered: 4, dropped: 1, fileIssues: 1, issues: 1, overridden: 0 },
	lines: ["[clio-coder:extensions] hook dropped: pre-edit\u0007"],
};

test("the extension list is the session's own view, in the overlay's state words, without paths", async () => {
	const agent = await peer({
		list: [
			EXTENSION({}),
			EXTENSION({ id: "off", enabled: false }),
			EXTENSION({ id: "broken", valid: false, diagnostics: [{ message: "manifest is missing name" }] }),
			EXTENSION({ id: "old", compatible: false }),
			EXTENSION({ id: "shadow", loadable: false, overriddenBy: "user" }),
			{
				...EXTENSION({ id: "leaky" }),
				rootPath: "/home/someone/.config/x",
				manifestPath: "/x/y.yaml",
			} as AcpInstalledExtension,
		],
		reload: () => committed,
		libraryReload: () => ({ generation: 2, previousGeneration: 1, changed: true }),
	});
	try {
		const meta = (agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta;
		assert.deepEqual(meta["clio-coder/extensions"], {
			version: 1,
			list: "_clio-coder/extensions/list",
			reload: "_clio-coder/extensions/reload",
		});
		assert.deepEqual(meta["clio-coder/library"], { version: 1, reload: "_clio-coder/library/reload" });
		const listed = (await agent.call("_clio-coder/extensions/list", { sessionId: agent.sessionId })) as {
			extensions: Array<{ id: string; state: string; problems: number; overriddenBy?: string }>;
		};
		assert.deepEqual(
			listed.extensions.map((row) => [row.id, row.state]),
			[
				["survey-tools", "eligible"],
				["off", "disabled"],
				["broken", "invalid"],
				["old", "incompatible"],
				["shadow", "shadowed"],
				["leaky", "eligible"],
			],
		);
		assert.equal(listed.extensions[2]?.problems, 1);
		assert.equal(listed.extensions[4]?.overriddenBy, "user");
		assert.doesNotMatch(JSON.stringify(listed), /rootPath|manifestPath|\.config/);
	} finally {
		await agent.stop();
	}
});

test("an extension reload reports the committed generation, or the rejection and the generation that stays", async () => {
	let outcome: AcpExtensionReloadOutcome = committed;
	const agent = await peer({
		list: [],
		reload: () => outcome,
		libraryReload: () => ({ generation: 2, previousGeneration: 1, changed: true }),
	});
	try {
		const reloaded = await agent.call("_clio-coder/extensions/reload", { sessionId: agent.sessionId });
		assert.deepEqual(reloaded, {
			status: "committed",
			generation: 3,
			changed: true,
			added: 1,
			removed: 0,
			modified: 2,
			hooks: { registered: 4, dropped: 1, issues: 2, overridden: 0 },
			lines: ["[clio-coder:extensions] hook dropped: pre-edit "],
		});
		outcome = {
			status: "rejected",
			reason: "build-failed",
			generation: 3,
			lines: ["[clio-coder:extensions] bad manifest"],
		};
		assert.deepEqual(await agent.call("_clio-coder/extensions/reload", { sessionId: agent.sessionId }), {
			status: "rejected",
			reason: "build-failed",
			generation: 3,
			lines: ["[clio-coder:extensions] bad manifest"],
		});
		agent.streaming = true;
		await assert.rejects(
			agent.call("_clio-coder/extensions/reload", { sessionId: agent.sessionId }),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "prompt_active",
		);
	} finally {
		await agent.stop();
	}
});

test("a library reload reports the generation change, and a failed one says it failed", async () => {
	let fail = false;
	const agent = await peer({
		list: [],
		reload: () => committed,
		libraryReload: () => {
			if (fail) throw new Error("plugin tree digest mismatch");
			return { generation: 2, previousGeneration: 1, changed: true };
		},
	});
	try {
		assert.deepEqual(await agent.call("_clio-coder/library/reload", { sessionId: agent.sessionId }), {
			status: "refreshed",
			generation: 2,
			previousGeneration: 1,
			changed: true,
		});
		fail = true;
		assert.deepEqual(await agent.call("_clio-coder/library/reload", { sessionId: agent.sessionId }), {
			status: "failed",
			error: "plugin tree digest mismatch",
		});
	} finally {
		await agent.stop();
	}
});
