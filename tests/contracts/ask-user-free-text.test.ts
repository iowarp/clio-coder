/**
 * `ask_user` recorded the chosen option label and threw the typed answer away.
 *
 * The interview in `state/interviews/2026-08-25T10-14-05-319Z-...json` recorded
 * `Exact number - I'll type it` for two questions and `Different - I'll type
 * the exact dates` for a third, and then spent rounds 3 and 4 asking for the
 * same figures again: "The previous round captured the option label but not the
 * figures." Thirty-five minutes to collect four facts, and the operator typed
 * the same numbers three times (issue #228).
 *
 * The overlay now composes a label and a typed value into one answer and
 * records the three facts separately, so a reader can tell "they picked the
 * option" from "they picked it and gave the number", and the number survives
 * into the transcript and the decision record.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import type { AskUserAnswer, AskUserQuestion, AskUserResult } from "../../src/tools/ask-user.js";
import { createAskUserTool } from "../../src/tools/ask-user.js";
import type { AskUserToolPolicy } from "../../src/tools/registry.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const ENTER = "\r";
const KILL_TO_END = String.fromCharCode(11);

function askOverlay(): {
	session: ReturnType<typeof openAskUserOverlay>;
	child: () => Component;
	frame: () => Component;
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
		terminal: { rows: 30, columns: 120 },
		showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
			mounted = component;
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
	};
}

function type(child: Component, text: string): void {
	for (const character of text) child.handleInput?.(character);
}

/** Drive one round to completion and hand back what it recorded. */
async function answerRound(
	questions: ReadonlyArray<AskUserQuestion>,
	drive: (child: Component) => void,
): Promise<AskUserAnswer[]> {
	const overlay = askOverlay();
	const pending = overlay.session.ask(questions);
	drive(overlay.child());
	const result = await pending;
	overlay.session.close();
	strictEqual(result.cancelled, undefined, "the round settled with an answer, not a cancellation");
	return result.answers;
}

const NUMBERS_QUESTION: AskUserQuestion = {
	question: "How many nodes and how many runs?",
	header: "Scale",
	options: [{ label: "Use the defaults", description: "8 nodes, 3 runs" }, { label: "Exact number - I'll type it" }],
};

