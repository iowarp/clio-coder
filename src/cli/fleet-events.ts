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
import {
	type FleetEventLine,
	fleetEventJournalPath,
	readFleetEventJournal,
} from "../domains/dispatch/fleet-event-journal.js";
import { openLedger, readFleetRun } from "../domains/dispatch/state.js";
import { fleetInspectionScope } from "./fleet-project-scope.js";

const HELP = `clio-coder fleet events <fleetRootId> [--follow] [--json] [--all]

Print a fleet run's live event journal: fleet_started, step_dispatched,
step_settled (the step's receipt or command record path, the digest of its
entry in the fleet manifest, and the digest of the manifest bytes written at
that moment) and fleet_sealed, the last line. Lines are hash-chained, not
signed: the chain detects a line that does not extend the ones before it, not
a rewrite by someone who can write the file.

  --follow  keep reading as the fleet appends; exit after fleet_sealed
  --json    write the stored NDJSON lines verbatim
  --all     read a fleet root from any project
`;

const FOLLOW_POLL_MS = 250;

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

export async function runFleetEvents(args: ReadonlyArray<string>): Promise<number> {
	let follow = false;
	let json = false;
	let all = false;
	let rootId: string | undefined;
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(HELP);
			return 0;
		}
		if (arg === "--follow" || arg === "-f") follow = true;
		else if (arg === "--json") json = true;
		else if (arg === "--all") all = true;
		else if (arg.startsWith("-") || rootId !== undefined) {
			process.stderr.write(`clio-coder fleet events: unexpected argument '${arg}'\n${HELP}`);
			return 2;
		} else rootId = arg;
	}
	if (rootId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(rootId)) {
		process.stderr.write(`clio-coder fleet events: a fleet root id is required\n${HELP}`);
		return 2;
	}
	const record = readFleetRun(rootId);
	if (record !== null && !all) {
		const ledger = openLedger();
		if (!fleetInspectionScope(false).seesRoot(record, (id) => ledger.get(id))) {
			process.stderr.write(`clio-coder fleet events: ${rootId} belongs to another project; pass --all to read it\n`);
			return 1;
		}
	}
	let cursor = { offset: 0, seq: 0, prev: null as string | null };
	let reported = false;
	let broken = false;
	for (;;) {
		let read: ReturnType<typeof readFleetEventJournal>;
		try {
			read = readFleetEventJournal(rootId, cursor);
		} catch (error) {
			process.stderr.write(
				`clio-coder fleet events: cannot read ${fleetEventJournalPath(rootId)}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}
		if (read === null && cursor.offset === 0 && !follow) {
			process.stderr.write(`clio-coder fleet events: no event journal at ${fleetEventJournalPath(rootId)}\n`);
			return 1;
		}
		if (read !== null) {
			for (const line of read.lines) process.stdout.write(`${json ? JSON.stringify(line) : summary(line)}\n`);
			const last = read.lines.at(-1);
			cursor = { offset: read.offset, seq: last?.seq ?? cursor.seq, prev: last?.digest ?? cursor.prev };
			if (read.broken !== null && !reported) {
				reported = true;
				broken = true;
				process.stderr.write(`clio-coder fleet events: journal integrity: ${read.broken}\n`);
			}
			if (read.sealed) return broken ? 1 : 0;
		}
		if (!follow) return broken ? 1 : 0;
		await delay(FOLLOW_POLL_MS);
	}
}
