import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { ACP_SESSION_TREE_MAX_NODES, projectSessionTree } from "../../src/engine/acp/session-tree.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const AT = (second: number) => `2026-09-26T09:00:${String(second).padStart(2, "0")}.000Z`;

function readEntries(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
}

async function peer(options: { wired?: boolean } = {}) {
	const scratch = await isolateClioEnv("clio-coder-acp-branches-");
	const cwd = realpathSync(scratch.dir);
	const contract: SessionContract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
	const requests = new Map<string, (params: unknown) => unknown>();
	const updates: Array<{ sessionId: string; update: Record<string, unknown>; _meta?: Record<string, unknown> }> = [];
	const resets: Array<{ leaf: string | null; messages: number }> = [];
	let streaming = false;
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push(params as (typeof updates)[number]);
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
	const wired = options.wired !== false;
	const done = serveClioAcpAgent({
		transport,
		session: contract,
		cwd,
		autonomy: () => "default",
		routing: () => ({ target: null, model: null }),
		...(wired
			? {
					readSessionEntries: readEntries,
					buildReplayMessages: (entries: ReadonlyArray<SessionEntry>, leaf: string | null, scope?: "leaf" | "upto") =>
						buildModelReplayAgentMessagesFromTurns(
							entries,
							leaf === null ? {} : scope === "upto" ? { uptoTurnId: leaf } : { activeLeafTurnId: leaf },
						),
				}
			: {}),
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => streaming,
			getSessionId: () => contract.current()?.id ?? null,
			resetForSession: (leaf: string | null, messages?: ReadonlyArray<AgentMessage>) => {
				resets.push({ leaf, messages: messages?.length ?? 0 });
			},
		},
	});
	const call = async (method: string, params: unknown) => {
		const handler = requests.get(method);
		if (!handler) throw new Error(`missing handler: ${method}`);
		return await handler(params);
	};
	return {
		cwd,
		contract,
		updates,
		resets,
		call,
		set streaming(value: boolean) {
			streaming = value;
		},
		stop: async () => {
			close();
			await done;
			await contract.close();
			scratch.restore();
		},
	};
}

/**
 * u1 → a1 → u2 → a2, then a sibling branch u3 → a3 under a1. The newest leaf
 * is a3, so the second question is on the branch a person left.
 */
function seed(contract: SessionContract) {
	contract.append({ id: "u1", parentId: null, at: AT(1), kind: "user", payload: { text: "first question" } });
	contract.append({ id: "a1", parentId: "u1", at: AT(2), kind: "assistant", payload: { text: "first answer" } });
	contract.append({ id: "u2", parentId: "a1", at: AT(3), kind: "user", payload: { text: "second question" } });
	contract.append({ id: "a2", parentId: "u2", at: AT(4), kind: "assistant", payload: { text: "second answer" } });
	contract.switchTurn("a1");
	contract.append({ id: "u3", parentId: "a1", at: AT(5), kind: "user", payload: { text: "sibling question" } });
	contract.append({ id: "a3", parentId: "u3", at: AT(6), kind: "assistant", payload: { text: "sibling answer" } });
}

const replayText = (frames: ReadonlyArray<{ update: Record<string, unknown> }>) =>
	frames
		.map((frame) => (frame.update.content as { text?: string } | undefined)?.text ?? "")
		.filter((text) => text.length > 0);

async function refusal(promise: Promise<unknown>, code: string) {
	await rejects(promise, (error: unknown) => {
		ok(error instanceof AcpRequestError, String(error));
		strictEqual(error.detail.code, code);
		return true;
	});
}

