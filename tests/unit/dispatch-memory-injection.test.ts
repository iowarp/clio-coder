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

	it("appends a non-empty memorySection after the stable dispatch contract and recipe body", () => {
		const req: DispatchRequest = {
			agentId: "scout",
			task: "look",
			memorySection: "# Memory\n\nlesson alpha",
		};
		const out = buildSystemPrompt(req, baseRecipe);
		ok(out.startsWith("# Dispatch Task Contract"));
		ok(out.includes("\n\nRECIPE BODY\n\n# Memory\n\nlesson alpha"));
		ok(out.indexOf("# Dispatch Task Contract") < out.indexOf("# Memory"), out);
	});

	it("appends memorySection to req.systemPrompt when both are set, ignoring recipe body", () => {
		const req: DispatchRequest = {
			agentId: "scout",
			task: "look",
			memorySection: "# Memory\n\nlesson beta",
			systemPrompt: "OVERRIDE PROMPT",
		};
		const out = buildSystemPrompt(req, baseRecipe);
		ok(out.startsWith("# Dispatch Task Contract"));
		ok(out.includes("\n\nOVERRIDE PROMPT\n\n# Memory\n\nlesson beta"));
		strictEqual(out.includes("RECIPE BODY"), false);
	});

	it("wraps the base prompt with the dispatch task contract when memorySection is undefined", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look" };
		const out = buildSystemPrompt(req, baseRecipe);
		ok(out.startsWith("# Dispatch Task Contract"));
		ok(out.includes("The assigned task is authoritative"));
		ok(out.endsWith("\n\nRECIPE BODY"));
	});

	it("wraps the base prompt when memorySection is the empty string", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look", memorySection: "" };
		const out = buildSystemPrompt(req, baseRecipe);
		ok(out.startsWith("# Dispatch Task Contract"));
		ok(out.endsWith("\n\nRECIPE BODY"));
	});

	it("treats whitespace-only memorySection as empty (no separator, no prefix)", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look", memorySection: "   \n\t  " };
		const out = buildSystemPrompt(req, baseRecipe);
		ok(out.startsWith("# Dispatch Task Contract"));
		ok(out.endsWith("\n\nRECIPE BODY"));
	});

	it("falls back to the dispatch task contract when neither systemPrompt, recipe, nor memorySection are present", () => {
		const req: DispatchRequest = { agentId: "scout", task: "look" };
		const out = buildSystemPrompt(req, null);
		ok(out.startsWith("# Dispatch Task Contract"));
		ok(out.includes("Do not invent a different task"));
	});
});
