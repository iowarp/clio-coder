import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import {
	ASK_USER_COMPACT_MAX_OPTIONS,
	ASK_USER_DECISION_TITLE,
	ASK_USER_DECISION_TONE,
	ASK_USER_SURFACE_GEOMETRY,
	askUserSurface,
	openAskUserOverlay,
} from "../../src/interactive/overlays/ask-user.js";
import { clioTheme, fgSequence, GLYPH } from "../../src/interactive/theme/index.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import type { AskUserQuestion } from "../../src/tools/ask-user.js";
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

function askOverlay(
	rows = 30,
	columns = 120,
): {
	session: ReturnType<typeof openAskUserOverlay>;
	child: () => Component;
	frame: () => Component;
	options: () => OverlayOptions | undefined;
	renderFrame: (width?: number) => string[];
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
	const tui = {
		terminal: { rows, columns },
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
			mountedOptions?.visible?.(columns, rows);
			return frame.render(width);
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
		const waiting = idle.frame().render(90);
		const waitingBorder = waiting[0] ?? "";
		ok(waitingBorder.includes(clioTheme().fgSequence("frame")), "an overlay with no decision keeps the frame token");
		ok(!waitingBorder.includes(clioTheme().fgSequence(ASK_USER_DECISION_TONE)), "and does not claim the decision tone");

		await askDecision((mounted) => {
			const lines = mounted.frame().render(90);
			const top = lines[0] ?? "";
			const bottom = lines[lines.length - 1] ?? "";
			const tone = clioTheme().fgSequence(ASK_USER_DECISION_TONE);

			ok(top.includes(tone), `the top border carries the decision tone: ${JSON.stringify(top)}`);
			ok(bottom.includes(tone), `so does the bottom border: ${JSON.stringify(bottom)}`);
			ok(!top.includes(clioTheme().fgSequence("frame")), "and no informational frame token survives on it");
			ok(stripAnsi(top).includes(ASK_USER_DECISION_TITLE), stripAnsi(top));
			// The title is bold as well as toned, so a terminal with color off still
			// separates a decision from a panel.
			ok(top.includes(`[1;`) || top.includes("[1m"), `the title stays bold: ${JSON.stringify(top)}`);
		});
	});

	it("takes the decision tone from a theme token rather than a written-out color", () => {
		// The token is what makes the treatment follow the palette instead of one
		// terminal's idea of orange, in truecolor and in the 256-color fallback.
		strictEqual(fgSequence(ASK_USER_DECISION_TONE, true), "[38;2;255;126;41m");
		strictEqual(fgSequence(ASK_USER_DECISION_TONE, false), "[38;5;208m");

		const source = readFileSync("src/interactive/overlays/ask-user.ts", "utf8");
		ok(!/\\u001b\[|\\x1b\[|38;[25];/u.test(source), "the overlay writes no escape sequence of its own");
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
			strictEqual(hint, "[Enter] accept · [Esc] close");
		});

		await askDecision(
			(mounted) => {
				const hint = (mounted.child() as unknown as { footerHint: () => string }).footerHint();
				strictEqual(hint, "[Space] toggle · [Enter] accept · [Esc] close");
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
			ok(lines.length <= 10, `a two-option decision on a 40-row terminal draws ${lines.length} rows`);
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
		deepStrictEqual(await first, { answers: [{ question: "First root decision?", answer: "Narrow" }] });

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
});
