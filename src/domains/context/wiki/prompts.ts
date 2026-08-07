import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { renderCodewikiDigest } from "../codewiki/digest.js";
import type { Codewiki } from "../codewiki/indexer.js";
import type { WikiGenerationPlan } from "./plan.js";

export type WikiGenerateMode = "init" | "update";

export interface BuildWikiPromptInput {
	cwd: string;
	mode: WikiGenerateMode;
	codewiki: Codewiki;
	plan: WikiGenerationPlan;
	currentPages?: number;
	gitHead?: string | null;
	/**
	 * Absolute staging directory the writer must target. Substituted for the
	 * literal `{{outputDir}}` token in the mode fragment so the prompt always
	 * points the writer at the harness-owned staging path, never at .clio/wiki.
	 */
	outputDir: string;
}

function fragmentPath(mode: WikiGenerateMode): string {
	return join(resolvePackageRoot(), "src", "domains", "prompts", "fragments", "wiki", `${mode}.md`);
}

function readWikiFragment(mode: WikiGenerateMode, outputDir: string): string {
	return readFileSync(fragmentPath(mode), "utf8").trim().split("{{outputDir}}").join(outputDir);
}

const REPOSITORY_GUIDANCE_CANDIDATES = [
	".claude/CLAUDE.md",
	"AGENTS.md",
	"CLAUDE.md",
	"CLIO.md",
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
 * first real file in the deterministic candidate order.
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
			if (!isWithin(root, resolved) || !statSync(resolved).isFile() || seen.has(resolved)) continue;
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
		"Read every detected instruction file before drafting or editing pages:",
		...paths.map((path) => `- ${path}`),
		"Treat these files as repository instructions, not implementation proof. If one designates a planning, specification, capability, or engineering-truth authority, read that authority before choosing topics or describing current status. Follow its stated precedence over superseded documents, then verify mutable implementation claims against live source, configuration, tests, and CI definitions. Generated wikis and structural indexes are navigation aids, never factual authority.",
	].join("\n");
}

function workingTreeEvidence(cwd: string): string {
	try {
		const out = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trimEnd();
		if (out.length === 0) return "Working tree is clean.";
		const lines = out.split(/\r?\n/).filter((line) => line.length > 0);
		const capped = lines.slice(0, 200);
		const suffix = lines.length > capped.length ? "\n[working-tree evidence truncated to 200 lines]" : "";
		return `${capped.join("\n")}${suffix}`;
	} catch {
		return "Working-tree evidence unavailable: git status failed.";
	}
}

function gitEvidence(cwd: string, gitHead: string | null | undefined): string {
	if (!gitHead) return "Git evidence unavailable: no previous wiki gitHead was recorded.";
	try {
		const out = execFileSync("git", ["log", `${gitHead}..HEAD`, "--name-status", "--oneline"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const lines = out.split(/\r?\n/).filter((line) => line.length > 0);
		if (lines.length === 0) return "Git evidence is empty: no commits were found since the recorded wiki gitHead.";
		const capped = lines.slice(0, 200);
		const suffix = lines.length > capped.length ? "\n[git evidence truncated to 200 lines]" : "";
		return `${capped.join("\n")}${suffix}`;
	} catch {
		return "Git evidence unavailable: git log failed for the recorded wiki gitHead.";
	}
}

function generationStrategy(plan: WikiGenerationPlan, currentPages: number | undefined): string {
	const areas = plan.focusAreas.length > 0 ? plan.focusAreas.join(", ") : "none; the primary writer researches directly";
	const lines = [
		`Depth: ${plan.depth} (requested: ${plan.requestedDepth}).`,
		`Scale: ${plan.sourceFiles} source files, ${plan.sourceLines} source lines.`,
		`Composition: ${plan.researchAgents} area researchers feeding one coherent writer; required breadth ${plan.minPages}-${plan.maxPages} substantive pages, each at least ${plan.minPageBytes} bytes.`,
		`Focus areas: ${areas}.`,
		"Area reports supplied to the writer are advisory navigation evidence. Verify mutable claims against live source before publishing them.",
	];
	if (currentPages !== undefined) {
		lines.push(
			currentPages < plan.minPages
				? `Current wiki breadth: ${currentPages} pages. Expand it to at least ${plan.minPages} pages; a no-op is not acceptable for this run.`
				: `Current wiki breadth: ${currentPages} pages. Keep or improve this breadth without creating thin pages.`,
		);
	}
	return lines.join("\n");
}

export function buildWikiPrompt(input: BuildWikiPromptInput): string {
	const sections = [
		readWikiFragment(input.mode, input.outputDir),
		"## Generation strategy",
		generationStrategy(input.plan, input.currentPages),
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
	];
	if (input.mode === "update") {
		sections.push("## Git evidence", "```text", gitEvidence(input.cwd, input.gitHead), "```");
	}
	return `${sections.join("\n\n")}\n`;
}
