import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { dynamicToolName, type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { MODE_MATRIX } from "../../src/domains/modes/matrix.js";
import { applyToolProfile, isToolProfileName, toolProfileToolNames } from "../../src/tools/profiles.js";

describe("tool profiles", () => {
	it("recognizes only the shipped profile names", () => {
		strictEqual(isToolProfileName("minimal-local"), true);
		strictEqual(isToolProfileName("science-local"), true);
		strictEqual(isToolProfileName("full-agent"), true);
		strictEqual(isToolProfileName("unknown-profile"), false);
	});

	it("keeps full-agent as the current broad tool surface", () => {
		const defaultTools = [...MODE_MATRIX.default.tools];
		deepStrictEqual(applyToolProfile(defaultTools, "full-agent"), defaultTools);
		deepStrictEqual(toolProfileToolNames("full-agent"), null);
	});

	it("narrows minimal-local to local read and navigation tools only", () => {
		const filtered: ReadonlyArray<ToolName> = applyToolProfile([...MODE_MATRIX.default.tools], "minimal-local");
		const filteredSet = new Set<ToolName>(filtered);

		deepStrictEqual(filtered, [
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.Find,
			ToolNames.Glob,
			ToolNames.Ls,
			ToolNames.GitStatus,
			ToolNames.GitDiff,
			ToolNames.GitLog,
			ToolNames.WorkspaceContext,
			ToolNames.FindSymbol,
			ToolNames.EntryPoints,
			ToolNames.WhereIs,
		]);
		strictEqual(filteredSet.has(ToolNames.Write), false);
		strictEqual(filteredSet.has(ToolNames.Bash), false);
		strictEqual(filteredSet.has(ToolNames.WebFetch), false);
	});

	it("adds validation commands for science-local without adding general write or shell tools", () => {
		const filtered: ReadonlyArray<ToolName> = applyToolProfile([...MODE_MATRIX.default.tools], "science-local");

		strictEqual(filtered.includes(ToolNames.RunTests), true);
		strictEqual(filtered.includes(ToolNames.RunLint), true);
		strictEqual(filtered.includes(ToolNames.RunBuild), true);
		strictEqual(filtered.includes(ToolNames.PackageScript), true);
		strictEqual(filtered.includes(ToolNames.Write), false);
		strictEqual(filtered.includes(ToolNames.Edit), false);
		strictEqual(filtered.includes(ToolNames.Bash), false);
	});

	it("never expands the caller-supplied tool list", () => {
		const input: ToolName[] = [ToolNames.Read, ToolNames.Read, dynamicToolName("custom_dynamic")];

		deepStrictEqual(applyToolProfile(input, undefined), [ToolNames.Read, dynamicToolName("custom_dynamic")]);
		deepStrictEqual(applyToolProfile(input, "minimal-local"), [ToolNames.Read]);
	});
});
