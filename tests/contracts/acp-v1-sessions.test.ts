import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { TelemetryHub } from "../../src/core/telemetry/hub.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { suggestedSessionCostCeilingUsd } from "../../src/domains/scheduling/budget.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { acpUsageFacts } from "../../src/engine/acp/adapter.js";
import type { AcpCommandControl } from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import type { AcpUsageMeta } from "../../src/engine/acp/types.js";
import { budgetAlertNotice } from "../../src/interactive/bus-notices.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { writeSettledRun } from "../harness/settled-run.js";
import { readModelOf, telemetryCall } from "../harness/telemetry-view.js";

function fixture(
	entries: ReadonlyArray<SessionEntry> = [],
	onSubmit?: (emit: (event: unknown) => void) => void,
	commands?: AcpCommandControl,
	saveSettings = false,
	settlement?: { wait: () => Promise<void>; cancel?: () => void },
	bus?: TelemetryHub,
	/** The session's journal as the read model folds it, for a test that reads the usage block (#434 §11.3). */
	telemetry?: () => readonly TelemetryRecord[],
) {
	const requests = new Map<string, (params: unknown) => unknown>();
	const updates: Array<Record<string, unknown>> = [];
	const events: Array<Record<string, unknown>> = [];
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
	let safeSettings = {
		target: "target-a",
		model: "model-a",
		thinkingLevel: "medium" as "medium" | "high",
		autonomy: "default" as const,
	};
	let eventHandler: (event: unknown) => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push(params as Record<string, unknown>);
			else if (method === "_clio-coder/event") events.push(params as Record<string, unknown>);
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
			read: () => safeSettings,
			commit: (patch) => {
				if (saveSettings) {
					safeSettings = {
						...safeSettings,
						model: patch["chat.model"] ?? safeSettings.model,
						thinkingLevel: patch["chat.thinkingLevel"] === "high" ? "high" : safeSettings.thinkingLevel,
					};
					return safeSettings;
				}
				throw new Error("config option must not persist a default");
			},
		},
		...(commands ? { commands } : {}),
		...(bus ? { bus } : {}),
		...(telemetry
			? { usage: { quota: async () => [] }, telemetryReadModel: readModelOf(() => current?.id ?? null, telemetry) }
			: {}),
		setSessionRouting: (patch) => {
			routingChanges.push(patch);
		},
		readSessionEntries: () => entries,
		buildReplayMessages: () => [],
		chat: {
			...(settlement ? { whenSettled: settlement.wait } : {}),
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
				settlement?.cancel?.();
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
		emit: (event: unknown) => eventHandler(event),
		updates,
		events,
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

test("ACP saved routing updates the bound session config before a conversation choice", async () => {
	const peer = fixture([], undefined, undefined, true);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] });
		await peer.call("_clio-coder/settings/patch_safe", {
			patch: { "chat.model": "model-b", "chat.thinkingLevel": "high" },
		});
		const latest = peer.updates.at(-1)?.update as {
			sessionUpdate: string;
			configOptions: Array<{ id: string; currentValue: string }>;
		};
		strictEqual(latest.sessionUpdate, "config_option_update");
		strictEqual(latest.configOptions.find((row) => row.id === "model")?.currentValue, "model-b");
		const selected = (await peer.call("session/set_config_option", {
			sessionId: "created",
			configId: "model",
			value: "model-b",
		})) as { configOptions: Array<{ id: string; currentValue: string }> };
		strictEqual(selected.configOptions.find((row) => row.id === "thinkingLevel")?.currentValue, "high");
	} finally {
		await peer.stop();
	}
});

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
			_meta: {
				"clio-coder/session": {
					createdAt: "2026-09-25T12:00:00.000Z",
					endedAt: "2026-09-25T12:00:00.000Z",
					target: "target-a",
					model: "model-a",
				},
			},
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

