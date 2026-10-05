import type { ExtensionIsland } from "./public-api-v2.js";
import { extensionPlainText } from "./runtime-schema.js";
import type { View } from "./view.js";
import { SURFACE_LIMITS, VIEW_LIMITS } from "./view-limits.js";

export type ViewValidation = { ok: true; view: View; nodes: number } | { ok: false; path: string; reason: string };

type Parser = (value: unknown, path: string) => unknown;
type Field = { parse: Parser; optional?: boolean };
type Shape = Record<string, Field>;

class InvalidView extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(reason);
	}
}

function reject(path: string, reason: string): never {
	throw new InvalidView(path || "/", reason);
}

function childPath(path: string, key: string | number): string {
	return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) reject(path, "expected an object");
	return value as Record<string, unknown>;
}

function shape(value: unknown, path: string, fields: Shape): Record<string, unknown> {
	const raw = record(value, path);
	for (const key of Reflect.ownKeys(raw)) {
		if (typeof key !== "string" || !Object.hasOwn(fields, key)) reject(childPath(path, String(key)), "unknown field");
	}
	const copy: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(fields)) {
		if (field.optional && !Object.hasOwn(raw, key)) continue;
		copy[key] = field.parse(Object.hasOwn(raw, key) ? raw[key] : undefined, childPath(path, key));
	}
	return copy;
}

const required = (parse: Parser): Field => ({ parse });
const optional = (parse: Parser): Field => ({ parse, optional: true });

function string(max: number): Parser {
	return (value, path) => {
		if (typeof value !== "string") reject(path, "expected a string");
		if (value.length > max) reject(path, `exceeds ${max} characters`);
		return extensionPlainText(value);
	};
}

function choice(...values: string[]): Parser {
	return (value, path) => {
		if (typeof value !== "string" || !values.includes(value)) reject(path, `expected ${values.join(" | ")}`);
		return extensionPlainText(value);
	};
}

function finite(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) reject(path, "expected a finite number");
	return value;
}

function clamp(min: number, max: number): Parser {
	return (value, path) => Math.min(max, Math.max(min, finite(value, path)));
}

const boolean: Parser = (value, path) => {
	if (typeof value !== "boolean") reject(path, "expected a boolean");
	return value;
};

function array(max: number, parse: Parser): Parser {
	return (value, path) => {
		if (!Array.isArray(value)) reject(path, "expected an array");
		if (value.length > max) reject(childPath(path, max), `exceeds ${max} entries`);
		return Array.from(value, (item, index) => parse(item, childPath(path, index)));
	};
}

const label = string(VIEW_LIMITS.labelChars);
const text = string(VIEW_LIMITS.textChars);
const tone = choice("neutral", "muted", "accent", "brand", "positive", "warning", "error", "info");
const badge: Parser = (value, path) => shape(value, path, { text: required(label), tone: optional(tone) });

