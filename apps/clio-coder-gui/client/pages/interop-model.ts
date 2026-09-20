// External coding agents, in the operator's words. The wiring states are different facts and the
// page must not collapse them: wired as a delegation peer, offered and waiting for an answer,
// settled by a standing answer, or not a peer this Clio Coder can speak to at all. Pure, so every
// sentence is testable without a browser.

import type { Interop } from "../../contracts/system.js";
import { formatTime } from "../api/clock.js";
import type { StatusTone } from "../design/status.js";

export type InteropAgent = Interop["agents"][number];

/** How far one agent is wired, in one sentence. */
export function wiringSentence(
	agent: Pick<InteropAgent, "wiring" | "decision" | "decisionStale" | "adapter" | "presence">,
): string {
	switch (agent.wiring) {
		case "configured":
			return "Wired as a delegation peer.";
		case "not-acp":
			return "Speaks no ACP, so Clio Coder cannot delegate to it.";
		case "proposed": {
			const fetch =
				agent.adapter === "present" ? "" : " Accepting would fetch its ACP adapter from the network on first use.";
			return `${
				agent.decisionStale
					? "Offered again, because the facts moved since you last answered."
					: "Offered, and never answered."
			}${fetch}`;
		}
		case "decided":
			return agent.decision === "accepted"
				? "Accepted, but no delegation entry names it."
				: "Declined, so Clio Coder stays quiet about it.";
		case "not-offered":
			return agent.presence === "unknown"
				? "Not offered, because its executable could not be established."
				: "Not offered, because no executable was found to wire.";
		case "unknown":
			return "Wiring could not be established, because the settings that decide it could not be read.";
	}
}

export function wiringMark(agent: Pick<InteropAgent, "wiring">): { tone: StatusTone; label: string } {
	switch (agent.wiring) {
		case "configured":
			return { tone: "success", label: "Delegation peer" };
		case "proposed":
			return { tone: "warn", label: "Waiting for your answer" };
		case "decided":
			return { tone: "neutral", label: "Answered" };
		case "unknown":
			return { tone: "unverified", label: "Wiring unknown" };
		default:
			return { tone: "neutral", label: "Not a peer" };
	}
}

/** Presence of the executable. A kind with no executable is a set of shared conventions, not an absence. */
export function presenceMark(agent: Pick<InteropAgent, "hasExecutable" | "presence">): {
	tone: StatusTone;
	label: string;
} {
	if (!agent.hasExecutable) return { tone: "neutral", label: "Shared resource conventions" };
	if (agent.presence === "present") return { tone: "success", label: "Installed" };
	if (agent.presence === "absent") return { tone: "neutral", label: "Not installed" };
	return { tone: "unverified", label: "Could not be determined" };
}

/** A version always says where it came from, because a recorded one can be older than the binary. */
export function versionText(agent: Pick<InteropAgent, "version" | "versionSource" | "presence">): string {
	if (agent.version === null)
		return agent.presence === "present" ? "Not recorded yet. Detect again to probe it." : "Not reported";
	return `${agent.version} · ${agent.versionSource === "probed" ? "probed just now" : "last recorded"}`;
}

export function adapterText(adapter: InteropAgent["adapter"]): string {
	if (adapter === null) return "No recipe";
	if (adapter === "present") return "Installed locally";
	return adapter === "unknown" ? "Could not be determined" : "Would be fetched on first use";
}

/** Whether anything about this kind was found on the machine. */
export const isDetected = (agent: InteropAgent): boolean =>
	agent.presence === "present" ||
	agent.installDir !== null ||
	(agent.skillCount ?? 0) > 0 ||
	(agent.projectArtifacts ?? 0) > 0;

export interface InteropFigure {
	label: string;
	value: string;
}

/** Detected of known kinds, wired as peers, would be offered, and when. In that order. */
export function interopSummary(report: Interop): InteropFigure[] {
	const count = (wiring: InteropAgent["wiring"]) => report.agents.filter((agent) => agent.wiring === wiring).length;
	const unknown = count("unknown") > 0;
	return [
		{ label: "Detected", value: `${report.agents.filter(isDetected).length} of ${report.agents.length} known kinds` },
		// An unreadable settings file is not zero peers.
		{ label: "Wired as peers", value: unknown ? "Not established" : String(count("configured")) },
		{ label: "Would be offered", value: unknown ? "Not established" : String(count("proposed")) },
		{ label: "Checked", value: formatTime(report.detectedAt) },
	];
}

/** Detected agents first, in wire order within each half, so an empty machine still lists every kind. */
export function orderedAgents(report: Interop): InteropAgent[] {
	return [...report.agents.filter(isDetected), ...report.agents.filter((agent) => !isDetected(agent))];
}
