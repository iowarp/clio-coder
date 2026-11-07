import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type MemoryFlowSweepPorts, sweepRestrictedMemory } from "../../src/domains/memory/flow-sweep.js";
import { approveMemoryRecord } from "../../src/domains/memory/operations.js";
import { memoryRecordFromPromotion } from "../../src/domains/memory/promotion.js";
import { loadMemoryRecordsSync, memoryStorePath } from "../../src/domains/memory/store.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

const LABEL_AT = "2026-06-02T00:00:00.000Z";
const BEFORE = "2026-06-01T00:00:00.000Z";
const AFTER = "2026-06-03T00:00:00.000Z";

const scratchRoot = mkdtempSync(join(tmpdir(), "memory-flow-sweep-repos-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));
const CLEAN_REPO = realpathSync(mkdtempSync(join(scratchRoot, "clean-")));
const RULED_REPO = realpathSync(mkdtempSync(join(scratchRoot, "ruled-")));

/** A record shaped the way filing writes one, named here so an assertion can say which case it reads. */
const names = new Map<string, string>();
function record(name: string, fields: Partial<MemoryRecord> & { source?: string; repo?: string }): MemoryRecord {
	const { source, repo = CLEAN_REPO, ...rest } = fields;
	const filed = memoryRecordFromPromotion(
		{
			kind: "task-bank-entry",
			sessionId: source ?? "unrecorded",
			evidenceRefs: ["session:any"],
			entry: {
				id: `k-${name}`,
				kind: "knowledge",
				content: `Lesson ${name}.`,
				createdAt: BEFORE,
				lastTouchedAt: BEFORE,
				injectionCount: 0,
			},
		},
		{ scope: "repo", repository: { kind: "canonical-path", key: repo } },
		new Date(AFTER),
	);
	names.set(filed.id, name);
	const shaped: MemoryRecord = { ...filed, approved: true, ...rest };
	if (source === undefined) Reflect.deleteProperty(shaped, "provenance");
	return shaped;
}
const named = (ids: ReadonlyArray<string> | null | undefined) => (ids ?? []).map((id) => names.get(id)).sort();

const ports: MemoryFlowSweepPorts = {
	sessionFirstLabelAt: (sessionId) => {
		if (sessionId === "labeled") return LABEL_AT;
		if (sessionId === "clean") return null;
		throw new Error("session not found");
	},
	repositoryDeclaresFlowRules: (path) => path === RULED_REPO,
};

function home(records: MemoryRecord[] | string) {
	const root = mkdtempSync(join(tmpdir(), "memory-flow-sweep-"));
	const dataDir = join(root, "data");
	const stateDir = join(root, "state");
	mkdirSync(join(dataDir, "memory"), { recursive: true });
	writeFileSync(
		memoryStorePath(dataDir),
		typeof records === "string" ? records : JSON.stringify({ version: 1, records }),
	);
	return { root, dataDir, stateDir };
}

test("the sweep rejects what its source's label or the project's rules say, and keeps the rest", async () => {
	const h = home([
		record("after-label", { source: "labeled" }),
		record("at-label", { source: "labeled", createdAt: LABEL_AT }),
		record("before-label", { source: "labeled", createdAt: BEFORE }),
		record("clean-source", { source: "clean" }),
		record("proposed-after-label", { source: "labeled", approved: false }),
		record("missing-no-rules", { source: "gone" }),
		record("missing-under-rules", { source: "gone", repo: RULED_REPO }),
		record("unrecorded-no-rules", {}),
		record("unrecorded-under-rules", { repo: RULED_REPO }),
		record("already-rejected", { source: "labeled", approved: false, rejectedAt: BEFORE }),
	]);
	try {
		const rejected = await sweepRestrictedMemory(h.dataDir, h.stateDir, ports);
		deepStrictEqual(named(rejected), [
			"after-label",
			"at-label",
			"missing-under-rules",
			"proposed-after-label",
			"unrecorded-under-rules",
		]);
		const kept = new Map(loadMemoryRecordsSync(h.dataDir).map((item) => [names.get(item.id), item]));
		strictEqual(kept.size, 10, "every record stays on disk");
		strictEqual(kept.get("after-label")?.approved, false);
		ok(kept.get("after-label")?.rejectedAt);
		strictEqual(kept.get("before-label")?.approved, true);
		strictEqual(kept.get("clean-source")?.approved, true);
		strictEqual(kept.get("missing-no-rules")?.approved, true);
		strictEqual(kept.get("already-rejected")?.rejectedAt, BEFORE);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test("a finished sweep never runs again, so an operator's restore stands", async () => {
	const h = home([record("after-label", { source: "labeled" })]);
	try {
		const [id] = (await sweepRestrictedMemory(h.dataDir, h.stateDir, ports)) ?? [];
		strictEqual(names.get(id ?? ""), "after-label");
		await approveMemoryRecord(h.dataDir, id ?? "");
		strictEqual(await sweepRestrictedMemory(h.dataDir, h.stateDir, ports), null);
		const [restored] = loadMemoryRecordsSync(h.dataDir);
		strictEqual(restored?.approved, true);
		strictEqual(restored?.rejectedAt, undefined);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test("an unreadable store leaves no marker and the next boot finishes the work", async () => {
	const h = home("{ not json");
	try {
		await rejects(sweepRestrictedMemory(h.dataDir, h.stateDir, ports));
		strictEqual(existsSync(join(h.stateDir, "memory", "flow-sweep-v1.json")), false);
		writeFileSync(
			memoryStorePath(h.dataDir),
			JSON.stringify({ version: 1, records: [record("after-label", { source: "labeled" })] }),
		);
		deepStrictEqual(named(await sweepRestrictedMemory(h.dataDir, h.stateDir, ports)), ["after-label"]);
		strictEqual(existsSync(join(h.stateDir, "memory", "flow-sweep-v1.json")), true);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test("an empty or missing store finishes with nothing rejected", async () => {
	const h = home([]);
	try {
		rmSync(memoryStorePath(h.dataDir));
		deepStrictEqual(await sweepRestrictedMemory(h.dataDir, h.stateDir, ports), []);
		strictEqual(await sweepRestrictedMemory(h.dataDir, h.stateDir, ports), null);
		strictEqual(existsSync(memoryStorePath(h.dataDir)), false, "the sweep creates no store");
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

// Last in the file: entering read-only mode for good is one-way per process.
test("a read-only process withholds the restricted lessons from itself and writes neither store nor marker", async () => {
	const h = home([record("after-label", { source: "labeled" }), record("clean-source", { source: "clean" })]);
	try {
		const { enterReadOnlyMode } = await import("../../src/core/read-only-mode.js");
		const { readMemoryStoreSnapshot } = await import("../../src/domains/memory/store.js");
		const onDisk = readFileSync(memoryStorePath(h.dataDir), "utf8");
		enterReadOnlyMode();
		deepStrictEqual(await sweepRestrictedMemory(h.dataDir, h.stateDir, ports), []);
		strictEqual(readFileSync(memoryStorePath(h.dataDir), "utf8"), onDisk, "the store is not rewritten");
		strictEqual(existsSync(join(h.stateDir, "memory")), false, "no marker, so a writable boot still records the sweep");
		for (const records of [loadMemoryRecordsSync(h.dataDir), readMemoryStoreSnapshot(h.dataDir).records]) {
			const seen = new Map(records.map((item) => [names.get(item.id), item]));
			strictEqual(seen.get("after-label")?.approved, false);
			ok(seen.get("after-label")?.rejectedAt);
			strictEqual(seen.get("clean-source")?.approved, true);
		}
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});
