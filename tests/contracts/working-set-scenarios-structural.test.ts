/**
 * Charter scenarios S3, S4, and S5 end to end, under `structural-v1`.
 *
 * The policy unit tests build `PolicyInput` by hand. These drive the same
 * rules through the real stage: a scripted session on disk, the session cwd
 * reaching the path index the way `runAutoCompact` passes it, and the reasons
 * and `by` refs read back off the `contextEviction` record the session wrote.
 * That is the part a pure test cannot cover, because the path index keys files
 * by absolute path and the cwd only arrives from `session.current()`.
 */

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvictedItem } from "../../src/domains/session/entries.js";
import {
	createScenarioHarness,
	evictionEntries,
	type ScenarioHarness,
	type ScenarioToolCall,
	type ScenarioTurn,
	scenarioBody,
	seedScenarioTurns,
} from "../harness/working-set-session.js";

/** The twelve files the `find` at turn 6 surfaces. */
const SURFACED = Array.from(
	{ length: 12 },
	(_, index) => `src/generated/module-${String(index + 1).padStart(2, "0")}.ts`,
);

/**
 * A `find` result as the tool prints it: one path per line, plus the directory
 * rows a real listing includes. The directories are what carries the body past
 * `minEvictableTokens`; the path index skips any line ending in `/`, so only
 * the twelve files count as surfaced and only they have to be read for the
 * listing to be consumed.
 */
function findBody(): string {
	const directories = Array.from(
		{ length: 40 },
		(_, index) => `src/generated/bucket-${String(index + 1).padStart(2, "0")}/`,
	);
	return [...directories, ...SURFACED].join("\n");
}

function read(callId: string, path: string, label: string): ScenarioToolCall[] {
	return [{ callId, tool: "read", args: { path }, body: scenarioBody(label, 30) }];
}

/**
 * The scripted session the three rules read:
 *   turn 3  reads a.ts, turn 20 reads it again in full  -> superseded_read
 *   turn 4  reads b.ts, turn 5 edits b.ts               -> stale_after_mutation
 *   turn 6  finds twelve paths, turns 7..18 read them   -> listing_consumed
 * Turns 21 to 28 are filler so everything above sits outside the protection
 * horizon when the policy runs.
 */
function structuralScript(): ScenarioTurn[] {
	const turns: ScenarioTurn[] = [];
	const filler = (id: string, label: string): ScenarioTurn => ({
		id,
		user: `filler ${label}`,
		calls: read(`filler-${label}`, `src/filler/${label}.ts`, `filler-${label}`),
		assistant: { text: `filler ${label} done` },
	});

	turns.push(filler("t01", "one"), filler("t02", "two"));
	turns.push({
		id: "t03",
		user: "read a.ts",
		calls: read("read-a-first", "src/a.ts", "a-v1"),
		assistant: { text: "read a" },
	});
	turns.push({
		id: "t04",
		user: "read b.ts",
		calls: read("read-b", "src/b.ts", "b-v1"),
		assistant: { text: "read b" },
	});
	turns.push({
		id: "t05",
		user: "edit b.ts",
		calls: [
			{
				callId: "edit-b",
				tool: "edit",
				args: { path: "src/b.ts", edits: [{ oldText: "before", newText: "after" }] },
				body: scenarioBody("b-edited", 8),
			},
		],
		assistant: { text: "edited b" },
	});
	turns.push({
		id: "t06",
		user: "find the generated modules",
		calls: [
			{ callId: "find-generated", tool: "find", args: { path: ".", pattern: "src/generated/*.ts" }, body: findBody() },
		],
		assistant: { text: "found twelve" },
	});
	// Five of the surfaced paths first, then the remaining seven: the listing is
	// only consumed once every path it surfaced has been read.
	SURFACED.forEach((path, index) => {
		const id = `t${String(index + 7).padStart(2, "0")}`;
		turns.push({
			id,
			user: `read ${path}`,
			calls: read(`read-generated-${index + 1}`, path, `generated-${index + 1}`),
			assistant: { text: `read ${path}` },
		});
	});
	turns.push({
		id: "t19",
		user: "unrelated step",
		calls: read("read-unrelated", "src/unrelated.ts", "unrelated"),
		assistant: { text: "unrelated done" },
	});
	turns.push({
		id: "t20",
		user: "re-read a.ts in full",
		calls: read("read-a-second", "src/a.ts", "a-v2"),
		assistant: { text: "re-read a" },
	});
	for (let index = 21; index <= 28; index += 1) {
		turns.push(filler(`t${index}`, `late-${index}`));
	}
	return turns;
}

