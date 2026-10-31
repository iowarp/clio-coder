import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { inspectRunEvidence } from "../../src/domains/evidence/index.js";
import { activeDecisionRefs, createDecisionBoardStore } from "../../src/domains/session/decision-board.js";
import {
	type DecisionLedgerEntry,
	isSessionEntry,
	type MessageEntry,
	type SessionEntry,
} from "../../src/domains/session/entries.js";
import { telemetryJournalPath, telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { createDecideTool } from "../../src/tools/decide.js";
import { agentDecision } from "../harness/decision.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

function message(turnId: string, parentTurnId: string | null): MessageEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-06-25T11:00:00.000Z",
		role: "user",
		payload: "choose cache key",
	};
}
/**
 * Settle a run citing `refs` against a session ledger holding `entries`, the way dispatch does: the assessment reads
 * the board when the run settles and seals with it (#434). The ledger is written first, as it exists at settle time.
 */
async function assessed(
	entries: SessionEntry[],
	refs?: string[],
	options: { tamper?: boolean; pinnedLeaf?: string } = {},
) {
	const envelope = { ...fixtureEnvelope("decisions"), ...(refs ? { decisionRefs: refs } : {}) };
	const dir = join(clioStateDir(), "sessions", "workspace", "session-1");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "current.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
	if (options.pinnedLeaf)
		await writeFile(join(dir, "meta.json"), JSON.stringify({ pinnedLeafTurnId: options.pinnedLeaf }));
	const scope = telemetryRunDirectory(clioStateDir(), envelope.id);
	await rm(scope, { recursive: true, force: true });
	await writeSettledRun(clioStateDir(), { ...fixtureReceiptDraft(envelope), ...(refs ? { decisionRefs: refs } : {}) });
	if (options.tamper) {
		// One changed byte in the settled record: the run's seal no longer verifies.
		const path = telemetryJournalPath(scope);
		await writeFile(path, (await readFile(path, "utf8")).replace('"agentId":"coder"', '"agentId":"codex"'));
	}
	return inspectRunEvidence(clioStateDir(), envelope.id);
}

