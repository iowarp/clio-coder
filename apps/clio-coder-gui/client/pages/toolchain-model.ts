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
