import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import { councilTopologies } from "../../../../../src/domains/dispatch/council-topology.js";
import { gateTopology } from "../../../../../src/domains/dispatch/gate-topology.js";
import { type FleetRunRecord, openLedger, readFleetRun } from "../../../../../src/domains/dispatch/state.js";
import type { RunEnvelope } from "../../../../../src/domains/dispatch/types.js";
import { Id } from "../../../contracts/common.js";
import {
	Councils,
	DispatchRun,
	FleetGates,
	type FleetRequest,
	FleetRoot,
	FleetRootDetail,
} from "../../../contracts/fleet.js";
import { AppProblem } from "../../services/problem.js";
import { artifactPage, containedFile, readArtifact } from "./storage.js";

function checked<S extends TSchema>(schema: S, raw: unknown): Static<S> {
	const value = Value.Clean(schema, structuredClone(raw));
	if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "Fleet storage returned an invalid record.");
	return value;
}
function rootSummary(record: FleetRunRecord): FleetRoot {
	return checked(FleetRoot, { ...record, stepCount: record.stepIds.length, completedCount: record.steps.length });
}
function dispatchSummary(row: RunEnvelope): DispatchRun {
	return checked(DispatchRun, {
		...row,
		outcome: row.outcome ?? null,
		outcomeDetail: row.outcomeDetail ?? null,
		parentRunId: row.lineage?.parentRunId ?? null,
		rootRunId: row.lineage?.rootRunId ?? null,
	});
}
function receipt(id: string) {
	const raw = readArtifact(clioStateDir(), "receipts", `${id}.json`);
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}
function rootRecord(id: string) {
	if (!containedFile(clioStateDir(), "fleet-runs", `${id}.json`)) return null;
	return readFleetRun(id);
}
function dispatchRows() {
	try {
		statSync(join(clioStateDir(), "runs.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new AppProblem("unavailable", "The dispatch ledger cannot be read.");
	}
	if (!containedFile(clioStateDir(), "runs.json"))
		throw new AppProblem("unavailable", "The dispatch ledger is outside its storage boundary or exceeds 8 MiB.");
	try {
		return [...openLedger().list()].filter((row) => {
			try {
				dispatchSummary(row);
				return Number.isFinite(Date.parse(row.startedAt));
			} catch {
				return false;
			}
		});
	} catch {
		throw new AppProblem("unavailable", "The dispatch ledger is unreadable.");
	}
}
export function readFleet(input: FleetRequest): unknown {
	if (input.kind === "roots") {
		let entries: string[];
		try {
			entries = readdirSync(join(clioStateDir(), "fleet-runs"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return artifactPage([], input.limit, input.cursor);
			throw new AppProblem("unavailable", "The fleet directory cannot be read.");
		}
		if (entries.length > 100_000) throw new AppProblem("unavailable", "Fleet directory exceeds the supported scan size.");
		// listFleetRuns truncates its directory scan to 64 entries, before sorting.
		// Own the complete scan so pages can reach every durable root.
		const rows: FleetRoot[] = [];
		for (const name of entries) {
			const id = name.endsWith(".json") ? name.slice(0, -5) : "";
			if (!Value.Check(Id, id)) continue;
			try {
				const record = rootRecord(id);
				if (record && Number.isFinite(Date.parse(record.startedAt))) rows.push(rootSummary(record));
			} catch {
				/* A malformed record costs one row, never the page. */
			}
		}
		return artifactPage(rows, input.limit, input.cursor);
	}
	if (input.kind === "receipt") return { receipt: receipt(input.id) };
	if (input.kind === "gates") return checked(FleetGates, gateTopology());
	const rows = dispatchRows().sort(
		(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id),
	);
	if (input.kind === "dispatches") return artifactPage(rows.map(dispatchSummary), input.limit, input.cursor);
	if (input.kind === "councils") return checked(Councils, councilTopologies(rows));
	if (input.kind === "dispatch") {
		const row = rows.find((row) => row.id === input.id);
		if (!row) throw new AppProblem("not_found", "Dispatch run was not found.");
		return dispatchSummary(row);
	}
	if (input.kind !== "root") throw new AppProblem("unsupported", "Unknown fleet read.");
	const record = rootRecord(input.id);
	if (!record) throw new AppProblem("not_found", "Fleet run was not found.");
	const run = rootSummary(record);
	const ids = new Set([record.id, ...record.steps.map((step) => step.result.terminalRunId)]);
	const groups = new Set(
		rows
			.filter((row) => ids.has(row.id))
			.map((row) => row.council?.group)
			.filter(Boolean),
	);
	const councils = councilTopologies(rows.filter((row) => row.council && groups.has(row.council.group)));
	const gates = gateTopology();
	return checked(FleetRootDetail, {
		run,
		receipt: receipt(record.id),
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
