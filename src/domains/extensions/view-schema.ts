import type { ExtensionIsland } from "./public-api-v2.js";
import { extensionPlainText } from "./runtime-schema.js";
import type { View, ViewTableCell } from "./view.js";
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

function identifier(value: unknown, path: string): string {
	const id = label(value, path) as string;
	if (id.length === 0) reject(path, "expected a non-empty identifier");
	return id;
}

function meter(value: unknown, path: string): Record<string, unknown> {
	const copy = shape(value, path, { value: required(finite), max: required(finite), tone: optional(tone) });
	const max = copy.max as number;
	if (max <= 0) reject(childPath(path, "max"), "expected a maximum above zero");
	copy.value = Math.min(max, Math.max(0, copy.value as number));
	return copy;
}

const tableCell: Parser = (value, path) => {
	if (typeof value === "string") return text(value, path);
	const raw = record(value, path);
	if (Object.hasOwn(raw, "text")) return shape(raw, path, { text: required(text), tone: optional(tone) });
	return meter(raw, path);
};

function artLine(value: unknown, path: string): string {
	const line = text(value, path) as string;
	if (line.includes("\n")) reject(path, "expected one art line");
	if ([...line].length > VIEW_LIMITS.artColumns) reject(path, `exceeds ${VIEW_LIMITS.artColumns} art characters`);
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
					rows: required(array(VIEW_LIMITS.tableRows, array(VIEW_LIMITS.tableColumns, tableCell))),
					keys: optional(array(VIEW_LIMITS.tableRows, identifier)),
					action: optional(identifier),
				});
				break;
			case "list":
				fields.items = required(
					array(VIEW_LIMITS.listItems, (value, path) =>
						shape(value, path, {
							key: required(identifier),
							label: required(label),
							detail: optional(text),
							mark: optional(label),
							tone: optional(tone),
						}),
					),
				);
				fields.action = optional(identifier);
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
										key: required(identifier),
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
				fields.action = optional(identifier);
				break;
			}
			case "tree": {
				let treeNodes = 0;
				const treeNode = (value: unknown, path: string, nodeDepth: number): unknown => {
					count(path, nodeDepth);
					if (++treeNodes > VIEW_LIMITS.treeNodes) reject(path, `exceeds ${VIEW_LIMITS.treeNodes} tree nodes`);
					return shape(value, path, {
						key: required(identifier),
						label: required(label),
						detail: optional(text),
						tone: optional(tone),
						children: optional(array(VIEW_LIMITS.treeNodes, (value, path) => treeNode(value, path, nodeDepth + 1))),
					});
				};
				fields.nodes = required(array(VIEW_LIMITS.treeNodes, (value, path) => treeNode(value, path, depth + 1)));
				fields.action = optional(identifier);
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
							id: required(identifier),
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
				fields.size = optional(clamp(0, VIEW_LIMITS.spacerSize));
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
			for (const [index, row] of (copy.rows as ViewTableCell[][]).entries()) {
				if (row.length !== columns.length) reject(childPath(childPath(path, "rows"), index), "row must match column count");
			}
			if (copy.keys !== undefined && (copy.keys as string[]).length !== (copy.rows as ViewTableCell[][]).length)
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
				key: required(identifier),
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
