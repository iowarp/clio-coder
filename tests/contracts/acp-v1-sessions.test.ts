import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AcpCommandControl } from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

function fixture(
	entries: ReadonlyArray<SessionEntry> = [],
	onSubmit?: (emit: (event: unknown) => void) => void,
	commands?: AcpCommandControl,
) {
	const requests = new Map<string, (params: unknown) => unknown>();
	const updates: Array<Record<string, unknown>> = [];
	const cwd = process.cwd();
	const timestamp = "2026-09-25T12:00:00.000Z";
	const history: SessionMeta[] = Array.from({ length: 55 }, (_, index) => ({
		id: `session-${index}`,
		cwd,
		cwdHash: "fixture",
		createdAt: timestamp,
		endedAt: timestamp,
		model: "model-a",
		target: "target-a",
		clioCoderVersion: "0.5.6",
		piMonoVersion: "fixture",
		platform: "fixture",
		nodeVersion: "fixture",
		name: `Session ${index}`,
	}));
	let current: SessionMeta | null = null;
	let close: () => void = () => {};
	let cancelled = false;
	let settlePrompt: () => void = () => {};
	let promptPending = false;
	let resets = 0;
	const routingChanges: Array<{ model?: string; thinkingLevel?: string }> = [];
	let eventHandler: (event: unknown) => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push(params as Record<string, unknown>);
		},
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
	const session = {
		current: () => current,
		history: () => history,
		create: () => {
			const initial = history[0];
			if (!initial) throw new Error("fixture has no session template");
			const meta = { ...initial, id: "created", endedAt: null };
			current = meta;
			history.unshift(meta);
			return meta;
		},
		resume: (id: string) => {
			const meta = history.find((row) => row.id === id);
			if (!meta) throw new Error("missing");
			current = meta;
			return meta;
		},
		close: async () => {
			if (current) current.endedAt = timestamp;
			current = null;
		},
		tree: () => ({ leafId: null }),
		setName: (name: string, id: string) => {
			const meta = history.find((row) => row.id === id);
			if (meta) meta.name = name;
		},
		deleteSession: (id: string) => {
			const index = history.findIndex((row) => row.id === id);
			if (index >= 0) history.splice(index, 1);
		},
	} as unknown as SessionContract;
	const done = serveClioAcpAgent({
		transport,
		session,
		cwd,
		autonomy: () => "default",
		routing: () => ({ target: "target-a", model: "model-a" }),
		settings: {
			read: () => ({ target: "target-a", model: "model-a", thinkingLevel: "medium", autonomy: "default" }),
			commit: () => {
				throw new Error("config option must not persist a default");
			},
		},
		...(commands ? { commands } : {}),
		setSessionRouting: (patch) => {
			routingChanges.push(patch);
		},
		readSessionEntries: () => entries,
		buildReplayMessages: () => [],
		chat: {
			submit: async () => {
				if (onSubmit) {
					onSubmit(eventHandler);
					return;
				}
				promptPending = true;
				await new Promise<void>((resolve) => {
					settlePrompt = resolve;
				});
				promptPending = false;
			},
			cancel: () => {
				cancelled = true;
				settlePrompt();
			},
			onEvent: (handler) => {
				eventHandler = handler;
				return () => {
					eventHandler = () => {};
				};
			},
			isStreaming: () => promptPending,
			getSessionId: () => current?.id ?? null,
			resetForSession: () => {
				resets++;
			},
		},
	});
	return {
		cwd,
		requests,
		updates,
		history,
		routingChanges,
		get cancelled() {
			return cancelled;
		},
		get resets() {
			return resets;
		},
		call: async (method: string, params: unknown) => {
			const handler = requests.get(method);
			if (!handler) throw new Error(`missing handler: ${method}`);
			return await handler(params);
		},
		stop: async () => {
			close();
			await done;
		},
	};
}