test("ACP prompt usage writes the pricing facts that the delegation adapter reads", async () => {
	// The turn's one call, priced from the catalog, as the read model folds it.
	const records = telemetryCall("acp", {
		turnId: "turn-1",
		usage: { input: 3, output: 2 },
		usd: 0.01,
		pricedBy: "catalog",
	});
	const peer = fixture(
		[],
		(emit) => {
			emit({ type: "agent_start", turnId: "turn-1" });
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 3, output: 2, cost: { total: 0.01 }, pricedBy: "catalog" },
				},
			});
			emit({ type: "agent_end", turnId: "turn-1", messages: [] });
		},
		undefined,
		false,
		undefined,
		undefined,
		() => records,
	);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const opened = (await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] })) as { sessionId: string };
		const result = (await peer.call("session/prompt", {
			sessionId: opened.sessionId,
			prompt: [{ type: "text", text: "Hello" }],
		})) as { _meta: { "clio-coder/usage": AcpUsageMeta } };
		const usd = result._meta["clio-coder/usage"].quantities?.usd.fact;
		ok(usd);
		// A catalog price stays an estimate on the wire, and the delegation adapter reads it back as one (#434).
		ok("kind" in usd ? usd.kind === "estimated" : usd.coverage.estimated === 1);
		strictEqual(acpUsageFacts(result._meta["clio-coder/usage"]).pricing.usd.kind, "estimated");
	} finally {
		await peer.stop();
	}
});

test("a reloaded session replays a finished run's token facts as the live frame words them (#434)", async () => {
	const timestamp = "2026-09-25T12:00:00.000Z";
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	const settle = (runId: string, outcome: "succeeded" | "failed", apiCalls: number | null) =>
		writeSettledRun(
			clioStateDir(),
			{
				...fixtureReceiptDraft({ ...fixtureEnvelope(runId), startedAt: timestamp, endedAt: timestamp }),
				outcome,
				exitCode: outcome === "succeeded" ? 0 : 1,
			},
			{
				usage: {
					input: measured(1_000),
					output: measured(200),
					cacheRead: measured(0),
					cacheWrite: measured(0),
					cacheWrite1h: measured(0),
					reasoning: measured(0),
				},
				totalTokens: measured(1_200),
				apiCalls: apiCalls === null ? { kind: "unknown", reason: "not-observed" } : measured(apiCalls),
				pricing: { usd: measured(0), pricedBy: "none" },
			},
		);
	await settle("replay-partial", "succeeded", 3);
	await settle("replay-failed", "failed", 2);
	await settle("replay-legacy", "succeeded", null);
	const worker = (runId: string, index: number): SessionEntry =>
		({
			kind: "workerRun",
			turnId: `worker-${index}`,
			parentTurnId: "ask",
			timestamp,
			assignmentId: runId,
			runId,
			origin: "agent",
			agentId: "coder",
			runtime: { kind: "clio", targetId: "target-a", wireModelId: "model-a" },
		}) as SessionEntry;
	const loaded = fixture([
		{ kind: "message", role: "user", turnId: "ask", parentTurnId: null, timestamp, payload: "Ship it" },
		worker("replay-partial", 1),
		worker("replay-failed", 2),
		worker("replay-legacy", 3),
	]);
	try {
		await loaded.call("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				_meta: { "clio-coder/events": { version: 1, kinds: ["run.completed", "run.failed"] } },
			},
		});
		await loaded.call("session/load", { sessionId: "session-1", cwd: loaded.cwd, mcpServers: [] });
		deepStrictEqual(
			loaded.events.map((event) => {
				const { runId, totalTokens, apiCalls, tokenDisplay } = event.payload as Record<string, unknown>;
				return { kind: event.kind, runId, totalTokens, apiCalls, tokenDisplay };
			}),
			[
				{
					kind: "run.completed",
					runId: "replay-partial",
					totalTokens: measured(1_200),
					apiCalls: { kind: "measured", value: 3, source: "local-count" },
					tokenDisplay: "1,200",
				},
				{
					kind: "run.failed",
					runId: "replay-failed",
					totalTokens: measured(1_200),
					apiCalls: { kind: "measured", value: 2, source: "local-count" },
					tokenDisplay: "1,200",
				},
				{
					kind: "run.completed",
					runId: "replay-legacy",
					totalTokens: measured(1_200),
					apiCalls: null,
					tokenDisplay: "1,200",
				},
			],
		);
	} finally {
		await loaded.stop();
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

test("an injected command stays inside its ACP prompt until settlement, including cancellation", async () => {
	for (const cancel of [false, true]) {
		let finish = () => {};
		let began = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const commands: AcpCommandControl = {
			catalog: () => ({
				version: 1,
				commands: [
					{
						name: "skill",
						summary: "Use a skill",
						usage: "/skill <name>",
						group: "Session",
						args: {},
						injectsUserTurn: true,
					},
				],
			}),
			invoke: () => {
				began();
				return { level: "info", lines: ["Skill started"] };
			},
			injectsUserTurn: () => true,
			capability: {},
		};
		const peer = fixture([], () => {}, commands, false, { wait: () => done, cancel: finish });
		try {
			await peer.call("initialize", { protocolVersion: 1 });
			await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] });
			const announcement = peer.updates.find(
				(params) => (params.update as { sessionUpdate?: string }).sessionUpdate === "available_commands_update",
			);
			strictEqual(
				(announcement?.update as { availableCommands: Array<{ name: string }> }).availableCommands.some(
					(command) => command.name === "skill",
				),
				true,
			);
			let answered = false;
			const prompt = peer
				.call("session/prompt", { sessionId: "created", prompt: [{ type: "text", text: "/skill survey" }] })
				.then((result) => {
					answered = true;
					return result as { stopReason: string };
				});
			await started;
			await Promise.resolve();
			strictEqual(answered, false);
			peer.emit({ type: "text_delta", text: "Visible skill response" });
			if (cancel) await peer.call("session/cancel", { sessionId: "created" });
			else {
				peer.emit({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Visible skill response" }] },
				});
				finish();
			}
			strictEqual((await prompt).stopReason, cancel ? "cancelled" : "end_turn");
			strictEqual(
				peer.updates.some(
					(params) => (params.update as { content?: { text: string } }).content?.text === "Visible skill response",
				),
				true,
			);
			const response = peer.updates
				.filter((params) => (params.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk")
				.map((params) => (params.update as { content: { text: string } }).content.text)
				.join("");
			strictEqual(response.includes("Visible skill response\n\nSkill started"), true);
		} finally {
			finish();
			await peer.stop();
		}
	}
});

