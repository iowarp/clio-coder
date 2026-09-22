/**
 * Durable memory selection scenarios.
 *
 * The reader is the seam between the bounded memory store and the prompt. One
 * prepared operator attempt sees one selection: its continuations reuse the
 * frozen text even if the store changes underneath them, a new attempt rereads,
 * and a change of authority (session, data root, repository, target, runtime,
 * model) is a new selection rather than a cached one.
 *
 * Every scenario drives the production reader with a counting store source, so
 * what it measures is the freezing rule and not the file format underneath it.
 */
import { createMemoryPromptReader, type MemoryPromptRequest } from "../../../src/domains/memory/prompt-cache.js";
import type { MemoryRecord } from "../../../src/domains/memory/types.js";
import { type MachineryObservation, type MachineryScenario, observe } from "./observation.js";

function record(id: string, lesson: string): MemoryRecord {
	return {
		id,
		scope: "global",
		key: id,
		lesson,
		evidenceRefs: [`ev-${id}`],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-01-01T00:00:00.000Z",
		approved: true,
	};
}

interface CountingStore {
	read: (dataDir: string) => { revision: string; records: MemoryRecord[] };
	reads: () => number;
	dirs: () => string[];
	set: (revision: string, records: MemoryRecord[]) => void;
	fail: (shouldFail: boolean) => void;
}

function countingStore(revision: string, records: MemoryRecord[]): CountingStore {
	let current = { revision, records };
	let reads = 0;
	let failing = false;
	const dirs: string[] = [];
	return {
		read: (dataDir) => {
			reads += 1;
			dirs.push(dataDir);
			if (failing) throw new Error("memory prompt store exceeds read ceiling");
			return { revision: current.revision, records: [...current.records] };
		},
		reads: () => reads,
		dirs: () => dirs,
		set: (nextRevision, nextRecords) => {
			current = { revision: nextRevision, records: nextRecords };
		},
		fail: (shouldFail) => {
			failing = shouldFail;
		},
	};
}

function request(overrides: Partial<MemoryPromptRequest> = {}): MemoryPromptRequest {
	return {
		turnId: "turn-1",
		sessionAuthority: "session-a:main",
		cwd: "/workspace/project",
		targetId: "mini",
		runtimeId: "llamacpp",
		modelId: "fixture-model",
		taskText: "Explain the admission ceiling.",
		activePaths: ["src/domains/dispatch/extension.ts"],
		...overrides,
	};
}

const BANK = [
	record("m-1", "Admission clamps a worker to the session level."),
	record("m-2", "Approvals are axis-scoped."),
];

function readerFor(store: CountingStore, dataDir = "/data/root") {
	return createMemoryPromptReader({ getDataDir: () => dataDir, readStore: store.read });
}

async function frozenWithinTurn(): Promise<MachineryObservation> {
	const store = countingStore("rev-1", BANK);
	const read = readerFor(store);
	const first = read(request());
	// The store moves underneath the attempt. A prepared turn already decided
	// what it is reasoning over, so the change is visible at the next attempt.
	store.set("rev-2", [record("m-3", "A late edit must not change a live turn.")]);
	const second = read(request());
	const third = read(request());
	const readsAfterOneAttempt = store.reads();
	const nextAttempt = read(request({ turnId: "turn-2" }));
	return observe(
		{
			readsAfterOneAttempt,
			readsAfterNextAttempt: store.reads(),
			frozen: first === second && second === third,
			firstSection: first,
			nextAttemptSection: nextAttempt,
			dataDirsRead: store.dirs(),
		},
		{
			"one prepared attempt reads the store once": readsAfterOneAttempt === 1,
			"the next attempt reads it again": store.reads() === 2,
			"repeated calls in that attempt return the identical text": first === second && second === third,
			"the attempt's selection cites the bank it read": first.includes("m-1") && first.includes("m-2"),
			"a new attempt sees the edit the frozen one did not": nextAttempt.includes("m-3") && !nextAttempt.includes("m-1"),
		},
	);
}

async function continuationInheritsFrame(): Promise<MachineryObservation> {
	// A turn's tool continuations are the same attempt. They ask again because
	// the prompt is rebuilt, and they must get the same bytes each time, whether
	// or not anything else in the request moved.
	const store = countingStore("rev-1", BANK);
	const read = readerFor(store);
	const prepared = read(request());
	const continuations = [
		read(request({ taskText: "Continue after the first tool batch." })),
		read(request({ activePaths: ["src/domains/prompts/compiler.ts"] })),
		read(request({ activeSymbols: ["effectiveWorkerAutonomy"] })),
	];
	store.set("rev-2", []);
	const afterExternalEdit = read(request({ taskText: "Continue after an external edit." }));
	return observe(
		{
			reads: store.reads(),
			prepared,
			continuations,
			afterExternalEdit,
		},
		{
			"every continuation of one attempt reads the frozen text": continuations.every((text) => text === prepared),
			"a continuation never reopens the store": store.reads() === 1,
			"an external edit cannot revoke a live attempt's selection": afterExternalEdit === prepared,
		},
	);
}

