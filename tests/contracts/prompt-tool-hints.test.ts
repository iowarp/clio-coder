import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import { compile, compileWorker, type RenderedPromptFragment } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";
import { resolveToolPromptHint } from "../../src/tools/registry.js";

function hintFor(tool: string, role: "session" | "worker" | "bound-worker"): string {
	return toolPromptHintsForNames([tool as never], role).find((entry) => entry.tool === tool)?.hint ?? "";
}

function rolePrompt(
	role: "session" | "worker" | "bound-worker",
	toolNames: ReadonlyArray<never>,
	toolPromptHints: ReadonlyArray<{ tool: string; hint: string }>,
): string {
	const table = loadFragments();
	if (role === "session") {
		return compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { providerSupportsTools: true, toolNames, toolPromptHints },
		}).systemPrompt;
	}
	const persona: RenderedPromptFragment = {
		id: "persona.hint-order",
		relPath: "inline/hint-order",
		body: "# Hint order worker\n\nReturn the requested result.",
		contentHash: sha256("# Hint order worker\n\nReturn the requested result."),
		dynamic: false,
	};
	return compileWorker(table, {
		autonomy: "auto-edit",
		providerSupportsTools: true,
		toolNames,
		toolPromptHints,
		hasCanonicalContext: true,
		hasBoundSkills: role === "bound-worker",
		onPermission: "fail",
		persona,
	}).systemPrompt;
}

describe("role-aware prompt hints", () => {
	it("separates session, unbound-worker, and bound-worker skill policy", () => {
		const session = hintFor(ToolNames.Context, "session");
		const worker = hintFor(ToolNames.Context, "worker");
		const boundWorker = hintFor(ToolNames.Context, "bound-worker");

		match(session, /explicit pending skill request/u);
		strictEqual(session.includes("harness performs any install"), false);
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

	it("keeps reversed and duplicate inputs equivalent for every prompt role", () => {
		const toolNames = [ToolNames.Context, ToolNames.Read, ToolNames.CodeNav, ToolNames.Context] as never[];
		const hints = [
			{ tool: ToolNames.Context, hint: "  Shared\n role guidance " },
			{ tool: ToolNames.CodeNav, hint: "Shared role guidance" },
			{ tool: ToolNames.Context, hint: "Shared role guidance" },
		];
		for (const role of ["session", "worker", "bound-worker"] as const) {
			const forwardHints = toolPromptHintsForNames(toolNames, role);
			const reversedHints = toolPromptHintsForNames([...toolNames].reverse(), role);
			deepStrictEqual(forwardHints, reversedHints, `${role} registry hints must ignore tool input order and duplicates`);

			const forward = rolePrompt(role, toolNames, hints);
			const reversed = rolePrompt(role, [...toolNames].reverse(), [...hints].reverse());
			strictEqual(forward, reversed, `${role} compiler bytes must ignore tool/hint input order and duplicates`);
			strictEqual(forward.split("Shared role guidance").length - 1, 1);
		}
	});
});
