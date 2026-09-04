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
import type { LifecyclePresenter } from "./lifecycle-presenter.js";
import { printOk } from "./shared.js";

function describe(proposal: InteropProposal): string {
	const lines = [
		"",
		`${proposal.label} is installed and not configured as a delegation agent.`,
		"",
		renderProposalEntry(proposal),
		"",
		`projectContext stays ${INHERITED_PROJECT_CONTEXT}: this agent receives your task text, never the project projection.`,
		`toolGovernance is clio-coder-policy: its tool calls are gated by Clio safety.`,
	];
	if (proposal.needsNetworkInstall) {
		lines.push(`The ACP adapter is not installed locally; npx fetches it the first time you delegate.`);
	}
	return `${lines.join("\n")}\n`;
}

export interface InteropReviewStreams {
	in: NodeJS.ReadableStream;
	out: NodeJS.WritableStream;
}

export interface InteropReviewIo {
	/** Readline interface to ask on. Null means nothing can answer. */
	rl: ReturnType<typeof createInterface> | null;
	streams?: InteropReviewStreams;
	/** Rail to draw on when the caller already owns one. */
	presenter?: LifecyclePresenter;
	rail?: string;
	/** Skip the "nothing to connect" line, for a caller whose transcript says enough. */
	quiet?: boolean;
}

export interface InteropReviewOutcome {
	code: number;
	/** Agent ids that were wired, in the order they were written. */
	wired: string[];
	/** The user left the review without answering it. */
	back: boolean;
}

/**
 * Review detected agents and, with an explicit answer per agent, wire them as
 * delegation peers. Without a TTY this prints the proposals and writes nothing:
 * no code path adds a peer the operator did not agree to.
 */
export async function reviewInteropAgents(io: InteropReviewIo): Promise<InteropReviewOutcome> {
	const report = await detectInteropAgents({ cwd: process.cwd(), probeVersion: true });
	const proposals = interopProposals(report, readSettings());
	if (proposals.length === 0) {
		if (!io.quiet) output.write("No new coding agents to connect.\n");
		return { code: 0, wired: [], back: false };
	}
	if (io.rl === null) {
		for (const proposal of proposals) output.write(describe(proposal));
		output.write("\nRun `clio-coder configure --interop` on a terminal to connect any of these.\n");
		return { code: 0, wired: [], back: false };
	}

	const accepted: InteropAgentId[] = [];
	const declined: InteropAgentId[] = [];
	for (const proposal of proposals) {
		output.write(describe(proposal));
		const yes = await askYesNo(io.rl, `Add ${proposal.label} as delegation agent \`${proposal.entry.id}\`?`, false);
		(yes ? accepted : declined).push(proposal.kind);
	}

	const wired: string[] = [];
	if (accepted.length > 0) {
		const result = acceptInteropAgents(accepted, report);
		for (const diagnostic of result.diagnostics) {
			if (io.presenter) io.presenter.warn(diagnostic);
			else output.write(`note: ${diagnostic}\n`);
		}
		for (const id of result.wired) {
			wired.push(id);
			// A caller with a rail lists what it wrote in its own completion rows.
			if (!io.presenter) printOk(`delegation agent ${id} added; use \`/delegate ${id} <task>\``);
		}
	}
	if (declined.length > 0) {
		declineInteropAgents(declined, report);
		const line = `Declined ${declined.join(", ")}; Clio stays quiet about them until their version or path changes.`;
		if (io.presenter) io.presenter.note(line);
		else output.write(`${line}\n`);
	}
	return { code: 0, wired, back: false };
}

export async function runInteropReview(io: InteropReviewIo): Promise<number> {
	return (await reviewInteropAgents(io)).code;
}