test("ACP announces branches only when the replay readers are wired", async () => {
	for (const wired of [true, false]) {
		const agent = await peer({ wired });
		try {
			const init = (await agent.call("initialize", { protocolVersion: 1 })) as {
				agentCapabilities: { _meta: Record<string, unknown> };
			};
			const announced = init.agentCapabilities._meta["clio-coder/branches"];
			if (wired)
				deepStrictEqual(announced, {
					version: 1,
					tree: "_clio-coder/session/tree",
					switchTurn: "_clio-coder/session/switch_turn",
					fork: "_clio-coder/session/fork",
				});
			else strictEqual(announced, undefined);
			if (!wired) {
				await agent.call("session/new", { cwd: agent.cwd, mcpServers: [] });
				const id = agent.contract.current()?.id;
				await refusal(agent.call("_clio-coder/session/tree", { sessionId: id }), "method_not_found");
			}
		} finally {
			await agent.stop();
		}
	}
});

test("ACP session tree projects the ledger's branches with the active path marked", async () => {
	const agent = await peer();
	try {
		await agent.call("initialize", { protocolVersion: 1 });
		await agent.call("session/new", { cwd: agent.cwd, mcpServers: [] });
		seed(agent.contract);
		const sessionId = agent.contract.current()?.id as string;
		const tree = (await agent.call("_clio-coder/session/tree", { sessionId })) as ReturnType<
			typeof projectSessionTree
		>;
		strictEqual(tree.sessionId, sessionId);
		strictEqual(tree.leafId, "a3");
		deepStrictEqual(
			tree.nodes.map((node) => [node.id, node.parentId, node.active]),
			[
				["u1", null, true],
				["a1", "u1", true],
				["u2", "a1", false],
				["a2", "u2", false],
				["u3", "a1", true],
				["a3", "u3", true],
			],
		);
		strictEqual(tree.truncated, false);
		match(tree.nodes.find((node) => node.id === "u2")?.preview ?? "", /second question/);
		await refusal(agent.call("_clio-coder/session/tree", { sessionId: "not-bound" }), "session_unknown");
	} finally {
		await agent.stop();
	}
});

test("ACP switch_turn pins the branch, resets the model context and replays only that branch", async () => {
	const agent = await peer();
	try {
		await agent.call("initialize", { protocolVersion: 1 });
		await agent.call("session/new", { cwd: agent.cwd, mcpServers: [] });
		seed(agent.contract);
		const sessionId = agent.contract.current()?.id as string;
		agent.updates.length = 0;
		agent.resets.length = 0;

		agent.streaming = true;
		await refusal(agent.call("_clio-coder/session/switch_turn", { sessionId, turnId: "a2" }), "prompt_active");
		agent.streaming = false;
		await refusal(agent.call("_clio-coder/session/switch_turn", { sessionId, turnId: "nope" }), "turn_unknown");
		strictEqual(agent.contract.tree(sessionId).leafId, "a3", "a refused switch moves nothing");

		const result = (await agent.call("_clio-coder/session/switch_turn", { sessionId, turnId: "a2" })) as {
			sessionId: string;
			leafId: string;
			_meta: Record<string, { replayed?: { turns: number } }>;
		};
		strictEqual(result.sessionId, sessionId);
		strictEqual(result.leafId, "a2");
		deepStrictEqual(result._meta["clio-coder/session"]?.replayed, { turns: 2, truncated: false });
		strictEqual(agent.contract.tree(sessionId).leafId, "a2", "the pin is durable, as /tree's is");
		deepStrictEqual(agent.resets, [{ leaf: "a2", messages: 4 }]);
		const replay = agent.updates.filter((frame) => frame._meta?.["clio-coder/replay"] !== undefined);
		deepStrictEqual(replayText(replay), ["first question", "first answer", "second question", "second answer"]);
		ok(replay.every((frame) => frame.sessionId === sessionId));
	} finally {
		await agent.stop();
	}
});

