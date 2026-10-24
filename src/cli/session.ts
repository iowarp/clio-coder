/**
 * `clio-coder session list|terminate`: see and end open sessions on a shared
 * state dir from any node (#439).
 *
 * Every open session keeps `live/<id>.json` fresh (domains/session/heartbeat.ts).
 * A terminate request is a file the owner reads on its next beat; a signal is
 * sent only to a process on this host whose birth token still matches, because
 * a pid means nothing on another node. `--force` releases a session whose
 * owner cannot answer: a stale heartbeat, or a pid provably gone on this host.
 * The release fences the old owner first, so a stopped process that wakes
 * later shuts down without writing the ledger, and then frees only records
 * whose owner is exactly the dead {host, pid, birth}.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processAlive, processBirthToken } from "../core/process-identity.js";
import { assertSafeId } from "../core/safe-id.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { releaseStateLocksOwnedBy, type StateLockOwner } from "../core/state-file-lock.js";
import { clioStateDir } from "../core/xdg.js";
import { releaseCapacityLeasesOwnedBy } from "../domains/dispatch/capacity-lease.js";
import {
	currentRequester,
	formatAge,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_SKEW_MS,
	HEARTBEAT_STALE_MS,
	type LiveSessionView,
	listLiveSessions,
	liveRecordNames,
	liveRecordPath,
	liveSessionsDir,
	liveSessionView,
	printable,
	type ReleasedFence,
	releasedFencePath,
	stateDirClockOffsetMs,
	type TerminateRequest,
	terminateRequestPath,
} from "../domains/session/heartbeat.js";
import { endAbandonedSession } from "../domains/session/history.js";
import { type ClioSessionMeta, cwdHash } from "../engine/session.js";

const USAGE = `usage: clio-coder session list [--json] [--stale]
       clio-coder session terminate <id> [--force] [--reason <text>] [--json]
`;
/** A same-host SIGTERM normally ends the owner well inside this; past it the request still stands. */
const SIGNAL_SETTLE_WAIT_MS = 5_000;

export async function runSessionCommand(args: ReadonlyArray<string>): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === "list") return runList(rest);
	if (sub === "terminate") return runTerminate(rest);
	if (sub === undefined || sub === "--help" || sub === "-h") {
		process.stdout.write(USAGE);
		return sub === undefined ? 2 : 0;
	}
	process.stderr.write(`clio-coder session: unknown subcommand '${sub}'\n${USAGE}`);
	return 2;
}

function stateOf(view: LiveSessionView): string {
	const state = view.terminateRequested ? "terminating" : view.stale ? `stale ${formatAge(view.ageMs)}` : "live";
	return view.skewMs > HEARTBEAT_SKEW_MS ? `${state} skew ${formatAge(view.skewMs)}` : state;
}

function runList(args: ReadonlyArray<string>): number {
	let json = false;
	let staleOnly = false;
	for (const arg of args) {
		if (arg === "--json") json = true;
		else if (arg === "--stale") staleOnly = true;
		else {
			process.stderr.write(`clio-coder session list: unexpected argument: ${arg}\n${USAGE}`);
			return 2;
		}
	}
	const listed = listLiveSessions();
	const clockOffsetMs = listed.sessions.some((view) => view.record.host !== hostname()) ? stateDirClockOffsetMs() : 0;
	const clockSkewed = clockOffsetMs !== null && Math.abs(clockOffsetMs) > HEARTBEAT_SKEW_MS;
	const views = listed.sessions.filter((view) => !staleOnly || view.stale);
	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					stateDir: clioStateDir(),
					staleAfterMs: HEARTBEAT_STALE_MS,
					sessions: views.map((view) => ({
						...view.record,
						ageMs: Math.round(view.ageMs),
						skewMs: Math.round(view.skewMs),
						state: view.terminateRequested ? "terminating" : view.stale ? "stale" : "live",
					})),
					malformed: listed.malformed,
					clockOffsetMs,
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}
	const listNotes = (): void => {
		if (clockSkewed && clockOffsetMs !== null)
			process.stdout.write(
				`warning: this host's clock is ${formatAge(Math.abs(clockOffsetMs))} ${clockOffsetMs < 0 ? "ahead of" : "behind"} the state dir's file times; heartbeat ages of other hosts are off by that much\n`,
			);
		for (const name of listed.malformed)
			process.stdout.write(`malformed live record ${printable(name)} under ${liveSessionsDir()}; ignored\n`);
	};
	if (views.length === 0) {
		process.stdout.write(`no ${staleOnly ? "stale" : "open"} sessions under ${liveSessionsDir()}\n`);
		listNotes();
		return 0;
	}
	const rows = [
		["ID", "HOST", "PID", "SURFACE", "STARTED", "HEARTBEAT", "STATE", "CWD"],
		...views
			.map((view) => [
				view.record.id,
				view.record.host,
				String(view.record.pid),
				view.record.surface,
				view.record.startedAt.replace(/\.\d+Z$/, "Z"),
				`${formatAge(view.ageMs)} ago`,
				stateOf(view),
				view.record.cwd,
			])
			.map((row) => row.map(printable)),
	];
	const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
	for (const row of rows) {
		process.stdout.write(
			`${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join("  ")}\n`,
		);
	}
	listNotes();
	return 0;
}

