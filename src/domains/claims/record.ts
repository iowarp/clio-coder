import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { claimFromVerifyResult, claimsFromHostVerification, type SealedHostCheck } from "./capture.js";
import { appendClaims, claimsProjectRoot } from "./store.js";

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
			if (claim !== null) await appendClaims([claim]);
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
	if (claims.length > 0) await appendClaims(claims);
	return claims.length;
}
