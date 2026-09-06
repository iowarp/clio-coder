import { match } from "node:assert/strict";
import { describe, it } from "node:test";
import { compile, compileWorker } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { createDecideTool } from "../../src/tools/decide.js";

describe("decision adherence guidance", () => {
	it("reaches both the session and the worker that may commit the implementation", () => {
		const table = loadFragments();
		const session = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { toolNames: ["decide", "git", "verify"] },
		});
		const worker = compileWorker(table, {
			autonomy: "auto-edit",
			providerSupportsTools: true,
			toolNames: ["git", "verify"],
			toolPromptHints: [],
			hasCanonicalContext: false,
			hasBoundSkills: false,
			onPermission: "deny",
			persona: { id: "fixture", relPath: "inline", body: "Commit the repair.", contentHash: "fixture", dynamic: false },
		});
		for (const { systemPrompt } of [session, worker]) {
			match(systemPrompt, /Before committing, verify the actual implementation against active decisions/u);
			match(systemPrompt, /scalar types as well as indexability/u);
			match(systemPrompt, /trailer proves attribution, not adherence/u);
			match(systemPrompt, /revise an agent choice with the same `decide` key/u);
			match(systemPrompt, /operator choices require operator revision/u);
			match(systemPrompt, /If revision is unavailable, report the mismatch and stop before commit/u);
		}
	});

	it("explains verification and revision ownership when the model selects decide", () => {
		const { description } = createDecideTool();
		match(description, /Verify implementation against the active choice before commit/u);
		match(description, /same key revises your earlier agent choice/u);
		match(description, /operator choices require operator revision/u);
		match(description, /trailers do not prove adherence/u);
	});
});
