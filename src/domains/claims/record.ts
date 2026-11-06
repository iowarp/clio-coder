import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { clioDataDir } from "../../core/xdg.js";
import { recordClaimRegressions } from "../memory/index.js";
import type { MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimFromVerifyResult, claimsFromHostVerification, type SealedHostCheck } from "./capture.js";
import { claimBackingRefs, claimRegressionNote, overturnedAgreements, regressionRecord } from "./edges.js";
import { type CheckRun, hypothesesFromSlate } from "./hypotheses.js";
import {
	appendClaimRegressions,
	appendClaims,
	appendHypotheses,
	appendHypothesisTests,
	claimsProjectRoot,
	readClaims,
} from "./store.js";
import type { ClaimEdgeRecord, ClaimRecord } from "./types.js";

export const CLAIM_CAPTURE_REGISTRATION_ID = "observer.claims-capture";
export const HYPOTHESIS_CAPTURE_REGISTRATION_ID = "observer.hypothesis-capture";

/** A slate past this size is not read; a hypothesis slate is a few KB. */
const SLATE_MAX_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The run a verify result records, or null when the check never ran: no declared check, no judgement, or a runner
 * that was unavailable. A run that started is a test of any hypothesis naming the check, judged or not.
 */
function verifyRun(
	details: Readonly<Record<string, unknown>> | undefined,
	claim: ClaimRecord | null,
	source: CheckRun["source"],
	at: string,
): CheckRun | null {
	if (details === undefined || typeof details.check !== "string") return null;
	const judgement = details.judgement;
	if (!isRecord(judgement) || typeof judgement.execution !== "string" || judgement.execution === "unavailable")
		return null;
	return { check: details.check, execution: judgement.execution, ...(claim !== null ? { claim } : {}), source, at };
}

/**
 * Captures the claim a main-thread `verify` result carries (#406). Only the main session registers it, so a worker's
 * own verify call, which judges the worker's tree under the worker's control, never writes the operator's log; a
 * worker run's checks reach the log through host verification instead. The phase is awaited, so a headless run
 * cannot exit before its claim is on disk.
 */
export function createClaimCaptureRegistration(options: {
	cwd: () => string;
	now?: () => Date;
}): MiddlewareHookRegistration {
	const now = options.now ?? (() => new Date());
	return {
		id: CLAIM_CAPTURE_REGISTRATION_ID,
		description: "record a judged reproduce or numeric-compare verify result in the project's claims log",
		hooks: ["after_tool"],
		toolNames: [ToolNames.Verify],
		evidence: "typed:verify.report@tool-result",
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(input: MiddlewareHookInput) {
			if (input.toolName !== ToolNames.Verify) return [];
			const project = claimsProjectRoot(options.cwd());
			const at = now().toISOString();
			const source = {
				channel: "verify" as const,
				sessionId: input.sessionId ?? null,
				toolCallId: input.toolCallId ?? null,
				requestedBy: input.metadata?.origin === "harness" ? ("harness" as const) : ("model" as const),
			};
			const claim = claimFromVerifyResult({ details: input.toolResultDetails, project, at, source });
			if (claim !== null) await recordClaims([claim], now());
			// After the claim is on disk, so a test record never names a claim the log does not hold yet.
			const run = verifyRun(input.toolResultDetails, claim, source, at);
			if (run !== null) await appendHypothesisTests(project, [run]);
			return [];
		},
	};
}

/**
 * Records the hypotheses of a hypothesis-workflow slate the main session writes or edits (#406), at `proposed`. The
 * slate is read from disk after the tool ran, so what is recorded is the file as it stands, whichever tool shaped it.
 * Like claim capture, only the main session registers it: a worker's slate is the worker's draft until the main
 * session writes it into the project.
 */
