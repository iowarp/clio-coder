/**
 * The text field had one way out, and it took the interview with it.
 *
 * Pressing `t` on a focused option (issue #228) opened a free-text field, and
 * from there Esc resolved the whole round as cancelled. The mode also stuck to
 * the question: navigating away and back returned the prefilled field rather
 * than the options, so a round with a single question offered no route from a
 * typed draft back to a plain option short of abandoning the interview
 * (issue #260).
 *
 * Esc now leaves the field for the option list whenever the question has one,
 * and a question left mid-draft comes back as its options with the draft parked
 * behind `t`. Cancelling the interview is still Esc, one surface further out on
 * the option list, and a question with no options still cancels on the first
 * press because it has no list to return to.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import type { AskUserQuestion } from "../../src/tools/ask-user.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const ALT_RIGHT = "\x1b[1;3C";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

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
	return { session, child: () => (mountedFrame() as unknown as { child: Component }).child, frame: mountedFrame };
}

function type(child: Component, text: string): void {
	for (const character of text) child.handleInput?.(character);
}

const NUMBERS_QUESTION: AskUserQuestion = {
	question: "How many nodes and how many runs?",
	header: "Scale",
	options: [{ label: "Use the defaults", description: "8 nodes, 3 runs" }, { label: "Exact number - I'll type it" }],
};

const CLUSTER_QUESTION: AskUserQuestion = {
	question: "Which cluster?",
	header: "Cluster",
	options: [{ label: "mini" }, { label: "blade" }],
};

describe("contracts/ask_user text-mode exit", () => {
	/**
	 * The defect from the 0.3.9 release test: one question, several options, a
	 * typed draft the operator changed their mind about, and no way back.
	 */
	it("returns Esc from the text field to the option list without cancelling the round", async () => {
		const overlay = askOverlay();
		const pending = overlay.session.ask([NUMBERS_QUESTION]);
		const child = overlay.child();

		child.handleInput?.(DOWN);
		child.handleInput?.("t");
		type(child, "64 nodes, 5 runs");
		child.handleInput?.(ESC);

		const afterEscape = stripAnsi(overlay.frame().render(120).join("\n"));
		ok(afterEscape.includes("[t] add text"), `the option list is back, footer and all: ${afterEscape}`);
		ok(!afterEscape.includes("64 nodes, 5 runs"), `the typed draft is gone from the surface: ${afterEscape}`);

		child.handleInput?.(ENTER);
		const result = await pending;
		overlay.session.close();

		strictEqual(result.cancelled, undefined, "Esc left the field, not the interview");
		strictEqual(result.answers[0]?.answer, "Exact number - I'll type it");
		strictEqual(result.answers[0]?.value, undefined, "the discarded text reaches no answer, option, or value");
	});

	it("still cancels the interview when the question has no option list to return to", async () => {
		const overlay = askOverlay();
		const pending = overlay.session.ask([{ question: "What should Clio optimize for?" }]);
		overlay.child().handleInput?.(ESC);
		const result = await pending;
		overlay.session.close();

		strictEqual(result.cancelled, true, "a text-only question keeps Esc as the way out of the interview");
	});

	it("cancels the interview from the option list the text field returned to", async () => {
		const overlay = askOverlay();
		const pending = overlay.session.ask([NUMBERS_QUESTION]);
		const child = overlay.child();

		child.handleInput?.("t");
		type(child, "something");
		child.handleInput?.(ESC);
		child.handleInput?.(ESC);
		const result = await pending;
		overlay.session.close();

		strictEqual(result.cancelled, true, "the way out of the interview is one surface further out, and still Esc");
	});

	/**
	 * The sticky half of the defect. The mode belonged to the question and
	 * outlived the visit, so a question the operator had opened a field on could
	 * never be answered with a plain option again.
	 */
	it("brings a question left mid-draft back as its option list", async () => {
		const overlay = askOverlay();
		const pending = overlay.session.ask([NUMBERS_QUESTION, CLUSTER_QUESTION]);
		const child = overlay.child();

		child.handleInput?.(DOWN);
		child.handleInput?.("t");
		type(child, "64 nodes, 5 runs");
		child.handleInput?.(ALT_RIGHT);
		child.handleInput?.(LEFT);

		const returned = stripAnsi(overlay.frame().render(120).join("\n"));
		ok(returned.includes("[t] add text"), `the question came back on its options: ${returned}`);
		ok(!returned.includes("64 nodes, 5 runs"), `and not in a prefilled field: ${returned}`);

		// The draft is parked rather than destroyed: navigating away is not the
		// same gesture as discarding, so `t` finds the text where it was left.
		child.handleInput?.("t");
		const reopened = stripAnsi(overlay.frame().render(120).join("\n"));
		ok(reopened.includes("64 nodes, 5 runs"), `the parked draft is still behind [t]: ${reopened}`);

		child.handleInput?.(ESC);
		child.handleInput?.(ENTER);
		child.handleInput?.(ENTER);
		const result = await pending;
		overlay.session.close();

		strictEqual(result.cancelled, undefined);
		const scale = result.answers.find((answer) => answer.question === NUMBERS_QUESTION.question);
		strictEqual(scale?.answer, "Exact number - I'll type it", "answered with the plain option after all");
		strictEqual(scale?.value, undefined, "the abandoned draft never became a value");
	});

	it("names the way back on the text footer", async () => {
		const overlay = askOverlay();
		const pending = overlay.session.ask([NUMBERS_QUESTION]);
		const child = overlay.child();
		child.handleInput?.("t");
		const rendered = stripAnsi(overlay.frame().render(120).join("\n"));
		overlay.session.cancel();
		await pending;
		overlay.session.close();
		ok(rendered.includes("[Esc] back"), `the text footer says where Esc goes: ${rendered}`);
	});
});
