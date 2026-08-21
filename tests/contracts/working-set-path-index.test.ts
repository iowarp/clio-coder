import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPathIndex, type PathObservation } from "../../src/domains/context/working-set/path-index.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

const CWD = "/repo";
const TS = "2026-08-21T00:00:00.000Z";

/** The JSONL header is a SessionFileEntry, not a SessionEntry; callers that keep it pass it through. */
const HEADER = { type: "session", version: 4, id: "s1", timestamp: TS, cwd: CWD } as unknown as SessionEntry;

let seq = 0;
function nextId(prefix: string): string {
	seq += 1;
	return `${prefix}${seq}`;
}

function user(text: string): SessionEntry {
	return { kind: "message", turnId: nextId("u"), parentTurnId: null, timestamp: TS, role: "user", payload: { text } };
}

function call(toolName: string, args: unknown, id = nextId("call-")): { entry: SessionEntry; id: string } {
	return {
		id,
		entry: {
			kind: "message",
			turnId: nextId("c"),
			parentTurnId: null,
			timestamp: TS,
			role: "tool_call",
			payload: { toolCallId: id, name: toolName, args },
		},
	};
}

function result(
	toolName: string,
	callId: string,
	text: string,
	options: { isError?: boolean; turnId?: string } = {},
): SessionEntry {
	return {
		kind: "message",
		turnId: options.turnId ?? nextId("t"),
		parentTurnId: null,
		timestamp: TS,
		role: "tool_result",
		payload: {
			toolCallId: callId,
			toolName,
			result: { content: [{ type: "text", text }] },
			isError: options.isError === true,
		},
	};
}

/** One call/result pair plus the entries around it, indexed. */
function indexOne(toolName: string, args: unknown, text = "", options: { isError?: boolean } = {}): PathObservation {
	const made = call(toolName, args);
	const entries: SessionEntry[] = [HEADER, user("go"), made.entry, result(toolName, made.id, text, options)];
	const observations = buildPathIndex(entries).observations;
	const first = observations[0];
	assert.ok(first, `expected one observation for ${toolName}`);
	return first;
}

test("path index: a read carries the canonical path and a full range", () => {
	const observation = indexOne("read", { path: "src/a.ts" }, "file body");
	assert.equal(observation.op, "read");
	assert.equal(observation.path, "/repo/src/a.ts");
	assert.deepEqual(observation.range, { offset: 0, limit: null });
	assert.equal(observation.isError, false);
	assert.deepEqual(observation.surfaced, []);
	assert.equal(observation.toolName, "read");
});

test("path index: read ranges normalize the 1-indexed offset argument", () => {
	assert.deepEqual(indexOne("read", { path: "src/a.ts", offset: 51, limit: 100 }).range, { offset: 50, limit: 100 });
	// offset 1 is the top of the file, which is the full-read shape.
	assert.deepEqual(indexOne("read", { path: "src/a.ts", offset: 1 }).range, { offset: 0, limit: null });
	assert.deepEqual(indexOne("read", { path: "src/a.ts", limit: 40 }).range, { offset: 0, limit: 40 });
	// A tail read covers an unknown suffix, so it claims no range at all.
	assert.equal(indexOne("read", { path: "src/a.ts", tail: 30 }).range, null);
});

test("path index: an absolute argument is kept, a relative one without a header is left as written", () => {
	assert.equal(indexOne("read", { path: "/elsewhere/b.ts" }).path, "/elsewhere/b.ts");

	const made = call("read", { path: "src/a.ts" });
	const entries: SessionEntry[] = [user("go"), made.entry, result("read", made.id, "body")];
	assert.equal(buildPathIndex(entries).observations[0]?.path, "src/a.ts");
});

test("path index: grep surfaces the path before the line number", () => {
	// grep prints paths relative to the directory it searched.
	const body = [
		"a.ts:12: const x = 1;",
		"a.ts-13-   context line",
		"b.ts:4: const y = 2;",
		"[grep: 3/3 matches shown (1.0KB of 1.0KB)]",
	].join("\n");
	const observation = indexOne("grep", { pattern: "const", path: "src" }, body);
	assert.equal(observation.op, "grep");
	assert.equal(observation.path, "/repo/src");
	assert.deepEqual(observation.surfaced, ["/repo/src/a.ts", "/repo/src/b.ts"]);
});