test("ACP stable session list pages SessionInfo and filters cwd", async () => {
	const peer = fixture();
	try {
		const init = (await peer.call("initialize", { protocolVersion: 1 })) as {
			agentCapabilities: { sessionCapabilities: Record<string, unknown> };
		};
		deepStrictEqual(Object.keys(init.agentCapabilities.sessionCapabilities).sort(), [
			"close",
			"delete",
			"list",
			"resume",
		]);
		const first = (await peer.call("session/list", { cwd: peer.cwd })) as {
			sessions: Array<Record<string, unknown>>;
			nextCursor?: string;
		};
		strictEqual(first.sessions.length, 50);
		deepStrictEqual(first.sessions[0], {
			sessionId: "session-0",
			cwd: peer.cwd,
			title: "Session 0",
			updatedAt: "2026-09-25T12:00:00.000Z",
		});
		strictEqual(typeof first.nextCursor, "string");
		const second = (await peer.call("session/list", { cursor: first.nextCursor })) as {
			sessions: Array<Record<string, unknown>>;
			nextCursor?: string;
		};
		strictEqual(second.sessions.length, 5);
		strictEqual(second.nextCursor, undefined);
		deepStrictEqual(await peer.call("session/list", { cwd: "/different-workspace" }), { sessions: [] });
		await rejects(peer.call("session/list", { cursor: "bad" }), /cursor/u);
		strictEqual(peer.requests.has("_clio-coder/session/list"), false);
		deepStrictEqual(await peer.call("session/delete", { sessionId: "session-0" }), {});
		strictEqual(
			peer.history.some((row) => row.id === "session-0"),
			false,
		);
		strictEqual(peer.requests.has("_clio-coder/session/delete"), false);
	} finally {
		await peer.stop();
	}
});

test("ACP resume restores without replay, while mode and config controls share the session", async () => {
	const peer = fixture();
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const resumed = (await peer.call("session/resume", {
			sessionId: "session-1",
			cwd: peer.cwd,
			mcpServers: [],
		})) as {
			modes: { currentModeId: string; availableModes: Array<{ id: string }> };
			configOptions: Array<{ category: string }>;
		};
		strictEqual(peer.resets, 1);
		strictEqual(peer.updates.length, 0);
		strictEqual(resumed.modes.currentModeId, "default");
		deepStrictEqual(
			resumed.modes.availableModes.map((mode: { id: string }) => mode.id),
			["default", "yolo"],
		);
		deepStrictEqual(
			resumed.configOptions.map((option: { category: string }) => option.category),
			["mode", "model", "thought_level"],
		);
		deepStrictEqual(await peer.call("session/set_mode", { sessionId: "session-1", modeId: "yolo" }), {});
		strictEqual((peer.updates.at(-2)?.update as Record<string, unknown>).sessionUpdate, "current_mode_update");
		strictEqual((peer.updates.at(-1)?.update as Record<string, unknown>).sessionUpdate, "config_option_update");
		const changed = (await peer.call("session/set_config_option", {
			sessionId: "session-1",
			configId: "autonomy",
			value: "default",
		})) as { configOptions: Array<{ currentValue: string }> };
		strictEqual(changed.configOptions[0]?.currentValue, "default");
		await peer.call("session/set_config_option", {
			sessionId: "session-1",
			configId: "thinkingLevel",
			value: "high",
		});
		deepStrictEqual(peer.routingChanges, [{ thinkingLevel: "high" }]);
		await peer.call("_clio-coder/session/label", { sessionId: "session-1", label: "Renamed" });
		deepStrictEqual(peer.updates.at(-1)?.update, { sessionUpdate: "session_info_update", title: "Renamed" });
		strictEqual(peer.requests.has("_clio-coder/session/autonomy"), false);
	} finally {
		await peer.stop();
	}
});

test("ACP close cancels and waits for an active prompt", async () => {
	const peer = fixture();
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const opened = (await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] })) as { sessionId: string };
		const prompt = peer.call("session/prompt", {
			sessionId: opened.sessionId,
			prompt: [{ type: "text", text: "Hello" }],
		});
		await Promise.resolve();
		await rejects(peer.call("session/set_mode", { sessionId: opened.sessionId, modeId: "yolo" }), /active prompt/u);
		deepStrictEqual(await peer.call("session/close", { sessionId: opened.sessionId }), {});
		strictEqual(peer.cancelled, true);
		strictEqual(((await prompt) as { stopReason: string }).stopReason, "cancelled");
	} finally {
		await peer.stop();
	}
});

test("ACP load streams the complete active history beyond the former 64 turn limit", async () => {
	const timestamp = "2026-09-25T12:00:00.000Z";
	const entries: SessionEntry[] = [];
	let parentTurnId: string | null = null;
	for (let index = 0; index < 70; index++) {
		const userId = `user-${index}`;
		const replyId = `reply-${index}`;
		entries.push({ kind: "message", role: "user", turnId: userId, parentTurnId, timestamp, payload: `Prompt ${index}` });
		entries.push({
			kind: "message",
			role: "assistant",
			turnId: replyId,
			parentTurnId: userId,
			timestamp,
			payload: `Reply ${index}`,
		});
		parentTurnId = replyId;
	}
	const peer = fixture(entries);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const result = (await peer.call("session/load", { sessionId: "session-1", cwd: peer.cwd, mcpServers: [] })) as {
			_meta: { "clio-coder/session": { replayed: { turns: number; truncated: boolean } } };
		};
		deepStrictEqual(result._meta["clio-coder/session"].replayed, { turns: 70, truncated: false });
		strictEqual(peer.updates.length, 140);
		strictEqual((peer.updates[0]?.update as { content: { text: string } }).content.text, "Prompt 0");
		strictEqual((peer.updates.at(-1)?.update as { content: { text: string } }).content.text, "Reply 69");
	} finally {
		await peer.stop();
	}
});

