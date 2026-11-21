import { existsSync, readFileSync } from "node:fs";
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import {
	SETTINGS_V1_RETIRED_PATHS,
	SETTINGS_V2_RETIRED_VALUE_SPELLINGS,
	SETTINGS_V2_RETIRED_WORKFLOWS,
	settingsPath,
	validateSettings,
	withSettingsLock,
} from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Rewrites what the settings validator used to tolerate at read time, so it no
 * longer has to: version-2 keys retired without a replacement
 * (`SETTINGS_V1_RETIRED_PATHS`), the turn-control workflows `init` once wrote,
 * the older `interface.exitSummary` and `interface.outputDetail` spellings and
 * a version-2 `fleet.nodes[].clioEntry`. Each change is reported, the previous
 * file is kept beside it, and only the user file is touched: project layers are
 * the repository's.
 */

const ID = "2026-11-21-retired-settings";

type Segment = string | number;

const RETIRED_VALUE_SPELLINGS = Object.entries(SETTINGS_V2_RETIRED_VALUE_SPELLINGS).map(([dotted, values]) => ({
	path: dotted.split(".") as readonly Segment[],
	values,
}));

interface RetiredSettingsRewrite {
	changed: string[];
	attention: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(path: readonly Segment[]): string {
	return path.reduce<string>(
		(out, segment) => (typeof segment === "number" ? `${out}[${segment}]` : out ? `${out}.${segment}` : segment),
		"",
	);
}

/** Expand a table pattern (`*` a map key, `[]` a list element) against the resolved document. */
function matches(root: unknown, pattern: string): Segment[][] {
	const out: Segment[][] = [];
	const visit = (current: unknown, rest: readonly string[], path: Segment[]): void => {
		const [segment, ...tail] = rest;
		if (segment === undefined) {
			out.push(path);
			return;
		}
		if (!isRecord(current)) return;
		if (segment === "*") {
			for (const key of Object.keys(current)) visit(current[key], tail, [...path, key]);
			return;
		}
		const list = segment.endsWith("[]");
		const key = list ? segment.slice(0, -2) : segment;
		if (!Object.hasOwn(current, key)) return;
		const child = current[key];
		if (!list) visit(child, tail, [...path, key]);
		else if (Array.isArray(child)) for (const [index, item] of child.entries()) visit(item, tail, [...path, key, index]);
	};
	visit(root, pattern.split("."), []);
	return out;
}

/** Remove one key, then each map it left empty, stopping at a list element or the root. */
function removeKey(doc: Document, path: readonly Segment[]): void {
	doc.deleteIn(path);
	for (let depth = path.length - 1; depth > 0; depth -= 1) {
		const parent = path.slice(0, depth);
		if (typeof parent.at(-1) !== "string") return;
		const node = doc.getIn(parent, true);
		if (!isMap(node) || node.items.length > 0) return;
		doc.deleteIn(parent);
	}
}

function rewriteRetiredSettings(doc: Document): RetiredSettingsRewrite {
	const result: RetiredSettingsRewrite = { changed: [], attention: [] };
	const unreachable = (path: readonly Segment[], what: string): void => {
		result.attention.push(
			`${display(path)} ${what} through a YAML anchor, alias or merge key and was left as written; edit it by hand.`,
		);
	};

	for (const [pattern, reason] of Object.entries(SETTINGS_V1_RETIRED_PATHS)) {
		// Deepest and last first, so removing one match never shifts the index of another.
		for (const path of matches(doc.toJS(), pattern).reverse()) {
			if (!doc.hasIn(path)) {
				unreachable(path, "is retired and reaches the file");
				continue;
			}
			removeKey(doc, path);
			result.changed.push(`Removed ${display(path)}: ${reason}.`);
		}
	}

	const workflowsPath = ["turnControl", "workflows"];
	const workflows = doc.getIn(workflowsPath, true);
	if (isSeq(workflows)) {
		for (let index = workflows.items.length - 1; index >= 0; index -= 1) {
			const item = workflows.items[index];
			if (!isScalar(item) || !SETTINGS_V2_RETIRED_WORKFLOWS.has(item.value)) continue;
			workflows.items.splice(index, 1);
			result.changed.push(
				`Removed ${String(item.value)} from turnControl.workflows: no harness workflow by that name runs any more.`,
			);
		}
	}

	for (const { path, values } of RETIRED_VALUE_SPELLINGS) {
		const node = doc.getIn(path, true);
		if (isAlias(node)) {
			const resolved = (doc.toJS() as Record<string, Record<string, unknown> | undefined>)[String(path[0])]?.[
				String(path[1])
			];
			if (typeof resolved === "string" && Object.hasOwn(values, resolved)) unreachable(path, `is ${resolved}`);
			continue;
		}
		if (!isScalar(node) || typeof node.value !== "string" || !Object.hasOwn(values, node.value)) continue;
		const from = node.value;
		const to = values[from] as string;
		if (node.anchor !== undefined) {
			unreachable(path, `is ${from}`);
			continue;
		}
		node.value = to;
		result.changed.push(`${display(path)}: ${from} → ${to}, the same setting under its current name.`);
	}

	const nodes = doc.getIn(["fleet", "nodes"], true);
	if (isSeq(nodes)) {
		nodes.items.forEach((node, index) => {
			if (!isMap(node)) return;
			const legacy = node.items.find((pair) => isScalar(pair.key) && pair.key.value === "clioEntry");
			if (legacy === undefined || !isScalar(legacy.key)) return;
			const from = `fleet.nodes[${index}].clioEntry`;
			const to = `fleet.nodes[${index}].clioCoderEntry`;
			if (node.has("clioCoderEntry")) {
				node.delete("clioEntry");
				result.changed.push(`Removed ${from}: ${to} is also set and wins.`);
				return;
			}
			legacy.key.value = "clioCoderEntry";
			result.changed.push(`Renamed ${from} to ${to}.`);
		});
	}
	return result;
}

/**
 * The same rewrite over a parsed document, for the v1 migrator and archive
 * import: a settings fragment from an older release must still import.
 */
export function dropRetiredSettings(raw: Record<string, unknown>): RetiredSettingsRewrite & {
	document: Record<string, unknown>;
} {
	const doc = new Document(raw);
	const rewrite = rewriteRetiredSettings(doc);
	return { document: doc.toJS() as Record<string, unknown>, ...rewrite };
}

const migration: Migration = {
	id: ID,
	projectSettings(raw: unknown): unknown {
		if (!isRecord(raw) || (raw.version !== undefined && raw.version !== 2)) return raw;
		return dropRetiredSettings(raw).document;
	},
	async up(): Promise<MigrationReport> {
		return withSettingsLock(() => {
			const report: MigrationReport = { changed: [], attention: [] };
			const file = settingsPath();
			if (!existsSync(file)) return report;
			const text = readFileSync(file, "utf8");
			const doc = parseDocument(text);
			if (doc.errors.length > 0) throw new Error(`retired settings migration: ${doc.errors[0]?.message}`);
			const before = doc.toJS() as unknown;
			// Version 1 is the v1 migrator's, which runs first and applies this same rewrite. A
			// version-2 file may omit the key, as the validator allows.
			if (!isRecord(before) || (before.version !== undefined && before.version !== 2)) return report;
			const rewrite = rewriteRetiredSettings(doc);
			report.attention.push(...rewrite.attention);
			if (rewrite.changed.length === 0) return report;
			const next = doc.toString({ lineWidth: 0 });
			// The rewrite only removes or renames; an issue it introduces means it misread the file.
			const known = new Set(validateSettings(before).issues.map((issue) => issue.path));
			const introduced = validateSettings(parseDocument(next).toJS()).issues.filter((issue) => !known.has(issue.path));
			if (introduced.length > 0)
				throw new Error(
					`retired settings migration left settings.yaml unchanged: the rewrite would introduce ${introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
				);
			const backupPath = `${file}.retired.bak`;
			safeResourceWrite(file, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE, backup: { path: backupPath } });
			report.changed.push(
				`What changed for you in settings.yaml (the previous file is ${backupPath}):`,
				...rewrite.changed,
			);
			return report;
		});
	},
};

export default migration;
