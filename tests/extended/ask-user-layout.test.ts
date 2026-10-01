import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createOverlayAskUserLifecycle } from "../../src/interactive/overlay-ask-user-lifecycle.js";
import { createOverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import {
	createAskUserViewForTesting,
	formatAskUserQuestion,
	optionAsksForText,
} from "../../src/interactive/overlays/ask-user.js";
import type { AskUserQuestion, AskUserResult } from "../../src/tools/ask-user.js";
import { createHarnessHold } from "../../src/tools/registry.js";

const ENTER = "\r";
const DOWN = "\u001b[B";
const PAGE_DOWN = "\u001b[6~";

const DAISY_ROUND: AskUserQuestion = {
	header: "Research Exploration; Material Science",
	question:
		"Let's explore your research direction.\n\n1. **Domain**: Which area of material science? (e.g., Structural, Energy, Biomaterials, Computational, Nanomaterials, Functional, Polymers, Characterization)\n2. **Driving question**: What phenomenon, material, or problem interests you? (free-form, even vague is fine)\n3. **Motivation**: Fundamental understanding, application/device, optimization, or review/synthesis?\n4. **Resources available**: Experimental lab, computational cluster, literature only, or combination?",
	options: [
		{ label: "Provided details" },
		{ label: "I'm not sure yet; help me explore" },
		{ label: "I have a specific topic already" },
	],
};

const CONDUCTOR_ROUND: AskUserQuestion[] = [
	{
		header: "Consistency",
		question: "What's your tolerance for eventual consistency in the data layer?",
		options: [
			{
				label: "Strong (Recommended)",
				description: "All reads see latest write. +Latency, +Simplicity. Good for: Financial, Auth",
			},
			{ label: "Eventual", description: "Reads may lag writes. -Latency, +Complexity. Good for: Social, Analytics" },
			{
				label: "Tunable per query",
				description: "Choose per read path. +Flexibility, +Operational burden. Good for: Mixed workloads",
			},
		],
	},
	{
		header: "Sample size",
		question: "How many replicate samples per condition will you synthesize?",
		options: [
			{ label: "3 replicates", description: "Minimum for a mean and standard deviation" },
			{ label: "5 replicates", description: "Supports Grubbs outlier test and a 95% confidence interval at n=5" },
		],
	},
	{
		header: "Validation",
		question: "Which experimental benchmark will the DFT formation energies be validated against?",
		options: [
			{ label: "Materials Project", description: "Computed reference; same functional family" },
			{ label: "Calorimetry data", description: "Measured enthalpies from Kubaschewski; sparse for ternaries" },
		],
	},
	{
		header: "Failure",
		question: "If this project fails, what is the most likely reason?",
		multi_select: true,
		options: [
			{ label: "Synthesis route", description: "The precursor chemistry never yields single-phase material" },
			{ label: "Instrument time", description: "Synchrotron beamtime is not awarded in the timeline" },
		],
	},
];

const CANDIDATES: AskUserQuestion = {
	header: "Your Research Prompts",
	question: [
		"Based on our conversation, here are 3 research prompts:",
		"",
		"**A (Focused):** How does Nb microalloying (0.05 to 0.3 at%) shift the sigma-phase precipitation onset in CoCrFeNi high-entropy alloys aged at 700 C?",
		"  In: arc-melted buttons, 700 C aging to 500 h, SEM/EBSD, XRD · Out: additive manufacturing, corrosion · Keywords: sigma phase, HEA, Nb, aging kinetics",
		"",
		"**B (Standard):** What is the role of refractory microalloying additions in delaying intermetallic precipitation in FCC high-entropy alloys during intermediate-temperature service?",
		"  In: Nb, Mo, W additions; 600 to 800 C · Out: BCC HEAs · Keywords: HEA, precipitation, thermal stability",
		"",
		"**C (Ambitious):** Can a CALPHAD-guided microalloying strategy produce an FCC high-entropy alloy with no sigma phase after 1000 h at 750 C while retaining 400 MPa yield strength?",
		"  In: CALPHAD screening, DFT formation energies, aging, tensile · Out: fatigue, creep · Keywords: CALPHAD, design rule, HEA",
		"",
		"Recommended: A because it is answerable with the arc melter and the SEM you already have, within a nine-month timeline.",
		"",
		"Which fits your goals? If you pick one, also say whether its scope and keywords need any correction.",
	].join("\n"),
	options: [
		{ label: "Prompt A", description: "Focused; feasible with current lab; nine months" },
		{ label: "Prompt B", description: "Standard; needs Mo and W stock and a second furnace" },
		{ label: "Prompt C", description: "Ambitious; needs cluster allocation and tensile frame time" },
		{ label: "Combine or edit; I'll describe" },
	],
};

/** The inner width the frame hands the body at a terminal width: box minus two borders and two pads. */
function innerWidth(columns: number): number {
	return columns - 4;
}

function plain(lines: ReadonlyArray<string>): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function assertWithinWidth(lines: ReadonlyArray<string>, width: number): void {
	for (const line of lines) {
		ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripTerminalSequences(line)}`);
	}
}

/** Every word of `source`, in order, somewhere in the joined rows: folded, never cut. */
function assertWordsInOrder(rows: ReadonlyArray<string>, source: string, label: string): void {
	const flattened = rows.map((row) => row.trim()).join(" ");
	let cursor = 0;
	for (const word of source.split(/\s+/u).filter(Boolean)) {
		const at = flattened.indexOf(word, cursor);
		ok(at >= 0, `${label}: lost "${word}"`);
		cursor = at + word.length;
	}
}

test("a question renders bold spans and hanging list items instead of raw markdown", () => {
	const rows = formatAskUserQuestion(DAISY_ROUND.question, 60);
	const text = plain(rows);
	ok(
		text.every((row) => !row.includes("**")),
		"no literal asterisks",
	);
	const domain = text.findIndex((row) => row.startsWith("1. Domain"));
	ok(domain >= 0);
	ok(text[domain + 1]?.startsWith("   "), "the second row of a list item hangs under its marker");
	ok(
		rows.some((row) => row.includes("[1;")),
		"bold span painted bold",
	);
	deepStrictEqual(formatAskUserQuestion("a\n\n\n\nb\n", 20), ["a", "", "b"], "blank runs collapse to one row");
});

test("options whose label says the operator will type open the text field", () => {
	ok(optionAsksForText("Provided details"));
	ok(optionAsksForText("Combine or edit; I'll describe"));
	ok(optionAsksForText("Exact number - I'll type it"));
	ok(optionAsksForText("Other"));
	ok(!optionAsksForText("I have a specific topic already"));
	ok(!optionAsksForText("Skip; use reasonable defaults"));
	ok(!optionAsksForText("Prompt A"));
});

for (const [columns, rows] of [
	[80, 40],
	[120, 30],
	[160, 30],
] as const) {
	const width = innerWidth(columns);

	test(`${columns}x${rows}: a Daisy round shows the whole question, every option, and no boilerplate`, async () => {
		const view = createAskUserViewForTesting({ rows });
		const pending = view.ask([DAISY_ROUND]);
		const lines = view.render(width);
		const text = plain(lines);
		assertWithinWidth(lines, width);
		ok(lines.length <= rows - 4, `${lines.length} rows exceed the ${rows - 4}-row budget`);
		for (const part of ["1. Domain", "2. Driving question", "3. Motivation", "4. Resources available"]) {
			ok(
				text.some((row) => row.includes(part)),
				`${columns}: missing "${part}"`,
			);
		}
		assertWordsInOrder(text, DAISY_ROUND.question.replace(/\*\*/g, ""), `${columns} question`);
		for (const option of DAISY_ROUND.options ?? []) {
			ok(
				text.some((row) => row.includes(option.label)),
				`${columns}: missing option "${option.label}"`,
			);
		}
		assertWordsInOrder(text, "Provided details opens a text field for your answer", "option explanation");
		ok(!text.some((row) => row.includes("Conversational answer")), "tier boilerplate is folded away");
		ok(!text.some((row) => row.includes("[Enter]")), "rows carry no key affordance");
		ok(!text.some((row) => row.includes("…")), "nothing is elided");
		strictEqual(
			text[2],
			"Clio-Coder asks you · Research Exploration; Material Science",
			"the speaker and question header lead the dialog",
		);
		const lastQuestionRow = text.findIndex((row) => row.includes("combination?"));
		const firstOption = text.findIndex((row) => row.includes("Provided details"));
		ok(firstOption - lastQuestionRow <= 2, "options sit directly under the question");
		view.cancel();
		await pending;
	});

	test(`${columns}x${rows}: a conductor round names every question and keeps every trade-off`, async () => {
		const view = createAskUserViewForTesting({ rows });
		const pending = view.ask(CONDUCTOR_ROUND);
		const lines = view.render(width);
		const text = plain(lines);
		assertWithinWidth(lines, width);
		for (const header of ["Consistency", "Sample size", "Validation", "Failure"]) {
			ok(
				text.some((line) => line.includes(header)),
				`${columns}: strip lacks "${header}"`,
			);
		}
		for (const option of CONDUCTOR_ROUND[0]?.options ?? []) {
			assertWordsInOrder(text, `${option.label} ${option.description ?? ""}`, `${columns} option ${option.label}`);
		}
		ok(!text.some((row) => row.includes("…")), "no option description is elided");
		ok(!text.some((row) => row.includes("[Enter]")));
		ok(!text.some((row) => row.includes("Conversational answer")));
		strictEqual(view.footerHint().includes("[?] details"), true);
		view.cancel();
		await pending;
	});

	test(`${columns}x${rows}: a long decision scrolls its question and never hides its options`, async () => {
		const view = createAskUserViewForTesting({ rows });
		const pending = view.ask([CANDIDATES]);
		const lines = view.render(width);
		const text = plain(lines);
		assertWithinWidth(lines, width);
		ok(lines.length <= rows - 4, `${lines.length} rows exceed the budget`);
		for (const label of ["Prompt A", "Prompt B", "Prompt C", "Combine or edit; I'll describe"]) {
			ok(
				text.some((row) => row.includes(label)),
				`${columns}: option "${label}" is off screen`,
			);
		}
		const scrolls = text.some((row) => row.includes("PgUp/PgDn"));
		if (scrolls) {
			match(view.footerHint(), /PgUp\/PgDn/u);
			let seen = false;
			for (let page = 0; page < 6 && !seen; page += 1) {
				view.handleInput(PAGE_DOWN);
				seen = plain(view.render(width)).some((row) => row.includes("Which fits your goals?"));
			}
			ok(seen, "the asking sentence is reachable by scrolling");
		} else {
			ok(text.some((row) => row.includes("Which fits your goals?")));
		}
		view.cancel();
		await pending;
	});
}

test("Enter on a text-asking option opens the field and records label plus text", async () => {
	const view = createAskUserViewForTesting({ rows: 40 });
	const pending = view.ask([DAISY_ROUND]);
	view.handleInput(ENTER);
	const opened = plain(view.render(76));
	ok(
		opened.some((row) => row.includes('Your answer, with "Provided details"')),
		opened.join("\n"),
	);
	ok(
		opened.some((row) => row.includes("4. Resources available")),
		"the question stays in view while typing",
	);
	for (const char of "Energy materials; arc melter") view.handleInput(char);
	view.handleInput(ENTER);
	const result = await pending;
	deepStrictEqual(result.answers, [
		{
			question: DAISY_ROUND.question,
			answer: "Provided details; Energy materials; arc melter",
			options: ["Provided details"],
			value: "Energy materials; arc melter",
		},
	]);
});

test("a plain option still records its label alone", async () => {
	const view = createAskUserViewForTesting({ rows: 40 });
	const pending = view.ask([DAISY_ROUND]);
	view.handleInput(DOWN);
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	const result = await pending;
	deepStrictEqual(result.answers[0]?.answer, "I have a specific topic already");
	strictEqual(result.answers[0]?.value, undefined);
});

test("later rounds fold earlier answers to one row until asked, and count rounds", async () => {
	const view = createAskUserViewForTesting({ rows: 30 });
	const first = view.ask([DAISY_ROUND]);
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	await first;
	const waiting = plain(view.render(76));
	ok(waiting[0]?.includes("waiting for the next question"), waiting.join("\n"));
	const second = view.ask([{ header: "Researcher Context", question: "Career stage?", options: [{ label: "PI" }] }]);
	const folded = plain(view.render(76));
	ok(folded[0]?.includes("Round 2") && folded.some((line) => line.includes("Researcher Context")), folded.join("\n"));
	ok(folded.some((row) => row.includes("1 earlier answer · a to review")));
	ok(!folded.some((row) => row.includes("help me explore")), "the ledger is folded");
	const question = folded.findIndex((row) => row.includes("Career stage?"));
	const option = folded.findIndex((row) => row.includes("PI"));
	ok(option - question <= 2, "options sit under the question, not under the ledger");
	view.handleInput("a");
	const expanded = plain(view.render(76));
	ok(expanded.some((row) => row.includes("Answers")));
	ok(
		expanded.some((row) => row.includes("help me explore")),
		"the ledger opens on a",
	);
	view.handleInput("?");
	const details = plain(view.render(76));
	ok(
		details.some((row) => row.includes("Conversational answer")),
		"details open on ?",
	);
	doesNotMatch(plain(view.render(76)).join("\n"), /Question 1\/1/u);
	view.cancel();
	await second;
});

test("multi-select toggles with Space and records every chosen label", async () => {
	const view = createAskUserViewForTesting({ rows: 40 });
	const pending = view.ask([CONDUCTOR_ROUND[3] as AskUserQuestion]);
	view.handleInput(" ");
	view.handleInput(DOWN);
	view.handleInput(" ");
	const text = plain(view.render(76));
	ok(text.some((row) => row.includes("[x] Synthesis route")));
	ok(text.some((row) => row.includes("[x] Instrument time")));
	view.handleInput(ENTER);
	const result = await pending;
	deepStrictEqual(result.answers[0]?.options, ["Synthesis route", "Instrument time"]);
});

test("discarding a revised answer preserves committed option facts", async () => {
	const view = createAskUserViewForTesting({ rows: 30 });
	const pending = view.ask([
		{ question: "First?", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Second?", options: [{ label: "Done" }] },
	]);
	for (const key of [ENTER, "\u001b[D", DOWN, "t", "\u001b", "\u001b[C", ENTER]) view.handleInput(key);
	deepStrictEqual((await pending).answers, [
		{ question: "First?", answer: "A", options: ["A"] },
		{ question: "Second?", answer: "Done", options: ["Done"] },
	]);
});

test("Other replaces a discarded single-choice text draft", async () => {
	const view = createAskUserViewForTesting({ rows: 30 });
	const pending = view.ask([{ question: "First?", options: [{ label: "Provided details" }] }]);
	view.handleInput(ENTER);
	for (const key of "draft") view.handleInput(key);
	view.handleInput("\u001b");
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	for (const key of "Alternative") view.handleInput(key);
	view.handleInput(ENTER);
	deepStrictEqual((await pending).answers, [{ question: "First?", answer: "Alternative", value: "Alternative" }]);
});

for (const columns of [80, 120, 160])
	test(`oversized option details remain readable at ${columns} columns`, async () => {
		const view = createAskUserViewForTesting({ rows: 24 });
		const pending = view.ask([
			{
				question: "Proceed?",
				options: [
					{ label: "Proceed", description: `${"Important scope ".repeat(180)}CRITICAL_END_MARKER` },
					{ label: "Cancel" },
				],
			},
		]);
		const seen: string[] = [];
		for (let page = 0; page < 40; page++) {
			const rows = view.render(columns - 8);
			assertWithinWidth(rows, columns - 8);
			ok(rows.length <= 20);
			seen.push(...plain(rows));
			if (seen.some((row) => row.includes("CRITICAL_END_MARKER"))) break;
			view.handleInput(PAGE_DOWN);
		}
		ok(
			seen.some((row) => row.includes("CRITICAL_END_MARKER")),
			"the entire focused description can be reviewed",
		);
		view.cancel();
		await pending;
	});

test("browse from choices to an empty text question and back, preserving typed drafts", async () => {
	const view = createAskUserViewForTesting({ rows: 40 });
	const pending = view.ask([
		{ header: "Style", question: "Pick a style", options: [{ label: "Teal" }] },
		{ header: "Details", question: "Explain your priorities" },
	]);
	view.handleInput("\x1b[C");
	match(plain(view.render(156)).join("\n"), /Question 2 of 2/);
	view.handleInput("\x1b[D");
	match(plain(view.render(156)).join("\n"), /Question 1 of 2/);
	view.handleInput("\t");
	view.handleInput("keep my draft");
	view.handleInput("\x1b[Z");
	match(plain(view.render(156)).join("\n"), /Question 1 of 2/);
	view.handleInput("\t");
	match(plain(view.render(156)).join("\n"), /keep my draft/);
	match(view.footerHint(), /Tab\/Shift\+Tab/);
	view.handleInput(ENTER);
	match(plain(view.render(156)).join("\n"), /Question 1 of 2/);
	view.handleInput(ENTER);
	const result = await pending;
	strictEqual(result.answers[1]?.value, "keep my draft");
	strictEqual(result.answers[0]?.answer, "Teal");
});

const SAFE_DEFAULT_ROUND: AskUserQuestion = {
	question: "Merge the task branch?",
	options: [{ label: "Merge" }, { label: "Keep branch" }, { label: "Discard" }],
};

test("a question with defaultOption opens focused on it, and one without opens on the first option", async () => {
	const focused = createAskUserViewForTesting({ rows: 40 });
	const focusedPending = focused.ask([{ ...SAFE_DEFAULT_ROUND, defaultOption: 1 }]);
	focused.handleInput(ENTER);
	deepStrictEqual((await focusedPending).answers[0]?.options, ["Keep branch"]);

	const plainRound = createAskUserViewForTesting({ rows: 40 });
	const plainPending = plainRound.ask([SAFE_DEFAULT_ROUND]);
	plainRound.handleInput(ENTER);
	deepStrictEqual((await plainPending).answers[0]?.options, ["Merge"]);
});

test("a harness round drops Enter inside its input guard, takes Esc, and answers after the guard", async () => {
	const guarded = createAskUserViewForTesting({ rows: 40 });
	const guardedPending = guarded.ask([{ ...SAFE_DEFAULT_ROUND, defaultOption: 1 }], undefined, {
		inputGuardMs: 60_000,
	});
	let settled = false;
	void guardedPending.then(() => {
		settled = true;
	});
	guarded.handleInput(ENTER);
	guarded.handleInput(DOWN);
	guarded.handleInput(ENTER);
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(settled, false, "Enter inside the guard must not answer");
	guarded.handleInput("\u001b");
	strictEqual((await guardedPending).cancelled, true);

	const elapsed = createAskUserViewForTesting({ rows: 40 });
	const elapsedPending = elapsed.ask([{ ...SAFE_DEFAULT_ROUND, defaultOption: 1 }], undefined, { inputGuardMs: 20 });
	await new Promise((resolve) => setTimeout(resolve, 100));
	elapsed.handleInput(ENTER);
	deepStrictEqual((await elapsedPending).answers[0]?.options, ["Keep branch"]);
});

/** A lifecycle on the real overlay transitions with a scripted overlay session, no TUI. */
function lifecycleFixture() {
	const sessions: FakeSession[] = [];
	const notices: string[] = [];
	let permissionCloses = 0;
	const transitions = createOverlayTransitions({
		stopDispatchBoardTicker: () => {},
		renderContextIsland: () => {},
		renderTaskIsland: () => {},
		requestRender: () => {},
		cancelPendingAskUser: () => lifecycle.cancelPending(),
		finishAuth: () => {},
		onPermissionOverlayClosed: () => {
			permissionCloses += 1;
		},
	});
	const lifecycle = createOverlayAskUserLifecycle({
		tui: {} as TUI,
		getOverlayState: () => transitions.state,
		setOverlayState: (state) => {
			transitions.state = state;
		},
		getOverlayHandle: () => transitions.handle,
		setOverlayHandle: (handle) => {
			transitions.handle = handle;
		},
		replaceInterruptedOverlay: (from, to) => transitions.replaceInterrupted?.(from, to),
		renderContextIsland: () => {},
		renderTaskIsland: () => {},
		requestRender: () => {},
		onHarnessWaiting: () => {
			notices.push("waiting");
		},
		openAskUserOverlay: () => {
			const session = new FakeSession();
			sessions.push(session);
			return session;
		},
	});
	return { lifecycle, transitions, sessions, notices, permissionCloses: () => permissionCloses };
}

class FakeSession {
	closed = false;
	hidden = false;
	waiting = true;
	private resolveRound: ((result: AskUserResult) => void) | null = null;
	asked: string[] = [];
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}
	isHidden(): boolean {
		return this.hidden;
	}
	focus(): void {}
	unfocus(): void {}
	isFocused(): boolean {
		return !this.hidden && !this.closed;
	}
	getBounds(): undefined {
		return undefined;
	}
	hide(): void {
		this.close();
	}
	ask(questions: ReadonlyArray<AskUserQuestion>): Promise<AskUserResult> {
		if (this.resolveRound !== null) return Promise.resolve({ answers: [], cancelled: true, unavailable: true });
		this.asked.push(questions[0]?.question ?? "");
		this.waiting = false;
		return new Promise((resolve) => {
			this.resolveRound = resolve;
		});
	}
	answer(label: string): void {
		const resolve = this.resolveRound;
		this.resolveRound = null;
		this.waiting = true;
		resolve?.({ answers: [{ question: this.asked.at(-1) ?? "", answer: label, options: [label] }] });
	}
	cancel(): void {
		const resolve = this.resolveRound;
		this.resolveRound = null;
		this.waiting = true;
		resolve?.({ answers: [], cancelled: true });
	}
	close(): void {
		this.closed = true;
		this.cancel();
	}
	isWaiting(): boolean {
		return this.waiting && this.resolveRound === null;
	}
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MODEL_CALL = { turnId: "turn-1", toolCallId: "call-1" };

test("a permission prompt over an interview that ends restores nothing instead of a dead session", async () => {
	const { lifecycle, transitions, sessions } = lifecycleFixture();
	const round = lifecycle.handler([{ question: "Which?", options: [{ label: "A" }] }], MODEL_CALL);
	await tick();
	sessions[0]?.answer("A");
	await round;
	strictEqual(transitions.state, "ask-user");
	const permission = new FakeSession();
	strictEqual(transitions.showPermission(permission), true);
	// A streamed text delta closes the interview while the permission prompt is up.
	lifecycle.close();
	strictEqual(sessions[0]?.closed, true);
	transitions.close();
	strictEqual(transitions.state, "closed", "no key is left swallowed by an ask-user state with no session");
	strictEqual(transitions.handle, null);
});

test("a harness card holds the screen across its rounds, so a waiting model question cannot split them", async () => {
	const { lifecycle, sessions } = lifecycleFixture();
	const hold = createHarnessHold();
	const card = { origin: "harness" as const, harnessHold: hold };
	const first = lifecycle.handler([{ question: "Merge?", options: [{ label: "Discard" }] }], card);
	await tick();
	sessions[0]?.answer("Discard");
	await first;
	const modelAsk = lifecycle.handler([{ question: "Model?", options: [{ label: "Yes" }] }], MODEL_CALL);
	await tick();
	const confirm = lifecycle.handler([{ question: "Delete?", options: [{ label: "Back" }] }], card);
	await tick();
	strictEqual(sessions.length, 1, "the confirm continues the card on its own screen");
	deepStrictEqual(sessions[0]?.asked, ["Merge?", "Delete?"]);
	sessions[0]?.answer("Back");
	await confirm;
	hold.release();
	await tick();
	strictEqual(sessions[0]?.closed, true);
	strictEqual(sessions.length, 2, "the model's waiting question takes the screen once the card is done");
	deepStrictEqual(sessions[1]?.asked, ["Model?"]);
	sessions[1]?.answer("Yes");
	const answered = await modelAsk;
	strictEqual(answered.cancelled, undefined);
	strictEqual(answered.answers[0]?.answer, "Yes");
});

test("an idle model interview yields the screen to a card and resumes after it, cancelling nothing", async () => {
	const { lifecycle, transitions, sessions } = lifecycleFixture();
	const first = lifecycle.handler([{ question: "Which?", options: [{ label: "A" }] }], MODEL_CALL);
	await tick();
	sessions[0]?.answer("A");
	await first;
	// The model's next message is a foreground dispatch whose finalize asks for the card.
	const hold = createHarnessHold();
	const card = lifecycle.handler([{ question: "Merge?", options: [{ label: "Keep branch" }] }], {
		origin: "harness",
		harnessHold: hold,
	});
	await tick();
	strictEqual(sessions.length, 2, "the card has a screen of its own");
	strictEqual(sessions[0]?.hidden, true);
	strictEqual(sessions[0]?.closed, false);
	sessions[1]?.answer("Keep branch");
	await card;
	hold.release();
	strictEqual(sessions[1]?.closed, true);
	strictEqual(sessions[0]?.hidden, false, "the interview is back");
	strictEqual(sessions[0]?.closed, false);
	strictEqual(transitions.state, "ask-user");
	strictEqual(transitions.handle, sessions[0]);
	const second = lifecycle.handler([{ question: "Next?", options: [{ label: "B" }] }], MODEL_CALL);
	await tick();
	deepStrictEqual(sessions[0]?.asked, ["Which?", "Next?"]);
	sessions[0]?.answer("B");
	strictEqual((await second).cancelled, undefined);
});

test("a card behind another overlay tells the operator once and shows when the screen frees", async () => {
	const { lifecycle, transitions, sessions, notices } = lifecycleFixture();
	transitions.state = "settings";
	const hold = createHarnessHold();
	const options = { origin: "harness" as const, harnessHold: hold };
	const question = [{ question: "Merge?", options: [{ label: "Keep branch" }] }];
	strictEqual((await lifecycle.handler(question, options)).unavailable, true);
	strictEqual((await lifecycle.handler(question, options)).unavailable, true);
	deepStrictEqual(notices, ["waiting"]);
	transitions.state = "closed";
	const shown = lifecycle.handler(question, options);
	await tick();
	sessions[0]?.answer("Keep branch");
	strictEqual((await shown).answers[0]?.answer, "Keep branch");
	hold.release();
});