describe("run decision provenance", () => {
	let isolated: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		isolated = await isolateClioEnv();
	});
	afterEach(() => isolated.restore());
	it("persists agent revisions without attributing them to the operator", async () => {
		const entries: DecisionLedgerEntry[] = [];
		const board = createDecisionBoardStore({
			readEntries: () => entries,
			getActiveLeafTurnId: () => "root",
			appendEntry: (entry) => {
				entries.push({ ...entry, turnId: `decision-${entries.length}`, timestamp: entry.endedAt });
			},
			now: () => new Date("2026-06-25T11:00:00.000Z"),
		});
		const tool = createDecideTool({ decisionBoard: board });
		for (const value of ["tuple", "node id"]) {
			const result = await tool.run({ key: "cache-key", value, alternatives: ["fleet hash"], rationale: `use ${value}` });
			strictEqual(result.kind, "ok", JSON.stringify(result));
		}
		const persisted: unknown[] = JSON.parse(JSON.stringify(entries));
		ok(persisted.every(isSessionEntry));
		const restored = createDecisionBoardStore({ readEntries: () => persisted }).snapshot();
		const revision = restored.find((entry) => entry.interviewId === entries[0]?.interviewId);
		strictEqual(revision?.origin, "agent");
		strictEqual(revision?.decisions[0]?.source, "agent");
		strictEqual(revision?.decisions[0]?.revisionSource, "agent");
	});
	for (const origin of ["agent", "interview", undefined] as const) {
		it(`attributes an operator revision of ${origin ?? "legacy unknown"} origin to the operator`, async () => {
			const initial = await agentDecision();
			if (origin === undefined) delete initial.origin;
			else initial.origin = origin;
			if (origin !== "agent") delete initial.decisions[0]?.source;
			const entries: DecisionLedgerEntry[] = [initial];
			const board = createDecisionBoardStore({
				readEntries: () => entries,
				getActiveLeafTurnId: () => "root",
				appendEntry: (entry) => {
					entries.push({ ...entry, turnId: "revision", timestamp: entry.endedAt });
				},
			});
			board.supersede(initial.interviewId, "cache-key", "operator selected node id");
			const persisted: unknown[] = JSON.parse(JSON.stringify(entries));
			ok(persisted.every(isSessionEntry));
			const revision = createDecisionBoardStore({ readEntries: () => persisted }).snapshot()[0];
			strictEqual(revision?.origin, origin);
			strictEqual(revision?.decisions[0]?.source, initial.decisions[0]?.source);
			strictEqual(revision?.decisions[0]?.revisionSource, "operator");
		});
	}
	it("resolves a real decide record into the sealed assessment and reports missing refs", async () => {
		const decision = await agentDecision();
		ok(isSessionEntry(decision), "persisted producer records must pass the session reader");
		const refs = activeDecisionRefs([decision]);
		const result = await assessed([message("root", null), decision], [...refs, "missing/key"]);
		strictEqual(result.decisions.length, 1);
		strictEqual(result.decisions[0]?.ref, refs[0]);
		deepStrictEqual(result.decisions[0]?.record, decision.decisions[0]);
		const text = result.findings.map((row) => row.message).join("\n");
		ok(text.includes(`Decision ref ${refs[0]} resolved`));
		match(text, /Decision ref missing\/key does not resolve/u);
		ok(
			result.findings.some(
				(row) => row.tag === "context-provenance" && row.severity === "info" && row.message.includes(refs[0] ?? "missing"),
			),
		);
		ok(
			result.findings.some(
				(row) => row.tag === "context-provenance" && row.severity === "warn" && row.message.includes("missing/key"),
			),
		);
	});
	it("excludes abandoned siblings and honors a persisted backward tree selection", async () => {
		const abandoned = await agentDecision("abandoned", "abandoned-key");
		const chosen = await agentDecision("chosen", "chosen-key");
		const entries = [message("root", null), message("abandoned", "root"), abandoned, message("chosen", "root"), chosen];
		const refs = activeDecisionRefs([abandoned, chosen]);
		const current = await assessed(entries, refs);
		deepStrictEqual(
			current.decisions.map((entry) => entry.record.key),
			["chosen-key"],
		);
		const pinned = await assessed(entries, refs, { pinnedLeaf: "abandoned" });
		deepStrictEqual(
			pinned.decisions.map((entry) => entry.record.key),
			["abandoned-key"],
		);
		const linearPinned = await assessed(
			[message("root", null), message("chosen", "root"), chosen],
			activeDecisionRefs([chosen]),
			{ pinnedLeaf: "root" },
		);
		deepStrictEqual(linearPinned.decisions, []);
	});
	it("does not promote refs from a run whose seal fails, or invent refs a run never recorded", async () => {
		const decision = await agentDecision();
		const entries = [message("root", null), decision];
		for (const options of [{ tamper: true }, {}]) {
			const result = await assessed(entries, "tamper" in options ? activeDecisionRefs([decision]) : undefined, options);
			deepStrictEqual(result.decisions, []);
			ok(!result.findings.some((row) => row.message.startsWith("Decision ref ")));
		}
	});
	it("reads cited decisions from the seal, never from a later ledger edit (#434)", async () => {
		const decision = await agentDecision();
		const refs = activeDecisionRefs([decision]);
		await assessed([message("root", null), decision], refs);
		// Rewriting the session ledger and the run ledger after the run sealed changes nothing the evidence reads.
		await writeFile(join(clioStateDir(), "sessions", "workspace", "session-1", "current.jsonl"), "");
		await writeFile(
			join(clioStateDir(), "runs.json"),
			JSON.stringify([{ ...fixtureEnvelope("decisions"), decisionRefs: ["forged/key"] }]),
		);
		const result = await inspectRunEvidence(clioStateDir(), "decisions");
		strictEqual(result.integrity.state, "verified");
		deepStrictEqual(
			result.decisions.map((entry) => entry.ref),
			refs,
		);
		ok(!result.findings.some((row) => row.message.includes("forged/key")));
	});
	it("redacts recorded arguments where the assessment stores them", async () => {
		const decision = await agentDecision();
		const record = decision.decisions[0];
		if (!record) throw new Error("missing decision");
		record.rationale = `Authorization: Bearer ghp_${"a".repeat(40)}`;
		const result = await assessed([message("root", null), decision], activeDecisionRefs([decision]));
		strictEqual(result.decisions.length, 1);
		doesNotMatch(JSON.stringify(result), /a{40}/u);
	});
});