// Unicode 17 East_Asian_Width W/F ranges keep art validation independent of
// the terminal engine. The grapheme rules match its treatment of marks and
// emoji; this table must move with the host's Unicode width data (S1).
const WIDE_CELL =
	/[\u1100-\u115F\u231A-\u231B\u2329-\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2630-\u2637\u2648-\u2653\u267F\u268A-\u268F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3000\u3001-\u303E\u3041-\u3096\u3099-\u30FF\u3105-\u312F\u3131-\u318E\u3190-\u31E5\u31EF-\u321E\u3220-\u3247\u3250-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFF01-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{16FE4}\u{16FF0}-\u{16FF6}\u{17000}-\u{18CD5}\u{18CFF}-\u{18D1E}\u{18D80}-\u{18DF2}\u{1AFF0}-\u{1AFF3}\u{1AFF5}-\u{1AFFB}\u{1AFFD}-\u{1AFFE}\u{1B000}-\u{1B122}\u{1B132}\u{1B150}-\u{1B152}\u{1B155}\u{1B164}-\u{1B167}\u{1B170}-\u{1B2FB}\u{1D300}-\u{1D356}\u{1D360}-\u{1D376}\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F200}-\u{1F202}\u{1F210}-\u{1F23B}\u{1F240}-\u{1F248}\u{1F250}-\u{1F251}\u{1F260}-\u{1F265}\u{1F300}-\u{1F320}\u{1F32D}-\u{1F335}\u{1F337}-\u{1F37C}\u{1F37E}-\u{1F393}\u{1F3A0}-\u{1F3CA}\u{1F3CF}-\u{1F3D3}\u{1F3E0}-\u{1F3F0}\u{1F3F4}\u{1F3F8}-\u{1F43E}\u{1F440}\u{1F442}-\u{1F4FC}\u{1F4FF}-\u{1F53D}\u{1F54B}-\u{1F54E}\u{1F550}-\u{1F567}\u{1F57A}\u{1F595}-\u{1F596}\u{1F5A4}\u{1F5FB}-\u{1F64F}\u{1F680}-\u{1F6C5}\u{1F6CC}\u{1F6D0}-\u{1F6D2}\u{1F6D5}-\u{1F6D8}\u{1F6DC}-\u{1F6DF}\u{1F6EB}-\u{1F6EC}\u{1F6F4}-\u{1F6FC}\u{1F7E0}-\u{1F7EB}\u{1F7F0}\u{1F90C}-\u{1F93A}\u{1F93C}-\u{1F945}\u{1F947}-\u{1F9FF}\u{1FA70}-\u{1FA7C}\u{1FA80}-\u{1FA8A}\u{1FA8E}-\u{1FAC6}\u{1FAC8}\u{1FACD}-\u{1FADC}\u{1FADF}-\u{1FAEA}\u{1FAEF}-\u{1FAF8}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
const ART_GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
// biome-ignore lint/complexity/useRegexLiterals: Node 22 supports v, but the repository's ES2022 TypeScript target rejects v literals.
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const NONPRINTING = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{M}\p{Surrogate}]/u;
const LEADING_NONPRINTING = /^[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{M}\p{Surrogate}]+/u;
// biome-ignore lint/complexity/useRegexLiterals: Node 22 supports v, but the repository's ES2022 TypeScript target rejects v literals.
const SPACING_MARK = new RegExp(
	"^(?:[\\p{Spacing_Mark}--[\\u1734\\u302E\\u302F]]|[\\u065F\\u0F7F\\u102B\\u102C\\u1031\\u1033-\\u1035\\u1038\\u103A-\\u103E])+$",
	"v",
);

function codePointCells(char: string): number {
	return WIDE_CELL.test(char) ? 2 : 1;
}

function artLine(value: unknown, path: string): string {
	const line = text(value, path) as string;
	if (line.includes("\n")) reject(path, "expected one art line");
	let columns = 0;
	for (const { segment } of ART_GRAPHEMES.segment(line)) {
		if (segment === "\t") {
			columns += 3;
			continue;
		}
		if (SPACING_MARK.test(segment)) {
			columns += [...segment].length;
			continue;
		}
		if (RGI_EMOJI.test(segment)) {
			columns += 2;
			continue;
		}
		const base = [...segment.replace(LEADING_NONPRINTING, "")];
		const first = base[0];
		if (first === undefined) continue;
		const cp = first.codePointAt(0) ?? 0;
		if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
			columns += 2;
			continue;
		}
		columns += codePointCells(first);
		let followsMark = false;
		for (const char of base.slice(1)) {
			if (SPACING_MARK.test(char)) {
				columns++;
				followsMark = false;
			} else if (/\p{M}/u.test(char)) followsMark = true;
			else if (!NONPRINTING.test(char)) {
				const cp = char.codePointAt(0) ?? 0;
				if (followsMark || (cp >= 0xff00 && cp <= 0xffef)) columns += codePointCells(char);
				else if (cp === 0x0e33 || cp === 0x0eb3) columns++;
				followsMark = false;
			}
		}
	}
	if (columns > VIEW_LIMITS.artColumns) reject(path, `exceeds ${VIEW_LIMITS.artColumns} art columns`);
	return line;
}

