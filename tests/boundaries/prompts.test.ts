import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { runPromptCheck } from "./check-prompts.js";

const PROJECT_ROOT = new URL("../..", import.meta.url).pathname;

describe("prompt fragments", () => {
	it("every fragment has valid frontmatter, unique id, and fits its budget", () => {
		const result = runPromptCheck(PROJECT_ROOT);
		if (result.errors.length > 0) {
			console.error("Prompt errors:");
			for (const e of result.errors) console.error(`  - ${e}`);
		}
		strictEqual(result.errors.length, 0);
		ok(result.fragments.length > 0, "no fragments discovered — did the fragments dir move?");
	});
});
