#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const output = join(dirname(fileURLToPath(import.meta.url)), "claude-code-01.jsonl");
const records = [];
const sessionId = "claude-code-replay-fixture-01";
let sequence = 0;

function timestamp() {
	sequence += 1;
	return `2026-08-21T01:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function common(type, extra = {}) {
	const index = records.length + 1;
	return {
		type,
		sessionId,
		uuid: `raw-${String(index).padStart(3, "0")}`,
		parentUuid: index === 1 ? null : `raw-${String(index - 1).padStart(3, "0")}`,
		timestamp: timestamp(),
		cwd: "/fixture/claude-code-repo",
		isSidechain: false,
		...extra,
	};
}

function user(content, extra = {}) {
	records.push(common("user", { message: { role: "user", content }, ...extra }));
}

function assistant(content) {
	records.push(
		common("assistant", {
			message: {
				role: "assistant",
				model: "claude-fixture",
				content,
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cache_read_input_tokens: 80,
					cache_creation_input_tokens: 5,
				},
			},
		}),
	);
}

function body(label, lines = 64) {
	return Array.from(
		{ length: lines },
		(_, index) => `${label} line ${String(index + 1).padStart(3, "0")} is deterministic Claude Code replay evidence.`,
	).join("\n");
}

function toolUse(id, name, input, extraBlocks = []) {
	assistant([...extraBlocks, { type: "tool_use", id, name, input }]);
}

function toolResult(id, content, isError = false) {
	user([{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
}

user("Inspect and update the fixture repository.");
toolUse("tool-read-a", "Read", { file_path: "src/a.ts", offset: 2, limit: 40 }, [
	{ type: "thinking", thinking: "I should inspect a.ts before changing it.", signature: "fixture-signature" },
	{ type: "text", text: "Reading the primary file." },
]);
toolResult("tool-read-a", body("a-v1"));
toolUse("tool-grep", "Grep", {
	pattern: "export",
	path: ".",
	include: "src/*.ts",
	output_mode: "content",
});
toolResult("tool-grep", [{ type: "text", text: "src/b.ts:4:export const b = 1;\nsrc/c.ts:7:export const c = 2;" }]);
toolUse("tool-read-b", "Read", { file_path: "src/b.ts" });
toolResult("tool-read-b", body("b-v1"));
toolUse("tool-read-c", "Read", { file_path: "src/c.ts" });
toolResult("tool-read-c", body("c-v1"));
toolUse("tool-edit-a", "Edit", {
	file_path: "src/a.ts",
	old_string: "before",
	new_string: "after",
});
toolResult("tool-edit-a", "Updated src/a.ts successfully.");
toolUse("tool-reread-a", "Read", { file_path: "src/a.ts" });
toolResult("tool-reread-a", body("a-v2"));
toolUse("tool-bash-fail", "Bash", { command: "npm test -- fixture" });
toolResult("tool-bash-fail", "fixture test failed with exit code 1", true);
toolUse("tool-bash-success", "Bash", { command: "npm test -- fixture" });
toolResult("tool-bash-success", "fixture test passed");
toolUse("tool-read-d", "Read", { file_path: "src/d.ts" });
toolResult("tool-read-d", body("d-v1"));
toolUse("tool-read-e", "Read", { file_path: "src/e.ts" });
toolResult("tool-read-e", body("e-v1"));
toolUse("tool-read-f", "Read", { file_path: "src/f.ts" });
toolResult("tool-read-f", body("f-v1"));
assistant([{ type: "text", text: "The first verification pass is complete." }]);
user("Finish the remaining checks.");
toolUse("tool-read-g", "Read", { file_path: "src/g.ts" });
toolResult("tool-read-g", body("g-v1"));
toolUse("tool-write-h", "Write", { file_path: "src/h.ts", content: "export const h = true;\n" });
toolResult("tool-write-h", "Wrote src/h.ts.");
user("This sidechain-only record must never enter replay.", { isSidechain: true, agentId: "fixture-subagent" });
assistant([{ type: "text", text: "All requested fixture work is complete." }]);

writeFileSync(output, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
process.stdout.write(`${output}\n`);
