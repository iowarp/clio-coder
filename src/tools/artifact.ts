import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

/**
 * The artifact tool: terminal document writers. kind=plan|review|report
 * writes a Markdown artifact (default PLAN.md / REVIEW.md / REPORT.md at the
 * project root) and terminates the turn: writing the artifact IS the answer,
 * so pi-agent-core skips the follow-up LLM call that would only summarize it.
 *
 * Skills are not artifacts: a skill is a SKILL.md folder written with the
 * ordinary write tool and validated by the skills loader on load. The
 * skill-craft shipped skill documents the format.
 */

const ARTIFACT_KINDS = ["plan", "review", "report"] as const;
type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const KIND_PATHS: Record<ArtifactKind, string> = {
	plan: "PLAN.md",
	review: "REVIEW.md",
	report: "REPORT.md",
};

export interface ArtifactToolDeps {
	getCwd?: () => string;
}

function cwdFromDeps(deps?: ArtifactToolDeps): string {
	return deps?.getCwd?.() ?? process.cwd();
}

function insideWorkspace(target: string, cwd: string): boolean {
	const rel = path.relative(path.resolve(cwd), target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function writeTerminalArtifact(
	kind: ArtifactKind,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const content = typeof args.content === "string" ? args.content : "";
	if (content.length === 0) return { kind: "error", message: `artifact: kind=${kind} requires non-empty content` };
	const rawPath = typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : KIND_PATHS[kind];
	const target = resolveToCwd(rawPath, cwd);
	if (!insideWorkspace(target, cwd)) {
		return { kind: "error", message: `artifact: path escapes workspace root: ${target}` };
	}
	const title = typeof args.title === "string" ? args.title.trim() : "";
	const body = title.length > 0 && !content.trimStart().startsWith("#") ? `# ${title}\n\n${content}` : content;
	try {
		await withFileMutationQueue(target, async () => {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, body, "utf8");
		});
	} catch (err) {
		return { kind: "error", message: `artifact: ${err instanceof Error ? err.message : String(err)}` };
	}
	const rel = path.relative(cwd, target) || rawPath;
	return {
		kind: "ok",
		output: `wrote ${kind} artifact (${Buffer.byteLength(body, "utf8")}B) to ${rel}`,
		details: { kind, paths: [target] },
		// Writing the artifact is the whole turn; terminate skips the follow-up
		// LLM call that would only restate what was just written.
		terminate: true,
	};
}

export function createArtifactTool(deps: ArtifactToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.Artifact,
		description:
			"Write a named artifact: kind=plan|review|report writes a terminal Markdown document (default PLAN.md/REVIEW.md/REPORT.md) and completes the turn.",
		parameters: Type.Object({
			kind: stringEnum(ARTIFACT_KINDS, "Artifact kind."),
			content: Type.String({ description: "Full Markdown body." }),
			title: Type.Optional(Type.String({ description: "Document title." })),
			path: Type.Optional(Type.String({ description: "Override the default artifact path." })),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		async run(args): Promise<ToolResult> {
			const kind = typeof args.kind === "string" ? args.kind : "";
			if (!(ARTIFACT_KINDS as ReadonlyArray<string>).includes(kind)) {
				return { kind: "error", message: `artifact: kind must be plan, review, or report; got '${kind}'` };
			}
			return writeTerminalArtifact(kind as ArtifactKind, args, cwdFromDeps(deps));
		},
	};
}
