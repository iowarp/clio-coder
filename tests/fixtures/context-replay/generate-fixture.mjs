#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const output = join(dirname(fileURLToPath(import.meta.url)), "fixture-01.jsonl");
const entries = [
	{
		type: "session",
		version: 4,
		id: "context-replay-fixture-01",
		timestamp: "2026-08-21T00:00:00.000Z",
		cwd: "/fixture/repo",
	},
];

let parentTurnId = null;
let sequence = 0;

function timestamp() {
	sequence += 1;
	return `2026-08-21T00:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}.000Z`;
}

function body(label, lines = 72) {
	return Array.from(
		{ length: lines },
		(_, index) => `${label} fixture line ${String(index + 1).padStart(3, "0")} contains deterministic replay evidence.`,
	).join("\n");
}

const turns = [
	{ label: "initial a read", tool: "read", args: { path: "src/a.ts" }, text: body("a-v1") },
	{ label: "initial b read", tool: "read", args: { path: "src/b.ts" }, text: body("b-v1") },
	{
		label: "discover files",
		tool: "find",
		args: { path: ".", pattern: "src/*.ts" },
		text: "src/c.ts\nsrc/d.ts",
	},
	{ label: "consume c", tool: "read", args: { path: "src/c.ts" }, text: body("c-v1") },
	{ label: "re-read a", tool: "read", args: { path: "src/a.ts" }, text: body("a-v1-again") },
	{
		label: "edit b",
		tool: "edit",
		args: { path: "src/b.ts", edits: [{ oldText: "x", newText: "y" }] },
		text: body("b-edited", 24),
	},
	{
		label: "missing read fails",
		tool: "read",
		args: { path: "src/missing.ts" },
		text: "ENOENT: src/missing.ts was not generated yet",
		isError: true,
	},
	{ label: "missing read succeeds", tool: "read", args: { path: "src/missing.ts" }, text: body("missing-now-present") },
	{ label: "read e", tool: "read", args: { path: "src/e.ts" }, text: body("e-v1") },
	{ label: "consume d", tool: "read", args: { path: "src/d.ts" }, text: body("d-v1") },
	{ label: "read f", tool: "read", args: { path: "src/f.ts" }, text: body("f-v1") },
	{
		label: "edit e",
		tool: "edit",
		args: { path: "src/e.ts", edits: [{ oldText: "before", newText: "after" }] },
		text: body("e-edited", 24),
	},
	{ label: "read g", tool: "read", args: { path: "src/g.ts" }, text: body("g-v1") },
	{ label: "read h", tool: "read", args: { path: "src/h.ts" }, text: body("h-v1") },
	{ label: "read i", tool: "read", args: { path: "src/i.ts" }, text: body("i-v1") },
];

for (let index = 0; index < turns.length; index += 1) {
	const turn = turns[index];
	const number = String(index + 1).padStart(2, "0");
	const userId = `user-${number}`;
	const callEntryId = `call-entry-${number}`;
	const callId = `tool-call-${number}`;
	const resultId = `result-${number}`;
	entries.push({
		kind: "message",
		turnId: userId,
		parentTurnId,
		timestamp: timestamp(),
		role: "user",
		payload: { text: turn.label },
	});
	entries.push({
		kind: "message",
		turnId: callEntryId,
		parentTurnId: userId,
		timestamp: timestamp(),
		role: "tool_call",
		payload: { toolCallId: callId, name: turn.tool, args: turn.args },
	});
	entries.push({
		kind: "message",
		turnId: resultId,
		parentTurnId: callEntryId,
		timestamp: timestamp(),
		role: "tool_result",
		payload: {
			toolCallId: callId,
			toolName: turn.tool,
			result: { content: [{ type: "text", text: turn.text }] },
			isError: turn.isError === true,
		},
	});
	parentTurnId = resultId;
}

writeFileSync(output, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
process.stdout.write(`${output}\n`);
