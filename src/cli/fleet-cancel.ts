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
 *
 * Exit codes (C19): 0 when the cancel applied or the run or root had already sealed, 75 while the cancel is accepted
 * but the target is still settling, 1 when the cancel failed or its target was not found, 2 usage. The report's
 * `state` says the same: `sealed` exits 0, `pending` exits 75; a failure prints the C6 error document instead.
 */

import { hostname } from "node:os";
import { processAlive, processStartedAtMs } from "../core/process-identity.js";
import {
	assignmentProcessOwnerAlive,
	type DurableAssignmentRecord,
	listStoredAssignments,
	settleStoredAssignment,
} from "../domains/dispatch/assignment-store.js";
import {
	cancelDetail,
	clearRunCancelRequest,
	isCancelableRunId,
	writeRootCancelRequest,
	writeRunCancelRequest,
} from "../domains/dispatch/cancel-requests.js";
import {
	FLEET_ROOT_PREFIX,
	fleetRootState,
	matchFleetRootIds,
	readFleetResult,
	readFleetRootRecord,
} from "../domains/dispatch/fleet-root-record.js";
import { isOpenRunRow, sealRowFromSettledRun } from "../domains/dispatch/orphan-recovery.js";
import { runStatusForOutcome } from "../domains/dispatch/outcome.js";
import { type Ledger, openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

const USAGE = "usage: clio-coder fleet cancel <runId|fleetRootId> [--json] [--reason <text>]";
const CANCEL_PATH = ["fleet", "cancel"] as const;
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
	action: "requested" | "terminated_orphan" | "sealed_orphan" | "already_sealed";
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

/** A cancel that cannot produce its report: the C3 line, and under --json the C6 failure document. Exits 1. */
function refuse(message: string, json: boolean, slug: ErrorSlug = "admission_refused"): number {
	writeCliFailure({ path: CANCEL_PATH, slug, message, json });
	return EXIT_CODES.failed;
}

/** A report's exit agrees with its `state`: a sealed target exits 0, one still settling exits 75. */
function exitForState(state: "sealed" | "pending"): number {
	return state === "sealed" ? EXIT_CODES.success : EXIT_CODES.notReady;
}

interface FleetCancelOptions {
	/** How long to wait for the owner to seal after the request; tests pass 0 to observe the pending report. */
	settleWaitMs?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The running assignment that owns this row. A hosted worker's published lineage root names the main run, which keys
 * no assignment, and `attempts` holds only finalized attempts. So a live first attempt is found by its own id, which
 * is its assignment id, and a live retry by the earlier attempt it continues.
 */
function assignmentFor(row: RunEnvelope): DurableAssignmentRecord | null {
	const rootRunId = row.lineage?.rootRunId ?? row.id;
	const retriedFrom = row.lineage !== undefined && row.lineage.attempt > 0 ? row.lineage.parentRunId : null;
	const records = listStoredAssignments().filter((record) => record.status === "running");
	return (
		records.find((record) => record.assignmentId === rootRunId) ??
		records.find((record) => record.assignmentId === row.id) ??
		records.find(
			(record) => record.attempts.includes(row.id) || (retriedFrom !== null && record.attempts.includes(retriedFrom)),
		) ??
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

async function waitForOwnerSeal(ledger: Ledger, runId: string, waitMs: number): Promise<RunEnvelope | null> {
	const deadline = performance.now() + waitMs;
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
	// The dead owner may have settled the run before it went down; that
	// record is the truth and outranks an operator cancel.
	if (!sealRowFromSettledRun(ledger, row.id)) {
		ledger.update(row.id, {
			status: runStatusForOutcome("canceled"),
			outcome: "canceled",
			outcomeDetail: cancelDetail("operator cancel (owner process gone)", reason),
			endedAt: new Date().toISOString(),
			exitCode: row.exitCode ?? 1,
		});
	}
	await ledger.persist();
	if (record !== null) await settleStoredAssignment(record.assignmentId, row.id, "canceled");
	const sealed = ledger.get(row.id);
	return {
		runId: row.id,
		owner: "gone",
		ownerPid: record?.processOwner?.pid ?? null,
		action,
		state: "sealed",
		outcome: sealed?.outcome ?? null,
		outcomeDetail: sealed?.outcomeDetail ?? null,
		note: "no run result is settled for an orphan the owner never finalized; the ledger row carries the outcome",
	};
}

function render(report: CancelReport, json: boolean): void {
	if (json) {
		writeJson(process.stdout, jsonDocument(report));
		return;
	}
	if (report.state === "pending") {
		process.stdout.write(
			`cancel requested for run ${report.runId}; owner pid ${report.ownerPid ?? "unknown"} has not sealed it yet. The request stays pending and is applied on the owner's next reconciler tick.\n`,
		);
		return;
	}
	process.stdout.write(
		`run ${report.runId} ${report.action === "already_sealed" ? "had already sealed" : "sealed"} ${report.outcome ?? "unknown"}${report.outcomeDetail ? `: ${report.outcomeDetail}` : ""}\n`,
	);
	if (report.action === "terminated_orphan") {
		process.stdout.write("owner process was gone; the orphaned worker was terminated\n");
	}
}

export async function runFleetCancel(args: ReadonlyArray<string>, options: FleetCancelOptions = {}): Promise<number> {
	const settleWaitMs = options.settleWaitMs ?? OWNER_SETTLE_WAIT_MS;
	const parsed = parseArgs(args);
	if (typeof parsed === "string") {
		const json = args.includes("--json");
		writeCliFailure({
			path: CANCEL_PATH,
			slug: parsed.startsWith("unknown flag") ? "unknown_flag" : "usage",
			message: parsed,
			json,
		});
		if (!json) process.stderr.write(`${USAGE}\n`);
		return EXIT_CODES.notStarted;
	}
	const { runId, json, reason } = parsed;
	// Ids starting `fleet-` name fleet roots; everything else names a run.
	if (runId.startsWith(FLEET_ROOT_PREFIX)) return cancelRoot(runId, json, reason, settleWaitMs);
	if (!isCancelableRunId(runId)) {
		// A malformed id is a usage error like any other bad argument: nothing was looked up or requested.
		writeCliFailure({ path: CANCEL_PATH, slug: "usage", message: `invalid run id '${runId}'`, json });
		return EXIT_CODES.notStarted;
	}
	ensureClioState();
	const ledger = openLedger();
	const row = ledger.get(runId);
	// A token short of `fleet-` can name a run and also prefix fleet roots: neither is chosen for the caller.
	if (row !== null && FLEET_ROOT_PREFIX.startsWith(runId) && matchFleetRootIds(runId).length > 0) {
		writeCliFailure({
			path: CANCEL_PATH,
			slug: "ambiguous",
			message: `'${runId}' names a run and prefixes fleet roots; give the full id`,
			json,
		});
		return 1;
	}
	if (row === null) return refuse(`unknown run '${runId}'`, json, "not_found");
	// Idempotent, as a sealed root is: the run is already where a cancel would take it, so nothing is requested.
	if (!isOpenRunRow(row)) {
		render(
			{
				runId,
				owner: "unknown",
				ownerPid: null,
				action: "already_sealed",
				state: "sealed",
				outcome: row.outcome ?? row.status,
				outcomeDetail: row.outcomeDetail ?? null,
			},
			json,
		);
		return EXIT_CODES.success;
	}
	// Pids and birth tokens only mean something on the host that recorded them.
	if (row.identity !== undefined && row.identity.host !== hostname()) {
		return refuse(`run ${runId} belongs to host ${row.identity.host}; run fleet cancel there`, json);
	}
	const record = assignmentFor(row);
	const owner = ownerState(record);
	if (owner === "gone") {
		try {
			const result = await cancelOrphan(ledger, row, record, reason);
			if (typeof result === "string") return refuse(result, json);
			render(result, json);
			return exitForState(result.state);
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error), json, "io");
		}
	}
	// An unknown owner may still be alive, so it gets a request and never a kill.
	writeRunCancelRequest(runId, reason);
	const sealed = await waitForOwnerSeal(ledger, runId, settleWaitMs);
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
	return exitForState(report.state);
}

interface RootCancelReport {
	rootId: string;
	action: "requested" | "already_sealed";
	state: "sealed" | "pending";
	ownerPid: number | null;
	/** From the persisted fleet result: `completion.state`, its stop reason, and the exit code the root returned. */
	outcome: string | null;
	stopReason: string | null;
	exitCode: number | null;
}

function rootReport(
	rootId: string,
	action: RootCancelReport["action"],
	ownerPid: number | null,
	result: Record<string, unknown> | null,
): RootCancelReport {
	const completion = result?.completion as { state?: unknown; stopReason?: unknown } | undefined;
	return {
		rootId,
		action,
		state: result === null ? "pending" : "sealed",
		ownerPid,
		outcome: typeof completion?.state === "string" ? completion.state : null,
		stopReason: typeof completion?.stopReason === "string" ? completion.stopReason : null,
		exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
	};
}

function renderRoot(report: RootCancelReport, json: boolean): void {
	if (json) {
		writeJson(process.stdout, jsonDocument(report));
		return;
	}
	if (report.state === "pending") {
		process.stdout.write(
			`cancel requested for fleet root ${report.rootId}; owner pid ${report.ownerPid ?? "unknown"} has not sealed it yet. No further step starts; the request stays until the root seals.\n`,
		);
		return;
	}
	process.stdout.write(
		`fleet root ${report.rootId} ${report.action === "already_sealed" ? "had already sealed" : "sealed"} ${report.outcome ?? "unknown"}${report.stopReason !== null ? ` (${report.stopReason})` : ""} exit=${report.exitCode ?? "unknown"}\n`,
	);
}

/**
 * Cancel a fleet root: a durable request its owner checks before every step admission and between waves, and fans out
 * to the steps it is running. Idempotent: a root that already sealed exits 0 with its recorded outcome.
 */
async function cancelRoot(token: string, json: boolean, reason: string | null, settleWaitMs: number): Promise<number> {
	ensureClioState();
	const matches = matchFleetRootIds(token);
	if (matches.length > 1) {
		writeCliFailure({
			path: CANCEL_PATH,
			slug: "ambiguous",
			message: `'${token}' matches ${matches.length} fleet roots: ${matches.slice(0, 5).join(", ")}`,
			json,
		});
		return 1;
	}
	const rootId = matches[0];
	if (rootId === undefined) {
		writeCliFailure({ path: CANCEL_PATH, slug: "not_found", message: `no fleet root matches '${token}'`, json });
		return 1;
	}
	const prior = readFleetResult(rootId);
	const record = readFleetRootRecord(rootId);
	if (prior !== null) {
		renderRoot(rootReport(rootId, "already_sealed", record?.pid ?? null, prior), json);
		return EXIT_CODES.success;
	}
	if (record === null) {
		writeCliFailure({
			path: CANCEL_PATH,
			slug: "not_found",
			message: `fleet root ${rootId} has no root record to cancel; it was started by an earlier release`,
			json,
		});
		return 1;
	}
	if (record.host !== hostname()) {
		return refuse(`fleet root ${rootId} belongs to host ${record.host}; run fleet cancel there`, json);
	}
	if (fleetRootState(record, false) === "orphaned") {
		return refuse(
			`fleet root ${rootId}'s owner (pid ${record.pid}) is gone and the root never sealed (owner_gone); cancel its runs by run id`,
			json,
		);
	}
	writeRootCancelRequest(rootId, reason);
	const deadline = Date.now() + settleWaitMs;
	let result: Record<string, unknown> | null = null;
	for (;;) {
		result = readFleetResult(rootId);
		if (result !== null || Date.now() >= deadline) break;
		const current = readFleetRootRecord(rootId);
		if (current !== null && fleetRootState(current, false) === "orphaned") {
			// The owner died after the request and before sealing: nothing will apply it, so the cancel failed.
			return refuse(
				`fleet root ${rootId}'s owner (pid ${record.pid}) exited before it sealed (owner_gone); cancel its runs by run id`,
				json,
			);
		}
		await sleep(POLL_MS);
	}
	const report = rootReport(rootId, "requested", record.pid, result);
	renderRoot(report, json);
	return exitForState(report.state);
}
