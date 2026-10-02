import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { readCiRunCommands } from "../../core/ci-commands.js";
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

// Workflow-heavy briefs can omit the C++ lint configuration that states project conventions.
const RULE_FILE_RE =
	/(?:^|\/)(?:README[^/]*|CONTRIBUTING[^/]*|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|CMakeLists\.txt|CPPLINT\.cfg|Makefile|biome\.jsonc?|eslint[^/]*|tsconfig[^/]*\.json|pytest\.ini|conftest\.py)$/i;
// Contributor rules were crowded out by product prose; recognize and favor root development guides.
const CONTRIBUTOR_GUIDE_RE =
	/^(?:CONTRIBUTING|DEVELOPMENT|HACKING|CODING_STANDARDS|STYLE)[^/]*\.(?:mdx?|markdown|mdown|mkdn?|mdwn|mdtxt|mdtext|rmd|qmd)$/i;
const README_RE = /(?:^|\/)README[^/]*$/i;
const GUIDE_RULE_RE = /\b(?:must|never|required|do not|only|always)\b/i;
/**
 * A test harness or setup module is a rule file only where tests or the root
 * keep one. Anywhere else the name matched UI code: a React `use-setup.ts`
 * hook took an evidence slot and every model wrote setup-wizard rules.
 */
const HARNESS_FILE_RE =
	/^(?:[^/]*|(?:[^/]+\/)*(?:tests?|spec|specs|__tests__|e2e)\/(?:[^/]+\/)*[^/]*)(?:harness|setup)[^/]*\.[cm]?[jt]s$/i;
const RULE_LINE_RE =
	/(?:check|lint|verify|guard|validate)\w*\s*\(|["'`][A-Za-z]{0,12}\d{1,4}[a-z]?: |must |never |requires? |forbidden|throw new|fail\(/i;
// Python checks using raise or sys.exit supply no coded failures; retain other languages' failure sites too.
const FAILURE_LINE_RE =
	/\b\w*(?:fail|error|report|violation|issue|problem)\w*\(\s*["'`][a-z][\w.:-]{1,40}["'`]\s*,|["'`][A-Za-z]{0,12}\d{1,4}[a-z]?: |throw new \w*Error\(|\braise\s+[\w.]+\s*\(|\bsys\.exit\s*\(|\b(?:errors|problems)\.append\s*\(|\bexit\s+1\b|\bstd::cerr\s*<</i;
// An invariant defined only in comments can be lost after failure-site context fills the brief.
const COMMENT_RULE_RE =
	/^\s*(?:\/\/|\/\*|\*|#).*\b(?:never|must|may not|cannot|only|forbid\w*|not allowed|at all|required)\b/i;
// Wrapped comment rules may put their subject above the line containing the rule language.
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#)/;
/** Per-file share of the evidence budget, relative to an ordinary file. */
const CHECK_FILE_WEIGHT_MAX = 4;
const ANCHOR_WEIGHT = 0.5;
const MAX_FILE_CHARS = 8000;

function pathDepth(path: string): number {
	return path.split("/").length - 1;
}

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
	const ruleFiles = paths
		.filter((path) => RULE_FILE_RE.test(path) || HARNESS_FILE_RE.test(path) || CONTRIBUTOR_GUIDE_RE.test(path))
		.sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
	const ruleCount = new Map(
		enforcement.checkFiles.map((file) => [file.path, file.checks.length + file.failures.length] as const),
	);
	// A check-heavy repository can fill every slot; prefer CI-reached checks, then richer rule evidence.
	const referenced = [...enforcement.ciCommands, ...Object.values(enforcement.scripts)].join("\n");
	const checks = enforcement.checkFiles
		.map((file) => file.path)
		.sort(
			(a, b) =>
				Number(referenced.includes(b)) - Number(referenced.includes(a)) ||
				(ruleCount.get(b) ?? 0) - (ruleCount.get(a) ?? 0),
		);
	// A repository with more than 15 workflows can fill the brief; prioritize those that judge changes.
	const workflowPriority = (path: string): number =>
		Number(
			/\b(?:ci|tests?|lint|checks?)\b/i.test([path.split("/").at(-1), ...readCiRunCommands(cwd, [path])].join("\n")),
		);
	const workflows = paths
		.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
		.map((path) => ({ path, priority: workflowPriority(path) }))
		.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path))
		.map(({ path }) => path);
	// Quotas preserve manifests and guides when checks or workflows alone could fill all 16 slots.
	const claimed = new Set<string>();
	const categories = [
		ruleFiles.filter((path) => pathDepth(path) === 0),
		checks,
		workflows,
		anchors,
		ruleFiles.filter((path) => pathDepth(path) > 0),
	].map((category) =>
		category.filter((path) => {
			if (!visible.has(path) || claimed.has(path)) return false;
			claimed.add(path);
			return true;
		}),
	);
	// Largest remainders make the observed 16-slot starvation fix deterministic at every depth.
	const shares = [0.3, 0.3, 0.2, 0.1, 0.1].map((share) => share * policy.files);
	const quotas = shares.map(Math.floor);
	const roundingOrder = shares
		.map((share, index) => ({ index, remainder: share - Math.floor(share) }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	const extra = policy.files - quotas.reduce((sum, quota) => sum + quota, 0);
	for (const { index } of roundingOrder.slice(0, extra)) quotas[index] = (quotas[index] ?? 0) + 1;
	const reserved = categories.flatMap((category, index) => category.slice(0, quotas[index]));
	// Sparse categories lend their slots in the same priority order so small repos still get a full brief.
	const leftovers = categories.flatMap((category, index) => category.slice(quotas[index]));
	const candidates = [...reserved, ...leftovers];
	const anchorSet = new Set(anchors);
	// A check file that defines many rules earns more of the brief than a
	// manifest; a flat share gave a 21-check hygiene script 1,500 characters.
	const weight = (path: string): number => {
		if (CONTRIBUTOR_GUIDE_RE.test(path)) return 3;
		if (README_RE.test(path)) return 0.5;
		const rules = ruleCount.get(path);
		if (rules !== undefined) return Math.min(CHECK_FILE_WEIGHT_MAX, Math.max(1, rules / 4));
		return anchorSet.has(path) ? ANCHOR_WEIGHT : 1;
	};
	const included = candidates.slice(0, policy.files);
	const totalWeight = included.reduce((sum, path) => sum + weight(path), 0) || 1;
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
				MAX_FILE_CHARS,
				Math.max(800, Math.floor((policy.evidenceChars * weight(path)) / totalWeight)),
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
			// Failure lines across the whole file come first, so rules near its end
			// are not crowded out by context around the first few. Then rule bodies
			// and remedies, then imports and boilerplate.
			// Take guide rules first so prose cannot consume the budget before prerequisites and flag semantics.
			for (const [index, line] of lines.entries())
				if (FAILURE_LINE_RE.test(line) || (CONTRIBUTOR_GUIDE_RE.test(path) && GUIDE_RULE_RE.test(line))) take(index);
			// A wrapped invariant lost its subject above the matching predicate; retain up to eight comment lines.
			for (const [index, line] of lines.entries()) {
				if (!COMMENT_RULE_RE.test(line)) continue;
				let start = index;
				let end = index;
				while (start > 0 && end - start + 1 < 8 && COMMENT_LINE_RE.test(lines[start - 1] ?? "")) start--;
				while (end + 1 < lines.length && end - start + 1 < 8 && COMMENT_LINE_RE.test(lines[end + 1] ?? "")) end++;
				for (let nearby = start; nearby <= end; nearby++) take(nearby);
			}
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
