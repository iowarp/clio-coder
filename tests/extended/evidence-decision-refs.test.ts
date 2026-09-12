import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { buildEvidence, inspectEvidence } from "../../src/domains/evidence/index.js";
import { activeDecisionRefs, createDecisionBoardStore } from "../../src/domains/session/decision-board.js";
import {
	type DecisionLedgerEntry,
	isSessionEntry,
	type MessageEntry,
	type SessionEntry,
} from "../../src/domains/session/entries.js";
import { createDecideTool } from "../../src/tools/decide.js";
import { agentDecision } from "../harness/decision.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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
async function bundle(
	entries: SessionEntry[],
	refs?: string[],
	options: { tamper?: boolean; pinnedLeaf?: string; retired?: boolean; session?: boolean } = {},
) {
	const envelope = { ...fixtureEnvelope("decisions"), ...(refs ? { decisionRefs: refs } : {}) };
	const receipt = withReceiptIntegrity(
		{ ...fixtureReceiptDraft(envelope), ...(refs ? { decisionRefs: refs } : {}) },
		envelope,
	);
	if (options.tamper) receipt.decisionRefs = ["forged/ref"];
	if (options.retired) receipt.integrity.version = 1 as typeof receipt.integrity.version;
	await mkdir(join(clioStateDir(), "receipts"), { recursive: true });
	await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
	await writeFile(join(clioStateDir(), "receipts", "decisions.json"), JSON.stringify(receipt));
	const dir = join(clioStateDir(), "sessions", "workspace", "session-1");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "current.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
	if (options.pinnedLeaf)
		await writeFile(join(dir, "meta.json"), JSON.stringify({ pinnedLeafTurnId: options.pinnedLeaf }));
	const result = await buildEvidence({
		dataDir: clioDataDir(),
		stateDir: clioStateDir(),
		...(options.session ? { sessionId: "session-1" } : { runId: envelope.id }),
	});
	const read = await inspectEvidence(clioDataDir(), result.overview.evidenceId);
	const transcript = await readFile(join(result.directory, "transcript.md"), "utf8");
	const findings = await readFile(join(result.directory, "findings.md"), "utf8");
	return { ...read, transcript, findingsText: findings };
}

describe("receipt decision provenance", () => {
	let isolated: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		isolated = await isolateClioEnv();
	});
	afterEach(() => isolated.restore());
	it("persists and renders agent revisions without attributing them to the operator", async () => {
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
		const result = await bundle([message("root", null), ...entries], undefined, { session: true });
		doesNotMatch(result.transcript, /(?:revision|correction)Source=operator/u);
		match(result.transcript, /revisionSource=agent/u);
		match(result.transcript, /correctionSource=agent correction=use node id/u);
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
			const result = await bundle([message("root", null), ...entries], undefined, { session: true });
			match(result.transcript, /revisionSource=operator/u);
			match(result.transcript, /correctionSource=operator correction=operator selected node id/u);
			const persisted: unknown[] = JSON.parse(JSON.stringify(entries));
			ok(persisted.every(isSessionEntry));
			const revision = createDecisionBoardStore({ readEntries: () => persisted }).snapshot()[0];
			strictEqual(revision?.origin, origin);
			strictEqual(revision?.decisions[0]?.source, initial.decisions[0]?.source);
			strictEqual(revision?.decisions[0]?.revisionSource, "operator");
		});
	}
	it("leaves historical revision authors unknown when the ledger did not record them", async () => {
		const initial = await agentDecision();
		delete initial.origin;
		delete initial.decisions[0]?.source;
		initial.decisions = initial.decisions.map((record) => ({
			...record,
			status: "superseded",
			revisedAt: initial.endedAt,
			correction: "historical correction",
		}));
		ok(isSessionEntry(initial));
		const result = await bundle([message("root", null), initial], undefined, { session: true });
		match(result.transcript, /revisionSource=unknown/u);
		match(result.transcript, /correctionSource=unknown correction=historical correction/u);
		doesNotMatch(result.transcript, /(?:revision|correction)Source=(?:operator|agent)/u);
	});
	it("resolves a real decide record before the run window and reports missing refs on both readable surfaces", async () => {
		const decision = await agentDecision();
		ok(isSessionEntry(decision), "persisted producer records must pass the session reader");
		const refs = activeDecisionRefs([decision]);
		const result = await bundle([message("root", null), decision], [...refs, "missing/key"]);
		strictEqual(result.overview.decisions?.length, 1);
		strictEqual(result.overview.decisions[0]?.ref, refs[0]);
		deepStrictEqual(result.overview.decisions[0]?.record, decision.decisions[0]);
		for (const text of [result.transcript, result.findingsText]) {
			ok(text.includes(`Decision ref ${refs[0]} resolved`));
			match(text, /Decision ref missing\/key does not resolve/u);
		}
		match(result.transcript, /needs keys that survive fleet changes/u);
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
		const current = await bundle(entries, refs);
		deepStrictEqual(
			current.overview.decisions?.map((entry) => entry.record.key),
			["chosen-key"],
		);
		const pinned = await bundle(entries, refs, { pinnedLeaf: "abandoned" });
		deepStrictEqual(
			pinned.overview.decisions?.map((entry) => entry.record.key),
			["abandoned-key"],
		);
		const linearPinned = await bundle(
			[message("root", null), message("chosen", "root"), chosen],
			activeDecisionRefs([chosen]),
			{ pinnedLeaf: "root" },
		);
		deepStrictEqual(linearPinned.overview.decisions, []);
	});
	it("does not promote refs from tampered or retired receipts, or invent refs on legacy receipts", async () => {
		const decision = await agentDecision();
		const entries = [message("root", null), decision];
		for (const options of [{ tamper: true }, { retired: true }, {}]) {
			const result = await bundle(
				entries,
				"tamper" in options || "retired" in options ? activeDecisionRefs([decision]) : undefined,
				options,
			);
			deepStrictEqual(result.overview.decisions, []);
			doesNotMatch(result.transcript, /## Decision provenance/u);
			ok(!result.findings.some((row) => row.message.startsWith("Decision ref ")));
		}
	});
	it("redacts recorded arguments at the export boundary", async () => {
		const decision = await agentDecision();
		const record = decision.decisions[0];
		if (!record) throw new Error("missing decision");
		record.rationale = `Authorization: Bearer ghp_${"a".repeat(40)}`;
		const result = await bundle([message("root", null), decision], activeDecisionRefs([decision]));
		doesNotMatch(JSON.stringify(result.overview), /a{40}/u);
		doesNotMatch(result.transcript, /a{40}/u);
		ok((result.overview.redactionCount ?? 0) > 0);
	});
});
