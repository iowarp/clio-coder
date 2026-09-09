import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplateList,
	promptTemplateDisplayText,
} from "../../src/domains/resources/prompts/loader.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { promptSourceLabel } from "../../src/interactive/prompt-source-label.js";
import { renderReferenceCard } from "../../src/interactive/renderers/reference-card.js";
import {
	createSlashCommandAutocompleteProvider,
	REFERENCE_TEMPLATE_MARKER,
	type SlashCompletionItem,
} from "../../src/interactive/slash-autocomplete.js";
import {
	dispatchSlashCommand,
	type PromptReferenceCard,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

const HELP_BLOCK = [
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	" Materio; materials research system",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"CORE RESEARCH LOOP",
	"─────────────────────────────────────────",
	" 1. /materio:identify-research",
	"       Guided interview → select domain, sub-field, scope, and confirm a research prompt",
	" 5. /materio:execute-task [N | all]",
	"       Execute a specific task or the full workflow; types: literature, experimental, computational, data-analysis",
	"",
	"TIPS",
	" • Each dispatch receives fresh worker context",
	" • /materio:checkpoint save before long tasks",
].join("\n");

const HELP_TEMPLATE = `---
description: "Overview of Materio commands"
display-only: true
---

<objective>
Display the Materio command reference. No tools needed.
</objective>

<process>

Display the following:

\`\`\`
${HELP_BLOCK}
\`\`\`

</process>
`;

function fixtureRoots(): { dir: string; templates: PromptTemplateList } {
	const dir = mkdtempSync(join(tmpdir(), "clio-display-only-"));
	const prompts = join(dir, "prompts", "materio");
	mkdirSync(prompts, { recursive: true });
	writeFileSync(join(prompts, "help.md"), HELP_TEMPLATE);
	writeFileSync(
		join(prompts, "status.md"),
		"---\ndescription: Project dashboard\ndisplay-only: yes\n---\nReport the project state for $ARGUMENTS\n",
	);
	writeFileSync(
		join(prompts, "notes.md"),
		"---\ndescription: Plain notes\ndisplayOnly: true\n---\nFirst line of notes.\nSecond line of notes.\n",
	);
	const templates = loadPromptTemplates({
		roots: [{ path: join(dir, "prompts"), scope: "package", source: "plugin:user:materio", precedence: 10 }],
	});
	return { dir, templates };
}

test("the loader parses display-only as a boolean flag and defaults it off", () => {
	const { dir, templates } = fixtureRoots();
	try {
		deepStrictEqual(templates.diagnostics, []);
		const byName = new Map(templates.items.map((template) => [template.name, template]));
		strictEqual(byName.get("materio:help")?.displayOnly, true);
		strictEqual(byName.get("materio:notes")?.displayOnly, true, "camelCase spelling is accepted like argumentHint");
		strictEqual(byName.get("materio:status")?.displayOnly, false, "a non-boolean value is not a flag");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a display-only template expands to an operator card and never to model text", () => {
	const { dir, templates } = fixtureRoots();
	try {
		const help = expandPromptTemplateInput("/materio:help  extra args", templates);
		strictEqual(help.expanded, false);
		ok(help.expanded === false && help.display, "display-only carries a display payload");
		if (help.expanded !== false || !help.display) return;
		strictEqual(help.refusal, undefined);
		strictEqual(help.display.template.name, "materio:help");
		strictEqual(help.display.text, HELP_BLOCK, "the first fenced block is the card, the prose around it is not");
		deepStrictEqual(help.args, ["extra", "args"]);
		strictEqual(help.text, "/materio:help  extra args", "the input is returned untouched, never a substituted body");

		const notes = expandPromptTemplateInput("/materio:notes", templates);
		ok(notes.expanded === false && notes.display);
		if (notes.expanded !== false || !notes.display) return;
		strictEqual(notes.display.text, "First line of notes.\nSecond line of notes.", "no fence: the whole body");

		const status = expandPromptTemplateInput("/materio:status now", templates);
		strictEqual(status.expanded, true, "a template without the flag still expands for the model");
		if (status.expanded) strictEqual(status.text, "Report the project state for now");

		strictEqual(promptTemplateDisplayText({ content: "~~~text\nfenced\n~~~\nafter" }), "fenced");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the TUI answers a display-only command with a card and does not submit a turn", () => {
	const { dir, templates } = fixtureRoots();
	try {
		const submitted: string[] = [];
		const cards: PromptReferenceCard[] = [];
		const notices: string[] = [];
		const stdout: string[] = [];
		let renders = 0;
		const ctx = {
			io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stdout.push(text) },
			expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, templates),
			submitChat: (text: string) => submitted.push(text),
			showReference: (card: PromptReferenceCard) => cards.push(card),
			notice: (_level: string, text: string) => notices.push(text),
			render: () => {
				renders += 1;
			},
		} as unknown as SlashCommandContext;

		const command = parseSlashCommand("/materio:help");
		strictEqual(command.kind, "unknown-command");
		strictEqual(dispatchSlashCommand(command, ctx), "accepted");
		deepStrictEqual(submitted, [], "nothing reaches the chat loop, so nothing reaches the model");
		deepStrictEqual(notices, []);
		deepStrictEqual(stdout, []);
		strictEqual(renders, 1);
		deepStrictEqual(cards, [{ command: "materio:help", source: "plugin materio", text: HELP_BLOCK }]);

		// The same template still expands as a model prompt when the flag is off.
		strictEqual(dispatchSlashCommand(parseSlashCommand("/materio:status now"), ctx), "accepted");
		deepStrictEqual(submitted, ["/materio:status now"]);
		strictEqual(cards.length, 1);

		// A host without a chat panel prints the card through the command sink.
		const bare = { ...(ctx as unknown as Record<string, unknown>) };
		delete bare.showReference;
		strictEqual(
			dispatchSlashCommand(parseSlashCommand("/materio:notes"), bare as unknown as SlashCommandContext),
			"accepted",
		);
		deepStrictEqual(stdout, ["/materio:notes (plugin materio)\nFirst line of notes.\nSecond line of notes.\n"]);
		deepStrictEqual(submitted, ["/materio:status now"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt sources read as the package the operator installed", () => {
	strictEqual(promptSourceLabel({ scope: "package", source: "plugin:project:wtfp" }), "plugin wtfp");
	strictEqual(promptSourceLabel({ scope: "user", source: "config" }), "user prompts");
	strictEqual(promptSourceLabel({ scope: "project", source: "project" }), "project prompts");
	strictEqual(promptSourceLabel({ scope: "user", source: "claude-user" }), "claude user prompts");
	strictEqual(promptSourceLabel({ scope: "project", source: "codex-project" }), "codex project prompts");
	strictEqual(promptSourceLabel({ scope: "project" }), "project prompts");
});

for (const width of [80, 120, 160]) {
	test(`the reference card wraps to ${width} columns without cutting a sentence`, () => {
		const card: PromptReferenceCard = { command: "materio:help", source: "plugin materio", text: HELP_BLOCK };
		const lines = renderReferenceCard(card, width).map(stripTerminalSequences);
		for (const line of lines) ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		const header = lines[0] ?? "";
		match(header, /\/materio:help/);
		match(header, /reference · plugin materio/);
		strictEqual(lines.at(-1), "", "the card ends with a spacer row");
		// Every word of every source row survives, in order: wrapping folds
		// a row that outruns the width, it never truncates it.
		const flattened = lines
			.slice(1)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.join(" ");
		for (const sourceRow of HELP_BLOCK.split("\n")) {
			const words = sourceRow.trim().split(/\s+/u).filter(Boolean);
			if (words.length === 0) continue;
			let cursor = 0;
			for (const word of words) {
				const at = flattened.indexOf(word, cursor);
				ok(at >= 0, `${width} columns lost "${word}" from row "${sourceRow.trim()}"`);
				cursor = at + word.length;
			}
		}
		ok(
			lines.some((line) => line.includes("━━━━━━━━━━")),
			"box-drawing rows are preserved",
		);
		const bodyRows = lines.slice(1).filter((line) => line.length > 0);
		ok(
			bodyRows.every((line) => line.startsWith("  ")),
			"body rows hang in the prose gutter",
		);
		doesNotMatch(lines.join("\n"), /…/u, "no ellipsis: nothing was elided");
	});
}

test("a wide row folds at 80 columns and stays on one row at 160", () => {
	const card: PromptReferenceCard = { command: "materio:help", source: "plugin materio", text: HELP_BLOCK };
	const longest = HELP_BLOCK.split("\n").reduce((best, row) => (row.length > best.length ? row : best), "");
	const narrow = renderReferenceCard(card, 80).map(stripTerminalSequences);
	const wide = renderReferenceCard(card, 160).map(stripTerminalSequences);
	ok(!narrow.some((line) => line.trim() === longest.trim()), "the longest row cannot fit in 80 columns and folds");
	ok(
		wide.some((line) => line.trim() === longest.trim()),
		"at 160 columns it stays whole",
	);
	ok(narrow.length > wide.length);
});

test("autocomplete marks a display-only template as a reference", async () => {
	const provider = createSlashCommandAutocompleteProvider({
		fdPath: null,
		promptTemplates: () => [
			{ name: "materio:help", description: "Overview of Materio commands", displayOnly: true },
			{ name: "materio:status", description: "Project dashboard" },
		],
	});
	const line = "/materio:";
	const items = ((await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal }))
		?.items ?? []) as SlashCompletionItem[];
	const help = items.find((item) => item.value === "materio:help");
	const status = items.find((item) => item.value === "materio:status");
	ok(help && status);
	ok(help.description?.startsWith(REFERENCE_TEMPLATE_MARKER), help.description);
	match(help.effectDescription ?? "", /nothing is sent to the model/);
	ok(!status.description?.includes(REFERENCE_TEMPLATE_MARKER));
	strictEqual(help.disabledReason, undefined, "a reference is enabled: it runs, just not on the model");
});

for (const newline of ["\n", "\r\n"]) {
	test(`display-only extracts ordinary indented and longer fences with ${JSON.stringify(newline)}`, () => {
		for (const [opening, closing] of [
			["```text", "```"],
			["  ~~~text", "   ~~~~~"],
			["   ````", "``````"],
		]) {
			const content = ["Instructions", opening, "REFERENCE", closing, "After"].join(newline);
			strictEqual(promptTemplateDisplayText({ content }), "REFERENCE");
		}
		strictEqual(
			promptTemplateDisplayText({ content: ["Before", "```", "body", "~~~", "after"].join(newline) }),
			"Before\n```\nbody\n~~~\nafter",
		);
	});
}
