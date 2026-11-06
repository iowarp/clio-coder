import { ToolNames } from "../../core/tool-names.js";
import { clioDataDir } from "../../core/xdg.js";
import { recordClaimRegressions } from "../memory/index.js";
import type { MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimFromVerifyResult, claimsFromHostVerification, type SealedHostCheck } from "./capture.js";
import { claimBackingRefs, claimRegressionNote, overturnedAgreements, regressionRecord } from "./edges.js";
import { appendClaimRegressions, appendClaims, claimsProjectRoot, readClaims } from "./store.js";
import type { ClaimEdgeRecord, ClaimRecord } from "./types.js";

export const CLAIM_CAPTURE_REGISTRATION_ID = "observer.claims-capture";

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
			const claim = claimFromVerifyResult({
				details: input.toolResultDetails,
				project: claimsProjectRoot(options.cwd()),
				at: now().toISOString(),
				source: {
					channel: "verify",
					sessionId: input.sessionId ?? null,
					toolCallId: input.toolCallId ?? null,
					requestedBy: input.metadata?.origin === "harness" ? "harness" : "model",
				},
			});
			if (claim !== null) await recordClaims([claim], now());
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
	const claims = claimsFromHostVerification({
		runId: input.runId,
		receiptDigest: input.receiptDigest,
		checks: input.checks,
		project: claimsProjectRoot(input.projectCwd),
		at: (input.now ?? new Date()).toISOString(),
	});
	if (claims.length > 0) await recordClaims(claims, input.now ?? new Date());
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