test("ACP fork follows the new session, replays its branch, keeps the parent and never rewinds files", async () => {
	const agent = await peer();
	try {
		await agent.call("initialize", { protocolVersion: 1 });
		await agent.call("session/new", { cwd: agent.cwd, mcpServers: [] });
		seed(agent.contract);
		const parentId = agent.contract.current()?.id as string;
		const edited = join(agent.cwd, "edited.txt");
		writeFileSync(edited, "an edit made after the fork point\n");
		agent.updates.length = 0;
		agent.resets.length = 0;

		await refusal(agent.call("_clio-coder/session/fork", { sessionId: parentId, turnId: "gone" }), "turn_unknown");
		strictEqual(agent.contract.current()?.id, parentId, "a refused fork keeps the parent current");

		const result = (await agent.call("_clio-coder/session/fork", { sessionId: parentId, turnId: "a1" })) as {
			sessionId: string;
			parentSessionId: string;
			parentTurnId: string;
			configOptions: unknown[];
			_meta: Record<string, { replayed?: unknown; resumed?: boolean }>;
		};
		const childId = result.sessionId;
		ok(childId !== parentId);
		strictEqual(result.parentSessionId, parentId);
		strictEqual(result.parentTurnId, "a1");
		ok(Array.isArray(result.configOptions));
		deepStrictEqual(result._meta["clio-coder/session"]?.replayed, { turns: 1, truncated: false });
		strictEqual(agent.contract.current()?.id, childId);
		const childTree = agent.contract.tree(childId);
		strictEqual(childTree.meta.parentSessionId, parentId);
		strictEqual(childTree.meta.parentTurnId, "a1");
		deepStrictEqual(agent.resets, [{ leaf: "a1", messages: 2 }]);
		const replay = agent.updates.filter((frame) => frame._meta?.["clio-coder/replay"] !== undefined);
		deepStrictEqual(replayText(replay), ["first question", "first answer"]);
		ok(replay.every((frame) => frame.sessionId === childId));
		strictEqual(readFileSync(edited, "utf8"), "an edit made after the fork point\n");

		// The process now hosts the child. The parent is no longer bound here but
		// remains whole in the ledger, with both of its branches.
		await refusal(agent.call("_clio-coder/session/tree", { sessionId: parentId }), "session_unknown");
		const childView = (await agent.call("_clio-coder/session/tree", { sessionId: childId })) as ReturnType<
			typeof projectSessionTree
		>;
		deepStrictEqual(
			childView.nodes.map((node) => node.id),
			["u1", "a1"],
		);
		strictEqual(childView.parentSessionId, parentId);
		strictEqual(Object.keys(agent.contract.tree(parentId).nodesById).length, 6);
	} finally {
		await agent.stop();
	}
});

test("the session tree projection keeps the active path whole when it cuts", () => {
	const nodes: Record<string, { id: string; parentId: string | null; at: string; kind: "user"; children: string[] }> =
		{};
	const total = ACP_SESSION_TREE_MAX_NODES + 50;
	for (let index = 0; index < total; index++) {
		// One long spine; every tenth node also carries an off-path sibling.
		const id = `n${index}`;
		nodes[id] = {
			id,
			parentId: index === 0 ? null : `n${index - 1}`,
			at: new Date(Date.UTC(2026, 8, 26, 0, 0, index)).toISOString(),
			kind: "user",
			children: [],
		};
	}
	const leafId = `n${Math.floor(total / 2)}`;
	const tree = projectSessionTree({
		sessionId: "s",
		meta: { id: "s", cwd: "/w", createdAt: AT(0), endedAt: null, model: null, target: null },
		leafId,
		nodesById: nodes,
		rootIds: ["n0"],
	});
	strictEqual(tree.truncated, true);
	strictEqual(tree.nodes.length, ACP_SESSION_TREE_MAX_NODES);
	const kept = new Set(tree.nodes.map((node) => node.id));
	for (let index = 0; index <= Math.floor(total / 2); index++) ok(kept.has(`n${index}`), `active n${index} kept`);
	for (const node of tree.nodes) ok(node.parentId === null || kept.has(node.parentId), "no dangling parent");
});
