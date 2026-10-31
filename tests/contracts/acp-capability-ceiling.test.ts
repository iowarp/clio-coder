import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import {
	narrowTurnConstraints,
	snapshotTurnConstraints,
	type TurnConstraints,
} from "../../src/core/turn-constraints.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { FleetRunPreviewResult } from "../../src/domains/dispatch/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const CEILING = "clio-coder/ceiling";

test("an ACP client's session and prompt ceilings narrow the operator's limits and are enforced", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	assert.ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	const cwd = process.cwd();
	let current: SessionMeta | null = null;
	let turns = 0;
	const session = {
		current: () => current,
		create: () => {
			current = {
				id: "acp-ceiling",
				cwd,
				cwdHash: "hash",
				createdAt: "2026-10-16T00:00:00.000Z",
				endedAt: null,
				model: null,
				target: null,
			} as SessionMeta;
			return current;
		},
		resume: () => current,
		append: (turn: Record<string, unknown>) => ({ ...turn, id: `turn-${++turns}`, at: "2026-10-16T00:00:00.000Z" }),
		appendEntry: (entry: Record<string, unknown>) => entry,
		checkpoint: async () => {},
		flushAppends: () => {},
		replaceEntries: () => {},
		tree: () => ({ leafId: null, nodes: [], nodesById: { "turn-1": { kind: "user" } } }),
		fork: () => {
			current = { ...(current as SessionMeta), id: "acp-ceiling-fork" };
			return current;
		},
	} as unknown as SessionContract;
	// What admission decides inside the turn, under the scope the turn actually ran with.
	const safety = createWorkerSafety({ cwd });
	let inTurn: TurnConstraints | undefined;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		// The operator started `clio-coder acp --allow-tools read,write,bash`.
		sessionToolLimits: { allowedTools: ["read", "write", "bash"] },
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			agent: {
				state: options?.initialState,
				subscribe: () => () => {},
				abort() {},
				async prompt() {
					inTurn = loop.currentTurnConstraints?.();
				},
			},
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	const admit = (tool: string, args: Record<string, unknown>) => {
		const verdict = evaluateAdmission({
			principal: "main",
			effects: [{ tool, args }],
			safety,
			autonomy: "default",
			constraints: { ...(inTurn !== undefined ? { turnConstraints: inTurn } : {}) },
		});
		return verdict.kind === "deny" ? verdict.code : verdict.kind;
	};
	const requests = new Map<string, (params: unknown) => unknown>();
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
	const done = serveClioAcpAgent({
		transport,
		session,
		cwd,
		autonomy: () => "default",
		chat: loop,
		readSessionEntries: () => [],
		buildReplayMessages: () => [],
	});
	const call = async (method: string, params: unknown) => {
		const handler = requests.get(method);
		assert.ok(handler, method);
		return (await handler(params)) as { sessionId?: string; _meta?: Record<string, unknown> };
	};
	const prompt = async (ceiling?: unknown) =>
		(
			await call("session/prompt", {
				sessionId: "acp-ceiling",
				prompt: [{ type: "text", text: "do the task" }],
				...(ceiling !== undefined ? { _meta: { [CEILING]: ceiling } } : {}),
			})
		)._meta?.[CEILING];
	const refused = (error: unknown) =>
		error instanceof AcpRequestError && error.rpcCode === -32602 && error.detail.code === "invalid_ceiling";
	try {
		await call("initialize", { protocolVersion: 1 });
		// A malformed ceiling refuses the request before any session exists.
		await assert.rejects(
			call("session/new", { cwd, mcpServers: [], _meta: { [CEILING]: { allowedTools: "read" } } }),
			refused,
		);
		const created = await call("session/new", {
			cwd,
			mcpServers: [],
			_meta: { [CEILING]: { allowedTools: ["read", "write"], delegation: "forbidden" } },
		});
		assert.deepEqual(created._meta?.[CEILING], { allowedTools: ["read", "write"], delegation: "forbidden" });

		// The prompt asks for bash; the session ceiling already withheld it.
		assert.deepEqual(await prompt({ allowedTools: ["read", "bash"] }), {
			allowedTools: ["read"],
			delegation: "forbidden",
		});
		assert.equal(admit("bash", { command: "ls" }), "tool_scope");
		assert.equal(admit("dispatch", { agent: "scout", task: "look" }), "tool_scope");

		assert.deepEqual(await prompt({ readOnly: true }), {
			allowedTools: ["read", "write"],
			delegation: "forbidden",
			readOnly: true,
		});
		assert.equal(admit("write", { path: "out.txt", content: "x" }), "read_only");
		assert.equal(admit("read", { path: "package.json" }), "allow");

		// A prompt ceiling lasts for its prompt only; the session ceiling stands.
		assert.deepEqual(await prompt(), { allowedTools: ["read", "write"], delegation: "forbidden" });

		for (const malformed of [{ readOnly: false }, { network: "off" }, ["read"], { delegatedTools: ["no spaces"] }]) {
			await assert.rejects(prompt(malformed), refused, JSON.stringify(malformed));
		}

		// A fork inherits the source ceiling; its own ceiling narrows it and never widens it.
		const narrowed = { allowedTools: ["read", "write"], delegation: "forbidden", readOnly: true };
		const forked = await call("_clio-coder/session/fork", {
			sessionId: "acp-ceiling",
			turnId: "turn-1",
			_meta: { [CEILING]: { allowedTools: ["read", "write", "bash"], delegation: "allowed", readOnly: true } },
		});
		assert.equal(forked.sessionId, "acp-ceiling-fork");
		assert.deepEqual(forked._meta?.[CEILING], narrowed);
		const afterFork = await call("session/prompt", {
			sessionId: "acp-ceiling-fork",
			prompt: [{ type: "text", text: "do the task" }],
		});
		assert.deepEqual(afterFork._meta?.[CEILING], narrowed);
		assert.equal(admit("grep", { pattern: "x" }), "tool_scope");
		assert.equal(admit("write", { path: "out.txt", content: "x" }), "read_only");
	} finally {
		close();
		await done;
		loop.dispose();
		await loop.whenSettled();
	}
});