interface TerminateArgs {
	id: string;
	force: boolean;
	reason: string | null;
	json: boolean;
}

function parseTerminate(args: ReadonlyArray<string>): TerminateArgs | string {
	let id: string | undefined;
	let force = false;
	let json = false;
	let reason: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--force") force = true;
		else if (arg === "--json") json = true;
		else if (arg === "--reason") {
			const value = args[index + 1];
			if (value === undefined || value.trim().length === 0) return "--reason needs a value";
			reason = printable(value);
			index += 1;
		} else if (arg?.startsWith("--reason=")) reason = printable(arg.slice("--reason=".length));
		else if (arg?.startsWith("-")) return `unknown flag: ${arg}`;
		else if (id === undefined && arg !== undefined) id = arg;
		else return `unexpected argument: ${arg}`;
	}
	if (id === undefined) return "missing <id>";
	return { id, force, reason, json };
}

interface TerminateReport {
	id: string;
	host: string;
	pid: number;
	action: "requested" | "signaled" | "released" | "refused";
	message: string;
	ageMs: number;
	exited?: boolean;
	released?: ReleaseResult;
}

type OwnerOnThisHost = "alive" | "gone" | "foreign";

function ownerOnThisHost(view: LiveSessionView): OwnerOnThisHost {
	const { host, pid, birth } = view.record;
	if (host !== hostname()) return "foreign";
	if (!processAlive(pid)) return "gone";
	if (birth === null) return "alive";
	const current = processBirthToken(pid);
	return current === null || current === birth ? "alive" : "gone";
}

function emit(report: TerminateReport, json: boolean, code: number): number {
	if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else
		(code === 0 ? process.stdout : process.stderr).write(`clio-coder session terminate: ${printable(report.message)}\n`);
	return code;
}

