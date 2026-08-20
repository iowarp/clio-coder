import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { foldDecisionBoard } from "../../src/domains/session/decision-board.js";
import type { SessionEntry, TaskLedgerEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { foldSessionArtifacts } from "../../src/domains/session/session-artifacts.js";
import { foldSessionTaskHistory } from "../../src/domains/session/task-board.js";
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

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-tree-continuity-");
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

	// issue #94, finding 5: the /tree pin lived in memory only, so a switch made
	// without a follow-up message was silently lost on quit and resume put the
	// operator back on the abandoned tip via computeLeafId's timestamp inference.
	it("a /tree switch with no follow-up message survives quit and resume", async () => {
		const first = createSessionBundle(stubContext());
		const { sessionId, a1, a2 } = seedBranchedSession(first.contract);
		// seedBranchedSession already switches to a1 and appends u3/a3 on the new
		// branch; switch back to a1 again and quit without sending anything.
		first.contract.switchTurn(a1);
		await first.contract.close();

		const second = createSessionBundle(stubContext());
		const resumed = second.contract.resume(sessionId);
		strictEqual(resumed.id, sessionId);
		strictEqual(second.contract.tree(sessionId).leafId, a1, "the persisted pin wins over timestamp inference");
		ok(a1 !== a2, "sanity: a1 and a2 are actually different turns");

		await second.contract.close();
	});

	// issue #107: the pin surviving quit was only half the fix. Resume replayed
	// the file unfiltered, so the abandoned turns after the pin rendered as
	// ordinary history above the prompt while the engine extended from the pin.
	// The transcript and the branch the next message parents onto disagreed, and
	// the disagreement was silent.
	it("resume renders the pinned branch only, and the next append extends it", async () => {
		const first = createSessionBundle(stubContext());
		const contract = first.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
		contract.switchTurn(a1.id);
		await contract.close();

		const second = createSessionBundle(stubContext());
		const resumed = second.contract;
		resumed.resume(meta.id);
		const leafTurnId = resumed.tree(meta.id).leafId;
		strictEqual(leafTurnId, a1.id, "resolveLeafOnOpen honors the persisted pin");

		const entries = sessionEntries(meta.id);
		deepStrictEqual(
			textBlocks(buildReplayAgentMessagesFromTurns(entries)),
			["u1", "a1", "u2", "a2"],
			"the file still holds the abandoned turns; only the leaf tells them apart",
		);
		deepStrictEqual(
			textBlocks(buildReplayAgentMessagesFromTurns(entries, { activeLeafTurnId: leafTurnId ?? undefined })),
			["u1", "a1"],
			"the rendered transcript stops at the pin",
		);

		// session.append refuses any parent that is not the session's current leaf,
		// so this both appends and asserts what the pin made the next append point.
		const u3 = resumed.append({ parentId: a1.id, kind: "user", payload: { text: "u3" } });
		strictEqual(u3.parentId, a1.id);
		deepStrictEqual(
			textBlocks(buildReplayAgentMessagesFromTurns(sessionEntries(meta.id))),
			["u1", "a1", "u3"],
			"the append made the pin authoritative for every later reader too",
		);

		await resumed.close();
	});

	// The pin names a turn, not an exchange: /tree rows are turns, so pinning the
	// user turn resumes with that prompt alone and parents the next message onto
	// it. That is what the live capture on issue #107 recorded.
	it("resume on a pinned user turn renders that turn alone and parents onto it", async () => {
		const first = createSessionBundle(stubContext());
		const contract = first.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "a2" } });
		contract.switchTurn(u1.id);
		await contract.close();

		const second = createSessionBundle(stubContext());
		const resumed = second.contract;
		resumed.resume(meta.id);
		const leafTurnId = resumed.tree(meta.id).leafId;
		strictEqual(leafTurnId, u1.id);

		deepStrictEqual(
			textBlocks(
				buildReplayAgentMessagesFromTurns(sessionEntries(meta.id), { activeLeafTurnId: leafTurnId ?? undefined }),
			),
			["u1"],
			"a1 is the pinned turn's child, not its ancestor, so it is not on the path",
		);
		const next = resumed.append({ parentId: u1.id, kind: "user", payload: { text: "u3" } });
		strictEqual(next.parentId, u1.id);

		await resumed.close();
	});

	// issue #94: fork's positional cut for unanchored sidecars (task board,
	// routing notices, leafless workerRun) is now the rule active-path replay
	// follows too, so /tree switch and /fork of the same turn agree on what the
	// model sees. Before this fix, filterEntriesToActivePath kept every
	// unanchored sidecar regardless of file position while fork.ts's
	// sessionEntryBelongsToPath dropped anything written after the fork point;
	// the same turn reached the two ways produced two different task boards.
	it("/tree switch and /fork of the same turn reconstruct the same composite task snapshot", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const ledgerFields = { subgoals: [], activeRunIds: [], requiredValidationEvidence: [] };
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "u1" } });
		contract.appendEntry({
			kind: "taskLedger",
			parentTurnId: null,
			goals: [{ id: "board", title: "board as of a1", status: "active" }],
			...ledgerFields,
		});
		const keptArtifact = contract.append({
			parentId: u1.id,
			kind: "tool_result",
			payload: {
				toolName: "write",
				isError: false,
				result: { details: { paths: ["reports/kept.md"] } },
			},
		});
		const a1 = contract.append({ parentId: keptArtifact.id, kind: "assistant", payload: { text: "a1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "u2" } });
		contract.appendEntry({
			kind: "taskLedger",
			parentTurnId: null,
			goals: [{ id: "board", title: "board as of a2, on the abandoned branch", status: "active" }],
			...ledgerFields,
		});
		const abandonedArtifact = contract.append({
			parentId: u2.id,
			kind: "tool_result",
			payload: {
				toolName: "write",
				isError: false,
				result: { details: { paths: ["reports/abandoned.md"] } },
			},
		});
		contract.append({ parentId: abandonedArtifact.id, kind: "assistant", payload: { text: "a2" } });

		// Reconstruction 1: /tree switch back to a1, then replay/fold as of a1.
		contract.switchTurn(a1.id);
		const liveEntries = filterEntriesToActivePath(sessionEntries(meta.id), a1.id);
		const liveLedgers = liveEntries.filter(
			(entry): entry is TaskLedgerEntry => (entry as { kind?: string }).kind === "taskLedger",
		);
		strictEqual(liveLedgers.length, 1, "only the taskLedger written at or before a1 is visible");
		strictEqual(liveLedgers[0]?.goals[0]?.title, "board as of a1");
		const liveComposite = {
			history: foldSessionTaskHistory(liveEntries),
			artifacts: foldSessionArtifacts(liveEntries, { workspace: process.cwd() }),
		};
		strictEqual(liveComposite.artifacts[0]?.path, "reports/kept.md");
		strictEqual(
			liveComposite.artifacts.some((artifact) => artifact.path === "reports/abandoned.md"),
			false,
		);
		await contract.close();

		// Reconstruction 2: /fork at a1 from a fresh contract over the same file.
		const second = createSessionBundle(stubContext());
		second.contract.resume(meta.id);
		const forkedMeta = second.contract.fork(a1.id);
		const forkedLedgers = sessionEntries(forkedMeta.id).filter(
			(entry): entry is TaskLedgerEntry => (entry as { kind?: string }).kind === "taskLedger",
		);
		strictEqual(forkedLedgers.length, 1);
		strictEqual(forkedLedgers[0]?.goals[0]?.title, "board as of a1");
		const forkedEntries = sessionEntries(forkedMeta.id);
		const forkedComposite = {
			history: foldSessionTaskHistory(forkedEntries),
			artifacts: foldSessionArtifacts(forkedEntries, { workspace: process.cwd() }),
		};

		// Same turn, two reconstruction paths, same task history and artifacts.
		strictEqual(liveLedgers[0]?.goals[0]?.title, forkedLedgers[0]?.goals[0]?.title);
		deepStrictEqual(forkedComposite, liveComposite);

		await second.contract.close();
	});

	it("/tree and /fork reconstruct finalized and revised decision snapshots identically", async () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;
		const meta = contract.create({ cwd: process.cwd() });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "choose scope" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "scope chosen" } });
		const baseSnapshot = {
			kind: "decisionLedger" as const,
			interviewId: "interview-tree-1",
			interviewStatus: "complete" as const,
			startedAt: "2026-08-19T10:00:00.000Z",
			endedAt: "2026-08-19T10:02:00.000Z",
			roundCount: 1,
			summary: "Use focused scope.",
			decisions: [
				{
					key: "scope",
					value: "focused",
					status: "active" as const,
					decidedAt: "2026-08-19T10:01:00.000Z",
				},
			],
		};
		const baseDecision = baseSnapshot.decisions[0];
		ok(baseDecision);
		// Host finalization occurs after the terminal assistant message. Its
		// originating-user anchor must keep it visible at a1 anyway.
		contract.appendEntry({ ...baseSnapshot, parentTurnId: u1.id });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "revise scope" } });
		const a2 = contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "scope revised" } });
		contract.appendEntry({
			...baseSnapshot,
			parentTurnId: a2.id,
			decisions: [
				{
					...baseDecision,
					status: "superseded",
					revisedAt: "2026-08-19T10:04:00.000Z",
					correction: "cover every package",
				},
			],
		});

		const allEntries = sessionEntries(meta.id);
		const treeFinalized = foldDecisionBoard(filterEntriesToActivePath(allEntries, a1.id));
		const treeRevised = foldDecisionBoard(filterEntriesToActivePath(allEntries, a2.id));
		strictEqual(treeFinalized.length, 1);
		strictEqual(treeFinalized[0]?.decisions[0]?.status, "active");
		strictEqual(treeRevised[0]?.decisions[0]?.status, "superseded");
		await contract.close();

		const finalizedForkBundle = createSessionBundle(stubContext());
		finalizedForkBundle.contract.resume(meta.id);
		const finalizedFork = finalizedForkBundle.contract.fork(a1.id);
		const forkFinalized = foldDecisionBoard(sessionEntries(finalizedFork.id));
		deepStrictEqual(
			forkFinalized.map(({ turnId: _turnId, timestamp: _timestamp, ...entry }) => entry),
			treeFinalized.map(({ turnId: _turnId, timestamp: _timestamp, ...entry }) => entry),
		);
		await finalizedForkBundle.contract.close();

		const revisedForkBundle = createSessionBundle(stubContext());
		revisedForkBundle.contract.resume(meta.id);
		const revisedFork = revisedForkBundle.contract.fork(a2.id);
		const forkRevised = foldDecisionBoard(sessionEntries(revisedFork.id));
		deepStrictEqual(
			forkRevised.map(({ turnId: _turnId, timestamp: _timestamp, ...entry }) => entry),
			treeRevised.map(({ turnId: _turnId, timestamp: _timestamp, ...entry }) => entry),
		);
		await revisedForkBundle.contract.close();
	});
});
