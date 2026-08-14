/**
 * Prompt assembly for the two kinds of wiki dispatch.
 *
 * The planning prompt is sent once and carries the repository-wide payload:
 * the codewiki digest, the candidate skeleton, and the change evidence. The
 * page prompt is sent once per page and carries only that page's plan entry,
 * the symbols indexed under its sources, and the sibling page list it may link
 * to. Keeping the repository-wide payload out of every page dispatch is the
 * point: a static prompt is re-sent on every round of a run, so a payload the
 * writer needed once was being prefilled hundreds of times.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { renderCodewikiDigest } from "../codewiki/digest.js";
import type { Codewiki } from "../codewiki/indexer.js";
import { WIKI_PLAN_FILE } from "./layout.js";
import type { WikiGenerationPlan, WikiPlan, WikiPlanPage } from "./plan.js";

export type WikiGenerateMode = "init" | "update";

type WikiFragment = "plan" | "page";

function fragmentPath(fragment: WikiFragment): string {
	return join(resolvePackageRoot(), "src", "domains", "prompts", "fragments", "wiki", `${fragment}.md`);
}

function readWikiFragment(fragment: WikiFragment, substitutions: Record<string, string>): string {
	let text = readFileSync(fragmentPath(fragment), "utf8").trim();
	for (const [token, value] of Object.entries(substitutions)) {
		text = text.split(`{{${token}}}`).join(value);
	}
	return text;
}

const REPOSITORY_GUIDANCE_CANDIDATES = [
	".claude/CLAUDE.md",
	"AGENTS.md",
	"CLAUDE.md",
	"CLIO-CODER.md",
	"CODEX.md",
	".codex/AGENTS.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
] as const;

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * List only fixed, well-known repository instruction files. Realpath checks
 * allow an in-repository alias such as AGENTS.md -> .claude/CLAUDE.md while
 * preventing a project symlink from turning prompt construction into an
 * arbitrary read outside the workspace. Duplicate aliases collapse to the
 * first real file in the deterministic candidate order. An empty file is
 * skipped: naming it only spends a read that returns nothing.
 */
function repositoryGuidancePaths(cwd: string): string[] {
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch {
		return [];
	}
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const relPath of REPOSITORY_GUIDANCE_CANDIDATES) {
		const absPath = join(cwd, relPath);
		if (!existsSync(absPath)) continue;
		try {
			const resolved = realpathSync(absPath);
			const stat = statSync(resolved);
			if (!isWithin(root, resolved) || !stat.isFile() || stat.size === 0 || seen.has(resolved)) continue;
			seen.add(resolved);
			paths.push(relPath);
		} catch {
			// Guidance discovery is best-effort; an unreadable candidate is omitted.
		}
	}
	return paths;
}

function repositoryGuidance(cwd: string): string {
	const paths = repositoryGuidancePaths(cwd);
	if (paths.length === 0) {
		return "No recognized repository instruction files were detected. Discover source-of-truth documentation from the live tree.";
	}
	return [
		"Read every detected instruction file before drafting:",
		...paths.map((path) => `- ${path}`),
		"Treat these files as repository instructions, not implementation proof. If one designates a planning, specification, or engineering-truth authority, read that authority before making status claims, then verify mutable implementation claims against live source, configuration, and tests.",
	].join("\n");
}

