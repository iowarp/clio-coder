import { match } from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";

test("no-edit convention scope reaches full-auto prompts with mutation tools available", () => {
	const prompt = compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.yolo",
		sessionInputs: {
			providerSupportsTools: true,
			toolNames: ["read", "edit", "write", "bash", "dispatch"],
			memorySection: "",
		},
	}).systemPrompt;
	match(prompt, /"Do not edit files" includes CLIO-CODER\.md and all repository files/u);
	match(prompt, /Full-auto capability does not expand task scope/u);
	match(prompt, /handoff export, shell write, or delegated\nedit/u);
	match(prompt, /If the entry is absent, report that limit/u);
	match(prompt, /where writes\nare authorized/u);
	match(prompt, /unapproved proposal/u);
	match(prompt, /approval of an unseen record/u);
	match(prompt, /only from delivery of the matching approved\nrecord/u);
});
