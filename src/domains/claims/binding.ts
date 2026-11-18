import { clioStateDir } from "../../core/xdg.js";
import type { SettledRunRecord } from "../telemetry/run-record.js";
import { readVerifiedRun } from "../telemetry/run-record.js";
import type { ClaimRecord } from "./types.js";

/**
 * How a claim stands against the sealed run it cites (D3-4). A claim line is accepted on its own hash, which anyone
 * who can write the log can recompute, so a host-verification claim is read against its run's seal before it is
 * shown or used as grounded:
 * - `verified`: the run's seal verifies, its run.settled digest is the cited one, and its sealed result holds the
 *   claimed check, executed in that run, with the claim's kind, verdict, payload and reference digests;
 * - `unverified`: the claim cites a run that has no verifying seal, a different settlement, or no such check;
 * - `unbound`: nothing sealed can confirm or refute it, as for a main-thread `verify` claim, which has no run, or a
 *   run sealed before its checks' verdicts were kept.
 */
export type ClaimSealBinding =
	| { state: "verified"; runId: string }
	| { state: "unverified"; reason: string }
	| { state: "unbound"; reason: string };

type SealedCheck = NonNullable<
	Extract<NonNullable<SettledRunRecord["result"]>, { state: "resolved" }>["value"]["hostVerification"]
>["checks"][number];

function short(digest: string): string {
	return digest.slice(0, 12);
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Whether one sealed check is the execution the claim reports. Null when it is; else what differs. */
function checkMismatch(claim: ClaimRecord, sealed: SealedCheck): string | null {
	if (sealed.memo || sealed.evidenceRunId !== null || sealed.notRun !== undefined)
		return "the run sealed it as reused or not run";
	const agrees = claim.verdict === "agrees";
	if ((sealed.exitCode === 0) !== agrees) return "the run sealed the opposite verdict";
	const report = sealed.report;
	if (report === undefined) return null;
	if (report.kind !== claim.kind) return `the run sealed a ${report.kind} check`;
	if (report.passed !== agrees) return "the run sealed the opposite verdict";
	const conditions = claim.conditions;
	if ((conditions.reference?.sha256 ?? null) !== (report.reference?.sha256 ?? null))
		return "the run sealed another reference";
	if (conditions.kind === "numeric-compare") {
		if ((conditions.actual?.sha256 ?? null) !== report.payloadSha256) return "the run sealed another payload";
		if (!sameStrings(claim.keys.command, sealed.argv)) return "the run sealed another command";
		if (
			conditions.treeFingerprint !== undefined &&
			sealed.tree !== undefined &&
			conditions.treeFingerprint !== sealed.tree.fingerprint
		)
			return "the run sealed another working tree";
	} else if (report.payloadSha256 !== null && conditions.payloads[0] !== report.payloadSha256)
		return "the run sealed another payload";
	return null;
}

/**
 * A reader of claims' seal bindings over one state directory. Each cited run's seal is verified once per reader, so a
 * listing of many claims from one run reads its journal once.
 */
export function claimSealReader(stateDir: string = clioStateDir()): (claim: ClaimRecord) => ClaimSealBinding {
	const runs = new Map<string, SettledRunRecord | null>();
	const verifiedRun = (runId: string): SettledRunRecord | null => {
		if (!runs.has(runId)) {
			let run: SettledRunRecord | null;
			try {
				run = readVerifiedRun(stateDir, runId);
			} catch {
				// A run id that is not a safe id names no run directory.
				run = null;
			}
			runs.set(runId, run);
		}
		return runs.get(runId) ?? null;
	};
	return (claim) => {
		const source = claim.source;
		if (source.channel !== "host-verification")
			return { state: "unbound", reason: "a main-thread verify call seals no run to check it against" };
		const run = verifiedRun(source.runId);
		if (run === null) return { state: "unverified", reason: `run ${source.runId} has no seal that verifies` };
		if (run.settled.digest !== source.receiptDigest)
			return {
				state: "unverified",
				reason: `run ${source.runId} settled as ${short(run.settled.digest)}, not the cited ${short(source.receiptDigest)}`,
			};
		const checks =
			run.result?.state === "resolved"
				? (run.result.value.hostVerification?.checks ?? []).filter((sealed) => sealed.check === claim.keys.check)
				: [];
		if (checks.length === 0)
			return { state: "unverified", reason: `run ${source.runId} sealed no check '${claim.keys.check}'` };
		const mismatches = checks.map((sealed) => checkMismatch(claim, sealed));
		const matched = checks.find((_sealed, index) => mismatches[index] === null);
		if (matched === undefined)
			return { state: "unverified", reason: `${mismatches.find((reason) => reason !== null)} for '${claim.keys.check}'` };
		if (matched.report === undefined)
			return { state: "unbound", reason: `run ${source.runId} sealed '${claim.keys.check}' without its verdict` };
		return { state: "verified", runId: source.runId };
	};
}
