/**
 * The configure surfaces are the first screens a new user sees, and they were
 * the ones that handled width worst. `--list` wrote rows sized for roughly 88
 * columns; at 80 the model hints ran to 141 columns and the terminal wrapped
 * them into fragments that lined up with nothing.
 *
 * The width the layout is given is the width it must respect, so these cases
 * assert containment first, then that narrowing degrades by restacking rather
 * than by dropping a column's worth of information on the floor.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONFIGURE_CATEGORY_CHOICES,
	formatCategoryMenu,
	formatRuntimeList,
	formatRuntimeMenu,
	matchCategoryChoice,
	type RuntimeListRow,
} from "../../src/cli/configure-layout.js";
import { wrapPlain } from "../../src/cli/text-layout.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import {
	listProviderSupportEntries,
	type ProviderSupportEntry,
	supportGroupLabel,
} from "../../src/domains/providers/support.js";

/** Every size in the release width matrix that a plain-stdout surface can see. */
const WIDTHS = [40, 60, 70, 80, 100, 120, 160, 220];

/**
 * The real registry, so the widest label and the longest model id in the
 * shipped catalog are the ones under test rather than fixtures that drift.
 */
function realEntries(): ProviderSupportEntry[] {
	const registry = createRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	return listProviderSupportEntries(registry.list());
}

function realRows(): RuntimeListRow[] {
	return realEntries().map((entry) => ({
		group: supportGroupLabel(entry.group),
		runtimeId: entry.runtimeId,
		label: entry.label,
		auth: "needs-key",
		targets: 0,
		models: entry.modelHints.slice(0, 2).join(", ") || "-",
	}));
}

const NARROW_ROWS: RuntimeListRow[] = [
	{
		group: "Cloud APIs",
		runtimeId: "google",
		label: "Google Generative AI",
		auth: "needs-key",
		targets: 0,
		models: "deep-research-max-preview-04-2026, deep-research-preview-04-2026",
	},
	{
		group: "Local HTTP",
		runtimeId: "anthropic-compat",
		label: "Generic Anthropic-compatible",
		auth: "credential",
		targets: 2,
		models: "-",
	},
];

