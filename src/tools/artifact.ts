import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { artifactDefaultPath, CLIO_ARTIFACT_DIR } from "../core/artifact-paths.js";
import { ToolNames } from "../core/tool-names.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

/**
 * The artifact tool: terminal document writers. kind=plan|review|report writes
 * a Markdown artifact and terminates the turn: writing the artifact IS the
 * answer, so pi-agent-core skips the follow-up LLM call that would only
 * summarize it.
 *
 * A pathless call lands under `.clio-coder/artifacts/`, not in the repo working
 * tree. A turn nobody asked for a file from used to drop REPORT.md into the
 * project root, which the operator then had to notice and delete; the working
 * tree holds files a human asked for, and everything Clio generates on its own
 * belongs in the gitignored project directory. An explicit `path` still writes
 * wherever the caller says, inside the workspace. See core/artifact-paths.ts
 * and docs/artifact-placement.md.
 *
 * Skills are not artifacts: a skill is a SKILL.md folder written with the
 * ordinary write tool and validated by the skills loader on load. The
 * skill-craft shipped skill documents the format.
 */

const ARTIFACT_KINDS = ["plan", "review", "report"] as const;
type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

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
	const rawPath =
		typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : artifactDefaultPath(kind);
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
	const bytes = Buffer.byteLength(body, "utf8");
	return {
		kind: "ok",
		output: `wrote ${kind} artifact (${bytes}B) to ${rel}`,
		// shownBytes is the artifact's real size; the ledger otherwise measures
		// this confirmation sentence (a 4753B plan rendered as "60B", #76).
		details: { kind, paths: [target], observation: { shownBytes: bytes } },
		// Writing the artifact is the whole turn; terminate skips the follow-up
		// LLM call that would only restate what was just written.
		terminate: true,
	};
}

export function createArtifactTool(deps: ArtifactToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.Artifact,
		description: `Write a named artifact: kind=plan|review|report writes a terminal Markdown document and completes the turn. Without an explicit path it lands in ${CLIO_ARTIFACT_DIR}/ (PLAN.md, REVIEW.md, REPORT.md); pass path only when the user asked for a file at a specific place.`,
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