test("a slash command under an ACP ceiling runs only as a read or a bounded turn, and its dispatch carries the limits", async () => {
	const cwd = process.cwd();
	let current: SessionMeta | null = null;
	const session = {
		current: () => current,
		create: () => {
			current = {
				id: "acp-ceiling-commands",
				cwd,
				cwdHash: "hash",
				createdAt: "2026-10-16T00:00:00.000Z",
				endedAt: null,
				model: null,
				target: null,
			} as SessionMeta;
			return current;
		},
		append: (turn: Record<string, unknown>) => ({ ...turn, id: "turn-1", at: "2026-10-16T00:00:00.000Z" }),
		appendEntry: (entry: Record<string, unknown>) => entry,
		checkpoint: async () => {},
		flushAppends: () => {},
	} as unknown as SessionContract;
	const chat = {
		submit: async () => {},
		whenSettled: async () => {},
		cancel() {},
		onEvent: () => () => {},
		isStreaming: () => false,
		getSessionId: () => current?.id ?? null,
		setToolCeiling: (ceilings: ReadonlyArray<TurnConstraints | undefined>) =>
			snapshotTurnConstraints(ceilings.reduce(narrowTurnConstraints, undefined)),
	};
	let limits: TurnConstraints | undefined;
	const dispatched: DispatchRequest[] = [];
	let exports = 0;
	const commands = acpCommandControl({
		dispatch: {
			dispatch: async (request: DispatchRequest) => {
				dispatched.push(request);
				return {
					runId: "oracle-run",
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ runId: "oracle-run", outcome: "completed", output: { text: null } }),
				};
			},
		} as unknown as AcpCommandHost["dispatch"],
		bus: createTelemetryHub(),
		providers: {} as ProvidersContract,
		eggsCommand: () => "No active eggs.",
		exportTranscript: () => {
			exports += 1;
		},
		isTurnInFlight: () => false,
		oracleBriefing: () => ({ decisions: [], tasks: [], compactionSummary: null }),
		submitOperatorNote: () => {},
		standingTurnConstraints: () => limits,
	});
	const requests = new Map<string, (params: unknown) => unknown>();
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
	const done = serveClioAcpAgent({
		transport,
		session,
		cwd,
		autonomy: () => "default",
		chat: {
			...chat,
			setToolCeiling: (ceilings) => {
				limits = chat.setToolCeiling(ceilings);
				return limits;
			},
		},
		commands,
		readSessionEntries: () => [],
		buildReplayMessages: () => [],
	});
	const call = async (method: string, params: unknown) => {
		const handler = requests.get(method);
		assert.ok(handler, method);
		return await handler(params);
	};
	const prompt = (text: string, ceiling?: TurnConstraints) =>
		call("session/prompt", {
			sessionId: "acp-ceiling-commands",
			prompt: [{ type: "text", text }],
			...(ceiling !== undefined ? { _meta: { [CEILING]: ceiling } } : {}),
		});
	const refused = (error: unknown) =>
		error instanceof AcpRequestError && error.rpcCode === -32602 && error.detail.code === "ceiling_refused";
	try {
		await call("initialize", { protocolVersion: 1 });
		await call("session/new", { cwd, mcpServers: [], _meta: { [CEILING]: { readOnly: true } } });

		// A write outside any tool call: trust is persisted and a transcript written.
		await assert.rejects(prompt("/mcp trust some-server read"), refused);
		await assert.rejects(
			call("_clio-coder/commands/invoke", {
				sessionId: "acp-ceiling-commands",
				command: "export",
				argv: ["out.md"],
			}),
			refused,
		);
		assert.equal(exports, 0);
		await prompt("/eggs status");

		// A read-only ceiling denies delegation, and a ceiling that withholds
		// dispatch refuses the worker outright.
		await assert.rejects(prompt("/oracle is this settled"), refused);
		await assert.rejects(prompt("/oracle is this settled", { delegation: "forbidden" }), refused);
		assert.equal(dispatched.length, 0);
	} finally {
		close();
		await done;
	}
});

