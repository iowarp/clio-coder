import { match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";
import { resolveToolPromptHint } from "../../src/tools/registry.js";

function hintFor(tool: string, role: "session" | "worker" | "bound-worker"): string {
	return toolPromptHintsForNames([tool as never], role).find((entry) => entry.tool === tool)?.hint ?? "";
}

describe("role-aware prompt hints", () => {
	it("separates session, unbound-worker, and bound-worker skill policy", () => {
		const session = hintFor(ToolNames.Context, "session");
		const worker = hintFor(ToolNames.Context, "worker");
		const boundWorker = hintFor(ToolNames.Context, "bound-worker");

		match(session, /explicit pending skill request/u);
		match(session, /harness performs any install/u);
		strictEqual(session.includes("harness-activated recipe-bound"), false);
		match(worker, /no operator skill-activation channel/u);
		strictEqual(worker.includes("Marketplace"), false);
		match(boundWorker, /harness-activated recipe-bound skills/u);
		match(boundWorker, /cannot install or suggest marketplace skills/u);
		strictEqual(boundWorker.includes("explicit pending skill request"), false);
	});

	it("advertises only the closed code_nav sources", () => {
		const hint = hintFor(ToolNames.CodeNav, "session");
		match(hint, /source=workspace \(default\)/u);
		match(hint, /source=clio/u);
		match(hint, /wiki \(workspace only\)/u);
	});

	it("normalizes role variants to one stable line", () => {
		strictEqual(resolveToolPromptHint({ session: "  First\n\n  second\tthird  " }, "session"), "First second third");
		strictEqual(resolveToolPromptHint({ session: "main only" }, "worker"), undefined);
	});

	it("renders no hint or capability prose for tools absent from the attached names", () => {
		const table = loadFragments();
		const compiled = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				providerSupportsTools: true,
				toolNames: [ToolNames.Read],
				toolPromptHints: [
					{ tool: ToolNames.Context, hint: "ABSENT_CONTEXT_HINT" },
					{ tool: ToolNames.Dispatch, hint: "ABSENT_DISPATCH_HINT" },
				],
				fleetRoster: "# Fleet\n\nABSENT_FLEET",
			},
		});

		strictEqual(compiled.systemPrompt.includes("ABSENT_CONTEXT_HINT"), false);
		strictEqual(compiled.systemPrompt.includes("ABSENT_DISPATCH_HINT"), false);
		strictEqual(compiled.systemPrompt.includes("ABSENT_FLEET"), false);
		strictEqual(compiled.systemPrompt.includes('context(scope="skills")'), false);
		strictEqual(compiled.systemPrompt.includes("workers behind dispatch"), false);
	});

	it("sorts, normalizes, and exact-deduplicates equivalent hint inputs", () => {
		const table = loadFragments();
		const forward = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				providerSupportsTools: true,
				toolNames: [ToolNames.Read, ToolNames.Grep],
				toolPromptHints: [
					{ tool: ToolNames.Read, hint: "  Shared\n guidance  " },
					{ tool: ToolNames.Grep, hint: "Shared guidance" },
				],
			},
		});
		const reversed = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				providerSupportsTools: true,
				toolNames: [ToolNames.Grep, ToolNames.Read],
				toolPromptHints: [
					{ tool: ToolNames.Grep, hint: "Shared guidance" },
					{ tool: ToolNames.Read, hint: "  Shared\n guidance  " },
				],
			},
		});

		strictEqual(forward.systemPrompt, reversed.systemPrompt);
		strictEqual(forward.systemPrompt.split("Shared guidance").length - 1, 1);
	});
});
