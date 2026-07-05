import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { renderCodewikiDigest } from "../codewiki/digest.js";
import type { Codewiki } from "../codewiki/indexer.js";

export type WikiGenerateMode = "init" | "update";

export interface BuildWikiPromptInput {
	cwd: string;
	mode: WikiGenerateMode;
	codewiki: Codewiki;
	gitHead?: string | null;
}

function fragmentPath(mode: WikiGenerateMode): string {
	return join(resolvePackageRoot(), "src", "domains", "prompts", "fragments", "wiki", `${mode}.md`);
}

function readWikiFragment(mode: WikiGenerateMode): string {
	return readFileSync(fragmentPath(mode), "utf8").trim();
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

export function buildWikiPrompt(input: BuildWikiPromptInput): string {
	const sections = [
		readWikiFragment(input.mode),
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