async function runTerminate(args: ReadonlyArray<string>): Promise<number> {
	const parsed = parseTerminate(args);
	if (typeof parsed === "string") {
		process.stderr.write(`clio-coder session terminate: ${parsed}\n${USAGE}`);
		return 2;
	}
	const { id, force, reason, json } = parsed;
	try {
		assertSafeId(id, "session");
	} catch (error) {
		process.stderr.write(`clio-coder session terminate: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	const view = liveSessionView(id);
	if (view === null && existsSync(liveRecordPath(id))) {
		process.stderr.write(
			`clio-coder session terminate: live record ${liveRecordPath(id)} is malformed or names another session; nothing done. A running owner rewrites it on its next beat; run clio-coder session list to see what is open\n`,
		);
		return 1;
	}
	if (view === null) {
		process.stderr.write(
			`clio-coder session terminate: no live session ${id} under ${liveSessionsDir()}; run clio-coder session list to see open sessions\n`,
		);
		return 1;
	}
	const { record } = view;
	const owner = ownerOnThisHost(view);
	const base = { id, host: record.host, pid: record.pid, ageMs: Math.round(view.ageMs) };
	const age = formatAge(view.ageMs);

	if (force) {
		if (owner === "alive") {
			return emit(
				{
					...base,
					action: "refused",
					message: `pid ${record.pid} is alive on this host; run without --force to ask it to end`,
				},
				json,
				2,
			);
		}
		if (owner === "foreign" && !view.stale) {
			return emit(
				{
					...base,
					action: "refused",
					message: `heartbeat from ${record.host} is ${age} old; --force needs it stale for over ${formatAge(HEARTBEAT_STALE_MS)}. Without --force the owner ends itself within ${formatAge(HEARTBEAT_INTERVAL_MS)}`,
				},
				json,
				2,
			);
		}
		if (owner === "foreign") {
			const offsetMs = stateDirClockOffsetMs();
			if (offsetMs === null || Math.abs(offsetMs) > HEARTBEAT_SKEW_MS) {
				return emit(
					{
						...base,
						action: "refused",
						message:
							offsetMs === null
								? `cannot write a clock probe under ${liveSessionsDir()}, so the heartbeat age ${age} cannot be trusted; nothing released`
								: `clocks disagree: this host's clock is ${formatAge(Math.abs(offsetMs))} ${offsetMs < 0 ? "ahead of" : "behind"} the state dir's file times, so the heartbeat age ${age} cannot be trusted; fix the clock and retry. (Checked against NFS server time; on Lustre and GPFS file times come from the client clock and this check cannot see skew.)`,
					},
					json,
					2,
				);
			}
		}
		const why = owner === "gone" ? "pid gone" : `stale heartbeat ${age}`;
		const released = await releaseSession(view, why);
		const freed = `freed ${released.capacityLeases} capacity lease(s), ${released.stateLocks.length} state lock(s), ${released.fleetLocks.length} fleet lock(s), ${released.checkoutLeases.length} checkout lease(s)`;
		if (released.refused !== undefined) {
			return emit({ ...base, action: "refused", message: released.refused, released }, json, 2);
		}
		if (released.failed.length > 0) {
			return emit(
				{
					...base,
					action: "refused",
					message: `partial release of ${id} (${why}); ${freed}; failed: ${released.failed.join("; ")}. The live record is kept; rerun clio-coder session terminate ${id} --force`,
					released,
				},
				json,
				2,
			);
		}
		return emit(
			{
				...base,
				action: "released",
				message: `released ${id} (${why}); ${freed}; resume it with clio-coder run --session ${id}`,
				released,
			},
			json,
			0,
		);
	}

	const request: TerminateRequest = {
		schema: 1,
		requestedAt: new Date().toISOString(),
		by: currentRequester(),
		...(reason !== null ? { reason } : {}),
		force: false,
	};
	safeResourceWrite(terminateRequestPath(id), `${JSON.stringify(request)}\n`);
	if (owner === "foreign") {
		return emit(
			{
				...base,
				action: "requested",
				message: `request written; ${record.host} polls every ${formatAge(HEARTBEAT_INTERVAL_MS)}; no signal crosses hosts (last heartbeat ${age} ago)`,
			},
			json,
			0,
		);
	}
	if (owner === "gone") {
		return emit(
			{
				...base,
				action: "requested",
				message: `request written, but pid ${record.pid} is gone on this host; run clio-coder session terminate ${id} --force to release it`,
			},
			json,
			0,
		);
	}
	try {
		process.kill(record.pid, "SIGTERM");
	} catch {
		// Exited between the probe and the signal; the wait below sees the record go.
	}
	const exited = await waitForRecordGone(id, record.pid);
	return emit(
		{
			...base,
			action: "signaled",
			exited,
			message: exited
				? `sent SIGTERM to pid ${record.pid}; session ended`
				: `sent SIGTERM to pid ${record.pid}; still shutting down after ${formatAge(SIGNAL_SETTLE_WAIT_MS)}, request stands`,
		},
		json,
		0,
	);
}

async function waitForRecordGone(id: string, pid: number): Promise<boolean> {
	const deadline = Date.now() + SIGNAL_SETTLE_WAIT_MS;
	while (Date.now() < deadline) {
		const current = liveSessionView(id);
		if (current === null || current.record.pid !== pid || !processAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

interface ReleaseResult {
	capacityLeases: number;
	stateLocks: string[];
	fleetLocks: string[];
	checkoutLeases: string[];
	endedAtStamped: boolean;
	failed: string[];
	refused?: string;
}

/**
 * Fence first: an owner that wakes mid-release finds the fence on its next
 * ledger write or beat and shuts down fenced, whatever step this process has
 * reached. Locks, leases and endedAt go next, each step caught and reported.
 * The live record and the request go last, and only when every step
 * succeeded, so an interrupted or failed release can simply be rerun.
 */
async function releaseSession(view: LiveSessionView, reason: string): Promise<ReleaseResult> {
	const { record } = view;
	const owner: StateLockOwner = { host: record.host, pid: record.pid, birth: record.birth };
	const result: ReleaseResult = {
		capacityLeases: 0,
		stateLocks: [],
		fleetLocks: [],
		checkoutLeases: [],
		endedAtStamped: false,
		failed: [],
	};
	// The view may be stale by now: a node that resumed the session owns a fresh record.
	if (!liveRecordNames(record.id, owner)) {
		result.refused = `live record for ${record.id} no longer names pid ${record.pid} on ${record.host}; it was resumed or released meanwhile, so nothing was released`;
		return result;
	}
	// Read leniently: an older or partial meta.json still names its owner.
	let meta: Partial<ClioSessionMeta> | null = null;
	try {
		meta = JSON.parse(
			readFileSync(join(clioStateDir(), "sessions", cwdHash(record.cwd), record.id, "meta.json"), "utf8"),
		) as Partial<ClioSessionMeta>;
	} catch {
		// No ledger here: locks and the record can still be released.
	}
	const metaOwner = meta?.owner;
	if (
		meta !== null &&
		meta.endedAt === null &&
		(metaOwner?.host !== owner.host || metaOwner.pid !== owner.pid || metaOwner.birth !== owner.birth)
	) {
		result.refused = `session ${record.id} is open under another owner (${metaOwner ? `pid ${metaOwner.pid} on ${metaOwner.host}` : "unknown"}) than its live record names; nothing was released`;
		return result;
	}
	const step = async (name: string, run: () => unknown | Promise<unknown>): Promise<void> => {
		try {
			await run();
		} catch (error) {
			result.failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const fence: ReleasedFence = { schema: 1, at: new Date().toISOString(), by: currentRequester(), reason };
	await step("fence", () => safeResourceWrite(releasedFencePath(record.id), `${JSON.stringify(fence)}\n`));
	if (result.failed.length > 0) return result;
	// A resumer that opened between the check above and the fence write owns a
	// fresh record now; the fence is not meant for it.
	const resumedMeanwhile = `session ${record.id} was resumed by another process during the release`;
	if (!liveRecordNames(record.id, owner)) {
		rmSync(releasedFencePath(record.id), { force: true });
		result.refused = `${resumedMeanwhile}; nothing was released`;
		return result;
	}
	const stateDir = clioStateDir();
	// The admission lock itself may be one the dead owner held, so lockfiles go before leases.
	await step("state locks", () => {
		result.stateLocks = releaseStateLocksOwnedBy(stateDir, owner);
	});
	await step("capacity leases", async () => {
		result.capacityLeases = await releaseCapacityLeasesOwnedBy(owner);
	});
	await step("fleet locks", () => {
		result.fleetLocks = removeOwnedRecords(join(stateDir, "fleet-locks"), (value) => {
			const lock = value as { host?: unknown; processOwner?: { pid?: unknown; processBirthToken?: unknown } };
			return (
				lock.host === owner.host &&
				lock.processOwner?.pid === owner.pid &&
				lock.processOwner.processBirthToken === owner.birth
			);
		});
	});
	// Checkout leases carry no host. A pid plus its start tick does not recur
	// across hosts in practice, and owner.birth is never null here.
	await step("checkout leases", () => {
		result.checkoutLeases = removeOwnedRecords(join(stateDir, "checkout-writer-leases"), (value) => {
			const lease = value as { pid?: unknown; processBirthToken?: unknown };
			return lease.pid === owner.pid && lease.processBirthToken === owner.birth;
		});
	});
	// Re-read before each step that touches the session itself: only the dead
	// owner's locks are safe to free once someone else has the session open.
	if (!liveRecordNames(record.id, owner)) {
		result.refused = `${resumedMeanwhile}; the dead owner's locks were freed, endedAt and the new owner's record were left alone`;
		return result;
	}
	await step("endedAt", () => {
		result.endedAtStamped = endAbandonedSession(record.cwd, record.id, owner);
	});
	if (result.failed.length > 0) return result;
	if (!liveRecordNames(record.id, owner)) {
		result.refused = `${resumedMeanwhile} after endedAt was stamped; its own open rewrote meta.json, and its record was left alone`;
		return result;
	}
	await step("live record", () => rmSync(liveRecordPath(record.id), { force: true }));
	await step("terminate request", () => rmSync(terminateRequestPath(record.id), { force: true }));
	return result;
}

function removeOwnedRecords(dir: string, owned: (value: unknown) => boolean): string[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (!owned(JSON.parse(readFileSync(path, "utf8")))) continue;
			rmSync(path, { force: true });
			removed.push(path);
		} catch {
			// Unreadable records are not matched.
		}
	}
	return removed;
}
