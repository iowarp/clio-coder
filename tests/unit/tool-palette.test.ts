import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { MODE_MATRIX } from "../../src/domains/modes/matrix.js";
import { resolveToolPalette } from "../../src/tools/palette.js";

function defaultPalette(text: string, overrides: Partial<Parameters<typeof resolveToolPalette>[0]> = {}) {
	return resolveToolPalette({
		mode: "default",
		providerSupportsTools: true,
		userText: text,
		availableTools: Array.from(MODE_MATRIX.default.tools),
		...overrides,
	});
}

describe("tool palette resolver", () => {
	it("exposes no tools for small talk", () => {
		const result = defaultPalette("hi");
		strictEqual(result.intent, "small_talk");
		deepStrictEqual(result.activeTools, []);
	});

	it("exposes no tools for tool-surface meta questions", () => {
		for (const text of ["what tools do you have access to?", "list all toolsl", "describe the tool palette"]) {
			const result = defaultPalette(text);
			strictEqual(result.intent, "small_talk");
			deepStrictEqual(result.activeTools, []);
		}
	});

	it("exposes no tools for explicit no-tool replies", () => {
		for (const text of [
			"Do not use tools. Reply with exactly: ok",
			"Answer without tool calls: ok",
			"no tools, just say ok",
		]) {
			const result = defaultPalette(text);
			strictEqual(result.intent, "small_talk");
			deepStrictEqual(result.activeTools, []);
		}
	});

	it("exposes orientation, locate, inspect, and codewiki tools for repo inspection", () => {
		const result = defaultPalette("inspect this repo and explain the entry points");
		const tools = new Set(result.activeTools);
		for (const tool of [
			ToolNames.WorkspaceContext,
			ToolNames.GitStatus,
			ToolNames.EntryPoints,
			ToolNames.WhereIs,
			ToolNames.FindSymbol,
			ToolNames.Find,
			ToolNames.Glob,
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.Ls,
			ToolNames.GitDiff,
			ToolNames.GitLog,
		]) {
			ok(tools.has(tool), `${tool} missing`);
		}
		ok(!tools.has(ToolNames.Edit));
		ok(!tools.has(ToolNames.Bash));
	});

	it("adds mutate tools for edit requests", () => {
		const result = defaultPalette("fix the parser and update the tests");
		const tools = new Set(result.activeTools);
		ok(tools.has(ToolNames.Edit));
		ok(tools.has(ToolNames.Write));
		ok(!tools.has(ToolNames.Bash));
	});

	it("keeps tools active when coding prompt says not to describe tool-call syntax", () => {
		const result = defaultPalette(
			"Fix src/math.js with the smallest targeted change. Run npm test first, edit only src/math.js, then run npm test again. Requirements: even-length medians average the two middle values, median must not mutate caller input, and summarize should pass. Do not describe tool-call syntax; call tools directly.",
		);
		const tools = new Set(result.activeTools);
		strictEqual(result.intent, "coding");
		strictEqual(result.phase, "validation");
		ok(tools.has(ToolNames.Edit));
		ok(tools.has(ToolNames.Write));
		ok(tools.has(ToolNames.RunTests));
		ok(tools.has(ToolNames.PackageScript));
		ok(!tools.has(ToolNames.Bash));
	});

	it("keeps tools active when real work asks to report tool usage", () => {
		const result = defaultPalette(
			"Inspect package.json and src/math.js, then run npm test. Do not edit files. Report what tools you used and the final test result.",
		);
		const tools = new Set(result.activeTools);
		strictEqual(result.intent, "coding");
		strictEqual(result.phase, "validation");
		ok(tools.has(ToolNames.Read));
		ok(tools.has(ToolNames.RunTests));
	});

	it("does not treat no-tool-prose wording as a no-tool request", () => {
		const result = defaultPalette("Use no tool prose. Read src/math.js and summarize it.");
		const tools = new Set(result.activeTools);
		strictEqual(result.intent, "repo_inspection");
		ok(tools.has(ToolNames.Read));
	});

	it("does not expose bash when the user asks to avoid bash", () => {
		const result = defaultPalette("Run npm test without using bash if possible; inspect failures and fix them.");
		const tools = new Set(result.activeTools);
		strictEqual(result.intent, "coding");
		strictEqual(result.phase, "validation");
		ok(tools.has(ToolNames.RunTests));
		ok(!tools.has(ToolNames.Bash));
	});

	it("adds validation tools after recent edits", () => {
		const result = defaultPalette("continue", { recentToolNames: [ToolNames.Edit] });
		const tools = new Set(result.activeTools);
		ok(tools.has(ToolNames.RunTests));
		ok(tools.has(ToolNames.RunLint));
		ok(tools.has(ToolNames.RunBuild));
		ok(tools.has(ToolNames.PackageScript));
		ok(tools.has(ToolNames.ValidateFrontend));
		strictEqual(result.phase, "post_edit");
	});

	it("adds dispatch only for delegation intent", () => {
		const result = defaultPalette("use subagents to audit the tool execution path");
		ok(new Set(result.activeTools).has(ToolNames.Dispatch));
		ok(!new Set(defaultPalette("audit the repo").activeTools).has(ToolNames.Dispatch));
	});

	it("adds web_fetch for external research intent", () => {
		const result = defaultPalette("fetch https://example.com and summarize it");
		ok(new Set(result.activeTools).has(ToolNames.WebFetch));
	});

	it("adds skill tools for skill requests and create_skill only for creation", () => {
		const readOnly = new Set(defaultPalette("read the clio-testing skill").activeTools);
		ok(readOnly.has(ToolNames.ReadSkill));
		ok(!readOnly.has(ToolNames.CreateSkill));

		const create = new Set(defaultPalette("create a skill for release verification").activeTools);
		ok(create.has(ToolNames.ReadSkill));
		ok(create.has(ToolNames.CreateSkill));
	});

	it("uses advise-safe read tools and advise writers without bash/edit/write", () => {
		const result = defaultPalette("review this change", {
			mode: "advise",
			availableTools: Array.from(MODE_MATRIX.advise.tools),
		});
		const tools = new Set(result.activeTools);
		ok(tools.has(ToolNames.Read));
		ok(tools.has(ToolNames.Grep));
		ok(tools.has(ToolNames.WritePlan));
		ok(tools.has(ToolNames.WriteReview));
		ok(!tools.has(ToolNames.Bash));
		ok(!tools.has(ToolNames.Edit));
		ok(!tools.has(ToolNames.Write));
	});

	it("exposes zero tools for providers without tool support", () => {
		const result = defaultPalette("edit src/index.ts", { providerSupportsTools: false });
		deepStrictEqual(result.activeTools, []);
		ok(result.omittedToolCount > 0);
	});
});
