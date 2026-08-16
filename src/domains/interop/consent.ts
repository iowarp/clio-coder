import { stringify as stringifyYaml } from "yaml";
import { type ClioSettings, readSettings, updateSettings } from "../../core/config.js";
import type { DelegationAgentConfig } from "../../core/defaults.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { interopAgentKind } from "./registry.js";
import { interopStatePath, readInteropReport, writeInteropReport } from "./state.js";
import type {
	InteropAgentId,
	InteropAgentKind,
	InteropAgentRecord,
	InteropDecision,
	InteropDecisionResult,
	InteropProposal,
	InteropReport,
} from "./types.js";

/**
 * A wired peer inherits `projectContext: "none"`, so repo conventions never
 * leave the machine unless the operator opts this agent in later. The key is
 * left out of the written entry precisely so it tracks that default.
 */
export const INHERITED_PROJECT_CONTEXT = "none";

function proposalEntry(
	kind: InteropAgentKind,
	defaults: ClioSettings["delegation"]["defaults"],
): DelegationAgentConfig {
	const recipe = kind.acp;
	if (recipe === undefined) throw new Error(`interop kind ${kind.id} has no ACP recipe`);
	return {
		id: kind.id,
		command: recipe.command,
		args: [...recipe.args],
		connectTimeoutMs: defaults.connectTimeoutMs,
		turnTimeoutMs: defaults.turnTimeoutMs,
		permissionTimeoutMs: defaults.permissionTimeoutMs,
		toolGovernance: "clio-policy",
	};
}

/**
 * Agents the operator has not decided on yet. A standing decision suppresses
 * re-proposal only while the facts it was made against still hold, so a
 * declined agent whose binary or version moved comes back as a fresh proposal.
 */
export function interopProposals(report: InteropReport, settings: ClioSettings): ReadonlyArray<InteropProposal> {
	const configured = new Set(settings.delegation.agents.map((agent) => agent.id));
	const proposals: InteropProposal[] = [];
	for (const record of report.agents) {
		const kind = interopAgentKind(record.kind);
		if (kind?.acp === undefined) continue;
		if (record.presence !== "present") continue;
		if (configured.has(kind.id)) continue;
		if (record.decision !== undefined && record.decidedFingerprint === record.fingerprint) continue;
		proposals.push({
			kind: kind.id,
			label: kind.label,
			fingerprint: record.fingerprint,
			entry: proposalEntry(kind, settings.delegation.defaults),
			needsNetworkInstall: record.adapter !== "present",
		});
	}
	return proposals;
}

/** The exact YAML the entry lands as, rendered by the writer's own serializer. */
export function renderProposalEntry(proposal: InteropProposal): string {
	return stringifyYaml([proposal.entry]).trimEnd();
}

function recordDecisions(
	ids: ReadonlyArray<InteropAgentId>,
	report: InteropReport,
	decision: InteropDecision,
): InteropAgentId[] {
	const decidedAt = new Date().toISOString();
	const wanted = new Set(ids);
	const decided: InteropAgentId[] = [];
	withStateFileLockSync(interopStatePath(), () => {
		const stored = readInteropReport();
		const byKind = new Map<InteropAgentId, InteropAgentRecord>(
			[...(stored?.agents ?? []), ...report.agents].map((record) => [record.kind, record]),
		);
		for (const id of wanted) {
			const record = byKind.get(id);
			if (record === undefined) continue;
			byKind.set(id, { ...record, decision, decidedAt, decidedFingerprint: record.fingerprint });
			decided.push(id);
		}
		writeInteropReport({ version: 1, detectedAt: report.detectedAt, agents: [...byKind.values()] });
	});
	return decided;
}

/**
 * Wire the named agents as ACP delegation peers. The settings append runs
 * inside the shared settings lock, which re-reads the file, so two processes
 * accepting different agents at once cannot drop each other's entry.
 */
export function acceptInteropAgents(ids: ReadonlyArray<InteropAgentId>, report: InteropReport): InteropDecisionResult {
	const proposals = interopProposals(report, readSettings()).filter((proposal) => ids.includes(proposal.kind));
	const diagnostics: string[] = [];
	for (const id of ids) {
		if (!proposals.some((proposal) => proposal.kind === id)) diagnostics.push(`${id} is not a pending proposal`);
	}
	if (proposals.length === 0) return { decided: [], wired: [], diagnostics };
	const wired: string[] = [];
	updateSettings((settings) => {
		for (const proposal of proposals) {
			if (settings.delegation.agents.some((agent) => agent.id === proposal.entry.id)) continue;
			settings.delegation.agents.push({ ...proposal.entry, args: [...proposal.entry.args] });
			wired.push(proposal.entry.id);
		}
	});
	const decided = recordDecisions(
		proposals.map((proposal) => proposal.kind),
		report,
		"accepted",
	);
	return { decided, wired, diagnostics };
}

export function declineInteropAgents(ids: ReadonlyArray<InteropAgentId>, report: InteropReport): InteropDecisionResult {
	return { decided: recordDecisions(ids, report, "declined"), wired: [], diagnostics: [] };
}
