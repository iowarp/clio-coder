import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Value } from "typebox/value";
import { MemoryObservationRecordedSchema } from "../../src/core/telemetry/schemas.js";
import type { MemoryPromptSelection } from "../../src/domains/memory/contract.js";
import {
	createMemoryPromptReader,
	type MemoryPromptRequest,
	memorySelectionFacts,
} from "../../src/domains/memory/prompt-cache.js";
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
	const save = (records: MemoryRecord[]) => writeFileSync(path, JSON.stringify({ version: 2, records }));
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
	writeFileSync(`${f.path}.next`, JSON.stringify({ version: 2, records: [record("Keep modified evidence.")] }));
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

test("gated queries can change at the next turn, with a distinct legacy default", (t) => {
	const f = fixture(t);
	f.save([
		record("Compaction receipts persist.", { id: "mem-0000000000000001" }),
		record("Formatting preserves indentation.", { id: "mem-0000000000000002", createdAt: "2026-09-22T00:00:00.000Z" }),
	]);
	const legacy = createMemoryPromptReader({ getDataDir: () => f.root, selection: { maxItems: 1 } });
	const gated = createMemoryPromptReader({ getDataDir: () => f.root, selection: { maxItems: 1 }, relevanceGate: {} });
	const first = { ...f.request, taskText: "compaction receipts" };
	ok(legacy(first).includes("Formatting"));
	ok(gated(first).includes("Compaction"));
	ok(gated({ ...first, taskText: "formatting indentation" }).includes("Compaction"));
	ok(gated({ ...first, turnId: "2", taskText: "formatting indentation" }).includes("Formatting"));
});

// CLI-P53: a repository lesson whose claim is a check rides every gated turn, inside the caps, and the journal says why.
test("a repository check lesson reaches an unrelated gated turn inside the caps, and the selection journal names why", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, ".clio-coder"));
	mkdirSync(join(f.root, "scripts"));
	writeFileSync(join(f.root, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
	writeFileSync(
		join(f.root, ".clio-coder", "verifiers.yaml"),
		JSON.stringify({
			version: 2,
			checks: [
				{
					id: "quick",
					description: "Quick checks",
					command: ["./scripts/check.sh", "--quick"],
					cwd: ".",
					timeoutMs: 5_000,
					tags: [],
				},
			],
		}),
	);
	const lesson = (id: string, text: string, argv: string[]) =>
		record(text, {
			id,
			scope: "repo",
			repository: { kind: "canonical-path", key: f.root },
			evidenceRefs: [`command:${id.slice(-1).repeat(64)}`],
			claim: { kind: "command", command: { assignments: [], argv, key: id.slice(-1).repeat(64) } },
		});
	f.save([
		lesson("mem-000000000000000a", "Validate with make test before handing back.", ["make", "test"]),
		lesson("mem-000000000000000b", "The quick suite is the real gate here.", ["./scripts/check.sh", "--quick"]),
		lesson("mem-000000000000000c", "Releases go out through the release script.", ["./scripts/release.sh"]),
	]);
	const seen: MemoryPromptSelection[] = [];
	const read = (maxItems: number) =>
		createMemoryPromptReader({
			getDataDir: () => f.root,
			selection: { maxItems },
			relevanceGate: {},
			onSelection: (selection) => seen.push(selection),
		});
	const turn = {
		...f.request,
		taskText: "Add a triple(x) function to util.py next to double, then run the project checks.",
	};
	const section = read(5)(turn);
	ok(section.includes("make test") && section.includes("quick suite"), section);
	ok(!section.includes("release script"), "a lesson about a command that is no check stays gated");
	const rows = (at: number) => {
		const selection = seen[at];
		if (selection === undefined) throw new Error("no selection");
		const facts = memorySelectionFacts(selection);
		ok(Value.Check(MemoryObservationRecordedSchema, { event: "memory-section-selected", facts }), JSON.stringify(facts));
		return [...(facts.selection as Array<{ id: string; reason: string }>)].sort((a, b) => a.id.localeCompare(b.id));
	};
	deepStrictEqual(rows(0), [
		{ id: "mem-000000000000000a", decision: "selected", reason: "check-command" },
		{ id: "mem-000000000000000b", decision: "selected", reason: "check-command" },
		{ id: "mem-000000000000000c", decision: "withheld", reason: "not-relevant" },
	]);
	// The caps are the caps: one item admits one check lesson and names the other's withholding.
	read(1)(turn);
	deepStrictEqual(
		rows(1)
			.map((row) => row.reason)
			.sort(),
		["check-command", "item-limit", "not-relevant"],
	);
});

test("bounded snapshot reads refuse oversized storage and validate rather than trusting a revision", (t) => {
	const f = fixture(t);
	f.save([record()]);
	deepStrictEqual(readMemoryStoreSnapshot(f.root).records, [record()]);
	truncateSync(f.path, MEMORY_PROMPT_STORE_MAX_BYTES + 1);
	throws(() => readMemoryStoreSnapshot(f.root), /read ceiling/);
	strictEqual(createMemoryPromptReader({ getDataDir: () => f.root })(f.request), "");
});
