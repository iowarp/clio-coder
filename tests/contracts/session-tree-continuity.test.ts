import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry, TaskLedgerEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { filterEntriesToActivePath } from "../../src/domains/session/tree/active-path.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/interactive/chat-renderer.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

// Session continuity around forks, trees, resume, and branch replay.
// current.jsonl is append-only and tree-shaped after a /tree switch: new turns
// parent onto the switched turn while the abandoned siblings stay in the file.
// Replay and fork must follow the active path, not the raw file order.

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

function sessionEntries(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
}

function textBlocks(messages: ReadonlyArray<AgentMessage>): string[] {
	const out: string[] = [];
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			out.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") out.push(record.text);
		}
	}
	return out;
}

/** u1 -> a1 -> u2 -> a2, then switchTurn(a1) and u3 -> a3 on the new branch. */
function seedBranchedSession(contract: SessionContract): {
	sessionId: string;
	a1: string;
	a2: string;
	a3: string;
} {
	const meta = contract.create({ cwd: process.cwd() });
	const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
	const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
	const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
	const a2 = contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
	contract.switchTurn(a1.id);
	// The chat loop parents the next submit onto the switched turn.
	const u3 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u3" } });
	const a3 = contract.append({ parentId: u3.id, kind: "assistant", payload: { text: "a3" } });
	return { sessionId: meta.id, a1: a1.id, a2: a2.id, a3: a3.id };
}

