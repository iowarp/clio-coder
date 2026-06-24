/**
 * Path-scoped project rules under `.clio/rules/**\/*.md`. A rule is a markdown
 * file with optional YAML frontmatter:
 *
 *   - `paths:`    activation globs. When present the rule is path-scoped and
 *                 activates only while a matching file is already in working
 *                 context. Absent means the rule is unconditional and loads
 *                 with project context.
 *   - `excludes:` globs contributed to the project context-exclude set.
 *   - `enabled:`  defaults true.
 *   - `description:` one-line summary for the inspector.
 *
 * Loading is deterministic and cache-stable: rules sort by id (their path under
 * `.clio/rules`), so the prompt prefix a local model caches does not reorder
 * between runs. Every rule carries a content hash and a token estimate so an
 * activated rule can be accounted in the context ledger. Reads are best-effort:
 * a malformed file is reported and skipped.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { compileGlobRegex, normalizeGlobInput } from "../../tools/glob.js";
import { ceilChars } from "../session/context-accounting.js";

export interface ProjectRule {
	/** Stable id: the rule's posix path under `.clio/rules`. */
	id: string;
	sourcePath: string;
	hash: string;
	tokenEstimate: number;
	/** Activation globs; absent means the rule is unconditional. */
	paths?: string[];
	enabled: boolean;
	description?: string;
	/** Markdown body after frontmatter; the text that enters the prompt. */
	body: string;
}

export interface ProjectRulesLoad {
	rules: ProjectRule[];
	/** Aggregated `context.excludes` globs from every rule's frontmatter. */
	excludes: string[];
	issues: string[];
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) out.push(item);
	}
	return out.length > 0 ? out : undefined;
}

function walkMarkdown(dir: string, root: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdown(full, root, out);
		else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
	}
}

function parseRule(filePath: string, root: string, issues: string[]): { rule?: ProjectRule; excludes: string[] } {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
	} catch (err) {
		issues.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return { excludes: [] };
	}
	const id = relative(root, filePath).split(sep).join("/");
	let body = text;
	let paths: string[] | undefined;
	let excludes: string[] = [];
	let enabled = true;
	let description: string | undefined;

	const match = FRONTMATTER_RE.exec(text);
	if (match) {
		body = text.slice(match[0].length);
		try {
			const front = parseYaml(match[1] ?? "");
			if (isRecord(front)) {
				paths = readStringArray(front.paths);
				excludes = readStringArray(front.excludes) ?? [];
				if (typeof front.enabled === "boolean") enabled = front.enabled;
				if (typeof front.description === "string") description = front.description;
			}
		} catch (err) {
			issues.push(`${id}: invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const trimmedBody = body.trim();
	const hash = createHash("sha256").update(trimmedBody).digest("hex").slice(0, 16);
	const rule: ProjectRule = {
		id,
		sourcePath: join(".clio", "rules", id),
		hash,
		tokenEstimate: ceilChars(trimmedBody.length),
		enabled,
		body: trimmedBody,
	};
	if (paths !== undefined) rule.paths = paths;
	if (description !== undefined) rule.description = description;
	return { rule, excludes };
}

/**
 * Load every rule under `.clio/rules`, deterministically ordered by id. Returns
 * the rules, the aggregated exclude set, and any per-file issues.
 */
export function loadProjectRules(cwd: string): ProjectRulesLoad {
	const root = join(cwd, ".clio", "rules");
	const issues: string[] = [];
	const files: string[] = [];
	walkMarkdown(root, root, files);
	files.sort();
	const rules: ProjectRule[] = [];
	const excludeSet = new Set<string>();
	for (const file of files) {
		const parsed = parseRule(file, root, issues);
		if (parsed.rule) rules.push(parsed.rule);
		for (const glob of parsed.excludes) excludeSet.add(glob);
	}
	rules.sort((a, b) => a.id.localeCompare(b.id));
	return { rules, excludes: [...excludeSet], issues };
}

function ruleMatchesAnyPath(rule: ProjectRule, workingPaths: ReadonlyArray<string>): boolean {
	for (const pattern of rule.paths ?? []) {
		let regex: RegExp;
		try {
			regex = compileGlobRegex(pattern);
		} catch {
			continue;
		}
		for (const path of workingPaths) {
			if (regex.test(normalizeGlobInput(path))) return true;
		}
	}
	return false;
}

/**
 * Select the rules that should load now. Unconditional rules (no `paths`) always
 * load; a path-scoped rule loads only when one of its globs matches a path
 * already in working context. Disabled rules never load. Order is preserved for
 * cache stability.
 */
export function selectActiveRules(
	rules: ReadonlyArray<ProjectRule>,
	workingContextPaths: ReadonlyArray<string>,
): ProjectRule[] {
	return rules.filter((rule) => {
		if (!rule.enabled) return false;
		if (rule.paths === undefined) return true;
		return ruleMatchesAnyPath(rule, workingContextPaths);
	});
}
