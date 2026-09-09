import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import {
	askUserBoxWidth,
	createAskUserViewForTesting,
	formatAskUserQuestion,
	optionAsksForText,
} from "../../src/interactive/overlays/ask-user.js";
import type { AskUserQuestion } from "../../src/tools/ask-user.js";

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
	return askUserBoxWidth(columns) - 4;
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

test("the box takes its measure from the terminal, not a constant", () => {
	strictEqual(askUserBoxWidth(80), 76);
	strictEqual(askUserBoxWidth(120), 100);
	strictEqual(askUserBoxWidth(160), 100);
	strictEqual(askUserBoxWidth(30), 40);
	strictEqual(askUserBoxWidth(0), 100);
});

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
		rows.some((row) => row.includes("[1m")),
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
		ok(text.some((row) => row.includes("Provided details") && row.includes("opens a text field")));
		ok(!text.some((row) => row.includes("Conversational answer")), "tier boilerplate is folded away");
		ok(!text.some((row) => row.includes("[Enter]")), "rows carry no key affordance");
		ok(!text.some((row) => row.includes("…")), "nothing is elided");
		strictEqual(text[0], "Research Exploration; Material Science", "the question header is the first row");
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
			ok(text[0]?.includes(header) || text[1]?.includes(header), `${columns}: strip lacks "${header}"`);
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
	ok(folded[0]?.includes("Researcher Context") && folded[0]?.includes("Round 2"), folded[0]);
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
