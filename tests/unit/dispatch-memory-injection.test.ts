import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { buildSystemPrompt } from "../../src/domains/dispatch/extension.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";

describe("dispatch/validation memorySection", () => {
	it("accepts memorySection when it is a non-empty string", () => {
		const v = validateJobSpec({ agentId: "coder", task: "fix bug", memorySection: "# Memory\n\nlesson" });
		ok(v.ok);
		if (v.ok) strictEqual(v.spec.memorySection, "# Memory\n\nlesson");
	});

	it("accepts an empty memorySection (treated as no-op upstream)", () => {
		const v = validateJobSpec({ agentId: "coder", task: "fix bug", memorySection: "" });
		ok(v.ok);
		if (v.ok) strictEqual(v.spec.memorySection, "");
	});

	it("rejects a non-string memorySection with the documented error message", () => {
		const v = validateJobSpec({ agentId: "coder", task: "fix bug", memorySection: 42 });
		strictEqual(v.ok, false);
		if (!v.ok) ok(v.errors.includes("memorySection must be a string"));
	});

	it("still rejects unknown keys (drift guard)", () => {
		const v = validateJobSpec({ agentId: "coder", task: "fix bug", mystery: "x" });
		strictEqual(v.ok, false);
		if (!v.ok) ok(v.errors.some((e) => e.includes("unknown key")));
	});
});

describe("dispatch/extension buildSystemPrompt", () => {
	const baseRecipe: AgentRecipe = {
		id: "scout",
		name: "scout",
		description: "test recipe",
		body: "RECIPE BODY",
		mode: "advise",
		tools: [],
		skills: [],
		runtime: "native",
		source: "builtin",
		filepath: "/builtin/scout.md",
	};

	it("prepends a non-empty memorySection to the recipe body with a blank-line separator", () => {
		const req: DispatchRequest = {
			agentId: "scout",
			task: "look",
			memorySection: "# Memory\n\nlesson alpha",
		};
		const out = buildSystemPrompt(req, baseRecipe);
		strictEqual(out, "# Memory\n\nlesson alpha\n\nRECIPE BODY");
	});

	it("prepends memorySection to req.systemPrompt when both are set, ignoring recipe body", () => {
		const req: DispatchRequest = {
			agentId: "scout",
			task: "look",
			memorySection: "# Memory\n\nlesson beta",
			systemPrompt: "OVERRIDE PROMPT",
		};
		const out = buildSystemPrompt(req, baseRecipe);
		strictEqual(out, "# Memory\n\nlesson beta\n\nOVERRIDE PROMPT");
	});

	it("returns the base prompt unchanged when memorySection is undefined", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look" };
		const out = buildSystemPrompt(req, baseRecipe);
		strictEqual(out, "RECIPE BODY");
	});

	it("returns the base prompt unchanged when memorySection is the empty string", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look", memorySection: "" };
		const out = buildSystemPrompt(req, baseRecipe);
		strictEqual(out, "RECIPE BODY");
	});

	it("treats whitespace-only memorySection as empty (no separator, no prefix)", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look", memorySection: "   \n\t  " };
		const out = buildSystemPrompt(req, baseRecipe);
		strictEqual(out, "RECIPE BODY");
	});

	it("falls back to empty string when neither systemPrompt, recipe, nor memorySection are present", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look" };
		const out = buildSystemPrompt(req, null);
		strictEqual(out, "");
	});
});