test("ACP load streams history beyond the former four MiB byte limit", async () => {
	const largeText = "x".repeat(5 * 1024 * 1024);
	const peer = fixture([
		{
			kind: "message",
			role: "user",
			turnId: "large-user",
			parentTurnId: null,
			timestamp: "2026-09-25T12:00:00.000Z",
			payload: largeText,
		},
	]);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		await peer.call("session/load", { sessionId: "session-1", cwd: peer.cwd, mcpServers: [] });
		const replayed = peer.updates.map((params) => (params.update as { content: { text: string } }).content.text).join("");
		strictEqual(replayed.length, largeText.length);
		strictEqual(replayed, largeText);
	} finally {
		await peer.stop();
	}
});

test("ACP prompt usage writes cost provenance that the delegation adapter reads", async () => {
	const peer = fixture([], (emit) => {
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 3, output: 2, cost: { total: 0.01 }, costProvenance: "estimated" },
			},
		});
	});
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const opened = (await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] })) as { sessionId: string };
		const result = (await peer.call("session/prompt", {
			sessionId: opened.sessionId,
			prompt: [{ type: "text", text: "Hello" }],
		})) as { _meta: { "clio-coder/usage": { costProvenance: string } } };
		strictEqual(result._meta["clio-coder/usage"].costProvenance, "estimated");
	} finally {
		await peer.stop();
	}
});

test("ACP tool call start includes the canonical tool name", async () => {
	const peer = fixture([], (emit) => {
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } });
	});
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const opened = (await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] })) as { sessionId: string };
		await peer.call("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "Read" }] });
		strictEqual((peer.updates[0]?.update as { name: string }).name, "read");
	} finally {
		await peer.stop();
	}
});

test("ACP advertises only slash commands executable from a prompt", async () => {
	let submitted = false;
	const commands: AcpCommandControl = {
		catalog: () => ({
			version: 1,
			commands: [
				{ name: "doctor", summary: "Inspect Clio", usage: "/doctor", group: "help", args: {} },
				{ name: "share", summary: "Share a note", usage: "/share <text>", group: "help", args: {}, injectsUserTurn: true },
			],
		}),
		invoke: () => ({ level: "info", lines: ["Doctor ready"] }),
		injectsUserTurn: () => false,
		capability: {},
	};
	const peer = fixture(
		[],
		() => {
			submitted = true;
		},
		commands,
	);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const opened = (await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] })) as { sessionId: string };
		const announced = peer.updates.find(
			(params) => (params.update as Record<string, unknown>).sessionUpdate === "available_commands_update",
		);
		deepStrictEqual(
			(announced?.update as { availableCommands: Array<{ name: string }> }).availableCommands.map((entry) => entry.name),
			["doctor"],
		);
		await peer.call("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "/doctor" }] });
		strictEqual(submitted, false);
		strictEqual(
			(
				peer.updates.find((params) => (params.update as Record<string, unknown>).sessionUpdate === "agent_message_chunk")
					?.update as { content: { text: string } }
			).content.text,
			"Doctor ready",
		);
	} finally {
		await peer.stop();
	}
});

test("ACP slash command input errors keep the invalid-params code", async () => {
	const commands: AcpCommandControl = {
		catalog: () => ({
			version: 1,
			commands: [{ name: "doctor", summary: "Inspect Clio", usage: "/doctor", group: "help", args: {} }],
		}),
		invoke: () => {
			throw new AcpRequestError(-32602, "invalid command arguments", { code: "invalid_params" });
		},
		injectsUserTurn: () => false,
		capability: {},
	};
	const peer = fixture([], undefined, commands);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const opened = (await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] })) as { sessionId: string };
		await rejects(
			peer.call("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "/doctor bad" }] }),
			(error: unknown) => (error as AcpRequestError).rpcCode === -32602,
		);
	} finally {
		await peer.stop();
	}
});
