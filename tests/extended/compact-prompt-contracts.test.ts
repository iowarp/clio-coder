import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOL_NAMES, type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { TurnConstraints } from "../../src/core/turn-constraints.js";
import { type CompiledSessionPrompt, compile, compileWorker } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";

const table = loadFragments();
const autonomyLevels: ReadonlyArray<AutonomyLevel> = ["default", "yolo"];

function mainPrompt(autonomy: AutonomyLevel, toolNames: ReadonlyArray<ToolName>): CompiledSessionPrompt {
	return compile(table, {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${autonomy}`,
		sessionInputs: {
			provider: "dynamo",
			model: "qwen3.8-27b",
			contextWindow: 262_144,
			providerSupportsTools: true,
			thinkingGuidance:
				"For this local model, reason compactly before tool use and ground final claims in observed evidence.",
			toolNames,
			coordinatorCapabilities: ALL_TOOL_NAMES,
		},
	});
}

function workerPrompt(turnConstraints?: TurnConstraints): CompiledSessionPrompt {
	const toolNames = [ToolNames.Read, ToolNames.Context, ToolNames.CodeNav];
	const body =
		'# Matrix worker\n\nReturn `{"mutatedPaths":[],"validations":[{"name":"read","passed":true,"evidence":"observed"}]}`.';
	return compileWorker(table, {
		...(turnConstraints ? { turnConstraints } : {}),
		providerSupportsTools: true,
		toolNames,
		toolPromptHints: toolPromptHintsForNames(toolNames, "worker"),
		hasCanonicalContext: true,
		hasBoundSkills: false,
		onPermission: "fail",
		persona: { id: "persona.matrix", relPath: "inline/matrix", body, contentHash: sha256(body), dynamic: false },
	});
}

describe("compact prompt contracts", () => {
	it("keeps main composition deterministic across autonomy and tool input order", () => {
		const tools = [
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.CodeNav,
			ToolNames.Context,
			ToolNames.Git,
			ToolNames.Verify,
			ToolNames.Dispatch,
		];
		for (const autonomy of autonomyLevels) {
			const forward = mainPrompt(autonomy, tools);
			const reversed = mainPrompt(autonomy, [...tools].reverse());
			strictEqual(forward.systemPrompt, reversed.systemPrompt, `${autonomy} prompt must ignore registry order`);
			strictEqual(forward.systemPromptHash, reversed.systemPromptHash);
			deepStrictEqual(
				forward.sections.map((section) => section.id),
				[
					"identity",
					"operating-contract",
					"delegation",
					"skills",
					"safety",
					"tool-contract",
					"harness-awareness",
					"retrieval-hints",
					"runtime",
				],
			);
			match(forward.systemPrompt, new RegExp(`Autonomy: ${autonomy}\\.`, "u"));
			strictEqual(forward.systemPrompt.includes("There is no read-only posture"), false);
		}
	});
});

// Which sections each tool surface and worker posture renders is pinned in
// tests/contracts/prompt-section-matrix.test.ts.
it("worker scope changes leave its constitutional prefix and assigned-task role stable", () => {
	const base = workerPrompt();
	const scoped = workerPrompt({ mode: "answer", allowedTools: [], skills: "disabled" });
	deepStrictEqual(scoped.stablePrefix, base.stablePrefix);
	strictEqual(
		scoped.systemPrompt.slice(0, scoped.systemPrompt.indexOf("# Tool Contract")),
		base.systemPrompt.slice(0, base.systemPrompt.indexOf("# Tool Contract")),
	);
	// #423: the scope rides in the worker's task messages, not its compiled prompt.
	strictEqual(scoped.systemPrompt.includes("# Current task scope"), false);
	strictEqual(
		scoped.sections.some((section) => section.id === "delegation" || section.id === "skills"),
		false,
	);
});
