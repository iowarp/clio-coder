import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { HANDOFF_NOTE_CUSTOM_TYPE, HANDOFF_SEED_CUSTOM_TYPE } from "../../src/domains/session/handoff.js";
import {
	commitHandoff,
	type HandoffExtractionRound,
	type HandoffServiceDeps,
	prepareHandoff,
} from "../../src/domains/session/handoff-service.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const GOAL = "finish the survey report and its figures";
const EXTRACTION = JSON.stringify({
	decisions: [{ summary: "report in Markdown", rationale: "the operator asked" }],
	facts: ["two samples were measured"],
	files: [],
	commands: [],
	openQuestions: [],
});

function readEntries(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
}

async function peer(
	rounds: HandoffExtractionRound[],
	options: { wired?: boolean; extract?: () => Promise<HandoffExtractionRound>; commandTurn?: boolean } = {},
) {
	const scratch = await isolateClioEnv("clio-coder-acp-handoff-");
	const cwd = realpathSync(scratch.dir);
	const contract: SessionContract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
	const requests = new Map<string, (params: unknown) => unknown>();
	const diagnostics: string[] = [];
	const resets: Array<{ leaf: string | null; messages: number }> = [];
	const extractions: string[] = [];
	let settle: () => void = () => {};
	let streaming = false;
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
	const service: HandoffServiceDeps = {
		session: contract,
		extract: async (goal) => {
			extractions.push(goal);
			if (options.extract) return options.extract();
			return rounds.shift() ?? { status: "failed", reason: "no scripted round" };
		},
		readEntries,
		isTurnInFlight: () => streaming,
		createSession: () => {
			contract.create({ cwd });
		},
	};
	const done = serveClioAcpAgent({
		transport,
		session: contract,
		cwd,
		autonomy: () => "default",
		routing: () => ({ target: null, model: null }),
		readSessionEntries: readEntries,
		buildReplayMessages: (entries: ReadonlyArray<SessionEntry>, leaf: string | null) =>
			buildModelReplayAgentMessagesFromTurns(entries, leaf === null ? {} : { activeLeafTurnId: leaf }),
		...(options.wired === false
			? {}
			: {
					handoff: {
						prepare: (goal: string) => prepareHandoff(service, goal),
						commit: (draft: Parameters<typeof commitHandoff>[1], document: string) => commitHandoff(service, draft, document),
					},
				}),
		...(options.commandTurn
			? {
					commands: {
						catalog: () => ({ version: 1 as const, commands: [] }),
						capability: { version: 1 },
						injectsUserTurn: () => true,
						invoke: () => {
							contract.append({
								id: "command-turn",
								parentId: contract.tree(contract.current()?.id).leafId,
								at: "2026-09-26T09:00:03.000Z",
								kind: "user",
								payload: { text: "operator note injected by share" },
							});
							return { level: "info" as const, lines: ["note recorded"] };
						},
					},
				}
			: {}),
		diagnostics: (line) => diagnostics.push(line),
		chat: {
			submit: async () => {
				streaming = true;
				await new Promise<void>((resolve) => {
					settle = resolve;
				});
				streaming = false;
			},
			cancel: () => settle(),
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
		return (await handler(params)) as Record<string, unknown>;
	};
	const init = await call("initialize", { protocolVersion: 1 });
	return {
		init,
		cwd,
		contract,
		call,
		diagnostics,
		resets,
		extractions,
		requests,
		settle: () => settle(),
		stop: async () => {
			close();
			await done;
			await contract.close();
			scratch.restore();
		},
	};
}

async function openWithHistory(agent: Awaited<ReturnType<typeof peer>>): Promise<string> {
	await agent.call("session/new", { cwd: agent.cwd, mcpServers: [] });
	agent.contract.append({
		id: "u1",
		parentId: null,
		at: "2026-09-26T09:00:01.000Z",
		kind: "user",
		payload: { text: "measure" },
	});
	agent.contract.append({
		id: "a1",
		parentId: "u1",
		at: "2026-09-26T09:00:02.000Z",
		kind: "assistant",
		payload: { text: "4.2" },
	});
	return agent.contract.current()?.id as string;
}

const customTypes = (sessionId: string) =>
	readEntries(sessionId).flatMap((entry) =>
		entry.kind === "custom" ? [(entry as { customType?: string }).customType ?? ""] : [],
	);

test("ACP announces handoff only when the shared service is bound", async () => {
	for (const wired of [true, false]) {
		const agent = await peer([], { wired });
		try {
			const meta = (agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta;
			if (wired)
				deepStrictEqual(meta["clio-coder/handoff"], {
					version: 1,
					prepare: "_clio-coder/session/handoff/prepare",
					commit: "_clio-coder/session/handoff/commit",
					cancel: "_clio-coder/session/handoff/cancel",
				});
			else strictEqual(meta["clio-coder/handoff"], undefined);
		} finally {
			await agent.stop();
		}
	}
});

test("ACP handoff drafts without writing, commits the reviewed edit once, and follows the successor", async () => {
	const agent = await peer([{ status: "answered", text: EXTRACTION }]);
	try {
		const fromId = await openWithHistory(agent);
		const refused = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: "continue" });
		strictEqual(refused.status, "refused");
		strictEqual(refused.code, "goal");
		strictEqual(agent.extractions.length, 0, "a goal-less line spends no model round");

		const draft = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		strictEqual(draft.status, "ready");
		strictEqual(draft.fromSessionId, fromId);
		match(String(draft.document), /report in Markdown/);
		deepStrictEqual(customTypes(fromId), [], "drawing up the document writes nothing");
		strictEqual(agent.contract.current()?.id, fromId);

		const empty = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: fromId,
			handoffId: draft.handoffId,
			document: "  \n",
		});
		deepStrictEqual([empty.status, empty.code], ["refused", "empty"]);

		const reviewed = `${draft.document}\n\nReviewer note: keep the figures in SI units.\n`;
		const committed = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: fromId,
			handoffId: draft.handoffId,
			document: reviewed,
		});
		strictEqual(committed.status, "committed", JSON.stringify(committed));
		const toId = committed.sessionId as string;
		ok(toId !== fromId);
		strictEqual(committed.fromSessionId, fromId);
		deepStrictEqual(committed.warnings, []);
		strictEqual(agent.contract.current()?.id, toId);
		const seed = readEntries(toId).find(
			(entry) => (entry as { customType?: string }).customType === HANDOFF_SEED_CUSTOM_TYPE,
		);
		match(String((seed as { data?: { document?: string } } | undefined)?.data?.document), /SI units/);
		ok(customTypes(fromId).includes(HANDOFF_NOTE_CUSTOM_TYPE), "the old session names where the work went");
		deepStrictEqual(agent.resets.at(-1)?.leaf, null);
		ok((agent.resets.at(-1)?.messages ?? 0) > 0, "the successor's model context carries the seed");

		const retried = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: toId,
			handoffId: draft.handoffId,
			document: reviewed,
		});
		deepStrictEqual([retried.status, retried.code], ["refused", "stale"]);
		strictEqual(agent.contract.current()?.id, toId, "a retried commit mints nothing");
		const sessions = agent.contract.history().filter((meta) => meta.cwd === agent.cwd).length;
		strictEqual(sessions, 2);
	} finally {
		await agent.stop();
	}
});

