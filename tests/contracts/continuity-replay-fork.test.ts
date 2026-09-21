import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";

import type { DomainContext } from "../../src/core/domain-loader.js";
import { clioStatePath } from "../../src/core/xdg.js";
import type {
	AcceptedNote,
	ContinuityCheckpointPayload,
	ContinuityCommitData,
	HandoffEvent,
	HandoffIdentity,
	HandoffPolicy,
} from "../../src/domains/session/continuity/contract.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";
import { HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE } from "../../src/domains/session/continuity/operator-request.js";
import {
	continuityReplayBlocks,
	resolveContinuityProjection,
} from "../../src/domains/session/continuity/projection.js";
import type { SessionContract, SessionEntryInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { renderSessionHtml } from "../../src/interactive/export-html/index.js";
import {
	buildModelReplayAgentMessagesFromTurns,
	continuityContextFromSession,
	withContinuityReplay,
} from "../../src/interactive/model-session-replay.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Fork, replay and export integration against real sessions on disk.
 *
 * The pure fold is single-origin and keys applicability on
 * `originSessionId === selection.sessionId`. A real fork gets a **new** session
 * id from the engine while the seeded entries keep their original origins, so
 * the unit-level `historical: true` fixture proves the projection rule and
 * proves nothing about this. Every fork below goes through the actual
 * `SessionContract.fork` API and asserts on the child's real JSONL as well as
 * on its rendered messages.
 */

const AT = "2026-09-21T09:00:00.000Z";
const PREPARED_AT = 1_000_000;
const NOW = PREPARED_AT + 10_000;

function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`fixture note rejected: ${result.reason}`);
	return result.accepted;
}

const NOTE_A = admit("A: finish the parser rewrite; the failing case is a nested fence");
const NOTE_B = admit("B: the child's own handoff, unrelated to A");

function policy(): HandoffPolicy {
	return {
		preparedAtMs: PREPARED_AT,
		automaticDeadlineAtMs: PREPARED_AT + 600_000,
		maxAttempts: 2,
		maxSummaryCallsPerAttempt: 2,
		additionalSummaryRetriesPerCall: 0,
		maxSummaryStreamInvocations: 4,
		flushRetryLimit: 3,
	};
}

interface HandoffShape {
	prefix: string;
	sessionId: string;
	anchor: string;
	initiating: string;
}

function identity(shape: HandoffShape): HandoffIdentity {
	return {
		handoffId: `${shape.prefix}-h`,
		preparedEntryId: `${shape.prefix}-prep`,
		commitId: `${shape.prefix}-commit`,
		commitEntryId: `${shape.prefix}-commit-entry`,
		originSessionId: shape.sessionId,
		branchAnchorTurnId: shape.anchor,
		initiatingTurnId: shape.initiating,
		toolCallId: `${shape.prefix}-tc`,
		sourceRevision: "lb-1-00000000000000ff",
	};
}

function tx(
	shape: HandoffShape,
	entryId: string,
	prev: string | null,
	sequence: number,
	attempt: number,
	event: HandoffEvent,
) {
	return {
		kind: "handoffTransaction",
		turnId: entryId,
		parentTurnId: shape.anchor,
		timestamp: AT,
		schemaVersion: 1,
		identity: identity(shape),
		transition: { entryId, prevEntryId: prev, sequence, attempt },
		event,
	} as unknown as SessionEntryInput;
}

function summarizedCommit(shape: HandoffShape): ContinuityCommitData {
	return {
		outcome: "summarized",
		entry: { turnId: `${shape.prefix}-commit-entry`, parentTurnId: shape.anchor, timestamp: AT },
		transition: {
			entryId: `${shape.prefix}-commit-entry`,
			prevEntryId: `${shape.prefix}-reduce`,
			sequence: 2,
			attempt: 1,
		},
		summaryRef: `${shape.prefix}-summary`,
		tokensBefore: 30_000,
		tokensAfter: 9_000,
	};
}

function checkpoint(shape: HandoffShape, note: AcceptedNote, over: Partial<ContinuityCheckpointPayload> = {}) {
	const commit = over.commit ?? summarizedCommit(shape);
	return {
		schemaVersion: 1,
		identity: over.identity ?? identity(shape),
		accepted: over.accepted ?? note,
		policy: over.policy ?? policy(),
		commit,
		state: over.state ?? { transition: commit.transition, event: { phase: "ready" }, activeResume: null, delivery: null },
	} as ContinuityCheckpointPayload;
}

