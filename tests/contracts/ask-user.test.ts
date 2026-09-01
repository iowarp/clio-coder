import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { agentSpecPolicyErrors, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import {
	classifyDecisionPresentation,
	decisionFactsForAnswer,
} from "../../src/domains/safety/decision-presentation.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import {
	ASK_USER_COMPACT_MAX_OPTIONS,
	ASK_USER_DECISION_TITLE,
	ASK_USER_DECISION_TONE,
	ASK_USER_SURFACE_GEOMETRY,
	ASK_USER_WAITING_TITLE,
	askUserSurface,
	openAskUserOverlay,
} from "../../src/interactive/overlays/ask-user.js";
import { clioTheme, createClioTheme, GLYPH } from "../../src/interactive/theme/index.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import type { AskUserQuestion } from "../../src/tools/ask-user.js";
import { createAskUserTool, finalizeAskUserInterviewForHost, normalizeAskUserCall } from "../../src/tools/ask-user.js";
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
		exposure: "local",
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

function askOverlay(
	rows = 30,
	columns = 120,
): {
	session: ReturnType<typeof openAskUserOverlay>;
	child: () => Component;
	frame: () => Component;
	options: () => OverlayOptions | undefined;
	renderFrame: (width?: number) => string[];
	setRows: (next: number) => void;
} {
	let mounted: Component | null = null;
	let mountedOptions: OverlayOptions | undefined;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	const terminal = { rows, columns };
	const tui = {
		terminal,
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
			mounted = component;
			mountedOptions = options;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	const session = openAskUserOverlay(tui, { onCancel: () => {} });
	const mountedFrame = (): Component => {
		if (!mounted) throw new Error("ask-user overlay was not mounted");
		return mounted;
	};
	return {
		session,
		child: () => (mountedFrame() as unknown as { child: Component }).child,
		frame: mountedFrame,
		options: () => mountedOptions,
		// The engine evaluates `visible` with the live terminal size in the same
		// pass that composites the overlay, and that call is where the frame
		// learns its row budget. A test that renders without it is measuring an
		// unbudgeted frame.
		renderFrame: (width = columns) => {
			const frame = mountedFrame();
			frame.invalidate?.();
			mountedOptions?.visible?.(columns, terminal.rows);
			return frame.render(width);
		},
		setRows: (next: number) => {
			terminal.rows = next;
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

	it("keeps outward exposure monotonic and ignores caller presentation fields", async () => {
		const policy = askUserPolicy();
		const tiers: string[] = [];
		const tool = createAskUserTool({
			askUser: async (questions, options) => {
				tiers.push(options?.decisionPresentation?.tier ?? "missing");
				return {
					answers: questions.map((question) => ({ question: question.question, answer: "approved" })),
				};
			},
		});

		await tool.run(
			{
				exposure: "outward",
				questions: [{ question: "Publish the report?" }],
				tier: "conversation",
				title: "Harmless local choice",
			},
			{
				askUserPolicy: policy,
				decisionPresentation: classifyDecisionPresentation(decisionFactsForAnswer("local")),
			},
		);
		const localRound = await tool.run(
			{ exposure: "local", questions: [{ question: "Use the short title?" }] },
			{ askUserPolicy: policy },
		);

		deepStrictEqual(tiers, ["outward", "outward"]);
		strictEqual(policy.exposure, "outward");
		strictEqual(
			(localRound.details as { interview?: { exposure?: string } } | undefined)?.interview?.exposure,
			"outward",
		);
	});

	it("carries action=complete summaries through the host finalizer to one decision producer", async () => {
		const policy = askUserPolicy();
		policy.sessionId = "session-1";
		policy.turnId = "user-1";
		const tool = createAskUserTool({
			askUser: async (questions) => ({
				answers: questions.map((question) => ({ question: question.question, answer: "Focused" })),
			}),
		});
		await tool.run(
			{
				questions: [{ header: "Scope", question: "Which scope?" }],
			},
			{ askUserPolicy: policy, sessionId: "session-1", turnId: "user-1" },
		);
		const completed = await tool.run(
			{
				action: "complete",
				summary: "Use focused scope for this release.",
				decisions: [{ key: "release_gate", value: "Focused contracts" }],
			},
			{ askUserPolicy: policy, sessionId: "session-1", turnId: "user-1" },
		);
		strictEqual(completed.kind, "ok");
		strictEqual(policy.summary, "Use focused scope for this release.");

		const produced: AskUserToolPolicy[] = [];
		await finalizeAskUserInterviewForHost(policy, "turn_finished", undefined, (settled) => produced.push(settled));
		strictEqual(produced.length, 1);
		strictEqual(produced[0], policy);
		strictEqual(produced[0]?.summary, "Use focused scope for this release.");
		strictEqual(produced[0]?.status, "complete");
	});

	it("direct fallback handler returns cancelled without blocking", async () => {
		const tool = createAskUserTool();
		const startedAt = performance.now();
		const result = await tool.run({
			questions: [
				{
					question: "Which implementation should be assumed?",
					options: [{ label: "Use the recommended implementation", description: "Proceed without operator input." }],
				},
			],
		});

		strictEqual(result.kind, "ok");
		strictEqual(performance.now() - startedAt < 100, true);
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

	it("wraps the focused option's description, ellipsizes the rest, and keeps validation hints dim", async () => {
		const focusedDescription = "Run typecheck, focused contracts, render audit, and full continuous integration.";
		const mounted = askOverlay();
		const pending = mounted.session.ask([
			{
				question: "Name the release gate.",
				options: [
					{
						label: "Run the complete repository gate",
						description: focusedDescription,
					},
					{
						label: "Run the fast gate",
						description: "Run typecheck and the focused contract tests only, skipping the render audit.",
					},
				],
			},
		]);
		try {
			const optionLines = mounted
				.child()
				.render(52)
				.map((line) => stripAnsi(line));
			// The focused option is what the operator is reading, so its whole
			// sentence is on screen across as many rows as it needs.
			const collapsed = optionLines.join(" ").replace(/\s+/g, " ");
			ok(collapsed.includes(focusedDescription), `the focused description must not be cut: ${collapsed}`);
			ok(!collapsed.includes("integration.…"), collapsed);
			// The unfocused row stays a one-line cell, and its ellipsis says so.
			const unfocused = optionLines.find((line) => line.includes("Run the fast gate")) ?? "";
			ok(unfocused.includes("…"), `an unfocused option row is a cell that marks its cut: ${unfocused}`);
			for (const line of optionLines) strictEqual(visibleWidth(line) <= 52, true, `line overflows: ${line}`);
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

/**
 * A prompt that has taken the keyboard and is waiting on a person is not an
 * informational panel, and it used to draw itself as one: the same teal frame,
 * the same centered box, the same title treatment. The operator report is the
 * whole case for this block — "it's centered and it's very hard for the human
 * eyes to move away and find where the acceptance is".
 */
describe("contracts/ask-user decision visibility", () => {
	const askDecision = async (
		run: (mounted: ReturnType<typeof askOverlay>) => void,
		question: AskUserQuestion = {
			header: "Scope",
			question: "Which implementation should Clio assume for this pass?",
			options: [{ label: "Use the shared overlay frame" }, { label: "Build local chrome" }],
		},
	): Promise<void> => {
		const mounted = askOverlay();
		const pending = mounted.session.ask([question]);
		try {
			run(mounted);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	};

	it("draws a pending decision in the decision tone, not the informational frame", async () => {
		const idle = askOverlay();
		const waitingBorder = idle.frame().render(90)[0] ?? "";
		ok(stripAnsi(waitingBorder).includes(ASK_USER_WAITING_TITLE), stripAnsi(waitingBorder));

		await askDecision((mounted) => {
			const lines = mounted.frame().render(90);
			const top = lines[0] ?? "";
			const bottom = lines[lines.length - 1] ?? "";
			const tone = clioTheme().fgSequence(ASK_USER_DECISION_TONE);

			if (tone.length > 0) {
				ok(top.includes(tone), `the top border carries the decision tone: ${JSON.stringify(top)}`);
				ok(bottom.includes(tone), `so does the bottom border: ${JSON.stringify(bottom)}`);
				ok(!top.includes(clioTheme().fgSequence("frame")), "and no informational frame token survives on it");
			}
			ok(stripAnsi(top).includes(ASK_USER_DECISION_TITLE), stripAnsi(top));
			// The title is bold as well as toned, so a terminal with color off still
			// separates a decision from a panel.
			ok(top.includes(`[1;`) || top.includes("[1m"), `the title stays bold: ${JSON.stringify(top)}`);
		});
	});

	it("takes the local-answer tone from a theme token rather than a written-out color", () => {
		const truecolor = createClioTheme({ color: true, truecolor: true });
		const indexed = createClioTheme({ color: true, truecolor: false });
		strictEqual(ASK_USER_DECISION_TONE, "accent");
		strictEqual(truecolor.fgSequence(ASK_USER_DECISION_TONE), "[38;2;70;229;208m");
		strictEqual(indexed.fgSequence(ASK_USER_DECISION_TONE), "[38;5;80m");

		const source = readFileSync("src/interactive/overlays/ask-user.ts", "utf8");
		ok(!/\\u001b\[|\\x1b\[|38;[25];/u.test(source), "the overlay writes no escape sequence of its own");
	});

	it("uses outward title, tone, consequence, and action copy without changing the surface", async () => {
		const mounted = askOverlay();
		const presentation = classifyDecisionPresentation(decisionFactsForAnswer("outward"));
		const pending = mounted.session.ask(
			[{ question: "Publish the result?", options: [{ label: "Publish" }, { label: "Keep local" }] }],
			presentation,
		);
		try {
			strictEqual(mounted.options()?.anchor, ASK_USER_SURFACE_GEOMETRY.compact.anchor);
			const frame = mounted.renderFrame().map(stripAnsi);
			ok(frame[0]?.includes("Confirm outward consequence"), frame.join("\n"));
			ok(
				frame.some((line) => line.includes("Outward consequence")),
				frame.join("\n"),
			);
			ok(
				frame.some((line) => line.includes("does not publish or send anything")),
				frame.join("\n"),
			);
			ok(frame.at(-1)?.includes("record outward answer"), frame.join("\n"));
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("makes the focused option dominant and names its key on the row", async () => {
		await askDecision((mounted) => {
			const lines = mounted.child().render(80);
			const focused = lines.find((line) => stripAnsi(line).includes("Use the shared overlay frame")) ?? "";
			const other = lines.find((line) => stripAnsi(line).includes("Build local chrome")) ?? "";

			ok(focused.includes(clioTheme().fgSequence("accent")), "the focused row is accent");
			ok(focused.includes("[1;") || focused.includes("[1m"), `and bold: ${JSON.stringify(focused)}`);
			ok(stripAnsi(focused).includes("[Enter]"), `the accept key rides on the focused row: ${stripAnsi(focused)}`);
			ok(!stripAnsi(other).includes("[Enter]"), `and on no other row: ${stripAnsi(other)}`);
			for (const line of lines) strictEqual(visibleWidth(line) <= 80, true, `line overflows: ${stripAnsi(line)}`);
		});
	});

	it("names the toggling key on the focused row of a multi-select", async () => {
		await askDecision(
			(mounted) => {
				const focused =
					mounted
						.child()
						.render(80)
						.find((line) => stripAnsi(line).includes("Targeted contracts")) ?? "";
				ok(stripAnsi(focused).includes("[Space]"), `a multi-select row toggles with Space: ${stripAnsi(focused)}`);
			},
			{
				question: "Which checks should run before commit?",
				multi_select: true,
				options: [{ label: "Targeted contracts" }, { label: "Full suite" }],
			},
		);
	});

	it("names the exact keys for accepting and leaving the decision", async () => {
		await askDecision((mounted) => {
			const hint = (mounted.child() as unknown as { footerHint: () => string }).footerHint();
			strictEqual(hint, "[t] add text · [Enter] record answer · [Esc] close");
		});

		await askDecision(
			(mounted) => {
				const hint = (mounted.child() as unknown as { footerHint: () => string }).footerHint();
				strictEqual(hint, "[Space] toggle · [t] add text · [Enter] record answer · [Esc] close");
			},
			{
				question: "Which checks should run before commit?",
				multi_select: true,
				options: [{ label: "Targeted contracts" }, { label: "Full suite" }],
			},
		);
	});
});

/**
 * One overlay served a permission confirmation, a quick question, and a
 * multi-round interview through the same centered full-height modal. The
 * operator report is the case for this block: a single two-option ask_user
 * arrived as a thirty-five-row box with the options at the top and twenty-five
 * blank rows under them.
 */
describe("contracts/ask-user surfaces", () => {
	const answer = (mounted: ReturnType<typeof askOverlay>): void => {
		mounted.child().handleInput?.("\r");
	};

	it("picks the surface from the request shape", () => {
		const small: AskUserQuestion = {
			question: "Which implementation should Clio assume?",
			options: [{ label: "Shared frame" }, { label: "Local chrome" }],
		};
		const wide: AskUserQuestion = {
			question: "Which runtime should this target?",
			options: Array.from({ length: ASK_USER_COMPACT_MAX_OPTIONS + 1 }, (_, index) => ({
				label: `Runtime ${index + 1}`,
			})),
		};

		strictEqual(askUserSurface([small]), "compact");
		// A single free-text question is the other quick shape, not an interview:
		// one line of typing does not earn the screen.
		strictEqual(askUserSurface([{ question: "What should Clio optimize for?" }]), "compact");
		strictEqual(askUserSurface([wide]), "panel");
		strictEqual(askUserSurface([small, wide]), "interview");
		// The same small question, once a round has already been answered. The
		// captured answers are what make it an interview.
		strictEqual(askUserSurface([small], 1), "interview");
	});

	it("anchors a small decision at the composer and a round in the middle", async () => {
		const compact = askOverlay();
		const compactPending = compact.session.ask([
			{ question: "Which implementation should Clio assume?", options: [{ label: "Shared frame" }] },
		]);
		const interview = askOverlay();
		const interviewPending = interview.session.ask([
			{ header: "Scope", question: "Which implementation?", options: [{ label: "Shared frame" }] },
			{ header: "Checks", question: "Which checks run before commit?", options: [{ label: "Targeted contracts" }] },
		]);
		try {
			strictEqual(compact.options()?.anchor, ASK_USER_SURFACE_GEOMETRY.compact.anchor);
			strictEqual(compact.options()?.anchor, "bottom-center");
			strictEqual(interview.options()?.anchor, "center");

			// The box paints its own width inside a row it claims whole, so the
			// surface widths are read off the rendered border, not off the options.
			const compactBorder = stripAnsi(compact.renderFrame()[0] ?? "").trim();
			const interviewBorder = stripAnsi(interview.renderFrame()[0] ?? "").trim();
			strictEqual(visibleWidth(compactBorder), ASK_USER_SURFACE_GEOMETRY.compact.width);
			ok(
				visibleWidth(interviewBorder) > visibleWidth(compactBorder),
				`the interview surface is the wider one: ${visibleWidth(interviewBorder)} vs ${visibleWidth(compactBorder)}`,
			);
		} finally {
			compact.session.cancel();
			interview.session.cancel();
			await compactPending;
			await interviewPending;
		}
	});

	it("sizes a small decision to its content instead of padding to the terminal", async () => {
		const mounted = askOverlay(40);
		const pending = mounted.session.ask([
			{
				header: "Scope",
				question: "Which implementation should Clio assume for this pass?",
				options: [{ label: "Shared frame" }, { label: "Local chrome" }],
			},
		]);
		try {
			const lines = mounted.renderFrame();
			ok(
				lines.length <= ASK_USER_SURFACE_GEOMETRY.compact.maxInnerRows + 2,
				`a two-option decision on a 40-row terminal draws ${lines.length} rows`,
			);
			const body = lines.slice(1, -1).map((line) => stripAnsi(line).trim());
			strictEqual(body[body.length - 1]?.length === 0, false, `the last body row is not filler: ${body.join(" | ")}`);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("keeps every option and its accept key inside the compact panel", async () => {
		const question: AskUserQuestion = {
			header: "Scope",
			question:
				"Which implementation should Clio assume for this pass, given that the shared overlay frame already carries the decision tone and the local chrome would have to reproduce it by hand?",
			options: Array.from({ length: ASK_USER_COMPACT_MAX_OPTIONS }, (_, index) => ({
				label: `Implementation choice number ${index + 1} with a deliberately long label`,
				description: `A description long enough to compete with the label for the row it shares with it (${index + 1}).`,
			})),
		};
		// A roomy terminal and a cramped one: the compact panel is a cap on both.
		for (const rows of [40, 14]) {
			const mounted = askOverlay(rows);
			const pending = mounted.session.ask([question]);
			try {
				const lines = mounted.renderFrame();
				const body = lines.map((line) => stripAnsi(line));
				ok(
					lines.length <= ASK_USER_SURFACE_GEOMETRY.compact.maxInnerRows + 2,
					`at ${rows} rows the compact panel drew ${lines.length} rows`,
				);
				for (const line of lines) {
					strictEqual(visibleWidth(line) <= 120, true, `at ${rows} rows a line overflows the terminal: ${stripAnsi(line)}`);
				}
				ok(
					!body.some((line) => line.includes("more rows")),
					`at ${rows} rows the frame had to drop body rows: ${body.join(" | ")}`,
				);
				ok(
					body.some((line) => line.includes("[Enter]")),
					`the accept key survives at ${rows} rows`,
				);
			} finally {
				mounted.session.cancel();
				await pending;
			}
		}
	});

	it("keeps the round and the captured answers on screen once an interview has one", async () => {
		const mounted = askOverlay(40);
		const first = mounted.session.ask([
			{ header: "Scope", question: "First root decision?", options: [{ label: "Narrow" }, { label: "Wide" }] },
		]);
		strictEqual(mounted.options()?.anchor, "bottom-center");
		answer(mounted);
		deepStrictEqual(await first, {
			answers: [{ question: "First root decision?", answer: "Narrow", options: ["Narrow"] }],
		});

		const second = mounted.session.ask([
			{ header: "Depth", question: "Second root decision?", options: [{ label: "Shallow" }, { label: "Deep" }] },
		]);
		try {
			// The same single question, one round later, on the full surface.
			strictEqual(mounted.options()?.anchor, "center");
			const body = mounted.renderFrame().map((line) => stripAnsi(line));
			ok(
				body.some((line) => line.includes("Round 2")),
				`the round position renders: ${body.join(" | ")}`,
			);
			ok(
				body.some((line) => line.includes("── Answers")),
				`the ledger renders: ${body.join(" | ")}`,
			);
			ok(
				body.some((line) => line.includes("1. Narrow")),
				`with the answer already captured: ${body.join(" | ")}`,
			);
		} finally {
			mounted.session.cancel();
			await second;
		}
	});

	it("wraps captured interview answers instead of cutting their sentences", async () => {
		const mounted = askOverlay(40, 40);
		const answerText = "Keep the complete explanation visible across every narrow terminal row";
		const first = mounted.session.ask([
			{ header: "Scope", question: "First root decision?", options: [{ label: answerText }] },
		]);
		answer(mounted);
		await first;

		const second = mounted.session.ask([
			{ header: "Depth", question: "Second root decision?", options: [{ label: "Continue" }] },
		]);
		try {
			const lines = mounted.child().render(40).map(stripAnsi);
			const collapsed = lines.join(" ").replace(/\s+/gu, " ");
			ok(collapsed.includes(answerText), `the answer ledger lost prose: ${collapsed}`);
			for (const line of lines) strictEqual(visibleWidth(line) <= 40, true, `line overflows: ${line}`);
		} finally {
			mounted.session.cancel();
			await second;
		}
	});
});

/**
 * The interview is the surface an operator works in for a whole round, and a
 * 42-row cap turned a 66-row terminal into a centered box with twenty blank
 * rows around it. It now fills the frame, holds its chrome fixed, and scrolls
 * the question and the ledger between them.
 */
describe("contracts/ask-user interview workspace", () => {
	const rowBudget = (frame: Component): number => (frame as unknown as { rowBudget: number }).rowBudget;
	const PAGE_DOWN = "\x1b[6~";
	const PAGE_UP = "\x1b[5~";
	const longQuestion = Array.from(
		{ length: 30 },
		(_, index) => `Sentence ${index + 1} of a question long enough to outrun the region it is drawn in.`,
	).join(" ");

	const roundQuestions = (question: string): AskUserQuestion[] => [
		{ header: "Scope", question, options: [{ label: "Narrow" }, { label: "Wide" }] },
		{
			header: "Checks",
			question: "Which checks run before commit?",
			options: [{ label: "Targeted" }, { label: "Full" }],
		},
	];

	it("fills the frame instead of capping the body at a fixed height", async () => {
		const mounted = askOverlay(50);
		const pending = mounted.session.ask(roundQuestions("Which implementation should Clio assume?"));
		try {
			// Zero is "every row the frame has", and the mount says so by passing no
			// fixed maxHeight at all.
			strictEqual(ASK_USER_SURFACE_GEOMETRY.interview.maxInnerRows, 0);
			// The mount passes no fixed maxHeight, so the frame's own budget is every
			// row the terminal has left after the margins.
			mounted.options()?.visible?.(120, 50);
			strictEqual(rowBudget(mounted.frame()), 48);

			const lines = mounted.renderFrame();
			// One row of margin top and bottom, then the two border rows.
			strictEqual(lines.length, 48);
			strictEqual(lines.length - 2, 46);
			const body = lines.slice(1, -1).map((line) => stripAnsi(line));
			ok(!body.some((line) => line.includes("more rows")), `the frame never has to drop body rows: ${body.join(" | ")}`);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("keeps compact and panel shape selection while budgeting consequence copy", async () => {
		deepStrictEqual(ASK_USER_SURFACE_GEOMETRY.compact, {
			width: 68,
			maxInnerRows: 14,
			anchor: "bottom-center",
			margin: { top: 1, right: 2, bottom: 1, left: 2 },
		});
		deepStrictEqual(ASK_USER_SURFACE_GEOMETRY.panel, { width: 88, maxInnerRows: 18, anchor: "center", margin: 1 });

		const mounted = askOverlay(50);
		const pending = mounted.session.ask([
			{
				header: "Scope",
				question: "Which runtime should this target?",
				options: Array.from({ length: ASK_USER_COMPACT_MAX_OPTIONS + 1 }, (_, index) => ({ label: `Runtime ${index}` })),
			},
		]);
		try {
			mounted.options()?.visible?.(120, 50);
			strictEqual(rowBudget(mounted.frame()), ASK_USER_SURFACE_GEOMETRY.panel.maxInnerRows + 2);
			const lines = mounted.renderFrame();
			ok(lines.length <= ASK_USER_SURFACE_GEOMETRY.panel.maxInnerRows + 2, `the panel stays capped: ${lines.length}`);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("keeps the control on the last rows and scrolls the content between the chrome", async () => {
		const mounted = askOverlay(30);
		const first = mounted.session.ask([
			{ header: "Scope", question: "First root decision?", options: [{ label: "Narrow" }, { label: "Wide" }] },
		]);
		mounted.child().handleInput?.("\r");
		await first;
		// Fourteen more answered rounds, so the ledger alone outruns the region.
		for (let round = 2; round <= 15; round += 1) {
			const pendingRound = mounted.session.ask([
				{ header: `Round ${round}`, question: `Decision ${round}?`, options: [{ label: `Answer ${round}` }] },
			]);
			mounted.child().handleInput?.("\r");
			await pendingRound;
		}

		const pending = mounted.session.ask([
			{ header: "Long", question: longQuestion, options: [{ label: "Yes" }, { label: "No" }] },
		]);
		try {
			const before = mounted.renderFrame().map((line) => stripAnsi(line));
			const bodyBefore = before.slice(1, -1);
			ok(
				bodyBefore.slice(-3).some((line) => line.includes("[Enter]")),
				`the control holds the last rows: ${bodyBefore.slice(-4).join(" | ")}`,
			);
			ok(
				bodyBefore.some((line) => line.includes("more")),
				`the scroll indicator appears when content overflows: ${bodyBefore.join(" | ")}`,
			);
			ok(
				before[before.length - 1]?.includes("PgUp/PgDn"),
				`the footer names the scroll keys: ${before[before.length - 1]}`,
			);

			mounted.child().handleInput?.(PAGE_DOWN);
			const after = mounted.renderFrame().map((line) => stripAnsi(line));
			ok(after.join("\n") !== before.join("\n"), "PgDn moves the content");
			ok(
				after
					.slice(1, -1)
					.slice(-3)
					.some((line) => line.includes("[Enter]")),
				"the control is still on the last rows after scrolling",
			);

			// The offset clamps at both ends: pages past the end stay at the end,
			// and pages past the top come back to the same first frame.
			for (let index = 0; index < 40; index += 1) mounted.child().handleInput?.(PAGE_DOWN);
			const bottom = mounted.renderFrame().map((line) => stripAnsi(line));
			for (let index = 0; index < 5; index += 1) mounted.child().handleInput?.(PAGE_DOWN);
			deepStrictEqual(
				mounted.renderFrame().map((line) => stripAnsi(line)),
				bottom,
			);
			for (let index = 0; index < 60; index += 1) mounted.child().handleInput?.(PAGE_UP);
			deepStrictEqual(
				mounted.renderFrame().map((line) => stripAnsi(line)),
				before,
			);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("resets the scroll on the next round and keeps the decision title", async () => {
		const mounted = askOverlay(20);
		const opening = mounted.session.ask([
			{ header: "Scope", question: "First root decision?", options: [{ label: "Narrow" }] },
		]);
		mounted.child().handleInput?.("\r");
		await opening;

		const first = mounted.session.ask([
			{ header: "Depth", question: longQuestion, options: [{ label: "Narrow" }, { label: "Wide" }] },
		]);
		mounted.renderFrame();
		mounted.child().handleInput?.(PAGE_DOWN);
		const scrolled = mounted.renderFrame().map((line) => stripAnsi(line));
		mounted.child().handleInput?.("\r");
		await first;

		const second = mounted.session.ask([{ header: "Shape", question: longQuestion, options: [{ label: "Shallow" }] }]);
		try {
			const lines = mounted.renderFrame().map((line) => stripAnsi(line));
			ok(lines[0]?.includes(ASK_USER_DECISION_TITLE), `the title still names the decision: ${lines[0]}`);
			ok(
				!lines.some((line) => line.includes("↑ ")),
				`the new round starts at the top of its content: ${lines.join(" | ")}`,
			);
			ok(
				scrolled.some((line) => line.includes("↑ ")),
				"the previous round had in fact been scrolled",
			);
		} finally {
			mounted.session.cancel();
			await second;
		}
	});

	it("keeps the text input and the way out on a 40x12 terminal", async () => {
		const mounted = askOverlay(12, 40);
		const first = mounted.session.ask([
			{ header: "Scope", question: "First root decision?", options: [{ label: "Narrow" }] },
		]);
		mounted.child().handleInput?.("\r");
		await first;

		const pending = mounted.session.ask([{ header: "Detail", question: longQuestion }]);
		try {
			const lines = mounted.renderFrame(40).map((line) => stripAnsi(line));
			ok(
				lines.slice(1, -1).some((line) => line.includes(GLYPH.cursor)),
				`the input row survives a short terminal: ${lines.join(" | ")}`,
			);
			ok(lines[lines.length - 1]?.includes("Esc"), `the way out survives: ${lines[lines.length - 1]}`);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});

	it("keeps the control visible when the terminal shrinks under it", async () => {
		const mounted = askOverlay(50);
		const pending = mounted.session.ask(roundQuestions(longQuestion));
		try {
			ok(
				mounted
					.renderFrame()
					.map((line) => stripAnsi(line))
					.some((line) => line.includes("[Enter]")),
				"the control renders at 50 rows",
			);
			mounted.setRows(15);
			const small = mounted.renderFrame().map((line) => stripAnsi(line));
			strictEqual(small.length, 13);
			ok(
				small.some((line) => line.includes("[Enter]")),
				`the control survives the shrink: ${small.join(" | ")}`,
			);
			ok(
				!small.some((line) => line.includes("more rows")),
				`the frame never drops body rows after the shrink: ${small.join(" | ")}`,
			);
		} finally {
			mounted.session.cancel();
			await pending;
		}
	});
});
