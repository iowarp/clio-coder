import { stdout as output } from "node:process";
import type { createInterface } from "node:readline/promises";
import { readSettings } from "../core/config.js";
import {
	acceptInteropAgents,
	declineInteropAgents,
	detectInteropAgents,
	INHERITED_PROJECT_CONTEXT,
	type InteropAgentId,
	type InteropProposal,
	interopProposals,
	renderProposalEntry,
} from "../domains/interop/index.js";
import { askYesNo } from "./ask.js";
import { printOk } from "./shared.js";

function describe(proposal: InteropProposal): string {
	const lines = [
		"",
		`${proposal.label} is installed and not configured as a delegation agent.`,
		"",
		renderProposalEntry(proposal),
		"",
		`projectContext stays ${INHERITED_PROJECT_CONTEXT}: this agent receives your task text, never the project projection.`,
		`toolGovernance is clio-policy: its tool calls are gated by Clio safety.`,
	];
	if (proposal.needsNetworkInstall) {
		lines.push(`The ACP adapter is not installed locally; npx fetches it the first time you delegate.`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Review detected agents and, with an explicit answer per agent, wire them as
 * delegation peers. Without a TTY this prints the proposals and writes nothing:
 * no code path adds a peer the operator did not agree to.
 */
export async function runInteropReview(rl: ReturnType<typeof createInterface> | null): Promise<number> {
	const report = await detectInteropAgents({ cwd: process.cwd(), probeVersion: true });
	const proposals = interopProposals(report, readSettings());
	if (proposals.length === 0) {
		output.write("No new coding agents to connect.\n");
		return 0;
	}
	if (rl === null) {
		for (const proposal of proposals) output.write(describe(proposal));
		output.write("\nRun `clio-coder configure --interop` on a terminal to connect any of these.\n");
		return 0;
	}
	const accepted: InteropAgentId[] = [];
	const declined: InteropAgentId[] = [];
	for (const proposal of proposals) {
		output.write(describe(proposal));
		const yes = await askYesNo(rl, `Add ${proposal.label} as delegation agent \`${proposal.entry.id}\`?`, false);
		(yes ? accepted : declined).push(proposal.kind);
	}
	if (accepted.length > 0) {
		const result = acceptInteropAgents(accepted, report);
		for (const diagnostic of result.diagnostics) output.write(`note: ${diagnostic}\n`);
		for (const id of result.wired) printOk(`delegation agent ${id} added; use \`/delegate ${id} <task>\``);
	}
	if (declined.length > 0) {
		declineInteropAgents(declined, report);
		output.write(`Declined ${declined.join(", ")}; Clio stays quiet about them until their version or path changes.\n`);
	}
	return 0;
}
