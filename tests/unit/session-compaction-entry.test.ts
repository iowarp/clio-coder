/**
 * Tier-2 telemetry coverage for T2.4: the persisted CompactionSummaryEntry
 * must carry trigger reason ("auto" | "force" | "overflow"), tokensAfter
 * estimation, messagesSummarized count, and isSplitTurn marker. The chat
 * loop's three trigger paths (threshold, /compact slash, post-overflow
 * retry) all funnel through session.appendEntry, so a roundtrip on the
 * extension proves the persistence layer accepts and surfaces every field.
 *
 * Older sessions written before these fields existed remain readable: the
 * fields are optional on the type, so an entry without them parses cleanly.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { CompactionSummaryEntry, CompactionTrigger } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { SessionContract } from "../../src/domains/session/index.js";

const ORIGINAL_ENV = { ...process.env };

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

function readSessionEntries(scratchDataDir: string, cwdHashValue: string, sessionId: string): unknown[] {
	const sessionDir = join(scratchDataDir, "sessions", cwdHashValue, sessionId);
	const text = readFileSync(join(sessionDir, "current.jsonl"), "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

describe("session compaction entry: persists trigger + tokensAfter + messagesSummarized + isSplitTurn", () => {
	let scratch: string;
	let bundle: ReturnType<typeof createSessionBundle>;
	let contract: SessionContract;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-compaction-entry-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		bundle = createSessionBundle(stubContext());
		contract = bundle.contract;
	});

	afterEach(async () => {
		try {
			await contract.close();
		} catch {
			// already closed
		}
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	for (const trigger of ["auto", "force", "overflow"] as CompactionTrigger[]) {
		it(`appendEntry roundtrips a CompactionSummaryEntry with trigger="${trigger}" and the new optional fields`, () => {
			const meta = contract.create({ cwd: scratch });
			const seed = contract.append({ parentId: null, kind: "user", payload: { text: "earliest" } });

			contract.appendEntry({
				kind: "compactionSummary",
				parentTurnId: seed.id,
				summary: "## Goal\nTest the trigger field roundtrip.",
				tokensBefore: 12_345,
				firstKeptTurnId: seed.id,
				trigger,
				tokensAfter: 110,
				messagesSummarized: 7,
				isSplitTurn: trigger === "overflow",
			});

			const entries = readSessionEntries(join(scratch, "data"), meta.cwdHash, meta.id);
			const compaction = entries.find(
				(e): e is CompactionSummaryEntry =>
					typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "compactionSummary",
			);
			ok(compaction, `expected a compactionSummary entry on disk, got ${JSON.stringify(entries)}`);
			strictEqual(compaction.trigger, trigger);
			strictEqual(compaction.tokensBefore, 12_345);
			strictEqual(compaction.tokensAfter, 110);
			strictEqual(compaction.messagesSummarized, 7);
			strictEqual(compaction.isSplitTurn, trigger === "overflow");
			strictEqual(compaction.firstKeptTurnId, seed.id);
		});
	}

	it("appendEntry remains backward compatible when the new optional fields are omitted (v1 entry shape)", () => {
		const meta = contract.create({ cwd: scratch });
		const seed = contract.append({ parentId: null, kind: "user", payload: { text: "earliest" } });

		contract.appendEntry({
			kind: "compactionSummary",
			parentTurnId: seed.id,
			summary: "legacy v1 entry without trigger",
			tokensBefore: 9_999,
			firstKeptTurnId: seed.id,
		});

		const entries = readSessionEntries(join(scratch, "data"), meta.cwdHash, meta.id);
		const compaction = entries.find(
			(e): e is Record<string, unknown> =>
				typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "compactionSummary",
		);
		ok(compaction, `expected a compactionSummary entry on disk, got ${JSON.stringify(entries)}`);
		strictEqual(compaction.trigger, undefined, "legacy entries must not invent a trigger");
		strictEqual(compaction.tokensAfter, undefined, "legacy entries must not invent tokensAfter");
		strictEqual(compaction.messagesSummarized, undefined, "legacy entries must not invent messagesSummarized");
		strictEqual(compaction.isSplitTurn, undefined, "legacy entries must not invent isSplitTurn");
	});
});
