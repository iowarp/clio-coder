import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { completedLessonSource, createHistoryReviewSource } from "../../src/domains/memory/history-review.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import {
	entriesBeforeMemoryOff,
	MEMORY_OFF_ENTRY_TYPE,
	markMemoryOffRecording,
} from "../../src/domains/memory/recording-marker.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { SessionEntry } from "../../src/domains/session/index.js";
import { filterEntriesToActivePath } from "../../src/domains/session/tree/active-path.js";
import { cwdHash } from "../../src/engine/session.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const base = { parentTurnId: null, timestamp: "2026-01-01T00:00:00.000Z" };
const task = (id: string): Record<string, unknown>[] => [
	{ ...base, kind: "message", turnId: `${id}-u`, role: "user", payload: { text: `task ${id}` } },
	{
		...base,
		kind: "message",
		turnId: `${id}-c`,
		role: "tool_call",
		payload: { toolCallId: id, name: "bash", args: { command: `node scripts/${id}.mjs` } },
	},
	{
		...base,
		kind: "message",
		turnId: `${id}-r`,
		role: "tool_result",
		payload: {
			toolCallId: id,
			outcome: "ok",
			result: { content: [{ type: "text", text: "done" }], details: { kind: "ok", outcome: "success", exitCode: 0 } },
		},
	},
	{ ...base, kind: "message", turnId: `${id}-a`, role: "assistant", payload: { text: "done", stopReason: "stop" } },
];
const marker = { ...base, kind: "custom", turnId: "off", customType: MEMORY_OFF_ENTRY_TYPE, data: {} };

it("retention reads only what was recorded before memory went off", () => {
	const midway = [...task("before"), marker, ...task("after")] as unknown as SessionEntry[];
	const source = completedLessonSource(midway, "/repo");
	ok(source);
	match(source.text, /node scripts\/before\.mjs/);
	strictEqual(source.text.includes("after"), false);
	strictEqual(completedLessonSource([marker, ...task("after")] as unknown as SessionEntry[], "/repo"), null);
});

it("history review stops at the marker, and a ledger with no marker stays reviewable", async () => {
	const env = await isolateClioEnv("clio-memory-off-marker-");
	try {
		const cwd = join(env.dir, "project");
		mkdirSync(join(cwd, ".git"), { recursive: true });
		const root = realpathSync(cwd);
		const write = (id: string, entries: unknown[]) => {
			const dir = join(clioStateDir(), "sessions", cwdHash(root), id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		};
		const request = { horizonMs: Number.POSITIVE_INFINITY, maxChars: 4000, maxReadBytes: 1 << 20 };
		write("off", [marker, ...task("offtext")]);
		const source = () => createHistoryReviewSource({ stateDir: clioStateDir(), cwd: root, currentSessionId: null });
		strictEqual(source().next(request).slice, null);
		write("legacy", task("legacy"));
		const slice = source().next(request).slice;
		ok(slice);
		deepStrictEqual(slice.sessionId, "legacy");
		match(slice.text, /node scripts\/legacy\.mjs/);
	} finally {
		env.restore();
	}
});

it("a reminder buffered before memory went off is no longer current", () => {
	const live = { enabled: true };
	const memory = createMemoryInterventionRegistration({ bank: new TaskMemoryBank(), getSettings: () => live as never });
	const current = memory.isContentCurrent();
	strictEqual(current(), true);
	live.enabled = false;
	strictEqual(current(), false);
});

it("history review keeps what precedes the marker in the same slice and reads nothing after it", async () => {
	const env = await isolateClioEnv("clio-memory-off-slice-");
	try {
		const cwd = join(env.dir, "project");
		mkdirSync(join(cwd, ".git"), { recursive: true });
		const root = realpathSync(cwd);
		const dir = join(clioStateDir(), "sessions", cwdHash(root), "mixed");
		mkdirSync(dir, { recursive: true });
		const entries = [...task("ontext"), marker, ...task("offtext")];
		writeFileSync(join(dir, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const request = { horizonMs: Number.POSITIVE_INFINITY, maxChars: 4000, maxReadBytes: 1 << 20 };
		const source = createHistoryReviewSource({ stateDir: clioStateDir(), cwd: root, currentSessionId: null });
		const slice = source.next(request).slice;
		ok(slice);
		match(slice.text, /node scripts\/ontext\.mjs/);
		strictEqual(slice.text.includes("offtext"), false);
		source.commit(slice);
		strictEqual(source.next(request).slice, null, "the cursor stays stopped at the marker");
	} finally {
		env.restore();
	}
});

it("the marker is decided from the active path, so a /tree branch gets its own", () => {
	const line = (id: string, parent: string | null) => ({
		...base,
		parentTurnId: parent,
		kind: "message",
		turnId: id,
		role: "user",
		payload: { text: id },
	});
	const ledger: Record<string, unknown>[] = [
		line("a", null),
		line("c", "a"),
		{ ...base, parentTurnId: "c", kind: "custom", turnId: "m1", customType: MEMORY_OFF_ENTRY_TYPE, data: {} },
	];
	let leaf = "c";
	const target = {
		current: () => ({ id: "s" }),
		tree: () => ({ leafId: leaf }),
		readEntries: () => ledger,
		appendEntry: (entry: Record<string, unknown>) => {
			ledger.push({ ...base, ...entry, turnId: `m${ledger.length}` });
			return entry;
		},
	} as never;
	markMemoryOffRecording(target);
	strictEqual(ledger.length, 3, "a marker on this path needs no second one");
	leaf = "a";
	ledger.push(line("offbranch", "a"));
	leaf = "offbranch";
	markMemoryOffRecording(target);
	strictEqual(ledger.length, 5, "the branch off the marked turn gets a marker");
	ledger.push(line("later", "offbranch"));
	const active = filterEntriesToActivePath(ledger as never, "later");
	const readable = entriesBeforeMemoryOff(active).map((entry) => entry.turnId);
	strictEqual(readable.includes("later"), false);
});
