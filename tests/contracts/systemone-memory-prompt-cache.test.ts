import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryPromptReader, type MemoryPromptRequest } from "../../src/domains/memory/prompt-cache.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

function record(id: string, lesson: string): MemoryRecord {
	return {
		id,
		scope: "global",
		key: id,
		lesson,
		evidenceRefs: ["run:1"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-09-01T00:00:00.000Z",
		approved: true,
	};
}

const RECORDS = [record("alpha", "Alpha lesson."), record("bravo", "Bravo lesson.")];

/** A store that never changes, so every difference below comes from the key. */
function readerOver(records: ReadonlyArray<MemoryRecord>, reads: { count: number }) {
	return createMemoryPromptReader({
		getDataDir: () => "/data",
		selection: { maxItems: 1 },
		readStore: (() => {
			reads.count += 1;
			return { revision: "rev-1", records: [...records] };
		}) as never,
	});
}

function request(over: Partial<MemoryPromptRequest> = {}): MemoryPromptRequest {
	return {
		turnId: null,
		sessionAuthority: "session-1",
		cwd: "/workspace",
		targetId: "t",
		runtimeId: "r",
		modelId: "m",
		taskText: "do the thing",
		activePaths: [],
		...over,
	};
}

describe("memory prompt cache under precomputed relevance", () => {
	// The section sits in the system prompt. A selection that moved with each
	// turn's scores would recompile the prompt and send a local model's whole
	// conversation through a cold prefill on every follow-up, so a session keeps
	// the first ranking it applied.
	it("keeps the session's first ranking when a later turn scores differently", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const first = read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 0.9, bravo: 0.1 } } }));
		const second = read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 0.1, bravo: 0.9 } } }));
		ok(first.includes("[alpha]"));
		strictEqual(second, first);
	});

	it("keeps the pinned ranking on a turn whose pass produced no scores", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const first = read(request({ precomputedRelevance: { source: "jev", scores: { bravo: 0.9, alpha: 0.1 } } }));
		ok(first.includes("[bravo]"));
		strictEqual(read(request()), first);
	});

	it("re-selects for a new session", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 0.9, bravo: 0.1 } } }));
		const next = read(
			request({
				sessionAuthority: "session-2",
				precomputedRelevance: { source: "jev", scores: { alpha: 0.1, bravo: 0.9 } },
			}),
		);
		ok(next.includes("[bravo]"));
	});

	// The first turn can run before the session id exists; the session it
	// becomes is the same session and keeps the pin.
	it("carries the pin from a pending session id to the id it becomes", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const first = read(
			request({
				sessionAuthority: JSON.stringify([0, "pending:1"]),
				precomputedRelevance: { source: "jev", scores: { alpha: 0.9, bravo: 0.1 } },
			}),
		);
		const second = read(
			request({
				sessionAuthority: JSON.stringify([0, "s-abc"]),
				precomputedRelevance: { source: "jev", scores: { alpha: 0.1, bravo: 0.9 } },
			}),
		);
		strictEqual(second, first);
	});

	it("re-selects when the approved records change", () => {
		const reads = { count: 0 };
		let revision = "rev-1";
		const read = createMemoryPromptReader({
			getDataDir: () => "/data",
			selection: { maxItems: 1 },
			readStore: (() => {
				reads.count += 1;
				return { revision, records: [...RECORDS] };
			}) as never,
		});
		read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 0.9, bravo: 0.1 } } }));
		revision = "rev-2";
		const next = read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 0.1, bravo: 0.9 } } }));
		ok(next.includes("[bravo]"));
	});

	it("re-selects when the same scores come from a different target", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const scores = { alpha: 0.9, bravo: 0.1 };
		read(request({ precomputedRelevance: { source: "jev", scores } }));
		const before = reads.count;
		read(request({ precomputedRelevance: { source: "jev2", scores } }));
		// A different source is a different key, so the section is rebuilt rather
		// than served from the entry the first source left behind.
		ok(reads.count > before);
	});

	// A pass that answered the same way twice must not pay to re-render, and the
	// order answers arrive in is not part of the answer.
	it("reuses the section for the same scores in a different key order", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const first = read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 0.9, bravo: 0.1 } } }));
		const second = read(request({ precomputedRelevance: { source: "jev", scores: { bravo: 0.1, alpha: 0.9 } } }));
		strictEqual(first, second);
	});

	// Opt-in by absence: with no pass, the reader behaves exactly as before.
	it("renders the legacy section when no scores are supplied", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const legacy = read(request());
		const empty = read(request({ precomputedRelevance: { source: "jev", scores: {} } }));
		strictEqual(empty, legacy);
		ok(legacy.includes("[alpha]"));
	});

	// The scores rank; they do not admit. Every eligibility gate still runs.
	it("cannot score an ineligible record into the prompt", () => {
		const reads = { count: 0 };
		const read = readerOver([{ ...record("unapproved", "Never."), approved: false }, RECORDS[0] as MemoryRecord], reads);
		const section = read(request({ precomputedRelevance: { source: "jev", scores: { unapproved: 1, alpha: 0.01 } } }));
		strictEqual(section.includes("unapproved"), false);
		ok(section.includes("[alpha]"));
	});

	// A store that cannot be read revokes the section, scores or not.
	it("returns nothing when the store read fails", () => {
		const read = createMemoryPromptReader({
			getDataDir: () => "/data",
			readStore: (() => {
				throw new Error("unreadable");
			}) as never,
		});
		strictEqual(read(request({ precomputedRelevance: { source: "jev", scores: { alpha: 1 } } })), "");
	});

	it("keeps a prepared turn frozen across its continuations", () => {
		const reads = { count: 0 };
		const read = readerOver(RECORDS, reads);
		const scored = request({ turnId: "turn-1", precomputedRelevance: { source: "jev", scores: { bravo: 0.9 } } });
		const first = read(scored);
		const reads0 = reads.count;
		deepStrictEqual(read(scored), first);
		strictEqual(reads.count, reads0);
	});
});