test("a ceiling admits commands that only stop, pause or reshape the session's own context", () => {
	const control = acpCommandControl({
		dispatch: {} as AcpCommandHost["dispatch"],
		bus: createTelemetryHub(),
		providers: {} as ProvidersContract,
	});
	const refusal = (command: string, argv: string[]) => control.ceilingRefusal?.(command, argv, { readOnly: true });
	for (const verb of ["stop", "cancel", "pause"]) assert.equal(refusal("loop", [verb, "job-1"]), null, `/loop ${verb}`);
	assert.equal(refusal("context", ["compact"]), null);
	assert.equal(refusal("context", ["recall", "ref-1"]), null);
	assert.equal(refusal("eggs", ["off"]), null);
	// These write project files or start workers, so the ceiling still refuses them.
	assert.notEqual(refusal("loop", ["resume", "job-1"]), null);
	assert.notEqual(refusal("context", ["reset", "--yes"]), null);
	assert.notEqual(refusal("memory", ["seed"]), null);
	assert.notEqual(refusal("council", ["review this"]), null);
});

test("a fleet run under an ACP ceiling is refused when the ceiling is read-only and otherwise carries it", async () => {
	const cwd = process.cwd();
	const planHash = "a".repeat(64);
	const runUnder = async (ceiling: TurnConstraints): Promise<Array<TurnConstraints | undefined>> => {
		let current: SessionMeta | null = null;
		const session = {
			current: () => current,
			create: () => {
				current = {
					id: "acp-ceiling-fleet",
					cwd,
					cwdHash: "hash",
					createdAt: "2026-10-16T00:00:00.000Z",
					endedAt: null,
					model: null,
					target: null,
				} as SessionMeta;
				return current;
			},
			checkpoint: async () => {},
			flushAppends: () => {},
		} as unknown as SessionContract;
		const runs: Array<TurnConstraints | undefined> = [];
		const requests = new Map<string, (params: unknown) => unknown>();
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
		const done = serveClioAcpAgent({
			transport,
			session,
			cwd,
			autonomy: () => "default",
			chat: {
				submit: async () => {},
				whenSettled: async () => {},
				cancel() {},
				onEvent: () => () => {},
				isStreaming: () => false,
				getSessionId: () => current?.id ?? null,
				setToolCeiling: (ceilings) => snapshotTurnConstraints(ceilings.reduce(narrowTurnConstraints, undefined)),
			},
			fleet: {
				preview: () => ({ ok: true, preview: { planHash, plan: { steps: [] } } }) as unknown as FleetRunPreviewResult,
				run: async (_preview, turnConstraints) => {
					runs.push(turnConstraints);
					return { status: "started", fleetRootId: "fleet-1" };
				},
			},
			readSessionEntries: () => [],
			buildReplayMessages: () => [],
		});
		const call = async (method: string, params: unknown) => {
			const handler = requests.get(method);
			assert.ok(handler, method);
			return await handler(params);
		};
		try {
			await call("initialize", { protocolVersion: 1 });
			await call("session/new", { cwd, mcpServers: [], _meta: { [CEILING]: ceiling } });
			await call("_clio-coder/fleet/run", { sessionId: "acp-ceiling-fleet", name: "review", planHash });
			return runs;
		} catch (error) {
			assert.equal(runs.length, 0, "a refused fleet run dispatched nothing");
			throw error;
		} finally {
			close();
			await done;
		}
	};
	const refused = (error: unknown) => error instanceof AcpRequestError && error.detail.code === "ceiling_refused";
	await assert.rejects(runUnder({ readOnly: true }), refused);
	await assert.rejects(runUnder({ delegation: "forbidden" }), refused);
	assert.deepEqual(await runUnder({ delegatedTools: ["read"] }), [
		{
			delegatedTools: ["read"],
			delegatedToolSurfaceSources: [
				{
					tools: ["read"],
					source: "ACP session ceiling",
					remedy: "Ask the ACP client to widen its session ceiling, then resubmit.",
				},
			],
		},
	]);
});

