import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { agentSpecPolicyErrors, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { resolveAgentTools } from "../../src/engine/worker-tools.js";
import { createAskUserTool, normalizeAskUserCall } from "../../src/tools/ask-user.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { resolveToolPalette } from "../../src/tools/palette.js";
import { createRegistry } from "../../src/tools/registry.js";

const ALL_TOOLS = Object.values(ToolNames) as ToolName[];

function allowReadSafety() {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

describe("contracts/ask_user", () => {
	it("normalizes ask rounds to one through four questions", () => {
		const oneQuestion = normalizeAskUserCall({ questions: [{ question: "Pick a direction?" }] });
		const zeroQuestions = normalizeAskUserCall({ questions: [] });
		const fiveQuestions = normalizeAskUserCall({
			questions: [
				{ question: "one" },
				{ question: "two" },
				{ question: "three" },
				{ question: "four" },
				{ question: "five" },
			],
		});
		const complete = normalizeAskUserCall({ action: "complete", decisions: [{ key: "scope", value: "minimal" }] });

		strictEqual(oneQuestion.error, undefined);
		strictEqual(zeroQuestions.error, "questions must contain at least 1 item");
		strictEqual(fiveQuestions.error, "questions must contain at most 4 items");
		strictEqual(complete.call?.action, "complete");
	});

	it("direct fallback handler returns cancelled without blocking", async () => {
		const tool = createAskUserTool();
		const startedAt = Date.now();
		const result = await tool.run({
			questions: [
				{
					question: "Which implementation should be assumed?",
					options: [{ label: "Use the recommended implementation", description: "Proceed without operator input." }],
				},
			],
		});

		strictEqual(result.kind, "ok");
		strictEqual(Date.now() - startedAt < 100, true);
		ok(result.output.includes("ask_user result: cancelled"));
		const details = result.details as
			| { answers?: unknown[]; cancelled?: true; interview?: { status?: string } }
			| undefined;
		deepStrictEqual(details?.answers, []);
		strictEqual(details?.cancelled, true);
		strictEqual(details?.interview?.status, "cancelled");
	});

	it("bootstrap registers ask_user only when an interactive handler is supplied", () => {
		const safety = allowReadSafety();
		const headless = createRegistry({ safety });
		registerAllTools(headless);
		strictEqual(headless.listRegistered().includes(ToolNames.AskUser), false);

		const interactive = createRegistry({ safety });
		registerAllTools(interactive, { askUser: async () => ({ answers: [] }) });
		strictEqual(interactive.listRegistered().includes(ToolNames.AskUser), true);
	});

	it("policy errors fire for recipes declaring ask_user", () => {
		const spec = normalizeAgentSpec({
			id: "interviewer",
			name: "Interviewer",
			description: "Invalid worker recipe.",
			tools: ["read", "ask_user"],
			category: "explore",
			capabilityClass: "read-only",
			source: "project",
			filepath: "/tmp/interviewer.md",
			body: "# Interviewer",
		});

		const errors = agentSpecPolicyErrors(spec);
		strictEqual(errors.length, 1);
		match(errors[0] ?? "", /ask_user, which is only available to the orchestrator/);
	});

	it("worker tool assembly filters ask_user even when requested", () => {
		const registry = createRegistry({ safety: allowReadSafety() });
		registerAllTools(registry, { askUser: async () => ({ answers: [] }) });
		const tools = resolveAgentTools({
			registry,
			allowedTools: [ToolNames.AskUser],
			includeInteractiveTools: false,
		}).map((tool) => tool.name);

		strictEqual(tools.includes(ToolNames.AskUser), false);
	});

	it("plain interview phrasing does not expose read_skill or ask_user", () => {
		const palette = resolveToolPalette({
			providerSupportsTools: true,
			availableTools: ALL_TOOLS,
			userText: "grill me on the plugin design",
		});

		strictEqual(palette.activeTools.includes(ToolNames.ReadSkill), false);
		strictEqual(palette.activeTools.includes(ToolNames.AskUser), false);
	});

	it("explicit ask_user interview requests expose only ask_user", () => {
		const compact = resolveToolPalette({
			providerSupportsTools: true,
			availableTools: ALL_TOOLS,
			userText: "using your ask_user tool interview me about new skills added to clio coder",
		});
		deepStrictEqual(compact.activeTools, [ToolNames.AskUser]);

		const spaced = resolveToolPalette({
			providerSupportsTools: true,
			availableTools: ALL_TOOLS,
			userText: "interview me about the plugin design",
		});
		deepStrictEqual(spaced.activeTools, [ToolNames.AskUser]);
	});

	it("pending skill requests expose only read_skill and ask_user before the skill workflow starts", () => {
		const palette = resolveToolPalette({
			providerSupportsTools: true,
			availableTools: ALL_TOOLS,
			userText: "about adding more science skills to clio coder",
			pendingSkillRequests: [
				{
					name: "grill-me",
					args: "about adding more science skills to clio coder",
					source: "slash-command",
					installed: true,
				},
			],
		});

		deepStrictEqual([...palette.activeTools].sort(), [ToolNames.AskUser, ToolNames.ReadSkill].sort());
		strictEqual(palette.activeTools.includes(ToolNames.Write), false);
		strictEqual(palette.activeTools.includes(ToolNames.Edit), false);
		strictEqual(palette.activeTools.includes(ToolNames.WhereIs), false);
	});
});
