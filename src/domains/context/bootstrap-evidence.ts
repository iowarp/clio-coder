import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { EnforcementInventory } from "./enforcement-inventory.js";

export type BootstrapDepth = "quick" | "standard" | "deep";

/** Exploration bounds are independent of repository size and wiki coverage. */
export const BOOTSTRAP_DEPTH_POLICY = {
	quick: { files: 8, evidenceChars: 12_000, toolCalls: 8, timeoutMs: 120_000 },
	standard: { files: 16, evidenceChars: 24_000, toolCalls: 16, timeoutMs: 240_000 },
	deep: { files: 32, evidenceChars: 36_000, toolCalls: 32, timeoutMs: 480_000 },
} as const;

export interface BootstrapEvidenceFile {
	path: string;
	/** Exact source lines, prefixed with their original line numbers. */
	excerpt: string;
	truncated: boolean;
}

export interface BootstrapEvidence {
	files: BootstrapEvidenceFile[];
	candidateFiles: number;
	chars: number;
}

const RULE_FILE_RE =
	/(?:^|\/)(?:README[^/]*|CONTRIBUTING[^/]*|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|CMakeLists\.txt|Makefile|biome\.jsonc?|eslint[^/]*|tsconfig[^/]*\.json|pytest\.ini|conftest\.py|[^/]*(?:harness|setup)[^/]*\.[cm]?[jt]s)$/i;
const RULE_LINE_RE =
	/(?:check|lint|verify|guard|validate)\w*\s*\(|["'`][A-Za-z]{0,12}\d{1,4}[a-z]?: |must |never |requires? |forbidden|throw new|fail\(/i;

/** A short brief of actual source, chosen before a model starts exploring. */
export function collectBootstrapEvidence(
	cwd: string,
	paths: ReadonlyArray<string>,
	enforcement: EnforcementInventory,
	depth: BootstrapDepth,
	anchors: ReadonlyArray<string> = [],
): BootstrapEvidence {
	const policy = BOOTSTRAP_DEPTH_POLICY[depth];
	const visible = new Set(paths);
	const candidates = [
		...new Set([
			...enforcement.checkFiles.slice(0, Math.ceil(policy.files / 2)).map((file) => file.path),
			...anchors,
			...paths.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)),
			...paths.filter((path) => RULE_FILE_RE.test(path)),
			...enforcement.checkFiles.map((file) => file.path),
		]),
	].filter((path) => visible.has(path));
	const root = realpathSync(cwd);
	const files: BootstrapEvidenceFile[] = [];
	let chars = 0;
	for (const path of candidates) {
		if (files.length >= policy.files || chars >= policy.evidenceChars) break;
		try {
			const absolute = join(cwd, path);
			const inside = relative(root, realpathSync(absolute));
			if (isAbsolute(inside) || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\")) continue;
			const stat = lstatSync(absolute);
			if (!stat.isFile() || stat.size > 512 * 1024) continue;
			const text = readFileSync(absolute, "utf8");
			if (text.includes("\0")) continue;
			const lines = text.split(/\r?\n/);
			const selected = new Set<number>();
			const budget = Math.min(
				4000,
				Math.max(1200, Math.floor(policy.evidenceChars / Math.min(policy.files, candidates.length))),
				policy.evidenceChars - chars,
			);
			let used = 0;
			const take = (index: number): void => {
				if (selected.has(index) || lines[index] === undefined) return;
				const size = `${index + 1}: ${lines[index]}\n`.length;
				if (used + size > budget) return;
				selected.add(index);
				used += size;
			};
			// Rule bodies and failure remedies earn space before imports and boilerplate.
			for (const [index, line] of lines.entries()) {
				if (!RULE_LINE_RE.test(line)) continue;
				for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 4); nearby++) take(nearby);
			}
			for (let index = 0; index < lines.length; index++) take(index);
			const excerpt = [...selected]
				.sort((a, b) => a - b)
				.map((index) => `${index + 1}: ${lines[index]}`)
				.join("\n");
			if (!excerpt) continue;
			files.push({ path, excerpt, truncated: selected.size < lines.length });
			chars += excerpt.length;
		} catch {
			// A vanished/unreadable candidate contributes no evidence or claims.
		}
	}
	return { files, candidateFiles: candidates.length, chars };
}
