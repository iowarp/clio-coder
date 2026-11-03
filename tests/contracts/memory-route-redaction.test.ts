import { deepStrictEqual, doesNotMatch, match, ok } from "node:assert/strict";
import { it } from "node:test";
import { completedLessonSource } from "../../src/domains/memory/history-review.js";
import type { SessionEntry } from "../../src/domains/session/index.js";

const entry = (turnId: string, role: string, payload: unknown): SessionEntry =>
	({
		kind: "message",
		turnId,
		parentTurnId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		role,
		payload,
	}) as SessionEntry;

const task = (command: string, id: string): SessionEntry[] => [
	entry(`${id}-u`, "user", {
		text: `run it, key AKIAIOSFODNN7EXAMPLE`,
		operatorText: "run it, key AKIAIOSFODNN7EXAMPLE",
	}),
	entry(`${id}-c`, "tool_call", { toolCallId: id, name: "bash", args: { command } }),
	entry(`${id}-r`, "tool_result", {
		toolCallId: id,
		outcome: "ok",
		result: { content: [{ type: "text", text: "done" }], details: { kind: "ok", outcome: "success", exitCode: 0 } },
	}),
	entry(`${id}-a`, "assistant", { text: "done", stopReason: "stop" }),
];

it("keeps bare secrets from a memory route without letting redacted text ground a lesson", () => {
	const secret = completedLessonSource(task("node scripts/deploy.mjs AKIAIOSFODNN7EXAMPLE", "secret"), "/repo");
	ok(secret);
	doesNotMatch(secret.text, /AKIAIOSFODNN7EXAMPLE/);
	match(secret.text, /ok: node scripts\/deploy\.mjs \[redacted:aws-access-key\]/);
	deepStrictEqual([...secret.succeededCommands], [], "text the operator never ran proves nothing");

	const reference = "API_TOKEN=$API_TOKEN node scripts/deploy.mjs";
	const named = completedLessonSource(task(reference, "named"), "/repo");
	ok(named);
	match(named.text, /ok: API_TOKEN=\$API_TOKEN node scripts\/deploy\.mjs/);
	deepStrictEqual([...named.succeededCommands], [reference], "a variable reference holds no credential");
});
