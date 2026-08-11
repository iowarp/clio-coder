import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { agentSpecPolicyErrors, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { createAskUserTool, normalizeAskUserCall } from "../../src/tools/ask-user.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { type AskUserToolPolicy, createRegistry } from "../../src/tools/registry.js";
import { agentRecipeFixture } from "../harness/agent-recipe.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

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

function askUserPolicy(maxCalls = 6): AskUserToolPolicy {
	const now = new Date().toISOString();
	return {
		id: "test-ask-user-policy",
		status: "idle",
		startedAt: now,
		updatedAt: now,
		rounds: [],
		decisions: [],
		inFlight: false,
		cancelled: false,
		answerCount: 0,
		callCount: 0,
		maxCalls,
		askedQuestionKeys: new Set<string>(),
	};
}

function askOverlay(rows = 30): {
	session: ReturnType<typeof openAskUserOverlay>;
	child: () => Component;
} {
	let mounted: Component | null = null;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	const tui = {
		terminal: { rows, columns: 120 },
		showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
			mounted = component;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	const session = openAskUserOverlay(tui, { onCancel: () => {} });
	return {
		session,
		child: () => {
			if (!mounted) throw new Error("ask-user overlay was not mounted");
			return (mounted as unknown as { child: Component }).child;
		},
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

	it("normalizes single-question interview mode and bounded max_rounds", () => {
		const single = normalizeAskUserCall({
			mode: "single-question",
			max_rounds: 12,
			questions: [{ question: "What should this optimize for?" }],
		});
		const batched = normalizeAskUserCall({
			mode: "single_question",
			questions: [{ question: "one" }, { question: "two" }],
		});
		const tooManyRounds = normalizeAskUserCall({
			max_rounds: 25,
			questions: [{ question: "Pick a direction?" }],
		});

		strictEqual(single.error, undefined);
		strictEqual(single.call?.mode, "single_question");
		strictEqual(single.call?.max_rounds, 12);
		// The rejection names the count received and both ways forward; the bare
		// "requires exactly 1 question" left a competent model guessing on first
		// contact and retrying the same shape.
		strictEqual(
			batched.error,
			"mode=single_question carries exactly 1 question and this call carried 2; send them one call at a time, or use mode=round to ask up to 4 together",
		);
		strictEqual(tooManyRounds.error, "max_rounds must be an integer from 1 to 24");
	});

	it("allows bounded phased interviews to raise the round limit", async () => {
		const policy = askUserPolicy(1);
		const tool = createAskUserTool({
			askUser: async (questions) => ({
				answers: questions.map((question) => ({ question: question.question, answer: "chosen answer" })),
			}),
		});

		const first = await tool.run(
			{
				mode: "single_question",
				max_rounds: 2,
				questions: [{ question: "First root decision?" }],
			},
			{ askUserPolicy: policy },
		);
		const second = await tool.run(
			{
				mode: "single_question",
				questions: [{ question: "Second root decision?" }],
			},
			{ askUserPolicy: policy },
		);
		const third = await tool.run(
			{
				mode: "single_question",
				questions: [{ question: "Third root decision?" }],
			},
			{ askUserPolicy: policy },
		);

		strictEqual(first.kind, "ok");
		strictEqual(second.kind, "ok");
		strictEqual(policy.maxCalls, 2);
		strictEqual(policy.callCount, 2);
		strictEqual(third.kind, "ok");
		ok(third.output.includes("ask_user result: round_limit_reached"));
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
			...agentRecipeFixture(),
			toolRequirements: { required: [], optional: ["read", "ask_user"] },
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
});

describe("contracts/ask-user overlay", () => {
	it("renders option questions with the design cursor, quiet question text, and dim answer summary", async () => {
		const mounted = askOverlay();
		const pending = mounted.session.ask([
			{
				header: "Scope",
				question: "Which implementation should Clio assume for this pass?",
				options: [
					{ label: "Use the shared overlay frame", description: "Keep the shipped frame helper." },
					{ label: "Build local chrome", description: "Only if the shared helper cannot express it." },
				],
			},
			{
				header: "Checks",
				question: "Which checks should run before commit?",
				options: [{ label: "Targeted contracts", description: "Run the changed contracts." }],
			},
		]);
		try {
			const lines = mounted.child().render(80);
			const body = stripAnsi(lines.join("\n"));
			const selected = lines.find((line) => stripAnsi(line).includes("Use the shared overlay frame")) ?? "";
			const question = lines.find((line) => stripAnsi(line) === "Which implementation should Clio assume for this pass?");
			const summary = lines.find((line) => stripAnsi(line).includes("── Answers")) ?? "";

			ok(body.includes(`${GLYPH.cursor} Q1 pending Scope`), body);
			ok(body.includes(`${GLYPH.cursor} Use the shared overlay frame`), body);
			ok(!body.includes(String.fromCharCode(0x2192)), "the legacy selected-row arrow must not render");
			ok(selected.includes(clioTheme().fgSequence("accent")), "selected option row uses the accent token");
			ok(question, "the plain question body renders as its own content line");
			ok(!question.includes(ESC), "the question body itself stays unstyled");
			ok(summary.includes(clioTheme().fgSequence("dim")), "answer summary header uses the dim token");
			for (const line of lines) strictEqual(visibleWidth(line) <= 80, true, `line overflows: ${stripAnsi(line)}`);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("uses an ellipsis for long option rows and keeps validation hints dim", async () => {
		const mounted = askOverlay();
		const pending = mounted.session.ask([
			{
				question: "Name the release gate.",
				options: [
					{
						label: "Run the complete repository gate",
						description: "Run typecheck, focused contracts, render audit, and full continuous integration.",
					},
				],
			},
		]);
		try {
			const optionLines = mounted.child().render(52);
			const option = optionLines.find((line) => stripAnsi(line).includes("Run the complete")) ?? "";
			ok(
				stripAnsi(option).includes("…"),
				`long option row should end its truncation with an ellipsis: ${stripAnsi(option)}`,
			);
		} finally {
			mounted.session.cancel();
			await pending;
		}

		const textMounted = askOverlay();
		const textPending = textMounted.session.ask([{ question: "What should Clio optimize for?" }]);
		try {
			textMounted.child().handleInput?.("\n");
			const lines = textMounted.child().render(80);
			const prompt = lines.find((line) => stripAnsi(line).trimStart().startsWith(GLYPH.cursor)) ?? "";
			const hint = lines.find((line) => stripAnsi(line).includes("Enter an answer or press Esc to cancel.")) ?? "";
			ok(stripAnsi(prompt).includes(GLYPH.cursor), "text input prompt uses the design cursor");
			ok(!stripAnsi(prompt).trimStart().startsWith(">"), "text input prompt no longer exposes the engine prompt glyph");
			ok(hint.includes(clioTheme().fgSequence("dim")), "validation hint uses the dim token");
		} finally {
			textMounted.session.cancel();
			await textPending;
		}
	});
});