function gitLines(cwd: string, args: ReadonlyArray<string>, cap: number): string | null {
	try {
		const out = execFileSync("git", [...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trimEnd();
		const lines = out.split(/\r?\n/).filter((line) => line.length > 0);
		if (lines.length === 0) return "";
		const capped = lines.slice(0, cap);
		return `${capped.join("\n")}${lines.length > capped.length ? `\n[truncated to ${cap} lines]` : ""}`;
	} catch {
		return null;
	}
}

function workingTreeEvidence(cwd: string): string {
	const out = gitLines(cwd, ["status", "--short", "--untracked-files=all"], 200);
	if (out === null) return "Working-tree evidence unavailable: git status failed.";
	return out.length === 0 ? "Working tree is clean." : out;
}

function gitEvidence(cwd: string, gitHead: string | null | undefined): string {
	if (!gitHead) return "Git evidence unavailable: no previous wiki gitHead was recorded.";
	const out = gitLines(cwd, ["log", `${gitHead}..HEAD`, "--name-status", "--oneline"], 200);
	if (out === null) return "Git evidence unavailable: git log failed for the recorded wiki gitHead.";
	return out.length === 0 ? "Git evidence is empty: no commits were found since the recorded wiki gitHead." : out;
}

function renderPlanSkeleton(plan: WikiPlan): string {
	return JSON.stringify(
		{
			overview: plan.overview,
			pages: plan.pages.map((page) => ({
				path: page.path,
				title: page.title,
				intent: page.intent,
				sources: page.sources,
			})),
		},
		null,
		2,
	);
}

export interface BuildWikiPlanPromptInput {
	cwd: string;
	mode: WikiGenerateMode;
	codewiki: Codewiki;
	generation: WikiGenerationPlan;
	/**
	 * The plan on disk right now. On an init this is the index's candidate; on
	 * an update it is the plan the existing wiki was built from, so the pass
	 * revises real structure instead of proposing a parallel one.
	 */
	plan?: WikiPlan;
	/** Indexed areas no existing page covers. Empty on an init. */
	unclaimedAreas?: ReadonlyArray<WikiPlanPage>;
	/** Absolute staging directory; the plan file the writer edits lives here. */
	outputDir: string;
	gitHead?: string | null;
}

/**
 * The one repository-wide dispatch. It edits a plan that already exists, so
 * the worst outcome is the plan it was handed, never a failed run.
 */
export function buildWikiPlanPrompt(input: BuildWikiPlanPromptInput): string {
	const { generation } = input;
	const plan = input.plan ?? generation.plan;
	const unclaimed = input.unclaimedAreas ?? [];
	const sections = [
		readWikiFragment("plan", { planPath: join(input.outputDir, WIKI_PLAN_FILE) }),
		"## Repository scale",
		`${generation.sourceFiles} indexed source files, ${generation.sourceLines} source lines, decomposed at ${generation.depth} depth into ${generation.plan.pages.length} candidate pages.`,
		"## Candidate plan",
		"```json",
		renderPlanSkeleton(plan),
		"```",
	];
	if (unclaimed.length > 0) {
		sections.push(
			"## Areas no page covers",
			"The index found these areas and no page in the plan above claims any of their sources. Add a page for each one that deserves its own, or fold it into an existing page by extending that page's sources.",
			unclaimed.map((page) => `- ${page.path} (${page.title}): ${page.sources.join(", ")}`).join("\n"),
		);
	}
	sections.push(
		"## Repository guidance",
		repositoryGuidance(input.cwd),
		"## Working-tree evidence",
		"```text",
		workingTreeEvidence(input.cwd),
		"```",
		"## Codewiki digest",
		"```text",
		renderCodewikiDigest(input.codewiki),
		"```",
	);
	if (input.mode === "update") {
		sections.push("## Git evidence", "```text", gitEvidence(input.cwd, input.gitHead), "```");
	}
	return `${sections.join("\n\n")}\n`;
}

/** Symbols the index records for the files this page is anchored on. */
function scopedSymbols(codewiki: Codewiki, sources: ReadonlyArray<string>, limit = 60): string {
	const wanted = new Set(sources);
	const fileById = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const lines: string[] = [];
	for (const symbol of codewiki.symbols) {
		const file = fileById.get(symbol.fileId);
		if (!file || !wanted.has(file.path)) continue;
		lines.push(`- ${symbol.name} ${symbol.kind} ${file.path}:${symbol.line}`);
		if (lines.length >= limit) break;
	}
	return lines.length > 0 ? lines.join("\n") : "No indexed symbols for these paths; read the files directly.";
}

export interface BuildWikiPagePromptInput {
	cwd: string;
	mode: WikiGenerateMode;
	codewiki: Codewiki;
	page: WikiPlanPage;
	/** Every page in the plan, so authored links point at pages that will exist. */
	siblings: ReadonlyArray<WikiPlanPage>;
	/** Absolute staging directory the page is written into. */
	outputDir: string;
	/** True when a previous version of this page is already staged for revision. */
	seeded: boolean;
}

/**
 * One page, one dispatch. The prompt names the file to write, what it must
 * cover, the sources that ground it, and nothing about any other page except
 * the paths it may link to.
 */
export function buildWikiPagePrompt(input: BuildWikiPagePromptInput): string {
	const { page } = input;
	const siblingLines = input.siblings
		.filter((sibling) => sibling.path !== page.path)
		.map((sibling) => `- ${sibling.path} — ${sibling.title}`);
	const sections = [
		readWikiFragment("page", {
			pagePath: join(input.outputDir, page.path),
			pageRelPath: page.path,
			pageTitle: page.title,
		}),
		"## What this page must document",
		page.intent.length > 0 ? page.intent : `Document ${page.title}.`,
		"## Anchor sources",
		page.sources.length > 0
			? `Read every one of these before writing, then follow at least one call in each direction:\n${page.sources.map((source) => `- ${source}`).join("\n")}`
			: "No anchor sources were planned. Use `code_nav` to locate this page's subject before writing.",
		"## Indexed symbols under those sources",
		"```text",
		scopedSymbols(input.codewiki, page.sources),
		"```",
		"## Other pages you may link to",
		siblingLines.length > 0 ? siblingLines.join("\n") : "None; this is the only page in the plan.",
		"## Repository guidance",
		repositoryGuidance(input.cwd),
	];
	if (input.seeded) {
		sections.push(
			"## Revision",
			`A previous version of this page is already at ${join(input.outputDir, page.path)}. Read it first and revise it in place. ` +
				"Correct what the current source contradicts and fill what it omits; keep accurate prose as it stands.",
		);
	}
	return `${sections.join("\n\n")}\n`;
}
