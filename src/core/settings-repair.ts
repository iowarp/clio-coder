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
export function repairSettingsCoercions(): SettingsRepairResult {
	const path = settingsPath();
	if (!existsSync(path)) return { rewritten: [], skipped: [] };
	return withSettingsLock(() => {
		const validation = validateSettingsFile();
		const repairs = [
			...validation.coercions,
			...validation.issues.flatMap((issue) => (issue.repair !== undefined ? [issue.repair] : [])),
		];
		if (repairs.length === 0) return { rewritten: [], skipped: [] };
		const text = readFileSync(path, "utf8");
		const document = parseDocument(text);
		const edits: Array<{ start: number; end: number; repair: SettingsScalarRepair }> = [];
		const skipped: string[] = [];
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
		for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
			next = `${next.slice(0, edit.start)}"${edit.repair.to}"${next.slice(edit.end)}`;
		}
		if (edits.length === 0 || next === text) return { rewritten: [], skipped };
		const checked = validateSettings(parseYaml(next));
		const remaining = new Set([
			...checked.coercions.map((entry) => entry.path),
			...checked.issues.map((issue) => issue.path),
		]);
		if (edits.some((edit) => remaining.has(edit.repair.path))) {
			return { rewritten: [], skipped: [...skipped, ...edits.map((edit) => edit.repair.path)] };
		}
		safeResourceWrite(path, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE });
		return { rewritten: edits.map((edit) => edit.repair), skipped };
	});
}
