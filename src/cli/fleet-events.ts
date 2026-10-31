/**
 * `clio-coder fleet events <fleetRootId> [--follow] [--json] [--all]`.
 *
 * Prints a fleet run's event journal (`fleet-runs/<id>.events.ndjson`, see
 * src/domains/dispatch/fleet-event-journal.ts). `--json` writes the stored
 * lines verbatim, one per line, so another process can import them; without
 * it each line is summarized. `--follow` keeps reading as the fleet appends
 * and exits once the `fleet_sealed` line arrives, so a follower such as an
 * external sealer ends exactly when the fleet's manifest is final. Lines are
 * hash-chained, not signed: the chain shows a reader that each line extends
 * the ones before it, and does not stop someone who can write the file. The
 * command is read-only and shares no memory with the process running the
 * fleet, so it works from another terminal or over SSH.
 */

import { setTimeout as delay } from "node:timers/promises";
import { assignmentProcessOwnerAlive, getStoredAssignment } from "../domains/dispatch/assignment-store.js";
import {
	type FleetEventLine,
	fleetEventJournalPath,
	readFleetEventJournal,
} from "../domains/dispatch/fleet-event-journal.js";
import { readFleetRun } from "../domains/dispatch/state.js";
import { fleetInspectionScope, resolveFleetRootId } from "./fleet-project-scope.js";

const HELP = `clio-coder fleet events <fleetRootId> [--follow] [--json] [--all]

Print a fleet run's live event journal: fleet_started, step_dispatched,
step_settled (the step's run record or command record path, the digest of its
entry in the fleet manifest, and the digest of the manifest bytes written at
that moment) and fleet_sealed, the last line. Lines are hash-chained, not
signed: the chain detects a line that does not extend the ones before it, not
a rewrite by someone who can write the file.

  --follow  keep reading as the fleet appends; exit after fleet_sealed
  --json    write the stored NDJSON lines verbatim
  --all     read a fleet root from any project

The root id may be a unique prefix, as with fleet view.

Exit codes: 0 sealed and intact, 1 integrity break or read error, 2 usage,
3 the journal read so far is intact but not sealed (the fleet may still be
running; pass --follow to wait for the seal), 4 --follow stopped because the fleet can no longer seal its journal (its root
record is gone, it ended without a seal, or the process running it is gone).
`;

const FOLLOW_POLL_MS = 250;

/** An intact journal read without --follow that has no seal yet. */
const EXIT_UNSEALED = 3;
/** A --follow that stopped because the fleet can no longer append its seal. */
const EXIT_WILL_NOT_SEAL = 4;

export interface FleetEventsIo {
	out(text: string): void;
	err(text: string): void;
}

const PROCESS_IO: FleetEventsIo = {
	out: (text) => void process.stdout.write(text),
	err: (text) => void process.stderr.write(text),
};

/**
 * Why a followed journal can never be sealed, or null while the fleet can
 * still append to it. The fleet claims its assignment row before writing its
 * root record and appends the seal right after the final record write, so a
 * record that is gone, a record with `endedAt` set, or a row naming no live
 * process means no seal is coming: the run crashed, its journal was turned off,
 * or the root predates the journal.
 */
function followDeadEnd(rootId: string, journalExists: boolean): string | null {
	const record = readFleetRun(rootId);
	if (record === null) return `there is no root record for ${rootId}`;
	const unsealed = journalExists ? "its event journal is not sealed" : "it has no event journal";
	if (record.endedAt !== null) return `${rootId} ended at ${record.endedAt} and ${unsealed}`;
	const assignment = getStoredAssignment(rootId);
	if (assignment?.status !== "running" || !assignmentProcessOwnerAlive(assignment)) {
		return `the process running ${rootId} is gone and ${unsealed}`;
	}
	return null;
}

function summary(line: FleetEventLine): string {
	const head = `${line.seq} ${line.at} ${line.type}`;
	switch (line.type) {
		case "fleet_started":
			return `${head} fleet=${line.fleet} plan=${line.planHash.slice(0, 12)} steps=${line.stepIds.length}${line.resumedFrom !== null ? ` resumed-from=${line.resumedFrom} replayed=${line.replayedStepIds.length}` : ""}`;
		case "step_dispatched":
			return `${head} step=${line.stepId} ${line.kind}:${line.agentId ?? line.commandId ?? "?"} wave=${line.waveIndex} run=${line.assignmentId}`;
		case "step_settled":
			return `${head} step=${line.stepId} ${line.succeeded ? "succeeded" : "failed"} run=${line.terminalRunId} record=${line.recordPath}${line.failureReason !== undefined ? ` reason=${line.failureReason}` : ""} manifest=${line.manifestDigest.slice(0, 12)}`;
		case "fleet_sealed":
			return `${head} ${line.outcome} steps=${line.stepCount} manifest=${line.manifestDigest.slice(0, 12)}`;
	}
}

