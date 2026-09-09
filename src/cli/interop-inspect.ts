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
	readonly inventory: {
		status: string;
		diagnosticCount: number;
		listing: "unknown";
		counts: Record<string, number>;
		items: ReadonlyArray<{
			kind: string;
			name: string;
			scope: string;
			version?: string;
			marketplace?: string;
			installation?: string;
			enabled?: boolean;
			adoption: string;
		}>;
	} | null;
	readonly id: InteropAgentId;
	readonly label: string;
	readonly presence: InteropPresence;
	/** The bounded version probe result, or last observed version. */
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
	 * detected" rather than "nothing to detect". Explicit inspection includes all five inventory-enabled hosts, including absent
	 * binaries; lightweight bootstrap detection still drops empty kinds.
	 */
	readonly knownKinds: number;
	readonly agents: readonly InteropInspectAgent[];
}

async function interopInspectSnapshot(now: () => number = Date.now): Promise<InteropInspectSnapshot> {
	const report = await detectInteropAgents({ cwd: process.cwd(), probeVersion: true, inventory: true });
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
			inventory: record.inventory
				? {
						status: record.inventory.status,
						diagnosticCount: record.inventory.diagnostics.length,
						listing: record.inventory.listing,
						counts: record.inventory.items.reduce<Record<string, number>>((counts, item) => {
							counts[item.kind] = (counts[item.kind] ?? 0) + 1;
							return counts;
						}, {}),
						items: record.inventory.items.map(({ kind, name, scope, version, marketplace, installation, enabled }) => ({
							kind,
							name,
							scope,
							...(version ? { version } : {}),
							...(marketplace ? { marketplace } : {}),
							...(installation ? { installation } : {}),
							...(enabled !== undefined ? { enabled } : {}),
							adoption: ["hook", "mcp", "executable", "output-style"].includes(kind) ? "not adoptable" : "review required",
						})),
					}
				: null,
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
	if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
		process.stderr.write("clio-coder interop inspect: usage: clio-coder interop inspect --json\n");
		return 2;
	}
	const snapshot = await interopInspectSnapshot();
	if (args[0] === "--json") process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
	else
		for (const agent of snapshot.agents) {
			process.stdout.write(
				`${agent.label}: ${agent.presence}; version ${agent.version ?? "unknown"}; ${agent.configured ? "connected" : "not connected"}; adapter ${agent.adapter ?? "unsupported"}\n`,
			);
			process.stdout.write(
				`  Inventory ${agent.inventory?.status ?? "unknown"}: ${
					Object.entries(agent.inventory?.counts ?? {})
						.map(([kind, count]) => `${count} ${kind}`)
						.join(", ") || "none found"
				}\n`,
			);
			for (const item of agent.inventory?.items ?? [])
				process.stdout.write(
					`  ${item.scope} ${item.kind} ${item.name}${item.version ? ` @ ${item.version}` : ""}${item.marketplace ? ` (${item.marketplace})` : ""}; ${item.adoption}\n`,
				);
		}
	return 0;
}
