import { existsSync } from "node:fs";
import { Value } from "typebox/value";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import type { RunEvidence } from "../../../../../src/domains/evidence/index.js";
import {
	admitRunProvenance,
	inspectRunEvidence,
	listRunEvidence,
	provenanceTranscriptLines,
	summarizeTrustStatus,
	trustVerdict,
} from "../../../../../src/domains/evidence/index.js";
import { telemetryRunsDirectory } from "../../../../../src/domains/telemetry/index.js";
import { Id } from "../../../contracts/common.js";
import { type EvidenceRequest, EvidenceRun } from "../../../contracts/evidence.js";
import { AppProblem } from "../../services/problem.js";
import { artifactPage } from "./storage.js";

/** A run that never settled stands in the inventory only when its seal was checked and failed. */
const NEVER = "1970-01-01T00:00:00.000Z";

/** The run as the GUI shows it: identity, seal verdict and the sealed assessment's summary (#434). */
function runRow(run: RunEvidence) {
	const settled = run.settled;
	return {
		runId: run.runId,
		sessionId: run.sessionId,
		integrity: run.integrity.state,
		sealReason: run.integrity.state === "verified" ? null : run.integrity.reason,
		assessedAt: run.assessedAt,
		settledAt: settled?.at ?? null,
		startedAt: settled?.startedAt ?? null,
		endedAt: settled?.endedAt ?? null,
		agentId: settled?.agentId ?? null,
		targetId: settled?.targetId ?? null,
		wireModelId: settled?.wireModelId ?? null,
		outcome: settled?.outcome ?? null,
		firstPassSuccess: run.firstPassSuccess,
		tags: [...run.tags],
		quantities: run.totals === null ? null : { tokens: run.totals.tokens, usd: run.totals.usd },
		totals:
			run.totals === null
				? null
				: {
						toolCalls: run.totals.toolCalls,
						toolErrors: run.totals.toolErrors,
						blockedToolCalls: run.totals.blockedToolCalls,
						wallTimeMs: run.totals.wallTimeMs,
					},
	};
}

export async function readEvidence(input: EvidenceRequest): Promise<unknown> {
	const state = clioStateDir();
	if (input.kind === "list") {
		const runs = (await listRunEvidence(state)).filter((run) => run.settled !== null || run.integrity.state === "failed");
		const rows = runs.map((run) => ({ run, row: runRow(run) })).filter(({ row }) => Value.Check(EvidenceRun, row));
		const page = artifactPage(
			rows.map(({ run, row }) => ({ id: run.runId, startedAt: run.settled?.at ?? NEVER, run, row })),
			input.limit,
			input.cursor,
		);
		return {
			items: page.items.map(({ run, row }) => ({ run: row, verdict: trustVerdict(run.trust) })),
			nextCursor: page.nextCursor,
			// An absent run store is a different fact from a present one holding no settled run.
			present: existsSync(telemetryRunsDirectory(state)),
		};
	}
	if (!Value.Check(Id, input.id)) throw new AppProblem("validation", "Invalid evidence identifier.");
	let run: RunEvidence;
	try {
		run = await inspectRunEvidence(state, input.id);
	} catch {
		throw new AppProblem("unavailable", "This run's evidence is unreadable. Other runs remain available.");
	}
	if (run.settled === null && run.integrity.state !== "failed")
		throw new AppProblem("not_found", "That run has not settled; it has no evidence yet.");
	const provenance = run.provenance ?? {};
	return {
		run: runRow(run),
		verdict: trustVerdict(run.trust),
		findings: run.findings,
		status: run.trust,
		summary: summarizeTrustStatus(run.trust),
		verdicts: run.verdicts,
		provenance: {
			view: admitRunProvenance(provenance, run.trust),
			lines: provenanceTranscriptLines(provenance, run.trust),
		},
		decisions: run.decisions,
	};
}