test("ACP branch switches invalidate a handoff draft before it can seed a successor", async () => {
	const agent = await peer([{ status: "answered", text: EXTRACTION }]);
	try {
		const fromId = await openWithHistory(agent);
		const draft = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		strictEqual(draft.status, "ready");
		await agent.call("_clio-coder/session/switch_turn", { sessionId: fromId, turnId: "u1" });
		const committed = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: fromId,
			handoffId: draft.handoffId,
			document: draft.document,
		});
		strictEqual(committed.status, "refused");
		strictEqual(committed.code, "stale");
		strictEqual(agent.contract.current()?.id, fromId);
		deepStrictEqual(customTypes(fromId), [], "a stale branch draft writes no handoff record");
	} finally {
		await agent.stop();
	}
});

test("ACP branch switches during extraction cannot produce a ready handoff for the old branch", async () => {
	let resolveRound: (round: HandoffExtractionRound) => void = () => {};
	const round = new Promise<HandoffExtractionRound>((resolve) => {
		resolveRound = resolve;
	});
	const agent = await peer([], { extract: () => round });
	try {
		const fromId = await openWithHistory(agent);
		const preparing = agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		await agent.call("_clio-coder/session/switch_turn", { sessionId: fromId, turnId: "u1" });
		resolveRound({ status: "answered", text: EXTRACTION });
		const outcome = await preparing;
		strictEqual(outcome.status, "refused");
		strictEqual(outcome.code, "stale");
		strictEqual(agent.contract.current()?.id, fromId);
		deepStrictEqual(customTypes(fromId), [], "moving branches during extraction writes nothing");
	} finally {
		resolveRound({ status: "aborted" });
		await agent.stop();
	}
});

