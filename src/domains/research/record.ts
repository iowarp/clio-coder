/**
 * RECORD: what one measured iteration adds to the project's claims ledger, through the ledger's own appenders.
 *
 * The agent's stated plan becomes a hypothesis on the campaign's slate (`.clio-coder/research/<id>/slate.json`, schema
 * `clio-coder.hypothesis-slate.v1`), whose success criterion names the objective check. Before the checks run, the
 * iteration's run identity is started against the objective and gate checks, so the hypothesis is bound to this run.
 * After they run, every judged check (numeric-compare, reproduce) yields a claim from Clio's own execution, and the
 * hypothesis is marked tested in the ledger without a claim. A claim's reference agreement says the output still
 * matches; it says nothing about whether the change improved the metric, so it never supports or refutes the
 * hypothesis. Whether it held is the research grade's call (`researchHypothesisVerdict`): the journal records it, and
 * `research report` recomputes the grade from the raw samples. The ledger only lets a judged claim support or refute,
 * so the grade is never written there as one.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { ToolResult } from "../../tools/registry.js";
import {
	appendCheckStarts,
	appendClaims,
	appendHypotheses,
	appendHypothesisTests,
	type CheckRun,
	type CheckRunIdentity,
	type ClaimRecord,
	type ClaimSource,
	claimFromVerifyResult,
	HYPOTHESIS_SLATE_SCHEMA,
	hypothesesFromSlate,
} from "../claims/index.js";
import { campaignDir, samplesName } from "./store.js";
import type { ResearchCampaign, ResearchGrade, ResearchHypothesisVerdict } from "./types.js";

/** The hypothesis verdict a research grade implies: improved supports, regressed refutes, anything else is inconclusive. */
export function researchHypothesisVerdict(grade: ResearchGrade | null): ResearchHypothesisVerdict {
	if (grade?.verdict === "improved") return "supported";
	if (grade?.verdict === "regressed") return "refuted";
	return "inconclusive";
}

function researchRunIdentity(campaign: ResearchCampaign, iteration: number): CheckRunIdentity {
	return { channel: "verify", sessionId: null, toolCallId: `research:${campaign.id}:${samplesName(iteration)}` };
}

function slatePath(campaign: ResearchCampaign): string {
	return join(campaignDir(campaign.project, campaign.id), "slate.json");
}

interface SlateEntry {
	id: string;
	statement: string;
	prediction: string;
	status: "proposed";
	experiment: { successCriterion: { kind: string; verifyId: string; statement: string } };
}

/**
 * Add the iteration's hypothesis to the campaign slate and record it, then start the run's checks so the record is
 * bound to them. Returns the hypothesis record id (null when the ledger kept an unchanged earlier record) and the
 * bindings each check's test needs.
 */
export async function beginIterationRecord(input: {
	campaign: ResearchCampaign;
	iteration: number;
	at: string;
	sessionId: string | null;
	hypothesis: { statement: string; prediction: string };
	checks: ReadonlyArray<string>;
}): Promise<{ hypothesis: string | null; bindings: Map<string, string[]> }> {
	const { campaign } = input;
	const path = slatePath(campaign);
	let entries: SlateEntry[] = [];
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { hypotheses?: unknown };
			if (Array.isArray(parsed.hypotheses)) entries = parsed.hypotheses as SlateEntry[];
		} catch {
			entries = [];
		}
	}
	const objective = campaign.objective;
	const id = `H${input.iteration}`;
	entries = entries.filter((entry) => entry.id !== id);
	entries.push({
		id,
		statement: input.hypothesis.statement,
		prediction:
			input.hypothesis.prediction.length > 0
				? input.hypothesis.prediction
				: `${objective.metric} moves ${objective.direction === "min" ? "down" : "up"} by at least ${objective.minImprovement * 100}%`,
		status: "proposed",
		experiment: {
			successCriterion: {
				kind: "research-objective",
				verifyId: objective.check,
				statement: `median ${objective.metric} ${objective.direction === "min" ? "falls" : "rises"} by at least ${objective.minImprovement * 100}% over ${objective.trials} interleaved pairs, with a bootstrap 95% interval excluding zero`,
			},
		},
	});
	const text = `${JSON.stringify({ schema: HYPOTHESIS_SLATE_SCHEMA, campaign: campaign.id, hypotheses: entries }, null, 2)}\n`;
	safeResourceWrite(path, text, { encoding: "utf8" });
	const drafts = (
		hypothesesFromSlate({
			text,
			slateSha256: createHash("sha256").update(text, "utf8").digest("hex"),
			path,
			project: campaign.project,
			at: input.at,
			source: { channel: "slate", sessionId: input.sessionId, toolCallId: null },
		}) ?? []
	).filter((draft) => draft.hypothesis === id);
	const written = (await appendHypotheses(campaign.project, drafts)) ?? [];
	const bindings = await appendCheckStarts(
		campaign.project,
		researchRunIdentity(campaign, input.iteration),
		input.checks,
		input.at,
	);
	return { hypothesis: written[0]?.id ?? null, bindings };
}

export interface CheckOutcome {
	check: string;
	execution: string;
	result?: ToolResult;
}

/** Append the claims judged checks produced and test the hypotheses bound to the run. Returns the claim ids. */
export async function finishIterationRecord(input: {
	campaign: ResearchCampaign;
	iteration: number;
	at: string;
	bindings: ReadonlyMap<string, string[]>;
	outcomes: ReadonlyArray<CheckOutcome>;
}): Promise<{ claims: Map<string, ClaimRecord> }> {
	const run = researchRunIdentity(input.campaign, input.iteration);
	if (run.channel !== "verify") throw new Error("research runs use the verify channel");
	const source: Extract<ClaimSource, { channel: "verify" }> = {
		channel: "verify",
		sessionId: run.sessionId,
		toolCallId: run.toolCallId,
		requestedBy: "harness",
	};
	const claims = new Map<string, ClaimRecord>();
	for (const outcome of input.outcomes) {
		const claim = claimFromVerifyResult({
			details: outcome.result?.details,
			project: input.campaign.project,
			at: input.at,
			source,
		});
		if (claim !== null) claims.set(outcome.check, claim);
	}
	if (claims.size > 0) await appendClaims([...claims.values()]);
	// No claim on the test: reference agreement is not evidence the change improved the metric.
	const runs: CheckRun[] = input.outcomes.map((outcome) => ({
		check: outcome.check,
		hypotheses: input.bindings.get(outcome.check) ?? [],
		execution: outcome.execution,
		source,
		at: input.at,
	}));
	await appendHypothesisTests(input.campaign.project, runs);
	return { claims };
}

/** The execution word a verify result's judgement carries, or what a plain command check's outcome implies. */
export function executionOf(result: ToolResult): string {
	const judgement = (result.details as { judgement?: { execution?: unknown } } | undefined)?.judgement;
	if (typeof judgement?.execution === "string") return judgement.execution;
	return result.kind === "ok" ? "succeeded" : "failed";
}
