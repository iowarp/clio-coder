/**
 * Re-authenticate one run's sealed receipt, right now.
 *
 * `fleet inspect --json` already reports receipt trust, but it reports it as of
 * the moment the snapshot was taken. This command reads the receipt and its
 * ledger envelope off disk and runs the integrity check again, which is the
 * only way to learn that a receipt trusted an hour ago no longer verifies.
 * That is the whole difference, and it is why this exists beside the snapshot
 * rather than inside it.
 *
 * Like `evidence inspect --json` it takes an identifier, because an operator
 * names the run. A GUI host may only pass back a run id it served inside its
 * current bounded window; see `apps/workbench/artifact-allowlist.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../core/xdg.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { inspectRunReceiptTrustStatus, TRUST_STATUS_AXES, type TrustStatusAxis } from "../domains/evidence/index.js";

/** Same vocabulary `fleet inspect --json` reports, so the two are comparable. */
export type FleetVerifyState = "pending" | "verified" | "failed" | "unavailable";

/**
 * Why a receipt did not authenticate, as a closed set.
 *
 * The harness composes most of these from literals, but one branch interpolates
 * a thrown error's message, which can carry anything including a path. So the
 * reason is classified rather than quoted, and anything unrecognised becomes
 * `unclassified` instead of arriving as prose.
 */
export const FLEET_VERIFY_REASONS = [
	"integrity-mismatch",
	"ledger-mismatch",
	"integrity-invalid",
	"execution-role-invalid",
	"routing-intent-invalid",
	"route-decision-invalid",
	"receipt-unreadable",
	"envelope-unavailable",
	"unclassified",
] as const;
export type FleetVerifyReason = (typeof FLEET_VERIFY_REASONS)[number];

export interface FleetVerifySnapshot {
	readonly version: 1;
	readonly verifiedAt: string;
	readonly runId: string;
	readonly state: FleetVerifyState;
	/** Null whenever the receipt authenticated or has not been sealed yet. */
	readonly reason: FleetVerifyReason | null;
	readonly axes: Readonly<Record<TrustStatusAxis, string>>;
}

export class FleetVerifyUnknownRunError extends Error {
	override readonly name = "FleetVerifyUnknownRunError";
}

function classify(reason: string): FleetVerifyReason {
	if (reason.startsWith("integrity mismatch")) return "integrity-mismatch";
	// The harness names the diverging field after this prefix. Which field it was
	// is a detail of the receipt, so the classification keeps the fact and drops
	// the name rather than passing a fragment of the record through.
	if (reason.startsWith("ledger mismatch")) return "ledger-mismatch";
	if (reason.startsWith("integrity invalid")) return "integrity-invalid";
	if (reason.startsWith("execution role invalid")) return "execution-role-invalid";
	if (reason.startsWith("routing intent invalid")) return "routing-intent-invalid";
	if (reason.startsWith("route decision invalid")) return "route-decision-invalid";
	if (reason.startsWith("receipt unavailable")) return "receipt-unreadable";
	if (reason.startsWith("run ledger envelope unavailable")) return "envelope-unavailable";
	return "unclassified";
}

function loadReceipt(envelope: RunEnvelope): RunReceipt | null {
	const path = envelope.receiptPath ?? join(clioStateDir(), "receipts", `${envelope.id}.json`);
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
	} catch {
		return null;
	}
}

/** Pure payload builder, exported so the fixed contract is testable without subprocess capture. */
function fleetVerifySnapshot(runId: string, now: () => number = Date.now): FleetVerifySnapshot {
	const envelope = openLedger().get(runId);
	if (envelope === null) throw new FleetVerifyUnknownRunError(`unknown run '${runId}'`);
	const verifiedAt = new Date(now()).toISOString();
	const receipt = loadReceipt(envelope);
	const inspection = inspectRunReceiptTrustStatus(receipt, envelope);
	const axes = Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, inspection.status[axis].state])) as Record<
		TrustStatusAxis,
		string
	>;

	// A run that has not finalized has nothing to authenticate yet, which is a
	// different answer from one whose receipt failed to authenticate.
	if (receipt === null && envelope.receiptPath === null && envelope.endedAt === null) {
		return { version: 1, verifiedAt, runId: envelope.id, state: "pending", reason: null, axes };
	}
	if (inspection.integrity.ok) {
		return { version: 1, verifiedAt, runId: envelope.id, state: "verified", reason: null, axes };
	}
	const reason = classify(inspection.integrity.reason);
	return {
		version: 1,
		verifiedAt,
		runId: envelope.id,
		// A receipt that could not be read at all is a missing artifact; one that
		// was read and did not authenticate is a failure, and the two must not be
		// reported as the same thing.
		state: reason === "receipt-unreadable" || reason === "envelope-unavailable" ? "unavailable" : "failed",
		reason,
		axes,
	};
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
