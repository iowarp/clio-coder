/**
 * Typed tool presentation policy. Answers one question for the transcript
 * renderers: does a tool's block open expanded or folded when it starts?
 *
 * The panel must not decide that by tool name. It asks this module, which
 * resolves the answer from two inputs: the registered presentation metadata
 * for the tool (declared once here and attached to `ToolMetadata` by the
 * builtin catalog) and the argument-sensitive resource-read rule. The lookup
 * is a plain object read, so it stays cheap enough to call on every tool start,
 * and it needs no registry instance: the live chat panel has none.
 *
 * Pure module: no I/O, no registry construction, no UI imports.
 */

import { ToolNames } from "../core/tool-names.js";

export type ToolFoldDefault = "expanded" | "folded";

export interface ToolPresentationPolicy {
	/** How a fresh block for this call renders before the operator touches it. */
	foldDefault: ToolFoldDefault;
}

const EXPANDED: ToolPresentationPolicy = { foldDefault: "expanded" };
const FOLDED: ToolPresentationPolicy = { foldDefault: "folded" };

/**
 * Per-tool presentation declarations. Bash bodies are the transcript's largest
 * and least re-read output: the folded row carries command, live elapsed,
 * settlement, size, and context disposition, and the operator opens the body
 * when they want it. Everything unlisted keeps the expanded default.
 */
export const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentationPolicy>> = {
	[ToolNames.Bash]: FOLDED,
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
	return TOOL_PRESENTATION[toolName] ?? EXPANDED;
}
