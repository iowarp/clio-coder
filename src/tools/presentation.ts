/**
 * Typed tool presentation policy. Answers, per tool, what the transcript's
 * balanced (`/output default`) view needs to know: does the block open folded
 * or expanded, does the folded row keep a mutation diff visible, and does a
 * failed folded row carry an output excerpt.
 *
 * The panel must not decide any of that by tool name. It asks this module,
 * which resolves the answer from two inputs: the registered presentation
 * metadata for the tool (declared once here and attached to `ToolMetadata` by
 * the builtin catalog) and the argument-sensitive resource-read rule. The
 * lookup is a plain object read, so it stays cheap enough to call on every
 * frame, and it needs no registry instance: the live chat panel has none.
 *
 * Pure module: no I/O, no registry construction, no UI imports.
 */

import { ToolNames } from "../core/tool-names.js";

export type ToolFoldDefault = "expanded" | "folded";

export interface ToolPresentationPolicy {
	/** How a fresh block for this call renders before the operator touches it. */
	foldDefault: ToolFoldDefault;
	/**
	 * Keep the mutation diff under the folded row. A folded `edit` that hides
	 * what it changed tells the operator nothing they could act on; the diff is
	 * the row's whole point and stays visible, bounded, until the body is opened.
	 */
	showDiffWhenFolded: boolean;
	/**
	 * Carry the last non-empty output line on a failed folded row. Bash pioneered
	 * this so a failed command stays diagnosable without opening its body; every
	 * tool that fails with text gets the same courtesy.
	 */
	failureExcerpt: boolean;
}

const FOLDED: ToolPresentationPolicy = { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true };
const FOLDED_WITH_DIFF: ToolPresentationPolicy = {
	foldDefault: "folded",
	showDiffWhenFolded: true,
	failureExcerpt: true,
};

/**
 * Per-tool presentation declarations. Every builtin folds by default: a
 * routine turn of six reads used to open six bodies, and the one-line row
 * already carries the call, its outcome facts, size, and settlement. Mutations
 * keep their diff under the folded row. Everything unlisted, including dynamic
 * tools, folds the same way.
 */
export const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentationPolicy>> = {
	[ToolNames.Read]: FOLDED,
	[ToolNames.Grep]: FOLDED,
	[ToolNames.Find]: FOLDED,
	[ToolNames.Ls]: FOLDED,
	[ToolNames.CodeNav]: FOLDED,
	[ToolNames.Context]: FOLDED,
	[ToolNames.CredentialPresent]: FOLDED,
	[ToolNames.Write]: FOLDED_WITH_DIFF,
	[ToolNames.Edit]: FOLDED_WITH_DIFF,
	[ToolNames.Bash]: FOLDED,
	[ToolNames.Git]: FOLDED,
	[ToolNames.Verify]: FOLDED,
	[ToolNames.Dispatch]: FOLDED,
	[ToolNames.Monitor]: FOLDED,
	[ToolNames.Steer]: FOLDED,
	[ToolNames.Tasks]: FOLDED,
	[ToolNames.Ledger]: FOLDED,
	[ToolNames.WebFetch]: FOLDED,
	[ToolNames.AskUser]: FOLDED,
	[ToolNames.Artifact]: FOLDED,
};

function readStringField(args: unknown, key: string): string | null {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Compact resource-read classification. Reads of skill/handbook/agent
 * instruction files and docs pages collapse to one labeled line and never
 * auto-expand; their bodies are reference material, not task output.
 */
export function classifyResourceRead(toolName: string, args: unknown): string | null {
	if (toolName !== ToolNames.Read) return null;
	const path = readStringField(args, "path");
	if (path === null) return null;
	const normalized = path.replace(/\\/g, "/");
	const base = normalized.split("/").pop() ?? "";
	if (base === "SKILL.md") return "skill";
	if (base === "CLIO-CODER.md") return "handbook";
	if (base === "AGENTS.md") return "agents";
	if (/(^|\/)docs\//.test(normalized)) return "docs";
	return null;
}

/**
 * Resolve the presentation policy for one call. Argument-sensitive rules win
 * over the per-tool declaration because a resource read is a property of the
 * path, not of the `read` tool.
 */
export function toolPresentationPolicy(toolName: string, args: unknown): ToolPresentationPolicy {
	if (classifyResourceRead(toolName, args) !== null) return FOLDED;
	return TOOL_PRESENTATION[toolName] ?? FOLDED;
}
