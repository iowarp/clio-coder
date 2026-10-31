import { InvalidIdError } from "../core/safe-id.js";
import { clioStateDir } from "../core/xdg.js";
import type { RunEvidence } from "../domains/evidence/index.js";
import {
	formatTrustAxes,
	formatTrustSummary,
	inspectRunEvidence,
	listRunEvidence,
	provenanceTranscriptLines,
} from "../domains/evidence/index.js";
import { runEvidenceDetail } from "./evidence-detail.js";
import { printError } from "./shared.js";

const HELP = `clio-coder evidence inspect <runId> [--json]
clio-coder evidence list

Inspect a finished run's evidence: its seal's verdict and the assessment the run
journaled before sealing. Each run is assessed when it settles; there is nothing
to build.
`;

type EvidenceCommand = "inspect" | "list";

interface ParsedEvidenceArgs {
	command?: EvidenceCommand;
	json: boolean;
	runId?: string;
	help: boolean;
}

function parseEvidenceArgs(args: ReadonlyArray<string>): ParsedEvidenceArgs {
	const parsed: ParsedEvidenceArgs = { help: false, json: false };
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "inspect" || arg === "list") {
				parsed.command = arg;
				continue;
			}
			// A run is assessed when it settles, inside its sealed scope (#434).
			if (arg === "build")
				throw new Error(
					"evidence build was removed: every run is assessed when it settles; use `evidence inspect <runId>`",
				);
			throw new Error(`unknown evidence command: ${arg}`);
		}
		if (parsed.command === "inspect" && arg === "--json" && !parsed.json) {
			parsed.json = true;
			continue;
		}
		if (parsed.command === "inspect" && parsed.runId === undefined) {
			if (arg.startsWith("-")) throw new Error("inspect requires a run id");
			parsed.runId = arg;
			continue;
		}
		throw new Error(`unexpected evidence argument: ${arg}`);
	}
	if (parsed.help) return parsed;
	if (parsed.command === undefined) throw new Error("evidence requires inspect or list");
	if (parsed.command === "inspect" && parsed.runId === undefined) throw new Error("inspect requires a run id");
	return parsed;
}

export async function runEvidenceCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedEvidenceArgs;
	try {
		parsed = parseEvidenceArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		// Usage that accompanies an error goes to stderr with it, so a caller capturing stdout for evidence output never
		// collects a help screen instead.
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const stateDir = clioStateDir();
	try {
		if (parsed.command === "inspect" && parsed.runId !== undefined) {
			if (parsed.json) return runEvidenceDetail(parsed.runId);
			const evidence = await inspectRunEvidence(stateDir, parsed.runId);
			if (evidence.settled === null && evidence.integrity.state !== "failed") {
				printError(
					`run ${parsed.runId} has no settled record: ${evidence.integrity.state === "verified" ? "not settled" : evidence.integrity.reason}`,
				);
				process.stderr.write("  run `clio-coder evidence list` to see local runs\n");
				return 1;
			}
			renderEvidence(evidence);
			// The record is printed either way, but the exit code never says ok over a seal that was checked and rejected.
			return evidence.integrity.state === "failed" ? 1 : 0;
		}
		renderEvidenceList(await listRunEvidence(stateDir));
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return error instanceof InvalidIdError ? 2 : 1;
	}
}

function renderEvidence(evidence: RunEvidence): void {
	const write = (line: string) => process.stdout.write(`${line}\n`);
	write(`run: ${evidence.runId}`);
	write(`seal: ${evidence.integrity.state === "verified" ? "verified" : evidence.integrity.reason}`);
	write(`assessed: ${evidence.assessedAt ?? "no"}`);
	if (evidence.settled) write(`outcome: ${evidence.settled.outcome} (exit ${evidence.settled.exitCode ?? "?"})`);
	if (evidence.totals) {
		write(`tool calls: ${evidence.totals.toolCalls}`);
		write(`blocked tools: ${evidence.totals.blockedToolCalls}`);
		write(`tokens: ${evidence.totals.tokens.display}`);
		write(`cost: ${evidence.totals.usd.display}`);
	}
	if (evidence.firstPassSuccess !== null) write(`first pass: ${evidence.firstPassSuccess ? "yes" : "no"}`);
	write(`tags: ${formatList(evidence.tags)}`);
	// The compact projection answers the trust questions; the canonical axis line beneath it is the drill-down, in the
	// same form the dispatch tool and monitor print.
	write(`trust: ${formatTrustSummary(evidence.trust)}`);
	write(`  ${formatTrustAxes(evidence.trust)}`);
	for (const verdict of evidence.verdicts) write(`gate ${verdict.decisionId}: ${verdict.outcome} (${verdict.review})`);
	// Provenance is the sealed assessment's; a run whose seal did not verify prints none.
	const lines = evidence.provenance === null ? [] : provenanceTranscriptLines(evidence.provenance, evidence.trust);
	if (lines.length > 0) {
		write("provenance:");
		for (const line of lines) write(`  ${line}`);
	}
	write(`findings: ${evidence.findings.length}`);
	for (const finding of evidence.findings) write(`  [${finding.severity}] ${finding.tag}: ${finding.message}`);
}

function renderEvidenceList(runs: ReadonlyArray<RunEvidence>): void {
	process.stdout.write(`${runs.length} runs\n`);
	if (runs.length === 0) return;
	process.stdout.write("\n");
	for (const run of runs) {
		const state =
			run.integrity.state !== "verified" ? run.integrity.state : run.assessedAt === null ? "unassessed" : "assessed";
		process.stdout.write(
			[
				run.runId.padEnd(28),
				(run.settled?.outcome ?? "unsettled").padEnd(12),
				state.padEnd(12),
				formatList(run.tags),
			].join(""),
		);
		process.stdout.write("\n");
	}
}

function formatList(values: ReadonlyArray<string>): string {
	return values.length === 0 ? "none" : values.join(", ");
}
