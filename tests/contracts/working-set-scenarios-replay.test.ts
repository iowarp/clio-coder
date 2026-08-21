/**
 * Charter section 10: replay is live.
 *
 * The replay-lite runner exists to measure policies offline, and the only
 * reason its numbers mean anything is that it drives the same `fold`,
 * `planEviction`, and `project` code the live stage does. This scenario proves
 * that on the frozen fixture: run `replayTrace` over it, then write the exact
 * entry prefix its first event stood on into a real session, run the live
 * `runAutoCompact` over that session, and compare the two evicted ref sets.
 *
 * The two sides disagree about the pressure number by construction. Replay
 * measures the projected ledger; the live stage measures the agent's message
 * list. `age-horizon` selection does not read either total (it has no target
 * stop, only the protection horizon and the size floor), so the ref sets must
 * still match exactly. A policy that started ranking by size would break this
 * test, which is the point.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { isTurnStart } from "../../src/domains/context/working-set/horizon.js";
import { ageHorizonPolicy } from "../../src/domains/context/working-set/policies/age-horizon.js";
import { loadClioTraces } from "../../src/domains/context/working-set/replay/load-clio.js";
import { replayTrace } from "../../src/domains/context/working-set/replay/runner.js";
import type { EvictedItem, MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { createScenarioHarness, evictionEntries } from "../harness/working-set-session.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "context-replay", "fixture-01.jsonl");

/** The budget the replay runs on. Any budget the first event fires under works; this one does. */
const REPLAY_BUDGET_TOKENS = 16_000;
const THRESHOLD = 0.8;

/**
 * The entries `replayTrace` had accumulated when its `turnIndex`-th event
 * fired: everything strictly before that turn's opening entry, which is where
 * the runner takes its pressure reading.
 */
function entriesBeforeTurn(entries: ReadonlyArray<SessionEntry>, turnIndex: number): SessionEntry[] {
	let seen = 0;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry === undefined || !isTurnStart(entry)) continue;
		seen += 1;
		if (seen === turnIndex) return entries.slice(0, index);
	}
	throw new Error(`the trace has no turn ${turnIndex}`);
}

function isMessage(entry: SessionEntry): entry is MessageEntry {
	return entry.kind === "message";
}

describe("contracts/working-set scenarios (replay is live)", () => {
	it("replayTrace and runAutoCompact evict the same refs on the frozen fixture", async () => {
		const loaded = await loadClioTraces([FIXTURE], { filter: false });
		const trace = loaded.traces[0];
		ok(trace, `the frozen fixture must load from ${FIXTURE}`);
		strictEqual(trace.id, "context-replay-fixture-01");

		const replayed = replayTrace(trace, ageHorizonPolicy, {
			policyId: ageHorizonPolicy.id,
			budgetTokens: REPLAY_BUDGET_TOKENS,
			threshold: THRESHOLD,
			target: DEFAULT_WORKING_SET_SETTINGS.target,
			settings: DEFAULT_WORKING_SET_SETTINGS,
			seed: 1,
		});
		const first = replayed.events[0];
		ok(first, "the fixture must cross the budget at least once");
		const replayRefs = first.items.map((item) => item.ref.entry).sort();
		ok(replayRefs.length > 0, "the first replay event evicted something");

		// The exact prefix the runner stood on when it made that decision.
		const prefix = entriesBeforeTurn(trace.entries, first.turnIndex);
		ok(prefix.every(isMessage), "the fixture is all message entries, so it seeds through session.append");

		const harness = await createScenarioHarness({
			prefix: "clio-ws-replay-parity-",
			// Sized so the live pressure check fires over the same prefix. The
			// number differs from the replay budget on purpose: the two estimators
			// measure different things, and the selection must not care.
			contextWindow: 8_000,
			threshold: THRESHOLD,
			policy: "age-horizon",
		});
		try {
			let parentId: string | null = null;
			for (const entry of prefix) {
				if (!isMessage(entry)) continue;
				parentId = harness.session.append({
					id: entry.turnId,
					parentId,
					at: entry.timestamp,
					kind: entry.role,
					payload: entry.payload,
				}).id;
			}
			ok(parentId !== null, "the prefix seeded at least one turn");
			harness.syncRuntimeFromLedger(parentId);

			await harness.context.runAutoCompact(harness.runtime, false);

			const live = evictionEntries(harness.entries())[0];
			ok(live, "the live stage must also evict over this prefix");
			strictEqual(live.policyId, ageHorizonPolicy.id);
			const liveRefs = live.evicted.map((item) => item.ref.entry).sort();

			deepStrictEqual(liveRefs, replayRefs, "replay and live must select the same units over the same ledger");
			// The markers are byte-stable, so the two runs also agree on what the
			// model would have read in place of each body.
			for (const item of first.items) {
				const paired: EvictedItem | undefined = live.evicted.find((candidate) => candidate.ref.entry === item.ref.entry);
				strictEqual(paired?.marker, item.marker, `marker drift for ${item.ref.entry}`);
				strictEqual(paired?.reason, item.reason, `reason drift for ${item.ref.entry}`);
			}
		} finally {
			await harness.dispose();
		}
	});
});