test("a refused injecting command does not produce a successful ACP turn", async () => {
	const commands: AcpCommandControl = {
		catalog: () => ({
			version: 1,
			commands: [
				{
					name: "skill",
					summary: "Use a skill",
					usage: "/skill <name>",
					group: "Session",
					args: {},
					injectsUserTurn: true,
				},
			],
		}),
		invoke: () => ({ level: "error", lines: ["No such skill"] }),
		injectsUserTurn: () => true,
		capability: {},
	};
	const peer = fixture([], () => {}, commands, false, { wait: async () => {} });
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		await peer.call("session/new", { cwd: peer.cwd, mcpServers: [] });
		await rejects(
			peer.call("session/prompt", { sessionId: "created", prompt: [{ type: "text", text: "/skill missing" }] }),
			(error: unknown) =>
				error instanceof AcpRequestError && error.rpcCode === -32603 && error.message === "the prompt turn failed",
		);
	} finally {
		await peer.stop();
	}
});

test("ACP load retains the compaction row and its operator notes as a notice", async () => {
	const peer = fixture([
		{
			kind: "compactionSummary",
			turnId: "summary",
			parentTurnId: null,
			timestamp: "2026-09-25T12:00:00.000Z",
			firstKeptTurnId: "summary",
			tokensBefore: 8000,
			tokensAfter: 4000,
			summary: "Remember: preserve the output format.",
		},
	]);
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		await peer.call("session/load", { sessionId: "session-1", cwd: peer.cwd, mcpServers: [] });
		const frame = peer.updates[0] as { update: { content: { text: string } }; _meta: Record<string, unknown> };
		strictEqual(
			frame.update.content.text,
			"[context engine] compacted 8000 → 4000 tokens\nRemember: preserve the output format.",
		);
		deepStrictEqual(frame._meta["clio-coder/notice"], { level: "info" });
	} finally {
		await peer.stop();
	}
});

