/**
 * Re-authenticate one run's sealed run scope, right now (#434).
 *
 * This command reads the run's journal and objects off disk and verifies its seal again, which is the only way to
 * learn that a run trusted an hour ago no longer verifies.
 *
 * Like `evidence inspect --json` it takes an identifier, because an operator names the run. The identifier is
 * validated for shape here; a GUI host that echoes operator-supplied ids owes its own served-id window on top of that,
 * because shape alone does not prove the id was ever served.
 */

import { clioStateDir } from "../core/xdg.js";
import { openLedger } from "../domains/dispatch/state.js";
import { inspectRunTrustStatus, TRUST_STATUS_AXES, type TrustStatusAxis } from "../domains/evidence/index.js";
import { loadRunRecord } from "../domains/session/telemetry-source.js";

/** A run's trust as of this check: still pending, verified, failed, or unavailable. */
export type FleetVerifyState = "pending" | "verified" | "failed" | "unavailable";

/** Why a run did not authenticate, as a closed set: the part of its sealed scope that did not verify, or why none did. */
export const FLEET_VERIFY_REASONS = [
	"manifest-mismatch",
	"segment-mismatch",
	"object-mismatch",
	"chain-mismatch",
	"seal-mismatch",
	"unsealed",
	"run-unreadable",
] as const;
export type FleetVerifyReason = (typeof FLEET_VERIFY_REASONS)[number];

export interface FleetVerifySnapshot {
	readonly version: 1;
	readonly verifiedAt: string;
	readonly runId: string;
	readonly state: FleetVerifyState;
	/** Null whenever the run authenticated or has not settled yet. */
	readonly reason: FleetVerifyReason | null;
	readonly axes: Readonly<Record<TrustStatusAxis, string>>;
}

export class FleetVerifyUnknownRunError extends Error {
	override readonly name = "FleetVerifyUnknownRunError";
}

function fleetVerifySnapshot(runId: string, now: () => number = Date.now): FleetVerifySnapshot {
	const envelope = openLedger().get(runId);
	if (envelope === null) throw new FleetVerifyUnknownRunError(`unknown run '${runId}'`);
	const verifiedAt = new Date(now()).toISOString();
	const record = loadRunRecord(clioStateDir(), envelope.id);
	const inspection = inspectRunTrustStatus(record);
	const axes = Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, inspection.status[axis].state])) as Record<
		TrustStatusAxis,
		string
	>;
	const snapshot = (state: FleetVerifyState, reason: FleetVerifyReason | null): FleetVerifySnapshot => ({
		version: 1,
		verifiedAt,
		runId: envelope.id,
		state,
		reason,
		axes,
	});
	// A run that has not settled has nothing to authenticate yet, which is a different answer from one that failed to.
	if (record?.settled == null)
		return envelope.endedAt === null ? snapshot("pending", null) : snapshot("unavailable", "run-unreadable");
	const seal = record.seal;
	if (seal === null) return snapshot("unavailable", "run-unreadable");
	if (seal.status === "verified") return snapshot("verified", null);
	if (seal.status === "unsealed") return snapshot("unavailable", "unsealed");
	return snapshot("failed", `${seal.mismatch.kind}-mismatch`);
}

export function runFleetVerify(args: ReadonlyArray<string>): number {
	const runId = args[0];
	if (args.length !== 2 || runId === undefined || runId.startsWith("-") || args[1] !== "--json") {
		process.stderr.write("clio-coder fleet verify: usage: clio-coder fleet verify <runId> --json\n");
		return 2;
	}
	try {
		process.stdout.write(`${JSON.stringify(fleetVerifySnapshot(runId), null, 2)}\n`);
		return 0;
	} catch (error) {
		if (!(error instanceof FleetVerifyUnknownRunError)) throw error;
		process.stderr.write(`clio-coder fleet verify: ${error.message}\n`);
		return 1;
	}
}