test("an ACP command's injected operator turn invalidates an earlier handoff draft", async () => {
	const agent = await peer([{ status: "answered", text: EXTRACTION }], { commandTurn: true });
	try {
		const fromId = await openWithHistory(agent);
		const draft = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		strictEqual(draft.status, "ready");
		await agent.call("_clio-coder/commands/invoke", { sessionId: fromId, command: "share", argv: ["note"] });
		const committed = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: fromId,
			handoffId: draft.handoffId,
			document: draft.document,
		});
		strictEqual(committed.status, "refused");
		strictEqual(committed.code, "stale");
		strictEqual(agent.contract.current()?.id, fromId);
		deepStrictEqual(customTypes(fromId), [], "the command makes the draft stale without creating a successor");
	} finally {
		await agent.stop();
	}
});

test("ACP handoff drafts end on cancel and on a new request, and provider text stays off the wire", async () => {
	const agent = await peer([
		{ status: "answered", text: EXTRACTION },
		{ status: "answered", text: EXTRACTION },
		{ status: "failed", reason: "401 Unauthorized: key sk-private rejected" },
	]);
	try {
		const fromId = await openWithHistory(agent);
		const first = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		deepStrictEqual(
			await agent.call("_clio-coder/session/handoff/cancel", { sessionId: fromId, handoffId: first.handoffId }),
			{ cancelled: true },
		);
		const afterCancel = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: fromId,
			handoffId: first.handoffId,
			document: "# reviewed",
		});
		strictEqual(afterCancel.code, "stale");

		const second = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		strictEqual(second.status, "ready");
		const prompt = agent.requests.get("session/prompt")?.({
			sessionId: fromId,
			prompt: [{ type: "text", text: "one more thing" }],
		}) as Promise<unknown>;
		agent.settle();
		await prompt.catch(() => undefined);
		const afterPrompt = await agent.call("_clio-coder/session/handoff/commit", {
			sessionId: fromId,
			handoffId: second.handoffId,
			document: "# reviewed",
		});
		strictEqual(afterPrompt.code, "stale", "a request after the draft makes it describe a conversation that moved");

		const provider = await agent.call("_clio-coder/session/handoff/prepare", { sessionId: fromId, goal: GOAL });
		deepStrictEqual([provider.status, provider.code], ["refused", "provider"]);
		ok(!JSON.stringify(provider).includes("sk-private"));
		ok(agent.diagnostics.some((line) => line.includes("401 Unauthorized")));
		deepStrictEqual(customTypes(fromId), [], "no path through here wrote a handoff");
		strictEqual(agent.contract.current()?.id, fromId);
	} finally {
		await agent.stop();
	}
});
