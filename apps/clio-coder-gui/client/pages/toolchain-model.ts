// One resolution label per pinned tool. The split is deliberate: a platform that was never
// supported, a copy found on PATH, the vendored pin, and nothing at all are four different facts,
// and only the last one is a problem an operator can act on. Pure, so the words are testable.

import type { Tool } from "../../contracts/toolchain.js";
import type { StatusTone } from "../design/status.js";

export interface ToolResolution {
	label: string;
	tone: StatusTone;
}

export function toolResolution(tool: Pick<Tool, "supported" | "resolution">): ToolResolution {
	if (!tool.supported) return { label: "Platform unsupported", tone: "neutral" };
	if (tool.resolution.source === "path") return { label: "Using PATH", tone: "success" };
	if (tool.resolution.source === "vendored") return { label: "Using pinned copy", tone: "success" };
	return { label: "Not available", tone: "warn" };
}

/** What a PATH copy that lost to the pin, or a pin that is not there, means for this row. */
export function toolCandidateNote(tool: Pick<Tool, "resolution">): string | null {
	const candidate = tool.resolution.pathCandidate;
	if (!candidate) return null;
	if (candidate.satisfiesMinimum) return null;
	return `A copy at ${candidate.path} reports ${candidate.version ?? "no version"}, which is below the pinned minimum, so Clio does not use it.`;
}

/** Explain the effect beside the action rather than making an operator infer it from the resolution. */
export function toolActionEffect(tool: Pick<Tool, "supported" | "installed" | "resolution">): string {
	if (!tool.supported)
		return "No pinned download is available for this platform. A compatible tool on PATH can still be inspected above.";
	if (tool.installed) return "Check confirms the pinned binaries are present. Remove deletes only the vendored copy.";
	return tool.resolution.source === "path"
		? "Install adds a pinned fallback. The compatible PATH copy may remain the executable Clio uses."
		: "Install downloads and verifies the pinned version into Clio’s toolchain folder.";
}

export const TOOL_FILTERS = ["all", "available", "missing", "unsupported"] as const;
export type ToolFilter = (typeof TOOL_FILTERS)[number];
export const TOOL_FILTER_LABELS: Record<ToolFilter, string> = {
	all: "All tools",
	available: "Available",
	missing: "Missing",
	unsupported: "No platform download",
};
export function matchesTool(tool: Tool, query: string, filter: ToolFilter): boolean {
	const available = tool.resolution.source === "path" || tool.resolution.source === "vendored";
	const matchesState =
		filter === "all" ||
		(filter === "available" && available) ||
		(filter === "missing" && !available && tool.supported) ||
		(filter === "unsupported" && !tool.supported);
	return (
		matchesState &&
		`${tool.id} ${tool.summary} ${tool.version} ${toolResolution(tool).label}`
			.toLocaleLowerCase("en-US")
			.includes(query.trim().toLocaleLowerCase("en-US"))
	);
}
export function operationUnsettled(operationId: string | null, status: string | undefined): boolean {
	return operationId !== null && status !== "succeeded" && status !== "failed" && status !== "cancelled";
}

export function requestOutcomeUnknown(status: number | undefined): boolean {
	return status === undefined || status === 408 || status >= 500;
}

export function toolAvailability(tool: Pick<Tool, "supported" | "resolution">): string {
	if (tool.resolution.source === "path") return "A compatible executable on PATH is available to Clio.";
	if (tool.resolution.source === "vendored") return "Clio resolves the installed pinned executable.";
	return tool.supported
		? "No usable executable was resolved. Install the pinned version to make this tool available."
		: "No executable was resolved and no pinned download is available for this platform.";
}
