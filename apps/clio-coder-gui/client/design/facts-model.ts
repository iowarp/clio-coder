// Turns a wire record into labelled facts. The records that reach an inspector are often
// `Record<string, unknown>` on the contract, so the rules here are about the value and the key's
// own words, never about a particular schema. Pure, so the wording is testable without a browser.

import { formatCost, formatDuration, formatTime } from "../api/clock.js";

export type Fact =
	| { kind: "value"; label: string; text: string; tone?: "absent" | "yes" | "no"; mono?: boolean }
	| { kind: "list"; label: string; items: string[]; omitted: number }
	| { kind: "group"; label: string; facts: Fact[]; omitted: number }
	| { kind: "rows"; label: string; rows: Fact[][]; omitted: number };

export const FACT_LIMITS = { depth: 4, keys: 40, items: 24, text: 600 } as const;

const ACRONYMS = new Set([
	"id",
	"ids",
	"url",
	"usd",
	"api",
	"acp",
	"cwd",
	"sha",
	"sha256",
	"ms",
	"cli",
	"json",
	"ttl",
	"pid",
]);
/** `toolCallsPerRun` → "Tool calls per run"; `costUsd` → "Cost USD"; `sha256` → "SHA256". */
export function humanizeKey(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-.]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		// The value already carries these units ("1m 1s", "$0.00"), so the label drops them.
		.filter((word, index, all) => !(index === all.length - 1 && all.length > 1 && /^(ms|usd)$/i.test(word)))
		.map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
	const first = words[0];
	if (!first) return key;
	return [
		ACRONYMS.has(first.toLowerCase()) ? first : `${first[0]?.toUpperCase()}${first.slice(1)}`,
		...words.slice(1),
	].join(" ");
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const clip = (text: string) => (text.length > FACT_LIMITS.text ? `${text.slice(0, FACT_LIMITS.text - 1)}…` : text);

/** One scalar, in the operator's words. The key decides the unit; the value never guesses one. */
export function scalarText(
	key: string,
	value: string | number | boolean | null | undefined,
): { text: string; tone?: "absent" | "yes" | "no"; mono?: boolean } {
	// Absent and zero are different facts, and only absent reads "not recorded".
	if (value === null || value === undefined) return { text: "Not recorded", tone: "absent" };
	if (typeof value === "boolean") return value ? { text: "Yes", tone: "yes" } : { text: "No", tone: "no" };
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return { text: "Not recorded", tone: "absent" };
		if (/usd$/i.test(key)) return { text: formatCost(value) };
		if (/ms$/i.test(key)) return { text: formatDuration(value) };
		if (/(bytes|Bytes)$/.test(key)) return { text: `${value.toLocaleString("en-US")} bytes` };
		return { text: value.toLocaleString("en-US") };
	}
	if (value === "") return { text: "Empty", tone: "absent" };
	if (ISO.test(value)) return { text: formatTime(value) };
	const mono = /(^|[a-z])(id|ids|hash|sha256|digest|path|ref|cwd|url)$/i.test(key) || /^[a-f0-9]{16,}$/.test(value);
	return { text: clip(value), ...(mono ? { mono: true } : {}) };
}

const scalar = (value: unknown): value is string | number | boolean | null | undefined =>
	value === null || value === undefined || typeof value !== "object";

/**
 * Facts for one record. `order` names the keys that lead, in that order; the rest follow in wire
 * order. Every bound that drops something reports how much, so nothing is silently truncated.
 */
export function factsOf(
	value: unknown,
	options: { order?: readonly string[]; hide?: readonly string[] } = {},
	depth = 0,
): { facts: Fact[]; omitted: number } {
	if (scalar(value) || Array.isArray(value)) return { facts: [factFor("Value", "value", value, depth)], omitted: 0 };
	const hide = new Set(options.hide ?? []);
	const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !hide.has(key));
	const lead = (options.order ?? []).flatMap((key) => entries.filter(([candidate]) => candidate === key));
	const rest = entries.filter(([key]) => !(options.order ?? []).includes(key));
	const ordered = [...lead, ...rest];
	return {
		facts: ordered.slice(0, FACT_LIMITS.keys).map(([key, item]) => factFor(humanizeKey(key), key, item, depth)),
		omitted: Math.max(0, ordered.length - FACT_LIMITS.keys),
	};
}

function factFor(label: string, key: string, value: unknown, depth: number): Fact {
	if (scalar(value)) return { kind: "value", label, ...scalarText(key, value) };
	if (Array.isArray(value)) {
		if (!value.length) return { kind: "value", label, text: "None", tone: "absent" };
		const shown = value.slice(0, FACT_LIMITS.items);
		const omitted = value.length - shown.length;
		if (shown.every(scalar))
			return { kind: "list", label, items: shown.map((item) => scalarText(key, item).text), omitted };
		if (depth >= FACT_LIMITS.depth)
			return { kind: "value", label, text: `${value.length} nested records`, tone: "absent" };
		return { kind: "rows", label, rows: shown.map((item) => factsOf(item, {}, depth + 1).facts), omitted };
	}
	const size = Object.keys(value as object).length;
	if (!size) return { kind: "value", label, text: "None", tone: "absent" };
	if (depth >= FACT_LIMITS.depth) return { kind: "value", label, text: `${size} nested fields`, tone: "absent" };
	const nested = factsOf(value, {}, depth + 1);
	return { kind: "group", label, facts: nested.facts, omitted: nested.omitted };
}

/** The sentence for a bound that dropped something. `noun` is singular. */
export const omittedSentence = (omitted: number, noun: string) =>
	omitted > 0
		? `${omitted.toLocaleString("en-US")} more ${noun}${omitted === 1 ? " is" : "s are"} outside this bounded view.`
		: "";
