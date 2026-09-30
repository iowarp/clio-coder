/**
 * `clio-coder fleet cancel <runId>`: operator-side cancellation of one run from
 * any terminal.
 *
 * A live run's abort handle lives in the process that dispatched it. When that
 * owner is alive this command leaves a cancel request that the owner's
 * reconciler tick turns into its own abort, so the run seals `canceled` with a
 * full receipt, and then waits for the ledger row to settle. When the owner is
 * gone the worker is an orphan nobody will finalize, so this command stops the
 * worker's process group itself and settles the row.
 */

import { hostname } from "node:os";
import { processAlive, processStartedAtMs } from "../core/process-identity.js";
import {
	assignmentProcessOwnerAlive,
	cancelStoredAssignment,
	type DurableAssignmentRecord,
	listStoredAssignments,
} from "../domains/dispatch/assignment-store.js";
import {
	cancelDetail,
	clearRunCancelRequest,
	isCancelableRunId,
	writeRunCancelRequest,
} from "../domains/dispatch/cancel-requests.js";
import { isOpenRunRow, sealRowFromVerifiedReceipt } from "../domains/dispatch/orphan-recovery.js";
import { runStatusForOutcome } from "../domains/dispatch/outcome.js";
import { type Ledger, openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { ensureClioState } from "../domains/lifecycle/index.js";

const USAGE = "usage: clio-coder fleet cancel <runId> [--json] [--reason <text>]";
/** Owner ticks run about once a second; this covers a slow finalizer and receipt write. */
const OWNER_SETTLE_WAIT_MS = 15_000;
const POLL_MS = 250;
/** Matches a cooperative worker's SIGTERM flush before escalation. */
const ORPHAN_TERM_GRACE_MS = 3_000;
/** processStartedAtMs resolves to about a second; see its doc comment. */
const START_TIME_TOLERANCE_MS = 1_500;

type OwnerState = "alive" | "gone" | "unknown";

interface CancelReport {
	runId: string;
	owner: OwnerState;
	ownerPid: number | null;
	action: "requested" | "terminated_orphan" | "sealed_orphan";
	state: "sealed" | "pending";
	outcome: string | null;
	outcomeDetail: string | null;
	note?: string;
}

interface ParsedArgs {
	runId: string;
	json: boolean;
	reason: string | null;
}

function parseArgs(args: ReadonlyArray<string>): ParsedArgs | string {
	let runId: string | undefined;
	let json = false;
	let reason: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--json") json = true;
		else if (arg === "--reason") {
			const value = args[index + 1];
			if (value === undefined || value.trim().length === 0) return "--reason needs a value";
			reason = value;
			index += 1;
		} else if (arg?.startsWith("--reason=")) reason = arg.slice("--reason=".length);
		else if (arg?.startsWith("-")) return `unknown flag: ${arg}`;
		else if (runId === undefined && arg !== undefined) runId = arg;
		else return `unexpected argument: ${arg}`;
	}
	if (runId === undefined) return "missing <runId>";
	return { runId, json, reason };
}

function refuse(message: string): number {
	process.stderr.write(`clio-coder fleet cancel: ${message}\n`);
	return 1;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assignmentFor(row: RunEnvelope): DurableAssignmentRecord | null {
	const rootRunId = row.lineage?.rootRunId ?? row.id;
	const records = listStoredAssignments();
	return (
		records.find((record) => record.assignmentId === rootRunId && record.status === "running") ??
		records.find((record) => record.attempts.includes(row.id) && record.status === "running") ??
		null
	);
}

function ownerState(record: DurableAssignmentRecord | null): OwnerState {
	if (record?.processOwner === undefined) return "unknown";
	return assignmentProcessOwnerAlive(record) ? "alive" : "gone";
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		// Workers lead their own process group (worker-spawn.ts), so the group
		// signal also reaches whatever the runtime spawned beneath them.
		process.kill(-pid, signal);
		return;
	} catch {
		// No such group; fall back to the process itself.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// Already exited between the probe and the signal.
	}
}

async function waitForExit(pid: number, graceMs: number): Promise<boolean> {
	const deadline = performance.now() + graceMs;
	while (performance.now() < deadline) {
		if (!processAlive(pid)) return true;
		await sleep(100);
	}
	return !processAlive(pid);
}

/**
 * Whether the live process at `row.pid` is still this run's worker. The ledger
 * keeps no birth token for the worker, but a pid reused after the worker died
 * started after the worker's last heartbeat, while the worker itself started
 * before it.
 */
function workerIdentity(pid: number, row: RunEnvelope): "same" | "recycled" | "unverifiable" {
	const startedAt = processStartedAtMs(pid);
	const lastSeen = row.heartbeatAt === null ? Number.NaN : Date.parse(row.heartbeatAt);
	if (startedAt === null || !Number.isFinite(lastSeen)) return "unverifiable";
	return startedAt <= lastSeen + START_TIME_TOLERANCE_MS ? "same" : "recycled";
}