async function authorityChangeRereads(): Promise<MachineryObservation> {
	// Freezing is scoped to one attempt under one authority. Everything that
	// decides which memory is even eligible is part of that authority, so a
	// change to any of it is a new selection rather than a stale one.
	const changes: Record<string, { reads: number; changed: boolean }> = {};
	for (const [name, override] of [
		["session", { sessionAuthority: "session-b:main" }],
		["cwd", { cwd: "/workspace/other" }],
		["target", { targetId: "blade" }],
		["runtime", { runtimeId: "ollama" }],
		["model", { modelId: "another-model" }],
	] as const) {
		const store = countingStore("rev-1", BANK);
		const read = readerFor(store);
		const before = read(request());
		store.set("rev-2", [record("m-9", "A new authority reads the store again.")]);
		const after = read(request(override));
		changes[name] = { reads: store.reads(), changed: after !== before };
	}
	// The data root is authority too, and it is not carried on the request.
	const store = countingStore("rev-1", BANK);
	let dataDir = "/data/root";
	const read = createMemoryPromptReader({ getDataDir: () => dataDir, readStore: store.read });
	const before = read(request());
	store.set("rev-2", [record("m-9", "A moved data root is a different bank.")]);
	dataDir = "/data/other";
	const after = read(request());
	changes["data-root"] = { reads: store.reads(), changed: after !== before };
	return observe(
		{ changes, dataDirsRead: store.dirs() },
		{
			"every authority change reopens the store": Object.values(changes).every((row) => row.reads === 2),
			"every authority change publishes the new selection": Object.values(changes).every((row) => row.changed),
			"the reader asks for the data root on every read":
				store.dirs().length === 2 && store.dirs()[0] === "/data/root" && store.dirs()[1] === "/data/other",
		},
	);
}

async function prewarmNeverFreezes(): Promise<MachineryObservation> {
	// Boot and reset prewarm have no prepared turn to freeze against. They read
	// each time, so a prewarm cannot hand a stale section to the attempt that
	// follows it.
	const store = countingStore("rev-1", BANK);
	const read = readerFor(store);
	const firstPrewarm = read(request({ turnId: null }));
	const secondPrewarm = read(request({ turnId: null }));
	store.set("rev-2", [record("m-4", "Prewarm sees the current bank.")]);
	const thirdPrewarm = read(request({ turnId: null }));
	const attempt = read(request({ turnId: "turn-1" }));
	const attemptRepeat = read(request({ turnId: "turn-1" }));
	return observe(
		{
			readsAfterThreePrewarms: 3,
			totalReads: store.reads(),
			prewarmStable: firstPrewarm === secondPrewarm,
			prewarmMoved: thirdPrewarm !== firstPrewarm,
			attemptFrozen: attempt === attemptRepeat,
		},
		{
			"a call without a prepared turn reads every time": store.reads() === 4,
			"two prewarms over an unchanged store return the same text": firstPrewarm === secondPrewarm,
			"a prewarm after an edit publishes it": thirdPrewarm !== firstPrewarm,
			"the attempt that follows a prewarm freezes normally": attempt === attemptRepeat,
		},
	);
}

async function selectionReuseAcrossTurns(): Promise<MachineryObservation> {
	// A fresh attempt always rereads, but an unchanged store under an unchanged
	// authority is the same selection. Reusing it keeps the compiled prompt
	// byte-identical across turns, which is what a provider prefix cache needs.
	const store = countingStore("rev-1", BANK);
	const read = readerFor(store);
	const sections = ["turn-1", "turn-2", "turn-3"].map((turnId) => read(request({ turnId })));
	store.set("rev-2", [...BANK, record("m-5", "A real edit ends the reuse.")]);
	const afterEdit = read(request({ turnId: "turn-4" }));
	store.set("rev-1", BANK);
	const restored = read(request({ turnId: "turn-5" }));
	return observe(
		{ reads: store.reads(), sections, afterEdit, restored },
		{
			"each attempt rereads the store": store.reads() === 5,
			"an unchanged store under unchanged authority reuses its selection": new Set(sections).size === 1,
			"a changed store publishes a changed selection": afterEdit !== sections[0],
			"restoring the store restores the selection": restored === sections[0],
		},
	);
}

async function readFailureRevokes(): Promise<MachineryObservation> {
	// A bounded store that cannot be read is not a reason to keep serving text
	// the operator may have revoked. The failure yields no section and drops the
	// cached selection, so recovery is a fresh read rather than a resurrection.
	const store = countingStore("rev-1", BANK);
	const read = readerFor(store);
	const healthy = read(request({ turnId: "turn-1" }));
	const readsAfterHealthy = store.reads();
	store.fail(true);
	const duringFailure = read(request({ turnId: "turn-2" }));
	const frozenFailure = read(request({ turnId: "turn-2" }));
	const readsAfterFailure = store.reads();
	store.fail(false);
	const recovered = read(request({ turnId: "turn-3" }));
	return observe(
		{
			readsAfterHealthy,
			readsAfterFailure,
			readsAfterRecovery: store.reads(),
			healthy,
			duringFailure,
			frozenFailure,
			recovered,
		},
		{
			"a failed read serves no memory at all": duringFailure === "",
			"the failure is frozen for the attempt that hit it rather than retried":
				frozenFailure === "" && readsAfterFailure === 2,
			"a later attempt reads again rather than resurrecting the cache": recovered === healthy && store.reads() === 3,
			"the healthy selection was non-empty to begin with": healthy.length > 0,
		},
	);
}

export const SCENARIOS: Record<string, MachineryScenario> = {
	"frozen-within-turn": frozenWithinTurn,
	"continuation-inherits-frame": continuationInheritsFrame,
	"authority-change-rereads": authorityChangeRereads,
	"prewarm-never-freezes": prewarmNeverFreezes,
	"selection-reuse-across-turns": selectionReuseAcrossTurns,
	"read-failure-revokes": readFailureRevokes,
};