function itemFor(items: ReadonlyArray<EvictedItem>, ref: string): EvictedItem | undefined {
	return items.find((item) => item.ref.entry === ref);
}

async function runStructuralScenario(): Promise<{ harness: ScenarioHarness; items: ReadonlyArray<EvictedItem> }> {
	const harness = await createScenarioHarness({
		prefix: "clio-ws-structural-",
		// Small enough that this scripted session crosses 0.8 and the stage
		// reaches the policy at all. Rungs 1 to 5 are unconditional once it does.
		contextWindow: 8_000,
		threshold: 0.8,
		policy: "structural-v1",
	});
	// Dispose on any failure here: the harness holds the process-wide isolated-env
	// lock, so throwing out of this function without releasing it hangs the next test.
	try {
		const seeded = seedScenarioTurns(harness.session, structuralScript());
		harness.syncRuntimeFromLedger(seeded.leafTurnId);
		await harness.context.runAutoCompact(harness.runtime, false);
		const eviction = evictionEntries(harness.entries())[0];
		if (eviction === undefined) throw new Error("the structural scenario produced no eviction event");
		strictEqual(eviction.policyId, "structural-v1");
		return { harness, items: eviction.evicted };
	} catch (error) {
		await harness.dispose();
		throw error;
	}
}

describe("contracts/working-set scenarios (S3, S4, S5 under structural-v1)", () => {
	it("S4: a read invalidated by a later edit of the same file is stale_after_mutation, by the edit", async () => {
		const { harness, items } = await runStructuralScenario();
		try {
			const item = itemFor(items, "t04-result-1");
			ok(item, `b.ts's read was not evicted; got ${items.map((i) => `${i.ref.entry}:${i.reason}`).join(" ")}`);
			strictEqual(item.reason, "stale_after_mutation");
			strictEqual(item.by, "t05-result-1", "the `by` ref names the edit that invalidated it");
			ok(item.marker.includes("reason=stale_after_mutation"), item.marker);
			ok(item.marker.includes("by=t05-result-1"), item.marker);
		} finally {
			await harness.dispose();
		}
	});

	it("S3: a read the agent repeated in full is superseded_read, by the later read", async () => {
		const { harness, items } = await runStructuralScenario();
		try {
			const item = itemFor(items, "t03-result-1");
			ok(item, `a.ts's first read was not evicted; got ${items.map((i) => `${i.ref.entry}:${i.reason}`).join(" ")}`);
			strictEqual(item.reason, "superseded_read");
			strictEqual(item.by, "t20-result-1", "the `by` ref names the read that covered it");
			// Nothing supersedes the newer copy, so rung 2 never claims it. The age
			// rung may still take it under pressure, which is a different reason and
			// a different decision.
			const superseding = itemFor(items, "t20-result-1");
			ok(
				superseding === undefined || superseding.reason === "age_horizon",
				`the superseding read must not be evicted as redundant, got ${superseding?.reason}`,
			);
		} finally {
			await harness.dispose();
		}
	});

	it("S5: a listing whose every surfaced path was read is listing_consumed, with no `by`", async () => {
		const { harness, items } = await runStructuralScenario();
		try {
			const item = itemFor(items, "t06-result-1");
			ok(item, `the find was not evicted; got ${items.map((i) => `${i.ref.entry}:${i.reason}`).join(" ")}`);
			strictEqual(item.reason, "listing_consumed");
			strictEqual(item.by, undefined, "a consumed listing names no superseding entry");
		} finally {
			await harness.dispose();
		}
	});

	it("selects the same units twice over the same ledger", async () => {
		const shape = (items: ReadonlyArray<EvictedItem>): string =>
			items.map((item) => `${item.ref.entry}:${item.reason}:${item.by ?? "-"}`).join("|");
		// One run at a time: each harness holds the process-wide isolated-env
		// lock until it disposes, so two live harnesses would deadlock.
		const shapeOf = async (): Promise<string> => {
			const run = await runStructuralScenario();
			try {
				return shape(run.items);
			} finally {
				await run.harness.dispose();
			}
		};

		strictEqual(await shapeOf(), await shapeOf(), "structural-v1 must be deterministic over one ledger");
	});
});