describe("contracts/session-tree-continuity", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = newScratchClioHome("clio-tree-continuity-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	it("replays only the active branch after a turn switch, excluding abandoned siblings", async () => {
		const bundle = createSessionBundle(stubContext());
		const { sessionId } = seedBranchedSession(bundle.contract);

		const texts = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(sessionId)));
		deepStrictEqual(texts, ["u1", "a1", "u3", "a3"]);

		await bundle.contract.close();
	});

	it("replays the abandoned branch when uptoTurnId pins its leaf", async () => {
		const bundle = createSessionBundle(stubContext());
		const { sessionId, a2 } = seedBranchedSession(bundle.contract);

		const texts = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(sessionId), { uptoTurnId: a2 }));
		deepStrictEqual(texts, ["u1", "a1", "u2", "a2"]);

		await bundle.contract.close();
	});

	it("selects a live branch without truncating a compaction summary appended after its leaf", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const rootUser = contract.append({ parentId: null, kind: "user", payload: { text: "root request" } });
		const rootAssistant = contract.append({
			parentId: rootUser.id,
			kind: "assistant",
			payload: { text: "root response" },
		});
		const selectedUser = contract.append({
			parentId: rootAssistant.id,
			kind: "user",
			payload: { text: "selected branch request" },
		});
		const selectedAssistant = contract.append({
			parentId: selectedUser.id,
			kind: "assistant",
			payload: { text: "selected branch response" },
		});
		contract.switchTurn(rootAssistant.id);
		const abandonedUser = contract.append({
			parentId: rootAssistant.id,
			kind: "user",
			payload: { text: "abandoned branch request" },
		});
		contract.append({
			parentId: abandonedUser.id,
			kind: "assistant",
			payload: { text: "abandoned branch response" },
		});
		contract.switchTurn(selectedAssistant.id);
		contract.appendEntry({
			kind: "compactionSummary",
			parentTurnId: selectedUser.id,
			summary: "selected branch summary",
			tokensBefore: 1000,
			firstKeptTurnId: selectedUser.id,
		});

		const turns = sessionEntries(meta.id);
		const liveTexts = textBlocks(buildReplayAgentMessagesFromTurns(turns, { activeLeafTurnId: selectedAssistant.id }));
		ok(liveTexts.some((text) => text.includes("selected branch summary")));
		ok(liveTexts.some((text) => text.includes("selected branch request")));
		ok(!liveTexts.some((text) => text.includes("abandoned branch")));

		const historicalTexts = textBlocks(buildReplayAgentMessagesFromTurns(turns, { uptoTurnId: selectedAssistant.id }));
		ok(
			!historicalTexts.some((text) => text.includes("selected branch summary")),
			"uptoTurnId keeps its historical truncation semantics",
		);

		await contract.close();
	});

	it("keeps anchored sidecars with their branch during replay", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.appendEntry({
			kind: "bashExecution",
			parentTurnId: u2.id,
			command: "echo abandoned",
			output: "abandoned",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		contract.switchTurn(a1.id);
		const u3 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u3" } });
		contract.appendEntry({
			kind: "bashExecution",
			parentTurnId: u3.id,
			command: "echo active",
			output: "active",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		const replay = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(meta.id))).join("\n");
		ok(replay.includes("echo active"), "sidecar anchored to the active branch replays");
		ok(!replay.includes("echo abandoned"), "sidecar anchored to the abandoned branch must not replay");

		await contract.close();
	});

	it("replays linear sessions unchanged, including unanchored sidecars", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		contract.appendEntry({
			kind: "bashExecution",
			parentTurnId: null,
			command: "echo loose",
			output: "loose",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });

		const texts = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(meta.id)));
		strictEqual(texts.length, 3, "linear replay keeps every message and the unanchored sidecar");
		ok(texts.some((text) => text.includes("echo loose")));

		await contract.close();
	});

	it("honors an explicit earlier leaf before a linear session has appended a sibling", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		const a2 = contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
		const entries = sessionEntries(meta.id);

		deepStrictEqual(
			filterEntriesToActivePath(entries, a1.id)
				.filter((entry) => entry.kind === "message")
				.map((entry) => entry.turnId),
			[u1.id, a1.id],
		);
		deepStrictEqual(filterEntriesToActivePath(entries, a2.id), entries, "the latest explicit leaf keeps linear replay");
		deepStrictEqual(
			filterEntriesToActivePath(entries, "missing-turn"),
			entries,
			"an invalid legacy leaf still falls back",
		);

		await contract.close();
	});

	it("fork copies pre-fork unanchored sidecars and excludes post-fork ones", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		contract.create({ cwd: process.cwd() });
		const ledgerFields = { subgoals: [], activeRunIds: [], requiredValidationEvidence: [] };
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		contract.appendEntry({
			kind: "taskLedger",
			parentTurnId: null,
			goals: [{ id: "pre", title: "written before the fork point", status: "active" }],
			...ledgerFields,
		});
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
		contract.appendEntry({
			kind: "taskLedger",
			parentTurnId: null,
			goals: [{ id: "post", title: "written after the fork point", status: "active" }],
			...ledgerFields,
		});

		const forkedMeta = contract.fork(a1.id);
		const forkedTurns = sessionEntries(forkedMeta.id);

		const ledgers = forkedTurns.filter(
			(entry): entry is TaskLedgerEntry => (entry as { kind?: string }).kind === "taskLedger",
		);
		strictEqual(ledgers.length, 1, "exactly the pre-fork taskLedger is copied");
		strictEqual(ledgers[0]?.goals[0]?.id, "pre");

		const texts = textBlocks(buildReplayAgentMessagesFromTurns(forkedTurns));
		deepStrictEqual(texts, ["u1", "a1"], "the fork transcript ends at the fork point");

		await contract.close();
	});

	/**
	 * /tree recorded neither a fork nor a compaction. Both exist on disk: the
	 * fork's meta.json carries parentSessionId/parentTurnId and a compaction
	 * appends a compactionSummary entry with its own turn id and parent pointer.
	 * The navigator reads tree.json, which holds message turns only, so the
	 * snapshot draws the structural entries from the ledger.
	 */
	it("shows a compaction as a node and a fork's parent in the snapshot", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		contract.appendEntry({
			kind: "compactionSummary",
			parentTurnId: a1.id,
			summary: "older history summarized",
			tokensBefore: 9901,
			tokensAfter: 2100,
			messagesSummarized: 6,
			firstKeptTurnId: a1.id,
		});

		const snapshot = contract.tree(meta.id);
		const compactionNodes = Object.values(snapshot.nodesById).filter((node) => node.kind === "compaction");
		strictEqual(compactionNodes.length, 1, "the compaction is a node in the tree");
		strictEqual(compactionNodes[0]?.parentId, a1.id, "hung off the turn it kept");
		ok(compactionNodes[0]?.preview?.includes("6 entries summarized"), compactionNodes[0]?.preview);
		strictEqual(snapshot.leafId, a1.id, "the next append point is still the last turn, not the marker");

		const forkedMeta = contract.fork(a1.id);
		const forkSnapshot = contract.tree(forkedMeta.id);
		strictEqual(forkSnapshot.meta.parentSessionId, meta.id, "the fork names the session it came from");
		strictEqual(forkSnapshot.meta.parentTurnId, a1.id, "and the turn it split at");

		await contract.close();
	});

	it("fork excludes a compaction summary written after the fork point", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
		// Later compaction whose kept anchor lands on the fork path.
		contract.appendEntry({
			kind: "compactionSummary",
			parentTurnId: a1.id,
			summary: "summary written after the fork point",
			tokensBefore: 1000,
			firstKeptTurnId: a1.id,
		});

		const forkedMeta = contract.fork(a1.id);
		const forkedTurns = sessionEntries(forkedMeta.id);
		ok(
			!forkedTurns.some((entry) => (entry as { kind?: string }).kind === "compactionSummary"),
			"a summary that did not exist at the fork point must not be copied",
		);
		const texts = textBlocks(buildReplayAgentMessagesFromTurns(forkedTurns));
		deepStrictEqual(texts, ["u1", "a1"], "the fork replays the plain transcript, not the summary boundary");

		await contract.close();
	});

	it("keeps abandoned siblings out of the active path even when a compaction summary anchors to it", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
		contract.switchTurn(a1.id);
		const u3 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u3" } });
		contract.append({ parentId: u3.id, kind: "assistant", payload: { text: "a3" } });

		// The compaction input seam applies the same active-path filter, so a
		// summary prompt never sees the abandoned branch.
		const active = filterEntriesToActivePath(sessionEntries(meta.id));
		const activeTexts = active
			.filter((entry) => entry.kind === "message")
			.map((entry) => (entry as { payload?: { text?: string } }).payload?.text ?? "");
		deepStrictEqual(activeTexts, ["u1", "a1", "u3", "a3"]);

		contract.appendEntry({
			kind: "compactionSummary",
			parentTurnId: u3.id,
			summary: "active-branch summary",
			tokensBefore: 1000,
			firstKeptTurnId: u3.id,
		});
		const replay = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(meta.id)));
		ok(
			replay.some((text) => text.includes("active-branch summary")),
			"the active-path summary replays as the boundary",
		);
		ok(!replay.some((text) => text.includes("u2") || text.includes("a2")), "abandoned turns stay out after compaction");

		await contract.close();
	});

	it("resolves a sidecar uptoTurnId through its anchor instead of the latest branch", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		const sidecar = contract.appendEntry({
			kind: "bashExecution",
			parentTurnId: u2.id,
			command: "echo abandoned",
			output: "abandoned",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		contract.switchTurn(a1.id);
		const u3 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u3" } });
		contract.append({ parentId: u3.id, kind: "assistant", payload: { text: "a3" } });

		const replay = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(meta.id), { uptoTurnId: sidecar.turnId }));
		ok(
			replay.some((text) => text.includes("u2")),
			"a sidecar pin follows the sidecar's branch",
		);
		ok(
			replay.some((text) => text.includes("echo abandoned")),
			"replay stops at the pinned sidecar, inclusive",
		);
		ok(!replay.some((text) => text.includes("u3") || text.includes("a3")), "the other branch stays out");

		await contract.close();
	});

	it("resume lands on the active leaf and future appends stay on that branch", async () => {
		const first = createSessionBundle(stubContext());
		const { sessionId, a3 } = seedBranchedSession(first.contract);
		await first.contract.close();

		const second = createSessionBundle(stubContext());
		const contract = second.contract;
		const resumed = contract.resume(sessionId);
		strictEqual(resumed.id, sessionId);
		strictEqual(contract.tree(sessionId).leafId, a3, "resume computes the active leaf, not the abandoned one");

		const u4 = contract.append({ parentId: a3, kind: "user", payload: { text: "u4" } });
		contract.append({ parentId: u4.id, kind: "assistant", payload: { text: "a4" } });

		const texts = textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(sessionId)));
		deepStrictEqual(texts, ["u1", "a1", "u3", "a3", "u4", "a4"]);

		await contract.close();
	});
});
