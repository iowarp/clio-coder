import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createMemoryPromptReader, type MemoryPromptRequest } from "../../src/domains/memory/prompt-cache.js";
import {
	createMemoryRecallUseRegistration,
	demotedMemoryIds,
	detectMemoryUse,
	foldRecallUse,
	MEMORY_DEMOTE_AFTER_UNUSED,
	type RecallUseLedger,
	readRecallUseLedger,
} from "../../src/domains/memory/recall-use.js";
import { selectRelevantMemory } from "../../src/domains/memory/relevance.js";
import { memoryStorePath } from "../../src/domains/memory/store.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

function record(id: string, lesson: string, patch: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id,
		scope: "global",
		key: `lesson-${id}`,
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

const PNPM = record(
	"mem-00000000000000a1",
	"Install workspace dependencies with `pnpm install --frozen-lockfile`; npm rewrites the lockfile.",
);
const HDF5 = record(
	"mem-00000000000000a2",
	"HDF5 chunk caches must be sized to the dataset chunk shape before parallel reads.",
	{
		createdAt: "2026-09-23T00:00:00.000Z",
	},
);
const FORMAT = record("mem-00000000000000a3", "Biome formatting keeps tabs for indentation in TypeScript sources.", {
	createdAt: "2026-09-24T00:00:00.000Z",
});
const ELIGIBLE = { scopes: ["global"] as const, activeRepository: null, activeRuntime: null, activeAgent: null };

test("the gate drops records with no distinctive overlap and never promotes a zero-overlap fallback", () => {
	const records = [PNPM, HDF5, FORMAT];
	const ids = (taskText: string, demoted?: ReadonlySet<string>) =>
		selectRelevantMemory(records, { ...ELIGIBLE, scopes: ["global"] }, { taskText }, demoted).map((c) => c.record.id);
	deepStrictEqual(ids("tune the HDF5 chunk cache for parallel reads"), ["mem-00000000000000a2"]);
	deepStrictEqual(ids("fix the failing test in the parser file"), [], "generic coding words are not a subject");
	deepStrictEqual(ids(""), []);
	deepStrictEqual(ids("install dependencies for the workspace"), ["mem-00000000000000a1"]);
	deepStrictEqual(
		ids("install dependencies for the workspace", new Set(["mem-00000000000000a1"])),
		[],
		"a demoted record needs more",
	);
	deepStrictEqual(
		ids("install workspace dependencies, the lockfile must stay frozen", new Set(["mem-00000000000000a1"])),
		["mem-00000000000000a1"],
	);
});

function readerFixture(t: TestContext, records: MemoryRecord[]) {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-memory-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "memory"));
	writeFileSync(memoryStorePath(root), JSON.stringify({ version: 1, records }));
	const request: MemoryPromptRequest = {
		turnId: "1",
		sessionAuthority: "session-a:0",
		cwd: root,
		targetId: "target",
		runtimeId: "runtime",
		modelId: "model",
		taskText: "",
		activePaths: [],
	};
	return { root, request };
}

test("the gated reader carries only what the turn concerns, while the legacy reader carries the newest", (t) => {
	const f = readerFixture(t, [PNPM, HDF5, FORMAT]);
	let demoted = new Set<string>();
	const gated = createMemoryPromptReader({ getDataDir: () => f.root, relevanceGate: { demoted: () => demoted } });
	const legacy = createMemoryPromptReader({ getDataDir: () => f.root });
	const unrelated = { ...f.request, taskText: "rename the parser variable in the test file" };
	for (const id of ["mem-00000000000000a1", "mem-00000000000000a2", "mem-00000000000000a3"])
		ok(legacy(unrelated).includes(id));
	strictEqual(gated(unrelated), "");
	const hdf5 = gated({ ...f.request, turnId: "2", taskText: "size the HDF5 chunk cache before parallel reads" });
	ok(hdf5.includes("mem-00000000000000a2"));
	ok(!hdf5.includes("mem-00000000000000a1") && !hdf5.includes("mem-00000000000000a3"));
	demoted = new Set(["mem-00000000000000a2"]);
	strictEqual(gated({ ...f.request, turnId: "3", taskText: "check HDF5 chunk sizes" }), "");
	strictEqual(
		gated({ ...f.request, turnId: "4", taskText: "throws reading the demoted record set" }),
		"",
		"a turn naming nothing carries nothing",
	);
	const throwing = createMemoryPromptReader({
		getDataDir: () => f.root,
		relevanceGate: {
			demoted: () => {
				throw new Error("unreadable");
			},
		},
	});
	ok(
		throwing({ ...f.request, taskText: "size the HDF5 chunk cache before parallel reads" }).includes(
			"mem-00000000000000a2",
		),
	);
});

