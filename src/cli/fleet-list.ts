/**
 * `clio-coder fleet list`: the fleet roots (playbook runs) this project ran, newest first, from the durable root records.
 * A run dispatched outside a playbook has no root; `fleet status` and `fleet view <run id>` see it, so an empty list
 * counts those runs instead of claiming the project ran nothing (row 362).
 *
 * Each row is read from disk alone, so the list answers from any terminal. A root's state comes from its event
 * journal and its assignment row: `sealed` once the journal carries `fleet_sealed`, `ended` when the record has an end
 * time but no seal (the journal was off or broke), `running` while the owning process is alive, and `orphaned` when
 * that process is gone without either.
 */

import { assignmentProcessOwnerAlive, getStoredAssignment } from "../domains/dispatch/assignment-store.js";
import { readFleetEventJournal } from "../domains/dispatch/fleet-event-journal.js";
import { type FleetRunRecord, listFleetRuns, openLedger } from "../domains/dispatch/state.js";
import { formatColumns } from "./argv.js";
import { fleetInspectionScope } from "./fleet-project-scope.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { parseCommandFlags } from "./kit/flags.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";

const LIST_PATH = ["fleet", "list"] as const;
const DEFAULT_LIMIT = 20;
/** `listFleetRuns` reads at most this many of the newest root records. */
const MAX_LIMIT = 64;

type FleetRootState = "sealed" | "ended" | "running" | "orphaned";

interface FleetRootRow {
	readonly rootId: string;
	readonly playbook: string;
	readonly planHash: string;
	readonly cwd: string | null;
	readonly startedAt: string;
	readonly endedAt: string | null;
	readonly resumedFrom: string | null;
	readonly stepCount: number;
	readonly settledStepCount: number;
	readonly state: FleetRootState;
	/** The journal's own verdict from `fleet_sealed`; null until the root seals. */
	readonly outcome: "succeeded" | "failed" | "aborted" | null;
}

function rootRow(record: FleetRunRecord): FleetRootRow {
	const journal = readFleetEventJournal(record.id);
	let outcome: FleetRootRow["outcome"] = null;
	for (const line of journal?.lines ?? []) if (line.type === "fleet_sealed") outcome = line.outcome;
	let state: FleetRootState;
	if (outcome !== null) state = "sealed";
	else if (record.endedAt !== null) state = "ended";
	else {
		const assignment = getStoredAssignment(record.id);
		state = assignment?.status === "running" && assignmentProcessOwnerAlive(assignment) ? "running" : "orphaned";
	}
	return {
		rootId: record.id,
		playbook: record.fleet,
		planHash: record.planHash,
		cwd: record.cwd ?? null,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		resumedFrom: record.resumedFrom,
		stepCount: record.stepIds.length,
		settledStepCount: record.steps.length,
		state,
		outcome,
	};
}

export function runFleetList(args: ReadonlyArray<string>): number {
	const parsed = parseCommandFlags(args, {
		json: { kind: "boolean" },
		"all-projects": { kind: "boolean" },
		// `--all` is the project-scope flag every other fleet inspection takes.
		all: { kind: "boolean" },
		limit: { kind: "value" },
	});
	const json = parsed.ok ? parsed.flags.json === true : args.includes("--json");
	if (!parsed.ok) {
		writeCliFailure({ path: LIST_PATH, slug: parsed.slug, message: parsed.message, json });
		return EXIT_CODES.notStarted;
	}
	const usage = (message: string): number => {
		writeCliFailure({ path: LIST_PATH, slug: "usage", message, json });
		return EXIT_CODES.notStarted;
	};
	if (parsed.positional.length > 0) return usage(`unexpected argument: ${parsed.positional[0]}`);
	let limit = DEFAULT_LIMIT;
	if (parsed.flags.limit !== undefined) {
		limit = Number(parsed.flags.limit);
		if (!/^\d+$/u.test(parsed.flags.limit) || limit < 1 || limit > MAX_LIMIT) {
			return usage(`--limit takes a whole number from 1 to ${MAX_LIMIT}`);
		}
	}
	const scope = fleetInspectionScope(parsed.flags["all-projects"] === true || parsed.flags.all === true);
	const ledger = openLedger();
	const records = listFleetRuns(MAX_LIMIT);
	const roots = records
		.filter((record) => scope.seesRoot(record, (id) => ledger.get(id)))
		.slice(0, limit)
		.map(rootRow);
	if (json) {
		writeJson(process.stdout, jsonDocument({ roots }));
		return EXIT_CODES.success;
	}
	if (roots.length === 0) {
		const stepRuns = new Set(
			records.flatMap((record) => (record.steps ?? []).map((entry) => entry?.result?.terminalRunId)),
		);
		const loose = ledger.list().filter((run) => scope.seesRun(run) && !stepRuns.has(run.id)).length;
		const where = scope.all ? "" : " in this project";
		process.stdout.write(
			scope.all
				? "no fleet roots (a fleet root is one playbook run)\n"
				: "no fleet roots in this project (a fleet root is one playbook run; pass --all-projects for every project)\n",
		);
		if (loose > 0) {
			process.stdout.write(
				`${loose} dispatched run${loose === 1 ? "" : "s"}${where} ran outside a playbook; fleet status and fleet view <run id> show them\n`,
			);
		}
		return EXIT_CODES.success;
	}
	process.stdout.write(
		formatColumns([
			["ROOT", "PLAYBOOK", "STATE", "OUTCOME", "STEPS", "STARTED"],
			...roots.map((row) => [
				row.rootId,
				row.playbook,
				row.state,
				row.outcome ?? "-",
				`${row.settledStepCount}/${row.stepCount}`,
				row.startedAt,
			]),
		]),
	);
	return EXIT_CODES.success;
}