export async function runFleetEvents(args: ReadonlyArray<string>, io: FleetEventsIo = PROCESS_IO): Promise<number> {
	let follow = false;
	let json = false;
	let all = false;
	let rootId: string | undefined;
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			io.out(HELP);
			return 0;
		}
		if (arg === "--follow" || arg === "-f") follow = true;
		else if (arg === "--json") json = true;
		else if (arg === "--all") all = true;
		else if (arg.startsWith("-") || rootId !== undefined) {
			io.err(`clio-coder fleet events: unexpected argument '${arg}'\n${HELP}`);
			return 2;
		} else rootId = arg;
	}
	if (rootId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(rootId)) {
		io.err(`clio-coder fleet events: a fleet root id is required\n${HELP}`);
		return 2;
	}
	const resolved = resolveFleetRootId(rootId, fleetInspectionScope(all));
	if ("rootId" in resolved) rootId = resolved.rootId;
	else if (resolved.candidates.length > 1) {
		io.err(
			`clio-coder fleet events: fleet root id '${rootId}' is ambiguous: ${resolved.candidates.slice(0, 8).join(", ")}\n`,
		);
		return 1;
	} else if (readFleetRun(rootId) !== null) {
		io.err(`clio-coder fleet events: ${rootId} belongs to another project; pass --all to read it\n`);
		return 1;
	}
	// Otherwise no record matches, and the journal alone is read under the exact id.
	let cursor = { offset: 0, seq: 0, prev: null as string | null };
	let reported = false;
	let broken = false;
	let deadEnd: string | null = null;
	for (;;) {
		let read: ReturnType<typeof readFleetEventJournal>;
		try {
			read = readFleetEventJournal(rootId, cursor);
		} catch (error) {
			io.err(
				`clio-coder fleet events: cannot read ${fleetEventJournalPath(rootId)}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}
		if (read === null && cursor.offset === 0 && !follow) {
			io.err(`clio-coder fleet events: no event journal at ${fleetEventJournalPath(rootId)}\n`);
			return 1;
		}
		let appended = false;
		if (read !== null) {
			appended = read.lines.length > 0;
			// --json output is imported by other tools, so it never carries a line
			// past a break; the summary is for a person and shows the rest.
			if (json && read.broken !== null) {
				for (const line of read.lines.slice(0, read.verified)) io.out(`${JSON.stringify(line)}\n`);
				io.err(`clio-coder fleet events: journal integrity: ${read.broken}\n`);
				return 1;
			}
			// A line past the break may not have the shape summary() reads, so
			// the person sees it raw and marked.
			const verified = read.verified;
			read.lines.forEach((line, index) => {
				const text = json ? JSON.stringify(line) : index < verified ? summary(line) : `unverified ${JSON.stringify(line)}`;
				io.out(`${text}\n`);
			});
			const last = read.lines.at(-1);
			cursor = { offset: read.offset, seq: last?.seq ?? cursor.seq, prev: last?.digest ?? cursor.prev };
			if (read.broken !== null && !reported) {
				reported = true;
				broken = true;
				io.err(`clio-coder fleet events: journal integrity: ${read.broken}\n`);
			}
			if (read.sealed) return broken ? 1 : 0;
		}
		if (!follow) return broken ? 1 : EXIT_UNSEALED;
		// Only an idle poll asks whether a seal is still coming, and the answer
		// must repeat on the next idle poll: the fleet stamps endedAt a moment
		// before it appends the seal.
		const reason = appended ? null : followDeadEnd(rootId, read !== null);
		if (reason !== null && reason === deadEnd) {
			io.err(`clio-coder fleet events: stopped following: ${reason}\n`);
			return EXIT_WILL_NOT_SEAL;
		}
		deadEnd = reason;
		await delay(FOLLOW_POLL_MS);
	}
}