async function waitForOwnerSeal(ledger: Ledger, runId: string): Promise<RunEnvelope | null> {
	const deadline = performance.now() + OWNER_SETTLE_WAIT_MS;
	while (performance.now() < deadline) {
		await sleep(POLL_MS);
		ledger.reload();
		const row = ledger.get(runId);
		if (row !== null && !isOpenRunRow(row)) return row;
	}
	return null;
}

async function cancelOrphan(
	ledger: Ledger,
	row: RunEnvelope,
	record: DurableAssignmentRecord | null,
	reason: string | null,
): Promise<CancelReport | string> {
	let action: CancelReport["action"] = "sealed_orphan";
	if (row.pid !== null && processAlive(row.pid)) {
		const identity = workerIdentity(row.pid, row);
		if (identity === "unverifiable") {
			return `worker pid ${row.pid} is alive but cannot be confirmed as this run's worker on this platform; stop it manually after checking it`;
		}
		if (identity === "same") {
			signalGroup(row.pid, "SIGTERM");
			if (!(await waitForExit(row.pid, ORPHAN_TERM_GRACE_MS))) {
				signalGroup(row.pid, "SIGKILL");
				await waitForExit(row.pid, 1_000);
			}
			action = "terminated_orphan";
		}
	}
	// The dead owner may have written the receipt before it went down; that
	// sealed record is the truth and outranks an operator cancel.
	if (!sealRowFromVerifiedReceipt(ledger, row.id)) {
		ledger.update(row.id, {
			status: runStatusForOutcome("canceled"),
			outcome: "canceled",
			outcomeDetail: cancelDetail("operator cancel (owner process gone)", reason),
			endedAt: new Date().toISOString(),
			exitCode: row.exitCode ?? 1,
		});
	}
	await ledger.persist();
	if (record !== null) await cancelStoredAssignment(record.assignmentId);
	const sealed = ledger.get(row.id);
	return {
		runId: row.id,
		owner: "gone",
		ownerPid: record?.processOwner?.pid ?? null,
		action,
		state: "sealed",
		outcome: sealed?.outcome ?? null,
		outcomeDetail: sealed?.outcomeDetail ?? null,
		note: "no receipt is minted for an orphan the owner never finalized; the ledger row carries the outcome",
	};
}

function render(report: CancelReport, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	if (report.state === "pending") {
		process.stdout.write(
			`cancel requested for run ${report.runId}; owner pid ${report.ownerPid ?? "unknown"} has not sealed it yet. The request stays pending and is applied on the owner's next reconciler tick.\n`,
		);
		return;
	}
	process.stdout.write(
		`run ${report.runId} sealed ${report.outcome ?? "unknown"}${report.outcomeDetail ? `: ${report.outcomeDetail}` : ""}\n`,
	);
	if (report.action === "terminated_orphan") {
		process.stdout.write("owner process was gone; the orphaned worker was terminated\n");
	}
}

export async function runFleetCancel(args: ReadonlyArray<string>): Promise<number> {
	const parsed = parseArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`clio-coder fleet cancel: ${parsed}\n${USAGE}\n`);
		return 2;
	}
	const { runId, json, reason } = parsed;
	if (!isCancelableRunId(runId)) return refuse(`invalid run id '${runId}'`);
	ensureClioState();
	const ledger = openLedger();
	const row = ledger.get(runId);
	if (row === null) return refuse(`unknown run '${runId}'`);
	if (!isOpenRunRow(row)) {
		return refuse(`run ${runId} is already terminal (${row.outcome ?? row.status})`);
	}
	// Pids and birth tokens only mean something on the host that recorded them.
	if (row.identity !== undefined && row.identity.host !== hostname()) {
		return refuse(`run ${runId} belongs to host ${row.identity.host}; run fleet cancel there`);
	}
	const record = assignmentFor(row);
	const owner = ownerState(record);
	if (owner === "gone") {
		try {
			const result = await cancelOrphan(ledger, row, record, reason);
			if (typeof result === "string") return refuse(result);
			render(result, json);
			return 0;
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error));
		}
	}
	// An unknown owner may still be alive, so it gets a request and never a kill.
	writeRunCancelRequest(runId, reason);
	const sealed = await waitForOwnerSeal(ledger, runId);
	const report: CancelReport = {
		runId,
		owner,
		ownerPid: record?.processOwner?.pid ?? null,
		action: "requested",
		state: sealed === null ? "pending" : "sealed",
		outcome: sealed?.outcome ?? null,
		outcomeDetail: sealed?.outcomeDetail ?? null,
		...(owner === "unknown"
			? {
					note: "no live assignment owner is recorded for this run; only a process still holding it can apply the request",
				}
			: {}),
	};
	if (sealed !== null) clearRunCancelRequest(runId);
	render(report, json);
	return sealed === null ? 1 : 0;
}
