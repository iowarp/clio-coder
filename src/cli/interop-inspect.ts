/**
 * Fixed machine-readable projection of detected external coding agents.
 *
 * `configure --interop` is an interactive review that writes delegation peers
 * into settings, so it is not a transport a GUI host can invoke. This command
 * takes no identifier or flag beyond `--json`, decides nothing, and writes
 * nothing.
 *
 * It also runs no foreign executable. Detection can probe `<bin> --version`,
 * and this read deliberately does not: a GUI refresh must not become "execute
 * every coding agent installed on this machine". The version still crosses,
 * because a non-probing detection keeps the last version the harness observed
 * for the same binary, so what the operator sees is a recorded fact rather than
 * a fresh execution.
 *
 * Resolved binary paths and the agent's home directory are native filesystem
 * facts and stay on the host. Whether a directory exists crosses; where it is
 * does not.
 */

import { readSettings } from "../core/config.js";
import {
	detectInteropAgents,
	INTEROP_AGENT_KINDS,
	type InteropAgentId,
	type InteropPresence,
	interopAgentKind,
} from "../domains/interop/index.js";

export type InteropDecisionState = "accepted" | "declined";

export interface InteropInspectAgent {
	readonly id: InteropAgentId;
	readonly label: string;
	readonly presence: InteropPresence;
	/** The last version the harness observed for this binary, never probed here. */
	readonly version: string | null;
	/** Whether the agent owns a directory under the operator's home. The path stays host-side. */
	readonly hasUserDirectory: boolean;
	/** Whether this kind speaks ACP at all. */
	readonly acp: boolean;
	/** Whether the ACP adapter can start without a network install; null for a kind with no recipe. */
	readonly adapter: InteropPresence | null;
	/** Whether a `delegation.agents` entry already names this agent. */
	readonly configured: boolean;
	/** The operator's standing answer, or null when they have not been asked. */
	readonly decision: InteropDecisionState | null;
	readonly decidedAt: string | null;
	/**
	 * True when the facts moved since the decision was taken.
	 *
	 * A standing answer suppresses re-proposal only while the facts it was made
	 * against still hold, so this is what says Clio Coder will ask again.
	 */
	readonly decisionStale: boolean;
	/** True when Clio Coder would offer to wire this agent on the next review. */
	readonly proposed: boolean;
	/** True when wiring it would fetch the adapter from the network on first use. */
	readonly needsNetworkInstall: boolean;
}

export interface InteropInspectSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly detectedAt: string;
	/**
	 * How many agent kinds the registry knows, so an empty list reads as "none
	 * detected" rather than "nothing to detect". Detection drops a kind with no
	 * binary, no directory, and no artifacts, so the list is never padded.
	 */
	readonly knownKinds: number;
	readonly agents: readonly InteropInspectAgent[];
}

/**
 * Skill and artifact counts are deliberately absent.
 *
 * Detection populates them only from sources the resources and context domains
 * have already loaded, and this command loads neither. Reporting the structural
 * zero that would result would state a fact this read did not establish.
 */
export async function interopInspectSnapshot(now: () => number = Date.now): Promise<InteropInspectSnapshot> {
	const report = await detectInteropAgents({ cwd: process.cwd(), probeVersion: false });
	const settings = readSettings();
	const configured = new Set(settings.integrations.externalAgents.entries.map((agent) => agent.id));
	const agents: InteropInspectAgent[] = [];
	for (const record of report.agents) {
		const kind = interopAgentKind(record.kind);
		if (kind === undefined) continue;
		const acp = kind.acp !== undefined;
		const decision = record.decision === "accepted" || record.decision === "declined" ? record.decision : null;
		const decisionStale = decision !== null && record.decidedFingerprint !== record.fingerprint;
		const isConfigured = configured.has(kind.id);
		agents.push({
			id: kind.id,
			label: kind.label,
			presence: record.presence,
			version: typeof record.version === "string" && record.version.length > 0 ? record.version : null,
			hasUserDirectory: record.installDir !== undefined,
			acp,
			adapter: acp ? (record.adapter ?? "unknown") : null,
			configured: isConfigured,
			decision,
			decidedAt: decision === null ? null : (record.decidedAt ?? null),
			decisionStale,
			// The same rule `interopProposals` applies, restated over the projected
			// fields so the flag cannot drift from what the review would offer.
			proposed: acp && record.presence === "present" && !isConfigured && (decision === null || decisionStale),
			needsNetworkInstall: acp && record.adapter !== "present",
		});
	}
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		detectedAt: report.detectedAt,
		knownKinds: INTEROP_AGENT_KINDS.length,
		agents,
	};
}

export async function runInteropInspect(args: ReadonlyArray<string>): Promise<number> {
	if (args.length !== 1 || args[0] !== "--json") {
		process.stderr.write("clio-coder interop inspect: usage: clio-coder interop inspect --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(await interopInspectSnapshot(), null, 2)}\n`);
	return 0;
}