export function createHypothesisCaptureRegistration(options: {
	cwd: () => string;
	now?: () => Date;
}): MiddlewareHookRegistration {
	const now = options.now ?? (() => new Date());
	return {
		id: HYPOTHESIS_CAPTURE_REGISTRATION_ID,
		description: "record the hypotheses of a written hypothesis slate in the project's claims log as proposed",
		hooks: ["after_tool"],
		toolNames: [ToolNames.Write, ToolNames.Edit],
		evidence: "typed:hypothesis-slate@tool-args",
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(input: MiddlewareHookInput) {
			const path = input.toolArgs?.path;
			if (typeof path !== "string" || !path.endsWith(".json")) return [];
			const cwd = options.cwd();
			const absolute = resolve(cwd, path);
			let text: string;
			try {
				if (statSync(absolute).size > SLATE_MAX_BYTES) return [];
				text = readFileSync(absolute, "utf8");
			} catch {
				// A write that failed or a file removed since leaves no slate to record.
				return [];
			}
			const project = claimsProjectRoot(cwd);
			const drafts = hypothesesFromSlate({
				text,
				path: absolute,
				project,
				at: now().toISOString(),
				source: { sessionId: input.sessionId ?? null, toolCallId: input.toolCallId ?? null },
			});
			if (drafts !== null && drafts.length > 0) await appendHypotheses(project, drafts);
			return [];
		},
	};
}

/**
 * Record the claims a settled worker run's host verification yields. `projectCwd` is the operator's checkout the run
 * belongs to, never a task worktree, so a worktree run's claims land in its project's log.
 */
export async function recordHostVerificationClaims(input: {
	runId: string;
	receiptDigest: string;
	checks: ReadonlyArray<SealedHostCheck>;
	projectCwd: string;
	now?: Date;
}): Promise<number> {
	const project = claimsProjectRoot(input.projectCwd);
	const at = (input.now ?? new Date()).toISOString();
	const claims = claimsFromHostVerification({
		runId: input.runId,
		receiptDigest: input.receiptDigest,
		checks: input.checks,
		project,
		at,
	});
	if (claims.length > 0) await recordClaims(claims, input.now ?? new Date());
	// Each check this run executed itself tests the hypotheses naming it; a memo hit or a batch member's shared check is
	// the other run's evidence and tested them there.
	const source = { channel: "host-verification" as const, runId: input.runId, receiptDigest: input.receiptDigest };
	const runs = input.checks
		.filter((check) => !check.memo && check.evidenceRunId === undefined)
		.map((check): CheckRun => {
			const claim = claims.find((candidate) => candidate.keys.check === check.check);
			return {
				check: check.check,
				execution: check.exitCode === 0 ? "succeeded" : "failed",
				...(claim !== undefined ? { claim } : {}),
				source,
				at,
			};
		});
	await appendHypothesisTests(project, runs);
	return claims.length;
}

/**
 * Append claims, then carry each contradiction that overturned an agreement into memory (#406): every memory record
 * citing one of the overturned agreeing claims gets a regression naming both claims, written through memory's own
 * locked mutation, and a `regression` line in the claims log names the records it reached, none included.
 */
async function recordClaims(claims: ReadonlyArray<ClaimRecord>, now: Date): Promise<void> {
	const edges = await appendClaims(claims);
	const contradictions = edges.filter((edge) => edge.kind === "contradicts");
	if (contradictions.length === 0) return;
	const byProject = new Map<string, ClaimEdgeRecord[]>();
	for (const edge of contradictions) byProject.set(edge.project, [...(byProject.get(edge.project) ?? []), edge]);
	for (const [project, group] of byProject) {
		const log = readClaims(project);
		const claimsById = new Map(log.records.map((claim) => [claim.id, claim]));
		const overturned = group.flatMap((edge) => {
			const later = claimsById.get(edge.from);
			const backing = overturnedAgreements(edge, log.records, log.edges);
			return later === undefined || backing.length === 0 ? [] : [{ edge, later, backing }];
		});
		if (overturned.length === 0) continue;
		const inputs = overturned.flatMap(({ later, backing }) =>
			backing.map((claim) => ({ refs: claimBackingRefs(claim), note: claimRegressionNote(later, claim) })),
		);
		const reached = await recordClaimRegressions(clioDataDir(), inputs);
		let index = 0;
		const records = overturned.map(({ edge, backing }) => {
			const memory = new Set<string>();
			for (const _claim of backing) for (const id of reached[index++] ?? []) memory.add(id);
			return regressionRecord({ edge, backing, memory: [...memory], at: now.toISOString() });
		});
		await appendClaimRegressions(records);
	}
}