describe("contracts/ask_user free-text answers", () => {
	it("records a typed answer to a question with no options", async () => {
		const answers = await answerRound([{ question: "What should Clio optimize for?" }], (child) => {
			type(child, "wall-clock time on 64 nodes");
			child.handleInput?.(ENTER);
		});

		strictEqual(answers.length, 1);
		strictEqual(answers[0]?.answer, "wall-clock time on 64 nodes");
		strictEqual(answers[0]?.value, "wall-clock time on 64 nodes", "the typed text is recorded as the value");
		strictEqual(answers[0]?.options, undefined, "a question with no options records no labels");
	});

	it("records a chosen option with no typed value, and says so by omitting one", async () => {
		const answers = await answerRound([NUMBERS_QUESTION], (child) => {
			child.handleInput?.(ENTER);
		});

		strictEqual(answers.length, 1);
		strictEqual(answers[0]?.answer, "Use the defaults");
		strictEqual(answers[0]?.options?.length, 1);
		strictEqual(answers[0]?.options?.[0], "Use the defaults");
		strictEqual(answers[0]?.value, undefined, "a label-only answer carries no value, which is how it is told apart");
	});

	/**
	 * The defect, exactly. The model offered an option that says the operator
	 * will type the figure, and before this there was no key that let them.
	 */
	it("records a chosen option together with the value typed for it", async () => {
		const answers = await answerRound([NUMBERS_QUESTION], (child) => {
			child.handleInput?.("\x1b[B");
			child.handleInput?.("t");
			type(child, "64 nodes, 5 runs");
			child.handleInput?.(ENTER);
		});

		strictEqual(answers.length, 1);
		strictEqual(answers[0]?.answer, "Exact number - I'll type it; 64 nodes, 5 runs");
		strictEqual(answers[0]?.options?.[0], "Exact number - I'll type it", "the label survives");
		strictEqual(answers[0]?.value, "64 nodes, 5 runs", "and so does the figure the label promised");
	});

	it("keeps every checked label beside the typed value on a multi-select", async () => {
		const answers = await answerRound(
			[
				{
					question: "Which gates should run?",
					multi_select: true,
					options: [{ label: "typecheck" }, { label: "contracts" }],
				},
			],
			(child) => {
				child.handleInput?.(" ");
				child.handleInput?.("\x1b[B");
				child.handleInput?.(" ");
				child.handleInput?.("t");
				type(child, "and the render audit");
				child.handleInput?.(ENTER);
			},
		);

		strictEqual(answers[0]?.answer, "typecheck; contracts; and the render audit");
		strictEqual(answers[0]?.options?.join(","), "typecheck,contracts");
		strictEqual(answers[0]?.value, "and the render audit");
	});

	/**
	 * Revising the figure is the case the old interview forced on the operator
	 * three times over. Coming back to the question lands in the text they
	 * already typed, and the label they chose it under stays attached to the
	 * replacement.
	 */
	it("keeps the chosen label attached when the operator comes back and revises the value", async () => {
		const cluster: AskUserQuestion = { question: "Which cluster?", options: [{ label: "mini" }, { label: "blade" }] };
		const answers = await answerRound([NUMBERS_QUESTION, cluster], (child) => {
			child.handleInput?.("\x1b[B");
			child.handleInput?.("t");
			type(child, "64 nodes, 5 runs");
			child.handleInput?.(ENTER);
			// Back to the first question, clear the field, and type the real figure.
			child.handleInput?.("\x1b[D");
			child.handleInput?.(KILL_TO_END);
			type(child, "8 nodes, 2 runs");
			child.handleInput?.(ENTER);
			child.handleInput?.(ENTER);
		});

		const scale = answers.find((answer) => answer.question === NUMBERS_QUESTION.question);
		strictEqual(scale?.answer, "Exact number - I'll type it; 8 nodes, 2 runs");
		strictEqual(scale?.options?.[0], "Exact number - I'll type it", "the label is still the one they chose");
		strictEqual(scale?.value, "8 nodes, 2 runs", "and the value is the revision, not the first attempt");
	});

	it("names the key that adds text on the select footer", async () => {
		const overlay = askOverlay();
		const pending = overlay.session.ask([NUMBERS_QUESTION]);
		const rendered = stripAnsi(overlay.frame().render(120).join("\n"));
		overlay.session.cancel();
		await pending;
		overlay.session.close();
		ok(rendered.includes("[t] add text"), `the footer names the key that lets you type: ${rendered}`);
	});

	/**
	 * The transcript is the durable record of the interview, and it is where the
	 * lost figures should have been readable after the fact.
	 */
	it("preserves the raw answer text in the interview transcript and the decision record", async () => {
		const previousState = process.env.CLIO_CODER_STATE_DIR;
		const scratch = mkdtempSync(join(tmpdir(), "clio-ask-user-free-text-"));
		process.env.CLIO_CODER_STATE_DIR = join(scratch, "state");
		resetXdgCache();
		try {
			const tool = createAskUserTool({
				askUser: async (questions): Promise<AskUserResult> => ({
					answers: questions.map((question) => ({
						question: question.question,
						answer: "Exact number - I'll type it; 64 nodes, 5 runs",
						options: ["Exact number - I'll type it"],
						value: "64 nodes, 5 runs",
					})),
				}),
			});
			const now = new Date().toISOString();
			const policy: AskUserToolPolicy = {
				id: "test-free-text-policy",
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
				maxCalls: 6,
				askedQuestionKeys: new Set<string>(),
			};

			const asked = await tool.run(
				{ action: "ask", questions: [{ question: "How many nodes and how many runs?", header: "Scale" }] },
				{ askUserPolicy: policy },
			);
			strictEqual(asked.kind, "ok");
			await tool.run({ action: "complete", summary: "scale settled" }, { askUserPolicy: policy });

			const dir = join(process.env.CLIO_CODER_STATE_DIR, "interviews");
			const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1, `one transcript was written: ${files.join(", ")}`);
			const transcript = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")) as {
				rounds: Array<{ answers: Array<{ answer: string; options?: string[]; value?: string }> }>;
				decisions: Array<{ value: string; options?: string[]; text?: string }>;
			};

			const answer = transcript.rounds[0]?.answers[0];
			strictEqual(answer?.value, "64 nodes, 5 runs", "the raw typed text is in the transcript");
			strictEqual(answer?.options?.[0], "Exact number - I'll type it", "beside the label it was chosen with");

			const decision = transcript.decisions[0];
			ok(decision !== undefined, "the answer produced a decision");
			ok(decision.value.includes("64 nodes, 5 runs"), `both survive into the decision value: ${decision.value}`);
			strictEqual(decision.text, "64 nodes, 5 runs", "and the decision keeps them separable");
			strictEqual(decision.options?.[0], "Exact number - I'll type it");
		} finally {
			if (previousState === undefined) Reflect.deleteProperty(process.env, "CLIO_CODER_STATE_DIR");
			else process.env.CLIO_CODER_STATE_DIR = previousState;
			resetXdgCache();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