function carryingSummary(
	shape: HandoffShape,
	payload: ContinuityCheckpointPayload,
	turnId = `${shape.prefix}-summary`,
) {
	return {
		kind: "compactionSummary",
		turnId,
		parentTurnId: shape.anchor,
		timestamp: AT,
		summary: "earlier work summarized",
		tokensBefore: 30_000,
		firstKeptTurnId: shape.anchor,
		continuity: payload,
	} as unknown as SessionEntryInput;
}

function commitEntry(payload: ContinuityCheckpointPayload) {
	return {
		kind: "continuityCommit",
		turnId: payload.commit.entry.turnId,
		parentTurnId: payload.commit.entry.parentTurnId,
		timestamp: payload.commit.entry.timestamp,
		continuity: payload,
	} as unknown as SessionEntryInput;
}

describe("continuity through real forks, replay and export", () => {
	let scratch: IsolatedClioEnv;
	let contract: SessionContract;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-continuity-fork-");
		contract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
	});

	afterEach(async () => {
		try {
			await contract.close();
		} finally {
			scratch.restore();
		}
	});

	/** Session A with a completed, ready handoff anchored on m2, then m3 and m4. */
	function buildParentWithReadyHandoff(): { sessionId: string; shape: HandoffShape } {
		const meta = contract.create({ cwd: scratch.dir });
		contract.append({ id: "m1", parentId: null, at: AT, kind: "user", payload: { text: "first" } });
		contract.append({ id: "m2", parentId: "m1", at: AT, kind: "assistant", payload: { text: "second" } });
		const shape: HandoffShape = { prefix: "a", sessionId: meta.id, anchor: "m2", initiating: "m1" };
		contract.appendEntry(tx(shape, "a-prep", null, 0, 0, { phase: "prepared", accepted: NOTE_A, policy: policy() }));
		contract.appendEntry(tx(shape, "a-reduce", "a-prep", 1, 1, { phase: "reducing" }));
		contract.appendEntry(carryingSummary(shape, checkpoint(shape, NOTE_A)));
		contract.appendEntry(commitEntry(checkpoint(shape, NOTE_A)));
		contract.append({ id: "m3", parentId: "m2", at: AT, kind: "user", payload: { text: "third" } });
		contract.append({ id: "m4", parentId: "m3", at: AT, kind: "assistant", payload: { text: "fourth" } });
		return { sessionId: meta.id, shape };
	}

	function childEntries(sessionId: string): SessionEntry[] {
		return openSession(sessionId).turns() as SessionEntry[];
	}

	function replayText(entries: ReadonlyArray<SessionEntry>, leafTurnId: string | null): string {
		return JSON.stringify(
			buildModelReplayAgentMessagesFromTurns(entries, {
				...(leafTurnId ? { activeLeafTurnId: leafTurnId } : {}),
				continuity: continuityContextFromSession(contract),
			}),
		);
	}

	it("carries A's exact note into a fork made after the handoff, recall only", () => {
		const parent = buildParentWithReadyHandoff();
		const child = contract.fork("m4");
		ok(child.id !== parent.sessionId);
		strictEqual(child.parentSessionId, parent.sessionId);

		const entries = childEntries(child.id);
		// The child's actual JSONL holds the inherited records under their
		// original origin, unrewritten.
		const inheritedCommit = entries.find((entry) => entry.kind === "continuityCommit");
		ok(inheritedCommit?.kind === "continuityCommit");
		strictEqual(inheritedCommit.continuity.identity.originSessionId, parent.sessionId);
		strictEqual(inheritedCommit.continuity.accepted.note, NOTE_A.note);

		const projection = resolveContinuityProjection({
			entries,
			sessionId: child.id,
			fork: { parentSessionId: parent.sessionId, parentTurnId: "m4" },
			nowMs: NOW,
		});
		// Inherited, therefore recall only, with no action and no reconstruction
		// exposed anywhere on the published recall record.
		strictEqual(projection.note, null);
		strictEqual(projection.inherited.length, 1);
		strictEqual(projection.inherited[0]?.note, NOTE_A.note);
		strictEqual(projection.inherited[0]?.originSessionId, parent.sessionId);
		strictEqual(projection.inherited[0]?.provenance, "inherited");
		ok(!("action" in (projection.inherited[0] ?? {})));
		ok(!("reconstruction" in (projection.inherited[0] ?? {})));
		// The fork can still read the note.
		const blocks = continuityReplayBlocks(projection);
		strictEqual(blocks.length, 1);
		ok(blocks[0]?.includes(NOTE_A.note));
		match(blocks[0] ?? "", /recall only/u);
		match(blocks[0] ?? "", /does not authorize resuming/u);
	});

	it("excludes continuity sidecars written after the fork point from the child's ledger", () => {
		buildParentWithReadyHandoff();
		// m2 is before the sidecars in file order even though they anchor to it.
		const child = contract.fork("m2");
		const raw = readFileSync(sessionPaths(child).current, "utf8");
		ok(!raw.includes("a-prep"));
		ok(!raw.includes("a-commit-entry"));
		ok(!raw.includes(NOTE_A.note));
		// Applying the gate only at replay would leave the records durably copied.
		const entries = childEntries(child.id);
		strictEqual(
			entries.filter((entry) => entry.kind === "handoffTransaction" || entry.kind === "continuityCommit").length,
			0,
		);
	});

	it("excludes an operator recovery request written after the fork point", () => {
		const parent = buildParentWithReadyHandoff();
		contract.appendEntry({
			kind: "custom",
			turnId: "a-request",
			parentTurnId: "m4",
			timestamp: AT,
			customType: HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE,
			display: false,
			data: {
				version: 1,
				requestKind: "handoff_recovery",
				handoffId: "a-h",
				action: "deliver",
				sessionId: parent.sessionId,
				branchAnchorTurnId: "m2",
				selectedLeafTurnId: "m4",
				pausedOrFailedEntryId: "a-pause",
			},
		} as unknown as SessionEntryInput);
		const child = contract.fork("m2");
		ok(!readFileSync(sessionPaths(child).current, "utf8").includes("a-request"));
	});

	it("keeps A recall alongside the child's own fresh handoff, selecting the child's for authority", () => {
		const parent = buildParentWithReadyHandoff();
		const child = contract.fork("m4");
		contract.append({ id: "c1", parentId: "m4", at: AT, kind: "user", payload: { text: "child work" } });
		const shapeB: HandoffShape = { prefix: "b", sessionId: child.id, anchor: "c1", initiating: "c1" };
		contract.appendEntry(tx(shapeB, "b-prep", null, 0, 0, { phase: "prepared", accepted: NOTE_B, policy: policy() }));
		contract.appendEntry(tx(shapeB, "b-reduce", "b-prep", 1, 1, { phase: "reducing" }));
		contract.appendEntry(carryingSummary(shapeB, checkpoint(shapeB, NOTE_B)));
		contract.appendEntry(commitEntry(checkpoint(shapeB, NOTE_B)));

		const entries = childEntries(child.id);
		const projection = resolveContinuityProjection({
			entries,
			sessionId: child.id,
			fork: { parentSessionId: parent.sessionId, parentTurnId: "m4" },
			nowMs: NOW,
		});
		// The child's own transaction is the one that can carry authority; A stays
		// recallable and is not erased by it.
		strictEqual(projection.note?.note, NOTE_B.note);
		strictEqual(projection.note?.originSessionId, child.id);
		strictEqual(projection.inherited.length, 1);
		strictEqual(projection.inherited[0]?.note, NOTE_A.note);
		const blocks = continuityReplayBlocks(projection);
		strictEqual(blocks.length, 2);
		ok(blocks[0]?.includes(NOTE_A.note));
		ok(blocks[1]?.includes(NOTE_B.note));

		// And the real replay shows both, once each.
		const replay = replayText(entries, "c1");
		strictEqual(replay.split(JSON.stringify(NOTE_A.note).slice(1, -1)).length - 1, 1);
		strictEqual(replay.split(JSON.stringify(NOTE_B.note).slice(1, -1)).length - 1, 1);
	});

	it("keeps both ancestors recallable through a second fork, and after the first ancestor is deleted", () => {
		const parent = buildParentWithReadyHandoff();
		const b = contract.fork("m4");
		contract.append({ id: "c1", parentId: "m4", at: AT, kind: "user", payload: { text: "child work" } });
		const shapeB: HandoffShape = { prefix: "b", sessionId: b.id, anchor: "c1", initiating: "c1" };
		contract.appendEntry(tx(shapeB, "b-prep", null, 0, 0, { phase: "prepared", accepted: NOTE_B, policy: policy() }));
		contract.appendEntry(tx(shapeB, "b-reduce", "b-prep", 1, 1, { phase: "reducing" }));
		contract.appendEntry(carryingSummary(shapeB, checkpoint(shapeB, NOTE_B)));
		contract.appendEntry(commitEntry(checkpoint(shapeB, NOTE_B)));
		contract.append({ id: "c2", parentId: "c1", at: AT, kind: "assistant", payload: { text: "done" } });

		const c = contract.fork("c2");
		// C's copied prefix physically holds both A's and B's records, so the
		// grandparent is reachable without reading any ancestor's file.
		const entries = childEntries(c.id);
		const projection = resolveContinuityProjection({
			entries,
			sessionId: c.id,
			fork: { parentSessionId: b.id, parentTurnId: "c2" },
			nowMs: NOW,
		});
		const notes = projection.inherited.map((row) => row.note).sort();
		deepStrictEqual(notes, [NOTE_A.note, NOTE_B.note].sort());
		deepStrictEqual(
			[...new Set(projection.inherited.map((row) => row.originSessionId))].sort(),
			[parent.sessionId, b.id].sort(),
		);

		// The bytes are C's own now. Removing A's directory cannot take them away,
		// and nothing here reads an ancestor's file to find them. The path is
		// composed read-only rather than through `sessionPaths`, which mkdirs.
		rmSync(join(clioStatePath(), "sessions", c.cwdHash, parent.sessionId), { recursive: true, force: true });
		const afterDelete = resolveContinuityProjection({
			entries: childEntries(c.id),
			sessionId: c.id,
			fork: { parentSessionId: b.id, parentTurnId: "c2" },
			nowMs: NOW,
		});
		ok(afterDelete.inherited.some((row) => row.note === NOTE_A.note));
	});

	it("refuses to project inherited recall when the fork boundary cannot be established", () => {
		const parent = buildParentWithReadyHandoff();
		const child = contract.fork("m4");
		const entries = childEntries(child.id);
		// A boundary that names a turn this ledger does not contain is unresolved.
		// It is not repaired by falling back to the latest handoff.
		const unresolved = resolveContinuityProjection({
			entries,
			sessionId: child.id,
			fork: { parentSessionId: parent.sessionId, parentTurnId: "not-in-this-ledger" },
			nowMs: NOW,
		});
		deepStrictEqual(unresolved.inherited, []);
		ok(unresolved.authoritySuppressed);
		match(unresolved.anomalies.map((row) => row.detail).join("\n"), /inherited boundary unresolved/u);

		// Header and metadata disagreeing about the fork message is the same refusal.
		const disagreeing = resolveContinuityProjection({
			entries,
			sessionId: child.id,
			fork: { parentSessionId: parent.sessionId, parentTurnId: "m4", headerParentTurnId: "m2" },
			nowMs: NOW,
		});
		deepStrictEqual(disagreeing.inherited, []);
		match(disagreeing.anomalies.map((row) => row.detail).join("\n"), /disagree about the fork message/u);
	});

	it("refuses execution when one handoff id is claimed by two origins", () => {
		const parent = buildParentWithReadyHandoff();
		const child = contract.fork("m4");
		contract.append({ id: "c1", parentId: "m4", at: AT, kind: "user", payload: { text: "child work" } });
		// The child mints a transaction reusing A's handoff id under its own origin
		// and its own reserved entry ids: one name, two immutable identities.
		contract.appendEntry({
			kind: "handoffTransaction",
			turnId: "a2-prep",
			parentTurnId: "c1",
			timestamp: AT,
			schemaVersion: 1,
			identity: {
				...identity({ prefix: "a", sessionId: child.id, anchor: "c1", initiating: "c1" }),
				preparedEntryId: "a2-prep",
				commitId: "a2-commit",
				commitEntryId: "a2-commit-entry",
			},
			transition: { entryId: "a2-prep", prevEntryId: null, sequence: 0, attempt: 0 },
			event: { phase: "prepared", accepted: NOTE_B, policy: policy() },
		} as unknown as SessionEntryInput);

		const projection = resolveContinuityProjection({
			entries: childEntries(child.id),
			sessionId: child.id,
			fork: { parentSessionId: parent.sessionId, parentTurnId: "m4" },
			nowMs: NOW,
		});
		ok(projection.authoritySuppressed);
		// The published fold is unvalidated, so no carry and no reconstruction can
		// be taken from it. Suppression is enforced, not advertised.
		strictEqual(projection.current?.validated, false);
		strictEqual(projection.current?.missingCommit, null);
		ok(projection.note === null || projection.note.authority !== "execution");
		match(
			projection.anomalies.map((row) => row.detail).join("\n"),
			/two different immutable identities|two different accepted notes/u,
		);
	});

	it("keeps an exact duplicate of an inherited record idempotent", () => {
		const parent = buildParentWithReadyHandoff();
		const child = contract.fork("m4");
		const before = resolveContinuityProjection({
			entries: childEntries(child.id),
			sessionId: child.id,
			fork: { parentSessionId: parent.sessionId, parentTurnId: "m4" },
			nowMs: NOW,
		});
		strictEqual(before.inherited.length, 1);
		strictEqual(before.authoritySuppressed, false);
	});

	it("shows a live /tree selection the sidecars anchored after the selected message", () => {
		const parent = buildParentWithReadyHandoff();
		// A pause anchored on m2, written after m4: on the live branch this is
		// current state, and truncating the display at m2 must not discard it.
		contract.appendEntry(
			tx(parent.shape, "a-pause", "a-commit-entry", 3, 1, { phase: "paused", reason: "operator_cancelled" }),
		);
		const entries = childEntries(parent.sessionId);

		const live = resolveContinuityProjection({
			entries,
			sessionId: parent.sessionId,
			pathTurnIds: ["m1", "m2", "m3", "m4"],
			nowMs: NOW,
		});
		strictEqual(live.current?.phase, "paused");
		strictEqual(live.note?.note, NOTE_A.note);

		// The same options through the real replay path: `uptoTurnId` is display
		// truncation, not a historical cut, so the pause still folds.
		const replayed = buildModelReplayAgentMessagesFromTurns(entries, {
			uptoTurnId: "m2",
			continuity: continuityContextFromSession(contract),
		});
		ok(JSON.stringify(replayed).includes(NOTE_A.note));

		// A genuine historical cut is the other meaning, and it does exclude the
		// later pause, because at m2 it had not been written.
		const historical = buildModelReplayAgentMessagesFromTurns(entries, {
			uptoTurnId: "m2",
			continuity: { ...continuityContextFromSession(contract), historical: true },
		});
		ok(!JSON.stringify(historical).includes(NOTE_A.note));
	});

	it("preserves the exact note and the newest state across three summary cycles after an eviction-only commit", () => {
		const meta = contract.create({ cwd: scratch.dir });
		contract.append({ id: "m1", parentId: null, at: AT, kind: "user", payload: { text: "first" } });
		contract.append({ id: "m2", parentId: "m1", at: AT, kind: "assistant", payload: { text: "second" } });
		const shape: HandoffShape = { prefix: "a", sessionId: meta.id, anchor: "m2", initiating: "m1" };
		const eviction = {
			kind: "contextEviction",
			turnId: "a-evict",
			parentTurnId: "m2",
			timestamp: AT,
			policyId: "p",
			trigger: "pressure",
			evicted: [],
			tokensBefore: 30_000,
			tokensAfter: 21_000,
			pressureBefore: null,
			snapshotIdBefore: null,
		} as unknown as SessionEntryInput;
		const evictedCommit: ContinuityCommitData = {
			outcome: "evicted",
			entry: { turnId: "a-commit-entry", parentTurnId: "m2", timestamp: AT },
			transition: { entryId: "a-commit-entry", prevEntryId: "a-reduce", sequence: 2, attempt: 1 },
			evictionRef: "a-evict",
			tokensBefore: 30_000,
			tokensAfter: 21_000,
		};
		const payload = checkpoint(shape, NOTE_A, { commit: evictedCommit });
		contract.appendEntry(tx(shape, "a-prep", null, 0, 0, { phase: "prepared", accepted: NOTE_A, policy: policy() }));
		contract.appendEntry(tx(shape, "a-reduce", "a-prep", 1, 1, { phase: "reducing" }));
		contract.appendEntry(eviction);
		contract.appendEntry(commitEntry(payload));
		// Three later ordinary summaries, each carrying the newest validated fold.
		contract.appendEntry(carryingSummary(shape, payload, "s1"));
		contract.appendEntry(carryingSummary(shape, payload, "s2"));
		contract.appendEntry(carryingSummary(shape, payload, "s3"));

		const projection = resolveContinuityProjection({ entries: childEntries(meta.id), sessionId: meta.id, nowMs: NOW });
		strictEqual(projection.note?.note, NOTE_A.note);
		// The outcome stays evicted through every cycle: a carry never promotes an
		// eviction-only commit to summarized.
		strictEqual(projection.current?.commit?.outcome, "evicted");
		// One note in front of the model, not three.
		strictEqual(continuityReplayBlocks(projection).length, 1);
	});

	it("reconstructs a missing evicted commit from the eviction plus the carry that describes it", () => {
		const meta = contract.create({ cwd: scratch.dir });
		contract.append({ id: "m1", parentId: null, at: AT, kind: "user", payload: { text: "first" } });
		contract.append({ id: "m2", parentId: "m1", at: AT, kind: "assistant", payload: { text: "second" } });
		const shape: HandoffShape = { prefix: "a", sessionId: meta.id, anchor: "m2", initiating: "m1" };
		const evictedCommit: ContinuityCommitData = {
			outcome: "evicted",
			entry: { turnId: "a-commit-entry", parentTurnId: "m2", timestamp: AT },
			transition: { entryId: "a-commit-entry", prevEntryId: "a-reduce", sequence: 2, attempt: 1 },
			evictionRef: "a-evict",
			tokensBefore: 30_000,
			tokensAfter: 21_000,
		};
		const payload = checkpoint(shape, NOTE_A, { commit: evictedCommit });
		contract.appendEntry(tx(shape, "a-prep", null, 0, 0, { phase: "prepared", accepted: NOTE_A, policy: policy() }));
		contract.appendEntry(tx(shape, "a-reduce", "a-prep", 1, 1, { phase: "reducing" }));
		contract.appendEntry({
			kind: "contextEviction",
			turnId: "a-evict",
			parentTurnId: "m2",
			timestamp: AT,
			policyId: "p",
			trigger: "pressure",
			evicted: [],
			tokensBefore: 30_000,
			tokensAfter: 21_000,
			pressureBefore: null,
			snapshotIdBefore: null,
		} as unknown as SessionEntryInput);
		// The commit row is exactly what went missing; the summary that carries it
		// is the proof it existed.
		contract.appendEntry(carryingSummary(shape, payload, "s1"));

		const projection = resolveContinuityProjection({ entries: childEntries(meta.id), sessionId: meta.id, nowMs: NOW });
		const reconstruction = projection.current?.missingCommit;
		ok(reconstruction, "the eviction plus the carry must bind the missing commit");
		// Rebuilt under the reserved identity and envelope, not a new one.
		strictEqual(reconstruction.entry.turnId, "a-commit-entry");
		strictEqual(reconstruction.entry.continuity.commit.outcome, "evicted");
		strictEqual(reconstruction.entry.continuity.accepted.note, NOTE_A.note);
	});

	it("labels the note in the transcript and escapes it in the HTML export", () => {
		const meta = contract.create({ cwd: scratch.dir });
		contract.append({ id: "m1", parentId: null, at: AT, kind: "user", payload: { text: "first" } });
		contract.append({ id: "m2", parentId: "m1", at: AT, kind: "assistant", payload: { text: "second" } });
		const shape: HandoffShape = { prefix: "a", sessionId: meta.id, anchor: "m2", initiating: "m1" };
		const hostile = admit('note with <script>alert("x")</script>, a ``` fence and a & ampersand');
		contract.appendEntry(tx(shape, "a-prep", null, 0, 0, { phase: "prepared", accepted: hostile, policy: policy() }));
		contract.appendEntry(tx(shape, "a-reduce", "a-prep", 1, 1, { phase: "reducing" }));
		contract.appendEntry(carryingSummary(shape, checkpoint(shape, hostile)));
		contract.appendEntry(commitEntry(checkpoint(shape, hostile)));

		const entries = childEntries(meta.id);
		const options = withContinuityReplay(entries, { unboundedToolBodies: true, activeLeafTurnId: "m2" }, contract);
		const panel = createChatPanel({ unboundedToolBodies: true, getOutputStyle: () => "detailed" });
		rehydrateChatPanelFromTurns(panel, entries, options);
		const lines = panel.render(100);
		const plain = stripVTControlCharacters(lines.join("\n"));
		// The transcript is a presentation view: the panel wraps to width, so this
		// is labelled transformed output, not byte-identical model text.
		match(plain, /Context handoff note/u);
		match(plain, /written by the assistant/u);
		ok(plain.includes("alert("));
		// It is never rendered as an operator turn.
		ok(!/^\s*>\s*note with <script>/mu.test(plain));

		const html = renderSessionHtml({ sessionId: meta.id, exportedAt: AT, ansiLines: lines });
		ok(!html.includes("<script>alert"));
		ok(html.includes("&lt;script&gt;"));
		ok(html.includes("&amp;"));
	});
});
