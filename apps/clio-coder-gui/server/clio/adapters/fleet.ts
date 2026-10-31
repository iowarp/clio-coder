import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	readDispatchHistory,
	readFleetHistory,
	readFleetHistoryRoot,
	readRunInspection,
	runHistoryCouncils,
	runHistoryGates,
} from "../../../../../src/domains/telemetry/index.js";
import {
	Councils,
	DispatchRun,
	FleetGates,
	type FleetRequest,
	FleetRoot,
	FleetRootDetail,
} from "../../../contracts/fleet.js";
import { AppProblem } from "../../services/problem.js";
import { artifactPage } from "./storage.js";

function checked<S extends TSchema>(schema: S, raw: unknown): Static<S> {
	const value = Value.Clean(schema, structuredClone(raw));
	if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "Fleet storage returned an invalid record.");
	return value;
}
function rootSummary(record: NonNullable<ReturnType<typeof readFleetHistoryRoot>>): FleetRoot {
	return checked(FleetRoot, { ...record, stepCount: record.stepIds.length, completedCount: record.steps.length });
}
/** A ledger row's own token and cost columns are not shown; its journal is, through the read model (#434). */
const DispatchIdentity = Type.Omit(DispatchRun, ["telemetry", "evidence"]);
function dispatchIdentity(row: ReturnType<typeof readDispatchHistory>["rows"][number]) {
	return checked(DispatchIdentity, {
		...row,
		outcome: row.outcome ?? null,
		outcomeDetail: row.outcomeDetail ?? null,
		parentRunId: row.lineage?.parentRunId ?? null,
		rootRunId: row.lineage?.rootRunId ?? null,
	});
}
function dispatchSummary(row: ReturnType<typeof readDispatchHistory>["rows"][number]): DispatchRun {
	const { telemetry, evidence } = readRunInspection(row.id);
	return checked(DispatchRun, { ...dispatchIdentity(row), telemetry, evidence });
}

function history<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		throw new AppProblem("unavailable", error instanceof Error ? error.message : String(error));
	}
}
export function readFleet(input: FleetRequest): unknown {
	if (input.kind === "roots") {
		const roots = history(readFleetHistory);
		const rows = roots.rows.flatMap((record) => {
			try {
				return [rootSummary(record)];
			} catch {
				return [];
			}
		});
		return { ...artifactPage(rows, input.limit, input.cursor), present: roots.present };
	}

	if (input.kind === "receipt") {
		const run = readRunInspection(input.id);
		return { evidence: run.evidence, record: input.full ? run.record : null };
	}
	if (input.kind === "gates") return checked(FleetGates, runHistoryGates());
	const ledger = history(readDispatchHistory);
	ledger.rows = ledger.rows.filter((row) => {
		try {
			dispatchIdentity(row);
			return Number.isFinite(Date.parse(row.startedAt));
		} catch {
			return false;
		}
	});
	const rows = ledger.rows.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id));
	if (input.kind === "dispatches") {
		const page = artifactPage(rows, input.limit, input.cursor);
		return { ...page, items: page.items.map(dispatchSummary), present: ledger.present };
	}
	if (input.kind === "councils") return checked(Councils, runHistoryCouncils(rows));
	if (input.kind === "dispatch") {
		const row = rows.find((row) => row.id === input.id);
		if (!row) throw new AppProblem("not_found", "Dispatch run was not found.");
		return dispatchSummary(row);
	}
	if (input.kind !== "root") throw new AppProblem("unsupported", "Unknown fleet read.");
	const record = history(() => readFleetHistoryRoot(input.id));
	if (!record) throw new AppProblem("not_found", "Fleet run was not found.");
	const run = rootSummary(record);
	const ids = new Set([record.id, ...record.steps.map((step) => step.result.terminalRunId)]);
	const groups = new Set(
		rows
			.filter((row) => ids.has(row.id))
			.map((row) => row.council?.group)
			.filter(Boolean),
	);
	const councils = runHistoryCouncils(rows.filter((row) => row.council && groups.has(row.council.group)));
	const gates = runHistoryGates();
	return checked(FleetRootDetail, {
		run,
		evidence: readRunInspection(record.id).evidence,
		councils,
		gates: {
			...gates,
			decisions: gates.decisions.filter(
				(gate) => gate.subjects.some((id) => ids.has(id)) || (gate.decider && ids.has(gate.decider)),
			),
		},
		steps: record.steps.map((step) => ({
			stepId: step.stepId,
			terminalRunId: step.result.terminalRunId || null,
			assignmentId: step.result.assignmentId || null,
			succeeded: step.result.succeeded,
			integrityValid: step.result.integrityValid,
			failureReason: step.result.failureReason ?? null,
			output: step.result.output,
		})),
	});
}
