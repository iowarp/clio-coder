import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import type { ContextFoldPayload } from "../../src/core/telemetry/live-events.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { supersededStageApplies } from "../../src/domains/context/index.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { resolveRecall } from "../../src/domains/context/working-set/recall.js";
import type { ContextEvictionEntry, SessionEntry } from "../../src/domains/session/entries.js";
import {
	OBSERVATION_AGING_CUSTOM_TYPE,
	observationAgingRecord,
	observationAgingStub,
} from "../../src/session-control/observation-aging.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { type CaptureServer, chatHarness, startCaptureServer, wireElements } from "../harness/context-capture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("observation-aging-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

const RECORD = `record body\n${"r".repeat(40_000 - 12)}`;
const SMALL = `small body\n${"s".repeat(12_000)}`;

/** A `read` that returns the record for `record.md` and a small body for anything else. */
const reader: ToolSpec = {
	name: ToolNames.Read,
	description: "Returns a fixed body for a path",
	parameters: Type.Object({ path: Type.String() }),
	baseActionClass: "read",
	run: async (input) => ({
		kind: "ok",
		output: (input as { path?: string }).path === "record.md" ? RECORD : SMALL,
	}),
};

/** Reads each path in turn, one call per request, then answers. */
async function readsServer(paths: ReadonlyArray<string>): Promise<CaptureServer> {
	return startCaptureServer((_request, index) =>
		index < paths.length
			? { calls: [{ id: `c${index + 1}`, name: ToolNames.Read, arguments: { path: paths[index] } }] }
			: { text: "done" },
	);
}

const AT = "2026-09-21T09:00:00.000Z";
const RECORD_TOOL = "extension_wtfp__read_record";
/** A desk read declared read-only: the loop guard reads its repeat as a read, and S1's rungs know no op for it. */
const recordTool: ToolSpec = {
	name: RECORD_TOOL as ToolSpec["name"],
	description: "Reads a desk record",
	parameters: Type.Object({ id: Type.String() }),
	baseActionClass: "read",
	metadata: {
		objective: "read a record",
		uiLabel: "wtfp/read_record",
		readOnly: true,
		resultSizePolicy: { kind: "bounded", maxBytes: 256 * 1024 },
	},
	run: async () => ({ kind: "ok", output: RECORD }),
};
function row(
	turnId: string,
	parentTurnId: string | null,
	role: "user" | "assistant" | "tool_result",
	payload: unknown,
) {
	return { kind: "message", turnId, parentTurnId, timestamp: AT, role, payload } as SessionEntry;
}
function callRow(turnId: string, parentTurnId: string, id: string, name: string, args: Record<string, unknown>) {
	return row(turnId, parentTurnId, "assistant", {
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
	});
}
function resultRow(turnId: string, parentTurnId: string, id: string, name: string, text: string) {
	return row(turnId, parentTurnId, "tool_result", {
		toolCallId: id,
		toolName: name,
		result: { content: [{ type: "text", text }] },
	});
}
/** An earlier turn: two identical file reads S1's rungs select, then two identical record reads S0 qualifies. */
function seeded(): SessionEntry[] {
	return [
		row("u1", null, "user", { text: "read everything twice" }),
		callRow("a1", "u1", "c1", ToolNames.Read, { path: "src/big.ts" }),
		resultRow("r1", "a1", "c1", ToolNames.Read, RECORD),
		callRow("a2", "r1", "c2", ToolNames.Read, { path: "src/big.ts" }),
		resultRow("r2", "a2", "c2", ToolNames.Read, RECORD),
		callRow("a3", "r2", "x1", RECORD_TOOL, { id: "intro" }),
		resultRow("r3", "a3", "x1", RECORD_TOOL, RECORD),
		callRow("a4", "r3", "x2", RECORD_TOOL, { id: "intro" }),
		resultRow("r4", "a4", "x2", RECORD_TOOL, RECORD),
		row("a5", "r4", "assistant", { content: [{ type: "text", text: "read" }] }),
	];
}

const evictions = (entries: ReadonlyArray<SessionEntry>): ContextEvictionEntry[] =>
	entries.filter((entry): entry is ContextEvictionEntry => entry.kind === "contextEviction");
const results = (elements: string[]): string[] => elements.filter((element) => element.startsWith("result:"));
const noticeTexts = (events: ReadonlyArray<{ type: string }>): string[] =>
	events.flatMap((event) => (event.type === "notice" ? [String((event as { text?: unknown }).text)] : []));

/** A harness that keeps every `context.fold` and `context.pruned` it publishes. */
function observed(harness: ReturnType<typeof chatHarness>) {
	const folds: ContextFoldPayload[] = [];
	const pruned: Array<{ stage: string; tokensBefore: number; tokensAfter: number }> = [];
	harness.context.bus.subscribe("context.fold", (event) => {
		folds.push(event as ContextFoldPayload);
	});
	harness.context.bus.subscribe("context.pruned", (event) => {
		pruned.push(event as (typeof pruned)[number]);
	});
	return { folds, pruned };
}

it("the S0 gate admits uncached routes only, every tier alike (bt-47 cf1j-a)", () => {
	const table: ReadonlyArray<[Parameters<typeof supersededStageApplies>[0], boolean]> = [
		[{ modelTier: "small", promptCaching: true }, false],
		[{ modelTier: "small", promptCaching: false }, true],
		[{ modelTier: "standard", promptCaching: false }, true],
		[{ modelTier: "standard", promptCaching: true }, false],
		[{ modelTier: "frontier", promptCaching: false }, true],
		[{ modelTier: "frontier", promptCaching: true }, false],
		[{ modelTier: "standard" }, false],
	];
	for (const [route, admits] of table) strictEqual(supersededStageApplies(route), admits, JSON.stringify(route));
});

for (const [label, route, superseded] of [
	["a small cached route", { tier: "small", caching: true }, false],
	["a standard cached route", { tier: "standard", caching: true }, false],
	["an uncached route", { caching: false }, true],
] as const) {
	it(`${label} with a viable S1 batch and qualifying identical reads ${superseded ? "commits" : "holds no"} superseded item`, {
		timeout: 30_000,
	}, async (t) => {
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		const options = { server, route: { ...route, window: 50_000 }, tools: [recordTool], autoCompact: true };
		const seed = chatHarness(options);
		let id: string;
		try {
			id = seed.session.create({ cwd: process.cwd() }).id;
			for (const entry of seeded()) seed.session.appendEntry(entry as never);
		} finally {
			await seed.close();
		}
		const harness = chatHarness(options);
		harness.settings.context.workingSet.protectLastTurns = 1;
		harness.settings.context.workingSet.protectLastSteps = 1;
		const { folds } = observed(harness);
		try {
			harness.reopen(id);
			await harness.submit("go on");
			const records = evictions(harness.session.readEntries() as SessionEntry[]);
			ok(records.length > 0, "a record committed");
			const items = records.flatMap((record) => record.evicted);
			// Items, not triggers: r3 is the record read only S0 selects; S1's rungs know no op for the desk tool.
			const s0 = items.filter((item) => item.ref.entry === "r3");
			if (superseded) {
				deepStrictEqual(
					s0.map((item) => [item.reason, item.by]),
					[["superseded_call", "r4"]],
				);
			} else {
				deepStrictEqual(s0, []);
				deepStrictEqual(
					items.filter((item) => item.reason === "superseded_call"),
					[],
				);
				deepStrictEqual(
					items.map((item) => [item.ref.entry, item.reason]),
					[["r1", "superseded_read"]],
					"S1 committed its own batch",
				);
			}
			for (const record of records)
				ok(
					folds.some((fold) => fold.stages.some((stage) => stage.recordId === record.turnId)),
					"every commit has a context.fold stage entry",
				);
		} finally {
			await harness.close();
		}
	});
}

it("an uncached route commits a superseded read between tool batches; the ledger keeps the body and recall answers it", {
	timeout: 30_000,
}, async (t) => {
	const server = await readsServer(["record.md", "record.md"]);
	t.after(() => server.close());
	const harness = chatHarness({ server, route: { caching: false }, tools: [reader] });
	const { folds, pruned } = observed(harness);
	try {
		await harness.submit("Read the record twice.");
		strictEqual(server.requests.length, 3);
		deepStrictEqual(results(wireElements(server.requests[1] as never)), [`result:${RECORD}`]);
		const [marker, fresh] = results(wireElements(server.requests[2] as never));
		ok(marker?.startsWith("result:[evicted ref=r1 reason=superseded_call by="), marker?.slice(0, 120));
		strictEqual(fresh, `result:${RECORD}`, "the fresh copy reaches the model");
		const entries = harness.session.readEntries() as SessionEntry[];
		const [record, ...rest] = evictions(entries);
		ok(record);
		deepStrictEqual(rest, []);
		strictEqual(record.policyId, "superseded-v1");
		strictEqual(record.route?.promptCaching, false, "the record names the uncached route it was cut on");
		strictEqual(JSON.stringify(entries).split(JSON.stringify(RECORD)).length - 1, 2, "the ledger keeps both bodies");
		const fold = folds.find((candidate) => candidate.stages.some((stage) => stage.recordId === record.turnId));
		ok(fold);
		strictEqual(fold.cause, "observation_aging");
		deepStrictEqual(fold.stages, [
			{ stage: "superseded", outcome: "committed", reason: "evicted", recordId: record.turnId },
		]);
		const [s0Pruned] = pruned.filter((event) => event.stage === "superseded");
		ok(s0Pruned);
		deepStrictEqual(
			[fold.tokensBefore, fold.tokensAfter],
			[s0Pruned.tokensBefore, s0Pruned.tokensAfter],
			"the fold states the record's own figures",
		);
		deepStrictEqual([record.tokensBefore, record.tokensAfter], [s0Pruned.tokensBefore, s0Pruned.tokensAfter]);
		ok(noticeTexts(harness.events).some((text) => text.startsWith("[context engine] superseded: 1 result")));
		const recalled = resolveRecall(entries, foldWorkingSet(entries), "r1");
		ok(recalled.ok, JSON.stringify(recalled));
		strictEqual(recalled.result.body, RECORD);
	} finally {
		await harness.close();
	}
});

it("a superseded set below the floor commits nothing, and the checkpoint records the hold", {
	timeout: 30_000,
}, async (t) => {
	const server = await readsServer(["small.md", "small.md"]);
	t.after(() => server.close());
	const harness = chatHarness({ server, route: { caching: false }, tools: [reader] });
	const { folds } = observed(harness);
	try {
		await harness.submit("Read the small file twice.");
		deepStrictEqual(evictions(harness.session.readEntries() as SessionEntry[]), []);
		deepStrictEqual(results(wireElements(server.requests[2] as never)), [`result:${SMALL}`, `result:${SMALL}`]);
		const hold = folds.find((fold) =>
			fold.stages.some(
				(stage) => stage.stage === "superseded" && stage.outcome === "held" && stage.reason === "below_floor",
			),
		);
		ok(hold, JSON.stringify(folds));
		ok(hold.tokensBefore > 0, "the hold states the context it measured");
		strictEqual(hold.tokensAfter, hold.tokensBefore, "a hold changes nothing");
	} finally {
		await harness.close();
	}
});

/** A v6 ledger: two identical record reads, and the aging row that stubbed the first in the outgoing request. */
function agedV6(): SessionEntry[] {
	return [
		row("u1", null, "user", { text: "read the record twice" }),
		callRow("a1", "u1", "c1", ToolNames.Read, { path: "record.md" }),
		resultRow("r1", "a1", "c1", ToolNames.Read, RECORD),
		callRow("a2", "r1", "c2", ToolNames.Read, { path: "record.md" }),
		resultRow("r2", "a2", "c2", ToolNames.Read, RECORD),
		{
			kind: "custom",
			turnId: "g1",
			parentTurnId: "r2",
			timestamp: AT,
			customType: OBSERVATION_AGING_CUSTOM_TYPE,
			data: observationAgingRecord(["c1"]),
			display: false,
		} as SessionEntry,
		row("a3", "g1", "assistant", { content: [{ type: "text", text: "read" }] }),
	];
}

async function seededV6(server: CaptureServer): Promise<string> {
	const seed = chatHarness({ server, route: { caching: false } });
	try {
		const id = seed.session.create({ cwd: process.cwd() }).id;
		for (const entry of agedV6()) seed.session.appendEntry(entry as never);
		return id;
	} finally {
		await seed.close();
	}
}

it("a v6 session on an uncached route adopts its aging stubs once, as one record whose markers are the stubs (§1.5)", {
	timeout: 30_000,
}, async (t) => {
	const server = await startCaptureServer(() => ({ text: "answered" }));
	t.after(() => server.close());
	const id = await seededV6(server);
	const stub = observationAgingStub(ToolNames.Read, { path: "record.md" }, Buffer.byteLength(RECORD, "utf8"));

	const harness = chatHarness({ server, route: { caching: false } });
	const { folds } = observed(harness);
	try {
		harness.reopen(id);
		await harness.submit("go on");
		deepStrictEqual(results(wireElements(server.requests.at(-1) as never)), [`result:${stub}`, `result:${RECORD}`]);
		const entries = harness.session.readEntries() as SessionEntry[];
		const [record, ...rest] = evictions(entries);
		ok(record);
		deepStrictEqual(rest, [], "the adoption is the only record; S0 finds nothing further");
		strictEqual(record.policyId, "superseded-legacy-v6");
		deepStrictEqual(
			record.evicted.map((item) => [item.ref.entry, item.reason, item.by, item.marker]),
			[["r1", "superseded_call", "r2", stub]],
		);
		const adopted = folds.find((fold) => fold.legacy !== undefined);
		ok(adopted);
		deepStrictEqual(adopted.legacy, { outcome: "adopted", results: 1, earliest: "r1", priorState: "unknown" });
		deepStrictEqual(adopted.stages[0], {
			stage: "superseded",
			outcome: "committed",
			reason: "adopted",
			recordId: record.turnId,
		});
		const alias = record.evicted[0]?.alias;
		ok(alias);
		const recalled = resolveRecall(entries, foldWorkingSet(entries), alias);
		ok(recalled.ok, JSON.stringify(recalled));
		strictEqual(recalled.result.body, RECORD);
	} finally {
		await harness.close();
	}

	const again = chatHarness({ server, route: { caching: false } });
	const later = observed(again);
	try {
		again.reopen(id);
		await again.submit("and again");
		strictEqual(evictions(again.session.readEntries() as SessionEntry[]).length, 1, "a second open adopts nothing");
		ok(later.folds.every((fold) => fold.legacy === undefined));
		deepStrictEqual(results(wireElements(server.requests.at(-1) as never)), [`result:${stub}`, `result:${RECORD}`]);
	} finally {
		await again.close();
	}
});

it("a v6 session on a cached route releases its aging stubs and writes no record (§1.5)", {
	timeout: 30_000,
}, async (t) => {
	const server = await startCaptureServer(() => ({ text: "answered" }));
	t.after(() => server.close());
	const id = await seededV6(server);
	const harness = chatHarness({ server, route: { caching: true } });
	const { folds } = observed(harness);
	try {
		harness.reopen(id);
		await harness.submit("go on");
		deepStrictEqual(evictions(harness.session.readEntries() as SessionEntry[]), []);
		deepStrictEqual(results(wireElements(server.requests.at(-1) as never)), [`result:${RECORD}`, `result:${RECORD}`]);
		const released = folds.find((fold) => fold.legacy !== undefined);
		ok(released, JSON.stringify(folds));
		deepStrictEqual(released.legacy, { outcome: "legacy_aging_released", results: 1, priorState: "unknown" });
	} finally {
		await harness.close();
	}
});