test("ACP session listing hides empty failed turns before pagination", async () => {
	const peer = fixture();
	const empty = peer.history[0];
	if (!empty) throw new Error("missing fixture session");
	empty.hasModelTurn = false;
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		const result = (await peer.call("session/list", {})) as { sessions: Array<{ sessionId: string }> };
		strictEqual(result.sessions.length, 50);
		strictEqual(
			result.sessions.some((row) => row.sessionId === "session-0"),
			false,
		);
		strictEqual(result.sessions[0]?.sessionId, "session-1");
	} finally {
		await peer.stop();
	}
});

test("ACP session/new carries the workspace view and an edit that dirties the tree re-sends it", async () => {
	const requests = new Map<string, (params: unknown) => unknown>();
	const updates: Array<Record<string, unknown>> = [];
	let close: () => void = () => {};
	let onEvent: (event: unknown) => void = () => {};
	let dirty = false;
	let probes = 0;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push((params as { update: Record<string, unknown> }).update);
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
	const settle = (id: string, toolName: string) => {
		onEvent({ type: "tool_execution_start", toolCallId: id, toolName, args: { path: "README.md" } });
		onEvent({ type: "tool_execution_end", toolCallId: id, toolName, result: "ok", isError: false });
	};
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		workspace: async (cwd) => {
			probes++;
			return {
				cwd,
				isGit: true,
				branch: "v060",
				dirty,
				ahead: 0,
				behind: null,
				recentCommits: [{ sha: "abc", subject: "private subject" }],
				remoteUrl: "https://user:secret-token@github.com/iowarp/clio-coder",
				projectType: "unknown",
				capturedAt: new Date().toISOString(),
			};
		},
		chat: {
			submit: async () => {
				settle("r1", "read");
				dirty = true;
				settle("e1", "edit");
			},
			cancel: () => {},
			onEvent: (handler) => {
				onEvent = handler;
				return () => {
					onEvent = () => {};
				};
			},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) => await requests.get(method)?.(params);
	const init = (await call("initialize", { protocolVersion: 1 })) as {
		agentCapabilities: { _meta: Record<string, unknown> };
	};
	deepStrictEqual(init.agentCapabilities._meta["clio-coder/workspace"], { version: 1, update: "session_info_update" });
	const created = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as {
		sessionId: string;
		_meta: Record<string, Record<string, unknown>>;
	};
	const view = created._meta["clio-coder/workspace"];
	strictEqual(view?.dirty, false);
	strictEqual(view?.branch, "v060");
	strictEqual(view?.remoteUrl, "https://github.com/iowarp/clio-coder");
	strictEqual(view?.recentCommits, undefined);
	strictEqual(probes, 1);
	await call("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "edit" }] });
	strictEqual(probes, 2, "a read settles without a probe; the edit probes once");
	const infos = updates.filter((update) => update.sessionUpdate === "session_info_update") as Array<{
		_meta: Record<string, Record<string, unknown>>;
	}>;
	strictEqual(infos.length, 1);
	strictEqual(infos[0]?._meta["clio-coder/workspace"]?.dirty, true);
	close();
	await served;
});

test("ACP carries a session cost ceiling stop as a notice chunk with its figures, live and on replay", async () => {
	const budgetMeta = (frame: Record<string, unknown>) => (frame._meta as Record<string, unknown>)["clio-coder/budget"];
	const text = (frame: Record<string, unknown>) =>
		((frame.update as { content: { text: string } }).content as { text: string }).text;
	// Live: the alert the admission wait raises inside a prompt crosses as that prompt's chunk,
	// with the TUI's exact notice text and the raise a client can apply.
	const bus = createTelemetryHub();
	const live = fixture([], undefined, undefined, false, undefined, bus);
	const alert = { level: "at" as const, currentUsd: 5.0008, ceilingUsd: 5, contextTokens: 12345.4 };
	try {
		const init = (await live.call("initialize", { protocolVersion: 1 })) as {
			agentCapabilities: { _meta: Record<string, unknown> };
		};
		deepStrictEqual(init.agentCapabilities._meta["clio-coder/budget"], {
			version: 1,
			meta: "clio-coder/budget",
			update: "agent_message_chunk",
			setting: "safety.limits.sessionCostUsd",
			replay: true,
		});
		bus.emit("budget.alerted", alert);
		strictEqual(live.updates.length, 0, "an alert outside a prompt has no turn to belong to");
		const opened = (await live.call("session/new", { cwd: live.cwd, mcpServers: [] })) as { sessionId: string };
		const prompt = live.call("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "Go" }] });
		await Promise.resolve();
		const before = live.updates.length;
		bus.emit("budget.alerted", alert);
		const frame = live.updates[before];
		if (frame === undefined) throw new Error("the parked prompt sent no budget frame");
		strictEqual((frame.update as { sessionUpdate: string }).sessionUpdate, "agent_message_chunk");
		strictEqual(text(frame), `${budgetAlertNotice(alert)?.text}\n`);
		deepStrictEqual((frame._meta as Record<string, unknown>)["clio-coder/notice"], { level: "warning" });
		deepStrictEqual(budgetMeta(frame), {
			version: 1,
			currentDisplay: "$5.00",
			ceilingDisplay: "$5.00",
			raiseDisplay: "$5.50",
			level: "at",
			currentUsd: 5.0008,
			ceilingUsd: 5,
			contextTokens: 12345,
			raiseToUsd: suggestedSessionCostCeilingUsd(5.0008, 5),
			setting: "safety.limits.sessionCostUsd",
		});
		await live.call("session/cancel", { sessionId: opened.sessionId });
		strictEqual(((await prompt) as { stopReason: string }).stopReason, "cancelled");
	} finally {
		await live.stop();
	}
	// Replay: the durable block comes back inside its turn with the raise it recorded, and no
	// other custom entry crosses.
	const timestamp = "2026-09-25T12:00:00.000Z";
	const block = {
		level: "over" as const,
		currentUsd: 5.2,
		ceilingUsd: 5,
		contextTokens: 9000,
		raiseToUsd: 5.72,
		setting: "safety.limits.sessionCostUsd" as const,
	};
	const loaded = fixture([
		{ kind: "message", role: "user", turnId: "ask", parentTurnId: null, timestamp, payload: "Ship it" },
		{
			kind: "custom",
			customType: "budgetBlock",
			turnId: "stop",
			parentTurnId: "ask",
			timestamp,
			display: true,
			data: block,
		},
		{
			kind: "custom",
			customType: "retryStatus",
			turnId: "retry",
			parentTurnId: "ask",
			timestamp,
			display: true,
			data: {},
		},
	]);
	try {
		await loaded.call("initialize", { protocolVersion: 1 });
		await loaded.call("session/load", { sessionId: "session-1", cwd: loaded.cwd, mcpServers: [] });
		const frames = loaded.updates.filter((frame) => budgetMeta(frame) !== undefined);
		strictEqual(frames.length, 1);
		const frame = frames[0];
		if (frame === undefined) throw new Error("unreachable");
		strictEqual(loaded.updates.filter((candidate) => text(candidate) === "").length, 0);
		strictEqual(text(frame), `${budgetAlertNotice(block)?.text}\n`);
		deepStrictEqual((frame._meta as Record<string, unknown>)["clio-coder/replay"], { turn: 1 });
		deepStrictEqual((frame._meta as Record<string, unknown>)["clio-coder/notice"], { level: "error" });
		deepStrictEqual(budgetMeta(frame), {
			version: 1,
			...block,
			currentDisplay: "$5.20",
			ceilingDisplay: "$5.00",
			raiseDisplay: "$5.72",
		});
		strictEqual(
			loaded.updates.filter(
				(candidate) => (candidate.update as { sessionUpdate: string }).sessionUpdate !== "user_message_chunk",
			).length,
			1,
			"the retry status entry stays off the wire",
		);
	} finally {
		await loaded.stop();
	}
});
