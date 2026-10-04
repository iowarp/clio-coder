/**
 * Explicit scalar repairs splice parsed source ranges so comments, key order,
 * blank lines and flow style stay byte for byte what the operator wrote.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Scalar } from "yaml";
import { isMap, isScalar, isSeq, parseDocument, parse as parseYaml } from "yaml";
import type { SettingsScalarRepair } from "./config.js";
import { settingsPath, validateSettings, validateSettingsFile, withSettingsLock } from "./config.js";
import { SETTINGS_FILE_MODE } from "./defaults.js";
import { safeResourceWrite } from "./safe-resource-write.js";

export interface SettingsRepairResult {
	rewritten: SettingsScalarRepair[];
	removed?: string[];
	/** Paths whose value the file's text cannot be edited for safely (an alias, an anchor, a tag). */
	skipped: string[];
}

/**
 * Walk a validator path (`fleet.profiles.fast.thinkingLevel`, `targets[0].x`) down
 * the parsed document. Keys may themselves contain dots, so every key that
 * prefixes the rest of the path is tried before giving up.
 */
function findNode(node: unknown, path: string): unknown {
	if (path === "") return node;
	if (isMap(node)) {
		for (const pair of node.items) {
			const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
			if (path === key) return findNode(pair.value, "");
			for (const separator of [".", "["]) {
				if (!path.startsWith(`${key}${separator}`)) continue;
				const found = findNode(pair.value, path.slice(separator === "." ? key.length + 1 : key.length));
				if (found !== null) return found;
			}
		}
		return null;
	}
	if (isSeq(node)) {
		const match = /^\[(\d+)\](?:\.(.*))?$/u.exec(path);
		if (match === null) return null;
		return findNode(node.items[Number(match[1])], match[2] ?? "");
	}
	return null;
}

function editableScalar(
	node: unknown,
	expected: boolean | string,
): node is Scalar<boolean | string> & { range: [number, number, number] } {
	return (
		isScalar(node) &&
		node.value === expected &&
		node.tag === undefined &&
		node.anchor === undefined &&
		Array.isArray(node.range)
	);
}

/**
 * Quoted replacements keep YAML 1.1 tools from reading on/off strings back
 * as booleans. The settings lock prevents a repair from replacing newer edits.
 * Nothing is written unless the edited text validates with none of the
 * rewritten paths still coerced.
 */
export function repairSettingsCoercions(additional: SettingsScalarRepair[] = []): SettingsRepairResult {
	const path = settingsPath();
	if (!existsSync(path)) return { rewritten: [], skipped: [] };
	return withSettingsLock(() => {
		const validation = validateSettingsFile();
		const repairs = [
			...additional,
			...validation.coercions,
			...validation.issues.flatMap((issue) => (issue.repair !== undefined ? [issue.repair] : [])),
		];
		if (repairs.length === 0 && validation.retired.length === 0) return { rewritten: [], skipped: [] };
		const text = readFileSync(path, "utf8");
		const document = parseDocument(text);
		const edits: Array<{ start: number; end: number; repair: SettingsScalarRepair }> = [];
		const skipped: string[] = [];
		const removals: Array<{ start: number; end: number; path: string }> = [];
		for (const retired of validation.retired) {
			const parts = retired.path.split(".");
			const key = parts.pop();
			const parent = findNode(document.contents, parts.join("."));
			const pair = isMap(parent)
				? parent.items.find((entry) => isScalar(entry.key) && entry.key.value === key)
				: undefined;
			const value = pair?.value;
			if (
				!pair ||
				!isScalar(pair.key) ||
				!pair.key.range ||
				!value ||
				typeof value !== "object" ||
				!("range" in value) ||
				!Array.isArray(value.range) ||
				("anchor" in value && value.anchor)
			) {
				skipped.push(retired.path);
				continue;
			}
			let start = text.lastIndexOf("\n", pair.key.range[0] - 1) + 1;
			let end = value.range[2] as number;
			if (isMap(parent) && parent.flow) {
				start = pair.key.range[0];
				end = value.range[1] as number;
				const after = /^\s*,\s*/.exec(text.slice(end));
				if (after) end += after[0].length;
				else {
					const before = /,\s*$/.exec(text.slice(0, start));
					if (before) start -= before[0].length;
				}
				removals.push({ start, end, path: retired.path });
				continue;
			}
			// Only whole block lines can be removed without reserializing adjacent settings or comments.
			if (text.slice(start, pair.key.range[0]).trim() || (end < text.length && text[end - 1] !== "\n")) {
				skipped.push(retired.path);
				continue;
			}
			removals.push({ start, end, path: retired.path });
		}
		for (const repair of repairs) {
			const node = findNode(document.contents, repair.path);
			if (!editableScalar(node, repair.from)) {
				skipped.push(repair.path);
				continue;
			}
			edits.push({ start: node.range[0], end: node.range[1], repair });
		}
		// Splice from the end so earlier offsets stay valid.
		let next = text;
		const removedRanges: Array<{ start: number; end: number; text: string }> = [];
		for (const removal of [...removals].sort((a, b) => a.start - b.start)) {
			const previous = removedRanges.at(-1);
			if (previous && removal.start <= previous.end) previous.end = Math.max(previous.end, removal.end);
			else removedRanges.push({ start: removal.start, end: removal.end, text: "" });
		}
		for (const edit of [
			...edits.map((entry) => ({ ...entry, text: JSON.stringify(entry.repair.to) })),
			...removedRanges,
		].sort((a, b) => b.start - a.start)) {
			next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
		}
		if (next === text) return { rewritten: [], skipped };
		const checked = validateSettings(parseYaml(next));
		const remaining = new Set([
			...checked.coercions.map((entry) => entry.path),
			...checked.issues.map((issue) => issue.path),
		]);
		if (edits.some((edit) => remaining.has(edit.repair.path))) {
			return { rewritten: [], skipped: [...skipped, ...edits.map((edit) => edit.repair.path)] };
		}
		safeResourceWrite(path, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE });
		return {
			rewritten: edits.map((edit) => edit.repair),
			skipped,
			...(removals.length ? { removed: removals.map((entry) => entry.path) } : {}),
		};
	});
}
