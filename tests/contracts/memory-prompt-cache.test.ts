import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createMemoryPromptReader, type MemoryPromptRequest } from "../../src/domains/memory/prompt-cache.js";
import {
	MEMORY_PROMPT_STORE_MAX_BYTES,
	memoryStorePath,
	readMemoryStoreSnapshot,
} from "../../src/domains/memory/store.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

function record(lesson = "Keep original evidence.", patch: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id: "mem-0000000000000001",
		scope: "global",
		key: "lesson",
		lesson,
		evidenceRefs: ["run:synthetic"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-09-21T00:00:00.000Z",
		approved: true,
		...patch,
	};
}

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-memory-cache-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "memory"));
	const path = memoryStorePath(root);
	const save = (records: MemoryRecord[]) => writeFileSync(path, JSON.stringify({ version: 1, records }));
	const request: MemoryPromptRequest = {
		turnId: "1",
		sessionAuthority: "session-a:0",
		cwd: root,
		targetId: "target",
		runtimeId: "runtime",
		modelId: "model",
		taskText: "evidence",
		activePaths: [],
	};
	return { root, path, save, request };
}

test("same-size atomic external replacement is invisible within the turn and visible at its next boundary", (t) => {
	const f = fixture(t);
	f.save([record("Keep original evidence.")]);
	let reads = 0;
	const read = createMemoryPromptReader({
		getDataDir: () => f.root,
		readStore: (root) => {
			reads++;
			return readMemoryStoreSnapshot(root);
		},
	});
	const first = read(f.request);
	const originalRevision = readMemoryStoreSnapshot(f.root).revision;
	const originalStat = statSync(f.path);
	writeFileSync(`${f.path}.next`, JSON.stringify({ version: 1, records: [record("Keep modified evidence.")] }));
	renameSync(`${f.path}.next`, f.path);
	utimesSync(f.path, originalStat.atime, originalStat.mtime);
	strictEqual(statSync(f.path).size, originalStat.size);
	notStrictEqual(readMemoryStoreSnapshot(f.root).revision, originalRevision);
	strictEqual(read({ ...f.request, taskText: "tool loop rebuilt prompt", activePaths: ["later.ts"] }), first);
	strictEqual(reads, 1);
	const next = read({ ...f.request, turnId: "2" });
	ok(next.includes("modified evidence"));
	strictEqual(reads, 2);
	strictEqual(read({ ...f.request, turnId: "3" }), next);
	strictEqual(reads, 3, "even unchanged content must be reread at a new turn");
});

for (const invalidation of ["removed", "approval-reversed", "invalid-json", "invalid-schema"] as const) {
	test(`a new turn after ${invalidation} never retains formerly approved content`, (t) => {
		const f = fixture(t);
		f.save([record()]);
		const read = createMemoryPromptReader({ getDataDir: () => f.root });
		ok(read(f.request).includes("original evidence"));
		if (invalidation === "removed") rmSync(f.path);
		else if (invalidation === "approval-reversed") f.save([record(undefined, { approved: false })]);
		else writeFileSync(f.path, invalidation === "invalid-json" ? "{" : '{"version":99,"records":[]}');
		strictEqual(read({ ...f.request, turnId: "2" }), "");
		f.save([record("Restored valid evidence.")]);
		strictEqual(read({ ...f.request, turnId: "2" }), "", "recovery must not alter this admitted snapshot");
		ok(read({ ...f.request, turnId: "3" }).includes("Restored valid evidence"));
	});
}

test("authority changes invalidate immediately even when the turn ID is unchanged", (t) => {
	const f = fixture(t);
	f.save([record("Runtime-specific evidence.", { scope: "runtime", runtime: { kind: "runtime", key: "runtime" } })]);
	const read = createMemoryPromptReader({ getDataDir: () => f.root });
	ok(read(f.request).includes("Runtime-specific"));
	strictEqual(read({ ...f.request, runtimeId: "different" }), "");
	f.save([record("Repo-specific evidence.", { scope: "repo", repository: { kind: "canonical-path", key: f.root } })]);
	ok(read({ ...f.request, sessionAuthority: "session-b:0" }).includes("Repo-specific"));
	strictEqual(read({ ...f.request, sessionAuthority: "session-b:0", cwd: join(f.root, "other") }), "");
	f.save([record("After model switch.")]);
	ok(read({ ...f.request, modelId: "different" }).includes("After model switch"));
	f.save([record("After branch switch.")]);
	ok(read({ ...f.request, sessionAuthority: "session-a:1" }).includes("After branch switch"));
});

test("prewarm reads cannot freeze the next attempt and mutable caller options cannot widen scope", (t) => {
	const f = fixture(t);
	f.save([record()]);
	const scopes: Array<MemoryRecord["scope"]> = ["global"];
	const read = createMemoryPromptReader({ getDataDir: () => f.root, selection: { scopes } });
	ok(read({ ...f.request, turnId: null }).includes("original evidence"));
	f.save([record("Changed before submit.")]);
	ok(read(f.request).includes("Changed before submit"));
	scopes.push("runtime");
	f.save([record("Not admitted.", { scope: "runtime", runtime: { kind: "runtime", key: "runtime" } })]);
	strictEqual(read({ ...f.request, turnId: "2" }), "");
});

test("explicit experimental queries can change at the next turn, with a distinct legacy default", (t) => {
	const f = fixture(t);
	f.save([
		record("Compaction receipts persist.", { id: "mem-0000000000000001" }),
		record("Formatting preserves indentation.", { id: "mem-0000000000000002", createdAt: "2026-09-22T00:00:00.000Z" }),
	]);
	const legacy = createMemoryPromptReader({ getDataDir: () => f.root, selection: { maxItems: 1 } });
	const experimental = createMemoryPromptReader({
		getDataDir: () => f.root,
		selection: { maxItems: 1 },
		experimentalRelevance: true,
	});
	const first = { ...f.request, taskText: "compaction" };
	ok(legacy(first).includes("Formatting"));
	ok(experimental(first).includes("Compaction"));
	ok(experimental({ ...first, taskText: "formatting" }).includes("Compaction"));
	ok(experimental({ ...first, turnId: "2", taskText: "formatting" }).includes("Formatting"));
});

test("bounded snapshot reads refuse oversized storage and validate rather than trusting a revision", (t) => {
	const f = fixture(t);
	f.save([record()]);
	deepStrictEqual(readMemoryStoreSnapshot(f.root).records, [record()]);
	truncateSync(f.path, MEMORY_PROMPT_STORE_MAX_BYTES + 1);
	throws(() => readMemoryStoreSnapshot(f.root), /read ceiling/);
	strictEqual(createMemoryPromptReader({ getDataDir: () => f.root })(f.request), "");
});
