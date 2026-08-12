/**
 * Row builders for the plain-stdout `clio configure` surfaces.
 *
 * These are pure so the width behavior can be asserted at the sizes users
 * actually run. The wizard and `--list` were the first screens a new user sees
 * and the ones that handled width worst: both wrote rows sized for roughly 88
 * columns, so at 80 the model hints ran to 141 columns and the terminal wrapped
 * them into fragments that no longer lined up with any header.
 *
 * The category choices live here too, so the printed menu and the answers the
 * parser accepts come from one list instead of two that can drift.
 */

import { column, truncate, twoColumnRow } from "./text-layout.js";

function maxLength(values: ReadonlyArray<string>): number {
	return values.reduce((widest, value) => Math.max(widest, value.length), 0);
}

export type ConfigureCategory = "local-app" | "local-http" | "chatgpt" | "cloud-api" | "all";

export interface CategoryChoice {
	category: ConfigureCategory;
	label: string;
	summary: string;
	/** Accepted in addition to the ordinal and the category id itself. */
	aliases: readonly string[];
}

export const CONFIGURE_CATEGORY_CHOICES: readonly CategoryChoice[] = [
	{
		category: "local-app",
		label: "Local app",
		summary: "Ollama or LM Studio (recommended for new users)",
		aliases: ["local"],
	},
	{
		category: "local-http",
		label: "Local HTTP server",
		summary: "llama.cpp / vLLM / SGLang / OpenAI/Anthropic-compatible",
		aliases: ["http"],
	},
	{
		category: "chatgpt",
		label: "ChatGPT plan",
		summary: "Plus or Pro via Codex OAuth",
		aliases: ["codex"],
	},
	{
		category: "cloud-api",
		label: "Cloud API key",
		summary:
			"Anthropic, OpenAI, OpenRouter, Groq, Google, DeepSeek, Mistral, Bedrock, or any OpenAI/Anthropic-compatible endpoint (e.g. Inception)",
		aliases: ["cloud"],
	},
	{
		category: "all",
		label: "All runtimes",
		summary: "advanced (full list)",
		aliases: ["a"],
	},
];

export function formatCategoryMenu(width: number): string[] {
	const leftWidth = maxLength(CONFIGURE_CATEGORY_CHOICES.map((choice, index) => `${index + 1}. ${choice.label}`)) + 2;
	const lines: string[] = [];
	for (const [index, choice] of CONFIGURE_CATEGORY_CHOICES.entries()) {
		lines.push(...twoColumnRow(`${index + 1}. ${choice.label}`, choice.summary, { indent: 2, leftWidth, width }));
	}
	return lines;
}

/** Resolve a wizard answer against the same list the menu was printed from. */
export function matchCategoryChoice(answer: string): ConfigureCategory | null {
	const lc = answer.trim().toLowerCase();
	if (lc.length === 0) return null;
	for (const [index, choice] of CONFIGURE_CATEGORY_CHOICES.entries()) {
		if (lc === String(index + 1) || lc === choice.category || choice.aliases.includes(lc)) {
			return choice.category;
		}
	}
	return null;
}

export interface RuntimeMenuItem {
	/** Heading this item sits under. A change in value starts a new group. */
	group: string;
	runtimeId: string;
	summary: string;
}

export function formatRuntimeMenu(items: ReadonlyArray<RuntimeMenuItem>, width: number): string[] {
	if (items.length === 0) return [];
	const leftWidth = maxLength(items.map((item, index) => `${String(index + 1).padStart(2)}. ${item.runtimeId}`)) + 1;
	const lines: string[] = [];
	let lastGroup: string | null = null;
	// A group heading divides one group from the next, so a list with only one
	// group has nothing to divide. Emitting it anyway put `Local HTTP:` directly
	// under the caller's own `Local HTTP servers:` heading and spent a line of a
	// short terminal saying the same thing twice.
	const grouped = new Set(items.map((item) => item.group)).size > 1;
	for (const [index, item] of items.entries()) {
		if (grouped && item.group !== lastGroup) {
			lastGroup = item.group;
			lines.push(`  ${item.group}:`);
		}
		lines.push(
			...twoColumnRow(`${String(index + 1).padStart(2)}. ${item.runtimeId}`, item.summary, {
				indent: 4,
				leftWidth,
				width,
			}),
		);
	}
	return lines;
}

export interface RuntimeListRow {
	/** Heading this row sits under. A change in value starts a new group. */
	group: string;
	runtimeId: string;
	label: string;
	auth: string;
	targets: number;
	models: string;
}

const LIST_INDENT = 2;
const LIST_GAP = 1;
/** Below this much room the model hints are worth less than the alignment. */
const LIST_MIN_MODELS = 16;

/**
 * One aligned row per runtime while the terminal can hold every column, and a
 * two-line form below that: identity and auth state on the first line, the
 * display name and model hints indented on the second. Nothing is dropped in
 * either form, and every line is cut to the terminal so a long model id cannot
 * push the next row out of alignment.
 */
export function formatRuntimeList(rows: ReadonlyArray<RuntimeListRow>, width: number): string[] {
	if (rows.length === 0) return [];
	const targetCells = rows.map((row) => `targets=${row.targets}`);
	const idWidth = maxLength(rows.map((row) => row.runtimeId));
	const labelWidth = maxLength(rows.map((row) => row.label));
	const authWidth = maxLength(rows.map((row) => row.auth));
	const targetsWidth = maxLength(targetCells);
	const alignedWidth = LIST_INDENT + idWidth + LIST_GAP + labelWidth + LIST_GAP + authWidth + LIST_GAP + targetsWidth;
	const inline = width >= alignedWidth + LIST_GAP + LIST_MIN_MODELS;
	const pad = " ".repeat(LIST_INDENT);
	const detailPad = " ".repeat(LIST_INDENT + 2);
	const lines: string[] = [];
	let lastGroup: string | null = null;
	for (const [index, row] of rows.entries()) {
		if (row.group !== lastGroup) {
			if (lastGroup !== null) lines.push("");
			lastGroup = row.group;
			lines.push(`${row.group}:`);
		}
		const targetCell = targetCells[index] ?? "";
		const models = `models=${row.models}`;
		if (inline) {
			const id = column(row.runtimeId, idWidth);
			const label = column(row.label, labelWidth);
			const auth = column(row.auth, authWidth);
			lines.push(truncate(`${pad}${id} ${label} ${auth} ${column(targetCell, targetsWidth)} ${models}`, width));
			continue;
		}
		lines.push(truncate(`${pad}${column(row.runtimeId, idWidth)} ${column(row.auth, authWidth)} ${targetCell}`, width));
		lines.push(truncate(`${detailPad}${row.label} · ${models}`, width));
	}
	return lines;
}