test("use is the turn acting on a record: its id, a literal it names, or its terms beyond the request", () => {
	strictEqual(detectMemoryUse(PNPM, "Per [mem-00000000000000a1] I ran the install."), "cited");
	strictEqual(detectMemoryUse(PNPM, '{"command":"pnpm install --frozen-lockfile"}', "set up the repo"), "literal");
	strictEqual(
		detectMemoryUse(PNPM, "pnpm install --frozen-lockfile", "run pnpm install --frozen-lockfile"),
		null,
		"a literal the operator typed is an echo",
	);
	strictEqual(
		detectMemoryUse(HDF5, "I sized the chunk cache to the dataset chunk shape first.", "speed up parallel reads"),
		"terms",
	);
	strictEqual(
		detectMemoryUse(HDF5, "Done: parallel reads of the HDF5 file are faster now.", "speed up HDF5 parallel reads"),
		null,
		"repeating the request is not using the lesson",
	);
	strictEqual(detectMemoryUse(FORMAT, ""), null);
});

test("records left unused turn after turn are demoted, and one use restores them", () => {
	let ledger: RecallUseLedger = { version: 1, records: {} };
	for (let turn = 0; turn < MEMORY_DEMOTE_AFTER_UNUSED - 1; turn++)
		ledger = foldRecallUse(ledger, { recalled: ["a", "b"], used: ["b"], at: `2026-10-0${turn + 1}T00:00:00Z` });
	deepStrictEqual([...demotedMemoryIds(ledger)], []);
	ledger = foldRecallUse(ledger, { recalled: ["a"], used: [], at: "2026-10-09T00:00:00Z" });
	deepStrictEqual([...demotedMemoryIds(ledger)], ["a"]);
	deepStrictEqual(ledger.records.a, {
		recalled: MEMORY_DEMOTE_AFTER_UNUSED,
		used: 0,
		consecutiveUnused: MEMORY_DEMOTE_AFTER_UNUSED,
		lastRecalledAt: "2026-10-09T00:00:00Z",
	});
	strictEqual(ledger.records.b?.used, MEMORY_DEMOTE_AFTER_UNUSED - 1);
	ledger = foldRecallUse(ledger, { recalled: ["a"], used: ["a"], at: "2026-10-10T00:00:00Z" });
	deepStrictEqual([...demotedMemoryIds(ledger)], []);
});

test("the registration records recall against use at turn end and skips aborted turns", async (t) => {
	const f = readerFixture(t, [PNPM, HDF5]);
	const stateDir = join(f.root, "state");
	let recalled: string[] = [];
	const turns: Array<{ recalled: ReadonlyArray<string>; used: ReadonlyArray<string> }> = [];
	const hook = createMemoryRecallUseRegistration({
		dataDir: () => f.root,
		stateDir: () => stateDir,
		enabled: () => true,
		takeRecalled: () => {
			const ids = recalled;
			recalled = [];
			return ids;
		},
		onTurn: (turn) => turns.push(turn),
	});
	const turn = async (task: string, toolArgs: Record<string, unknown>, text: string, stopReason = "stop") => {
		hook.evaluate({ hook: "turn_start", text: task });
		hook.evaluate({ hook: "after_tool", toolName: "bash", toolArgs });
		recalled = ["mem-00000000000000a1", "mem-00000000000000a2"];
		await hook.evaluateAsync?.({ hook: "turn_end", text, metadata: { stopReason } });
	};
	await turn("set up the repo", { command: "pnpm install --frozen-lockfile" }, "Dependencies installed.");
	deepStrictEqual(turns, [
		{ recalled: ["mem-00000000000000a1", "mem-00000000000000a2"], used: ["mem-00000000000000a1"] },
	]);
	await turn("set up the repo", { command: "ls" }, "Stopped.", "aborted");
	strictEqual(turns.length, 1);
	const ledger = readRecallUseLedger(stateDir);
	deepStrictEqual(
		Object.fromEntries(Object.entries(ledger.records).map(([id, entry]) => [id, [entry.recalled, entry.used]])),
		{ "mem-00000000000000a1": [1, 1], "mem-00000000000000a2": [1, 0] },
	);
});