function parseView(value: unknown, rootPath: string): { view: View; nodes: number } {
	let nodes = 0;
	const count = (path: string, depth: number): void => {
		if (depth > VIEW_LIMITS.depth) reject(path, `exceeds depth ${VIEW_LIMITS.depth}`);
		if (++nodes > VIEW_LIMITS.nodes) reject(path, `exceeds ${VIEW_LIMITS.nodes} nodes`);
	};
	const visit = (value: unknown, path: string, depth: number): Record<string, unknown> => {
		count(path, depth);
		const raw = record(value, path);
		const kind = raw.t;
		const fields: Shape = { t: required(choice(typeof kind === "string" ? kind : "")) };
		const children: Parser = (value, path) => visit(value, path, depth + 1);
		switch (kind) {
			case "box":
				Object.assign(fields, {
					dir: optional(choice("row", "col")),
					gap: optional(clamp(0, 4)),
					pad: optional(clamp(0, 4)),
					border: optional(choice("none", "single", "round")),
					title: optional(label),
					meta: optional(label),
					grow: optional(clamp(0, 8)),
					width: optional(clamp(1, 240)),
					children: required(array(VIEW_LIMITS.nodes, children)),
				});
				break;
			case "text":
				Object.assign(fields, {
					text: required(text),
					tone: optional(tone),
					bold: optional(boolean),
					dim: optional(boolean),
					wrap: optional(choice("wrap", "truncate")),
					align: optional(choice("left", "center", "right")),
				});
				break;
			case "markdown":
				fields.text = required(string(VIEW_LIMITS.markdownChars));
				break;
			case "kv":
				fields.items = required(
					array(VIEW_LIMITS.kvItems, (value, path) =>
						shape(value, path, {
							label: required(label),
							value: required(text),
							tone: optional(tone),
						}),
					),
				);
				break;
			case "table":
				Object.assign(fields, {
					columns: required(array(VIEW_LIMITS.tableColumns, label)),
					rows: required(array(VIEW_LIMITS.tableRows, array(VIEW_LIMITS.tableColumns, text))),
					keys: optional(array(VIEW_LIMITS.tableRows, label)),
					action: optional(label),
				});
				break;
			case "list":
				fields.items = required(
					array(VIEW_LIMITS.listItems, (value, path) =>
						shape(value, path, {
							key: required(label),
							label: required(label),
							detail: optional(text),
							mark: optional(label),
							tone: optional(tone),
						}),
					),
				);
				fields.action = optional(label);
				break;
			case "steps":
				fields.items = required(
					array(VIEW_LIMITS.steps, (value, path) =>
						shape(value, path, {
							label: required(label),
							state: required(choice("done", "active", "todo", "blocked")),
						}),
					),
				);
				break;
			case "board": {
				let cards = 0;
				fields.columns = required(
					array(VIEW_LIMITS.boardColumns, (value, path) =>
						shape(value, path, {
							title: required(label),
							tone: optional(tone),
							cards: required(
								array(VIEW_LIMITS.boardCards, (value, path) => {
									if (++cards > VIEW_LIMITS.boardCards) reject(path, `exceeds ${VIEW_LIMITS.boardCards} board cards`);
									return shape(value, path, {
										key: required(label),
										title: required(label),
										detail: optional(text),
										tone: optional(tone),
										badges: optional(array(VIEW_LIMITS.cardBadges, badge)),
									});
								}),
							),
						}),
					),
				);
				fields.action = optional(label);
				break;
			}
			case "tree": {
				let treeNodes = 0;
				const treeNode = (value: unknown, path: string, nodeDepth: number): unknown => {
					count(path, nodeDepth);
					if (++treeNodes > VIEW_LIMITS.treeNodes) reject(path, `exceeds ${VIEW_LIMITS.treeNodes} tree nodes`);
					return shape(value, path, {
						key: required(label),
						label: required(label),
						detail: optional(text),
						tone: optional(tone),
						children: optional(array(VIEW_LIMITS.treeNodes, (value, path) => treeNode(value, path, nodeDepth + 1))),
					});
				};
				fields.nodes = required(array(VIEW_LIMITS.treeNodes, (value, path) => treeNode(value, path, depth + 1)));
				fields.action = optional(label);
				break;
			}
			case "progress":
				Object.assign(fields, {
					value: required(finite),
					max: required(finite),
					label: optional(label),
					tone: optional(tone),
				});
				break;
			case "spark":
				Object.assign(fields, { values: required(array(VIEW_LIMITS.sparkValues, finite)), tone: optional(tone) });
				break;
			case "badge":
				Object.assign(fields, { text: required(label), tone: optional(tone) });
				break;
			case "actions":
				fields.items = required(
					array(VIEW_LIMITS.actions, (value, path) =>
						shape(value, path, {
							id: required(label),
							label: required(label),
							primary: optional(boolean),
							hotkey: optional((value, path) => {
								if (typeof value !== "string" || !/^[a-z0-9]$/.test(value))
									reject(path, "expected one lowercase letter or digit");
								return extensionPlainText(value);
							}),
						}),
					),
				);
				break;
			case "art":
				Object.assign(fields, { lines: required(array(VIEW_LIMITS.artLines, artLine)), tone: optional(tone) });
				break;
			case "divider":
				break;
			case "spacer":
				// A spacer has no numeric limit in the contract; use the spacing
				// budget of gap/pad so a finite number cannot allocate unbounded rows.
				fields.size = optional(clamp(0, 4));
				break;
			default:
				reject(childPath(path, "t"), "unknown view kind");
		}
		const copy = shape(raw, path, fields);
		if (kind === "progress") {
			const max = copy.max as number;
			if (max <= 0) reject(childPath(path, "max"), "expected a maximum above zero");
			copy.value = Math.min(max, Math.max(0, copy.value as number));
		} else if (kind === "table") {
			const columns = copy.columns as string[];
			if (columns.length === 0) reject(childPath(path, "columns"), "expected at least one column");
			for (const [index, row] of (copy.rows as string[][]).entries()) {
				if (row.length !== columns.length) reject(childPath(childPath(path, "rows"), index), "row must match column count");
			}
			if (copy.keys !== undefined && (copy.keys as string[]).length !== (copy.rows as string[][]).length)
				reject(childPath(path, "keys"), "keys must match row count");
		}
		return copy;
	};
	return { view: visit(value, rootPath, 1) as unknown as View, nodes };
}

function failure(error: unknown): { ok: false; path: string; reason: string } {
	return {
		ok: false,
		path: error instanceof InvalidView ? error.path : "/",
		reason: error instanceof Error ? error.message : String(error),
	};
}

export function validateView(value: unknown): ViewValidation {
	try {
		return { ok: true, ...parseView(value, "") };
	} catch (error) {
		return failure(error);
	}
}

export function validateIslands(
	value: unknown,
): { ok: true; islands: ExtensionIsland[] } | { ok: false; path: string; reason: string } {
	try {
		const keys = new Set<string>();
		const islands = array(SURFACE_LIMITS.islands, (value, path) => {
			const island = shape(value, path, {
				key: required(label),
				title: required(label),
				meta: optional(label),
				tone: optional(tone),
				view: required((value, path) => parseView(value, path).view),
			});
			const key = island.key as string;
			if (keys.has(key)) reject(childPath(path, "key"), "duplicate island key");
			keys.add(key);
			return island;
		})(value, "") as ExtensionIsland[];
		return { ok: true, islands };
	} catch (error) {
		return failure(error);
	}
}
