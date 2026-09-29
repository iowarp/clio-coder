/**
 * The one repair `clio-coder doctor --fix` makes to settings.yaml itself: turning
 * the YAML 1.1 booleans that `validateSettings` reads as on/off levels into the
 * strings they stand for. Only those scalars change. The edit splices the
 * parsed node's source range, so comments, key order, blank lines and flow
 * style stay byte for byte what the operator wrote.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isMap, isScalar, isSeq, parseDocument, parse as parseYaml, type Scalar } from "yaml";
import {
	type SettingsCoercion,
	settingsPath,
	validateSettings,
	validateSettingsFile,
	withSettingsLock,
} from "./config.js";
import { safeResourceWrite } from "./safe-resource-write.js";

export interface SettingsRepairResult {
	rewritten: SettingsCoercion[];
	/** Coerced paths whose value the file's text cannot be edited for safely (an alias, an anchor, a tag). */
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

function editableBoolean(
	node: unknown,
	expected: boolean,
): node is Scalar<boolean> & { range: [number, number, number] } {
	return (
		isScalar(node) &&
		node.value === expected &&
		node.tag === undefined &&
		node.anchor === undefined &&
		Array.isArray(node.range)
	);
}

/**
 * Rewrite every coerced boolean in the user's settings.yaml to its quoted
 * string, under the settings lock and through `safeResourceWrite`. The
 * quotes keep a YAML 1.1 tool from reading the string back as a boolean.
 * Nothing is written unless the edited text validates with none of the
 * rewritten paths still coerced.
 */
export function repairSettingsCoercions(): SettingsRepairResult {
	const path = settingsPath();
	if (!existsSync(path)) return { rewritten: [], skipped: [] };
	return withSettingsLock(() => {
		const { coercions } = validateSettingsFile();
		if (coercions.length === 0) return { rewritten: [], skipped: [] };
		const text = readFileSync(path, "utf8");
		const document = parseDocument(text);
		const edits: Array<{ start: number; end: number; coercion: SettingsCoercion }> = [];
		const skipped: string[] = [];
		for (const coercion of coercions) {
			const node = findNode(document.contents, coercion.path);
			if (!editableBoolean(node, coercion.from)) {
				skipped.push(coercion.path);
				continue;
			}
			edits.push({ start: node.range[0], end: node.range[1], coercion });
		}
		// Splice from the end so earlier offsets stay valid.
		let next = text;
		for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
			next = `${next.slice(0, edit.start)}"${edit.coercion.to}"${next.slice(edit.end)}`;
		}
		if (edits.length === 0 || next === text) return { rewritten: [], skipped };
		const remaining = new Set(validateSettings(parseYaml(next)).coercions.map((entry) => entry.path));
		if (edits.some((edit) => remaining.has(edit.coercion.path))) {
			return { rewritten: [], skipped: [...skipped, ...edits.map((edit) => edit.coercion.path)] };
		}
		safeResourceWrite(path, next, { encoding: "utf8", mode: statSync(path).mode & 0o777 });
		return { rewritten: edits.map((edit) => edit.coercion), skipped };
	});
}