describe("contracts/configure layout", () => {
	it("keeps every runtime-list line inside the terminal at every matrix width", () => {
		const rows = realRows();
		for (const width of WIDTHS) {
			for (const line of formatRuntimeList(rows, width)) {
				ok(line.length <= width, `width ${width} produced a ${line.length}-column line: ${JSON.stringify(line)}`);
			}
		}
	});

	it("aligns every column when the terminal can hold them", () => {
		const lines = formatRuntimeList(NARROW_ROWS, 160).filter((line) => line.startsWith("  "));
		strictEqual(lines.length, 2, "wide layout writes one line per runtime");
		const [first = "", second = ""] = lines;
		// Same offset for the auth cell on both rows is the property the fixed
		// widths were reaching for and lost as soon as a label overran.
		strictEqual(first.indexOf("needs-key"), second.indexOf("credential"));
		ok(first.includes("targets=0") && first.includes("models=deep-research-max-preview-04-2026"));
		ok(second.includes("targets=2") && second.includes("models=-"));
	});

	it("restacks instead of dropping a column when the terminal is narrow", () => {
		const lines = formatRuntimeList(NARROW_ROWS, 60);
		const body = lines.filter((line) => line.startsWith("  "));
		strictEqual(body.length, 4, "narrow layout writes two lines per runtime");
		ok(body[0]?.includes("google") && body[0]?.includes("needs-key") && body[0]?.includes("targets=0"));
		// The label and the hints move to the detail line rather than vanishing.
		ok(body[1]?.includes("Google Generative AI"));
		ok(body[1]?.includes("models="));
		ok(body[3]?.includes("Generic Anthropic-compatible"));
	});

	it("marks a model hint it had to cut", () => {
		const [, , detail = ""] = formatRuntimeList([NARROW_ROWS[0] as RuntimeListRow], 60);
		ok(detail.endsWith("…"), `expected a truncation mark, got ${JSON.stringify(detail)}`);
		ok(detail.length <= 60);
	});

	it("groups runtime-list rows under one heading each", () => {
		const lines = formatRuntimeList(NARROW_ROWS, 100);
		deepStrictEqual(
			lines.filter((line) => line.endsWith(":")),
			["Cloud APIs:", "Local HTTP:"],
		);
	});

	it("keeps the category menu inside the terminal at every matrix width", () => {
		for (const width of WIDTHS) {
			for (const line of formatCategoryMenu(width)) {
				ok(line.length <= width, `width ${width} produced a ${line.length}-column line: ${JSON.stringify(line)}`);
			}
		}
	});

	it("stacks the category summary under its label when the terminal is narrow", () => {
		const wide = formatCategoryMenu(120);
		strictEqual(wide.length, CONFIGURE_CATEGORY_CHOICES.length + 1, "only the cloud summary wraps at 120");
		ok(wide[0]?.includes("1. Local app") && wide[0]?.includes("Ollama or LM Studio"));
		const narrow = formatCategoryMenu(40);
		const labelLine = narrow.indexOf("  1. Local app");
		ok(labelLine >= 0, "the label gets its own line when the summary cannot sit beside it");
		ok(narrow[labelLine + 1]?.trim().startsWith("Ollama or LM Studio"));
	});

	it("accepts every answer the category menu advertises", () => {
		for (const [index, choice] of CONFIGURE_CATEGORY_CHOICES.entries()) {
			strictEqual(matchCategoryChoice(String(index + 1)), choice.category);
			strictEqual(matchCategoryChoice(choice.category), choice.category);
			strictEqual(matchCategoryChoice(choice.category.toUpperCase()), choice.category);
			for (const alias of choice.aliases) strictEqual(matchCategoryChoice(alias), choice.category);
		}
		strictEqual(matchCategoryChoice("6"), null);
		strictEqual(matchCategoryChoice("ollama"), null);
		strictEqual(matchCategoryChoice(""), null);
	});

	it("keeps the runtime menu inside the terminal at every matrix width", () => {
		const items = realEntries().map((entry) => ({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			summary: entry.summary,
		}));
		for (const width of WIDTHS) {
			for (const line of formatRuntimeMenu(items, width)) {
				ok(line.length <= width, `width ${width} produced a ${line.length}-column line: ${JSON.stringify(line)}`);
			}
		}
	});

	it("drops the group heading when every runtime is in one group", () => {
		// A group heading divides one group from the next. The wizard's category
		// screens list a single group under a heading the caller already printed,
		// so emitting it again put `Local HTTP:` directly under `Local HTTP
		// servers:` and spent a line of a short terminal saying it twice.
		const oneGroup = [
			{ group: "Local HTTP", runtimeId: "llamacpp", summary: "llama.cpp server" },
			{ group: "Local HTTP", runtimeId: "vllm", summary: "vLLM" },
		];
		const lines = formatRuntimeMenu(oneGroup, 80);
		ok(
			!lines.some((line) => line.trim() === "Local HTTP:"),
			`a single-group menu has no divider to draw: ${JSON.stringify(lines)}`,
		);
		ok(lines.some((line) => line.includes("llamacpp")), "the entries are still listed");

		// Two groups still need the divider that tells them apart.
		const twoGroups = [...oneGroup, { group: "Cloud APIs", runtimeId: "anthropic", summary: "Anthropic" }];
		const dividedLines = formatRuntimeMenu(twoGroups, 80);
		ok(
			dividedLines.some((line) => line.trim() === "Local HTTP:"),
			"a menu spanning groups keeps its headings",
		);
		ok(
			dividedLines.some((line) => line.trim() === "Cloud APIs:"),
			"both headings, not just the first",
		);
	});

	it("gives every wrapped line the full column, not the column minus its indent", () => {
		// The hanging indent is added when a line is emitted. Counting it against
		// the budget the next word is measured against made each continuation
		// line shorter than the last, so a four-word tail wrapped four times.
		// `width` is the room for text; the indent sits outside it.
		const wrapped = wrapPlain("aaaa bbbb cccc dddd eeee ffff gggg", 14, 6);
		deepStrictEqual(wrapped, ["aaaa bbbb cccc", "      dddd eeee ffff", "      gggg"]);
		for (const line of wrapped.slice(1)) strictEqual(line.trimStart().length <= 14, true);
	});

	it("emits a word longer than the column whole rather than splitting it", () => {
		// Runtime ids and URLs are worse broken than overhanging.
		deepStrictEqual(wrapPlain("id https://example.invalid/very/long/path", 12), [
			"id",
			"https://example.invalid/very/long/path",
		]);
	});

	it("numbers the runtime menu from one across group headings", () => {
		const lines = formatRuntimeMenu(
			[
				{ group: "Featured", runtimeId: "openai-codex", summary: "ChatGPT Plus/Pro via Codex OAuth" },
				{ group: "Cloud APIs", runtimeId: "anthropic", summary: "Anthropic API" },
				{ group: "Cloud APIs", runtimeId: "openai", summary: "OpenAI Platform API" },
			],
			100,
		);
		deepStrictEqual(lines, [
			"  Featured:",
			"     1. openai-codex ChatGPT Plus/Pro via Codex OAuth",
			"  Cloud APIs:",
			"     2. anthropic    Anthropic API",
			"     3. openai       OpenAI Platform API",
		]);
	});
});