test("a read-only ceiling refuses task writes, /oracle, a shell line, a memory proposal and a supersede", async () => {
	const control = acpCommandControl({
		dispatch: {} as AcpCommandHost["dispatch"],
		bus: createTelemetryHub(),
		providers: {} as ProvidersContract,
	});
	const refusal = (command: string, argv: string[], limits: TurnConstraints) =>
		control.ceilingRefusal?.(command, argv, limits);
	for (const verb of ["add", "hand", "done", "drop"])
		assert.notEqual(refusal("tasks", [verb, "t-1"], { readOnly: true }), null, `/tasks ${verb}`);
	assert.equal(refusal("tasks", ["add", "t-1"], { allowedTools: ["read"] }), null, "a turn-bound ceiling admits it");
	assert.notEqual(refusal("oracle", ["is", "this", "settled"], { readOnly: true }), null);
	assert.notEqual(refusal("oracle", ["is", "this", "settled"], { delegation: "forbidden" }), null);

	const cwd = process.cwd();
	const callUnder = async (ceiling: TurnConstraints, method: string, params: Record<string, unknown>) => {
		let current: SessionMeta | null = null;
		const session = {
			current: () => current,
			create: () => {
				current = {
					id: "acp-ceiling-writes",
					cwd,
					cwdHash: "hash",
					createdAt: "2026-10-16T00:00:00.000Z",
					endedAt: null,
					model: null,
					target: null,
				} as SessionMeta;
				return current;
			},
			resume: () => current,
			checkpoint: async () => {},
			flushAppends: () => {},
		} as unknown as SessionContract;
		const effects: string[] = [];
		const requests = new Map<string, (params: unknown) => unknown>();
		let close: () => void = () => {};
		const transport: AcpJsonRpcPeerTransport = {
			closed: false,
			request: async () => ({}) as never,
			notify: () => {},
			onRequest: (name, handler) => {
				requests.set(name, handler);
				return () => requests.delete(name);
			},
			onNotification: () => () => {},
			onClose: (handler) => {
				close = handler;
				return () => {};
			},
			close: () => close(),
		};
		const done = serveClioAcpAgent({
			transport,
			session,
			cwd,
			autonomy: () => "default",
			chat: {
				submit: async () => {},
				whenSettled: async () => {},
				cancel() {},
				onEvent: () => () => {},
				isStreaming: () => false,
				getSessionId: () => current?.id ?? null,
				resetForSession: () => {},
				setToolCeiling: (ceilings) => snapshotTurnConstraints(ceilings.reduce(narrowTurnConstraints, undefined)),
			},
			board: () => ({}) as never,
			boardActions: {
				supersedeDecision: () => {
					effects.push("supersede");
					return { status: "superseded" };
				},
				proposeMemory: async () => {
					effects.push("memory");
					return { created: true, recordId: "m-1" };
				},
			},
			labelOperatorCommand: () => {
				effects.push("shell");
				return null;
			},
			readSessionEntries: () => [],
			buildReplayMessages: () => [],
		});
		const call = async (name: string, body: unknown) => {
			const handler = requests.get(name);
			assert.ok(handler, name);
			return await handler(body);
		};
		try {
			await call("initialize", { protocolVersion: 1 });
			await call("session/new", { cwd, mcpServers: [], _meta: { [CEILING]: ceiling } });
			return await call(method, { sessionId: "acp-ceiling-writes", ...params });
		} finally {
			assert.deepEqual(effects, [], `${method} ran nothing`);
			close();
			await done;
		}
	};
	const refused = (error: unknown) => error instanceof AcpRequestError && error.detail.code === "ceiling_refused";
	const shell = { command: "true" };
	await assert.rejects(callUnder({ readOnly: true }, "_clio-coder/session/shell", shell), refused);
	await assert.rejects(callUnder({ allowedTools: ["read"] }, "_clio-coder/session/shell", shell), refused);
	const proposal = { entryId: "e-1", scope: "repo" };
	await assert.rejects(callUnder({ readOnly: true }, "_clio-coder/memory/propose", proposal), refused);
	const supersede = { interviewId: "i-1", key: "k-1" };
	await assert.rejects(callUnder({ readOnly: true }, "_clio-coder/decisions/supersede", supersede), refused);
});