test("path index: a search with no path argument observes the session cwd", () => {
	assert.equal(indexOne("grep", { pattern: "x" }, "a.ts:1: x").path, CWD);
	assert.equal(indexOne("find", { pattern: "**/*.ts" }, "a.ts").path, CWD);
	assert.equal(indexOne("ls", {}, "a.ts").path, CWD);
});

test("path index: find surfaces concrete files and skips directories and notices", () => {
	const body = ["a.ts", "nested/", "b.ts", "[find: 3/3 paths shown]", "   ", "Makefile"].join("\n");
	const observation = indexOne("find", { pattern: "**/*", path: "src" }, body);
	assert.deepEqual(observation.surfaced, ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/Makefile"]);
});

test("path index: ls surfaces its entries against the listed directory", () => {
	const observation = indexOne("ls", { path: "/repo/docs" }, ["guide.md", "images/", "README.md"].join("\n"));
	assert.equal(observation.op, "ls");
	assert.deepEqual(observation.surfaced, ["/repo/docs/guide.md", "/repo/docs/README.md"]);
});

test("path index: code_nav observes a path only in its path-shaped modes", () => {
	assert.equal(indexOne("code_nav", { mode: "path", query: "src/a.ts" }).path, "/repo/src/a.ts");
	assert.equal(indexOne("code_nav", { mode: "outline", query: "src/a.ts" }).path, "/repo/src/a.ts");
	assert.equal(indexOne("code_nav", { mode: "symbol", query: "buildPathIndex" }).path, "");
	assert.equal(indexOne("code_nav", { mode: "wiki", query: "architecture" }).path, "");
});

test("path index: write, edit, and artifact are mutations of their path", () => {
	assert.equal(indexOne("write", { path: "src/a.ts", content: "x" }).op, "write");
	assert.equal(indexOne("edit", { path: "src/a.ts", edits: [] }).op, "edit");
	const artifact = indexOne("artifact", { kind: "report", content: "x", path: "docs/r.md" });
	assert.equal(artifact.op, "write");
	assert.equal(artifact.path, "/repo/docs/r.md");
});

test("path index: bash takes its cwd argument and parses only listing commands", () => {
	const listing = indexOne("bash", { command: "ls -1", cwd: "src" }, ["a.ts", "b.ts"].join("\n"));
	assert.equal(listing.op, "bash");
	assert.equal(listing.path, "/repo/src");
	assert.deepEqual(listing.surfaced, ["/repo/src/a.ts", "/repo/src/b.ts"]);

	const rg = indexOne("bash", { command: "rg const src", cwd: "/repo" }, "src/a.ts:3: const x = 1;");
	assert.deepEqual(rg.surfaced, ["/repo/src/a.ts"]);

	// Not a listing verb: the output is prose as far as this index is concerned.
	const build = indexOne("bash", { command: "npm run build" }, "dist/index.js");
	assert.deepEqual(build.surfaced, []);
	assert.equal(build.path, "", "a bash call with no cwd argument names no path");
});

test("path index: git and verify index as commands", () => {
	assert.equal(indexOne("git", { op: "status" }, "clean").op, "bash");
	assert.equal(indexOne("verify", { check: "typecheck" }, "ok").op, "bash");
});

test("path index: an error result keeps its observation and surfaces nothing", () => {
	const observation = indexOne("find", { pattern: "**/*", path: "src" }, "find: path not found: src", {
		isError: true,
	});
	assert.equal(observation.isError, true);
	assert.deepEqual(observation.surfaced, []);
});

test("path index: a fileEntry is write evidence with no tool call", () => {
	const entries: SessionEntry[] = [
		HEADER,
		user("go"),
		{ kind: "fileEntry", turnId: "f1", parentTurnId: null, timestamp: TS, path: "src/a.ts", operation: "create" },
		{ kind: "fileEntry", turnId: "f2", parentTurnId: null, timestamp: TS, path: "src/b.ts", operation: "edit" },
		{ kind: "fileEntry", turnId: "f3", parentTurnId: null, timestamp: TS, path: "src/c.ts", operation: "read" },
	];
	const index = buildPathIndex(entries);
	assert.deepEqual(
		index.observations.map((observation) => [observation.ref.entry, observation.op, observation.path]),
		[
			["f1", "write", "/repo/src/a.ts"],
			["f2", "edit", "/repo/src/b.ts"],
			["f3", "read", "/repo/src/c.ts"],
		],
	);
	assert.equal(index.byRef.get("f1")?.toolCallId, null);
	assert.equal(index.byRef.get("f1")?.argsKey, "");
});

test("path index: argsKey is order-independent and distinguishes different arguments", () => {
	const a = indexOne("read", { path: "src/a.ts", limit: 10, offset: 2 });
	const b = indexOne("read", { offset: 2, path: "src/a.ts", limit: 10 });
	const c = indexOne("read", { path: "src/a.ts", limit: 11, offset: 2 });
	assert.equal(a.argsKey, b.argsKey);
	assert.notEqual(a.argsKey, c.argsKey);
	assert.equal(a.argsKey, '{"limit":10,"offset":2,"path":"src/a.ts"}');
});

test("path index: an unpaired result carries an empty argsKey rather than a guess", () => {
	const entries: SessionEntry[] = [HEADER, user("go"), result("read", "call-missing", "body")];
	const observation = buildPathIndex(entries).observations[0];
	assert.equal(observation?.argsKey, "");
	assert.equal(observation?.path, "");
	assert.equal(observation?.toolCallId, "call-missing");
});

test("path index: a call streamed as an assistant content block still pairs", () => {
	const entries: SessionEntry[] = [
		HEADER,
		user("go"),
		{
			kind: "message",
			turnId: "a1",
			parentTurnId: null,
			timestamp: TS,
			role: "assistant",
			payload: {
				content: [{ type: "toolCall", id: "call-block", name: "read", arguments: { path: "src/a.ts" } }],
			},
		},
		result("read", "call-block", "body"),
	];
	const observation = buildPathIndex(entries).observations[0];
	assert.equal(observation?.path, "/repo/src/a.ts");
	assert.equal(observation?.argsKey, '{"path":"src/a.ts"}');
});

test("path index: turn positions count turn starts strictly before an entry", () => {
	const first = call("read", { path: "a.ts" });
	const second = call("read", { path: "b.ts" });
	const entries: SessionEntry[] = [
		HEADER,
		user("one"),
		first.entry,
		result("read", first.id, "body", { turnId: "r1" }),
		{
			kind: "bashExecution",
			turnId: "b1",
			parentTurnId: null,
			timestamp: TS,
			command: "ls",
			output: "a.ts",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		},
		second.entry,
		result("read", second.id, "body", { turnId: "r2" }),
	];
	const index = buildPathIndex(entries);
	assert.equal(index.turnCount, 2);
	assert.equal(index.byRef.get("r1")?.turnIndex, 1);
	assert.equal(index.byRef.get("r2")?.turnIndex, 2);
	// A turn start is not before itself.
	assert.equal(index.turnIndexOf.get("b1"), 1);
	assert.equal(index.turnIndexOf.get("r1"), 1);
});

test("path index: byPath groups every observation of one file in ledger order", () => {
	const read = call("read", { path: "src/a.ts" });
	const edit = call("edit", { path: "src/a.ts", edits: [] });
	const other = call("read", { path: "src/b.ts" });
	const entries: SessionEntry[] = [
		HEADER,
		user("go"),
		read.entry,
		result("read", read.id, "body", { turnId: "r1" }),
		edit.entry,
		result("edit", edit.id, "edited", { turnId: "e1" }),
		other.entry,
		result("read", other.id, "body", { turnId: "r2" }),
	];
	const index = buildPathIndex(entries);
	assert.deepEqual(
		index.byPath.get("/repo/src/a.ts")?.map((observation) => observation.ref.entry),
		["r1", "e1"],
	);
	assert.deepEqual(
		index.byPath.get("/repo/src/b.ts")?.map((observation) => observation.ref.entry),
		["r2"],
	);
	// A pathless observation never lands in byPath.
	assert.equal(index.byPath.has(""), false);
	assert.equal(
		index.observations.every((observation) => observation.entryIndex > 0),
		true,
	);
});

test("path index: unobserved tools produce no observation", () => {
	const made = call("web_fetch", { url: "https://example.com" });
	const entries: SessionEntry[] = [HEADER, user("go"), made.entry, result("web_fetch", made.id, "page")];
	assert.deepEqual(buildPathIndex(entries).observations, []);
});

test("path index: the same ledger indexes identically twice", () => {
	const made = call("grep", { pattern: "x", path: "src" });
	const entries: SessionEntry[] = [HEADER, user("go"), made.entry, result("grep", made.id, "src/a.ts:1: x")];
	assert.deepEqual(buildPathIndex(entries).observations, buildPathIndex(entries).observations);
});
