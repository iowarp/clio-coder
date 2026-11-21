/**
 * `clio-coder fleet status [--json] [--all]` answered before src/cli/fleet.ts and its domain graph load, the way
 * fleet-help.ts answers the group help. A status with no ledger rows reads the run ledger's file, the settings (for
 * the warning a settings read prints) and the admission gate. A status with rows also loads the ledger, the project
 * scope and each run's journal through the telemetry domain's light reader (run-journal-read.ts), so it never
 * reaches the telemetry or dispatch domain modules either.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sumFactSums } from "../core/telemetry/pricing.js";
import { renderCountSum, renderDurationSum, renderUsdSum } from "../core/telemetry/render.js";
import { clioStateDir } from "../core/xdg.js";
import type { RecordedRunToolBudgetEnvelope } from "../domains/dispatch/budget-envelope.js";
import type { CapacityDrain } from "../domains/dispatch/capacity-lease.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";

export type FleetAdmissionStatus =
	| { state: "open" }
	| {
			state: "draining";
			requestedByPid: number;
			requestedAt: string;
			expiresAt: string;
	  };

export function admissionStatus(drain: CapacityDrain | null): FleetAdmissionStatus {
	if (drain === null) return { state: "open" };
	return { state: "draining", ...drain };
}

interface StatusWriter {
	write(chunk: string): unknown;
}

type Displayed = { display: string };

interface RunningRow {
	runId: string;
	agentId: string;
	budget: RecordedRunToolBudgetEnvelope | null;
	runtimeKind: RunEnvelope["runtimeKind"];
	outcomePhase: RunEnvelope["status"];
	heartbeat: "alive" | "stale" | "dead";
	lineage: NonNullable<RunEnvelope["lineage"]>;
	startedAt: string;
	elapsed: Displayed;
	tokens: unknown;
	usd: Displayed;
	node: string;
}

interface StatusSnapshot {
	generatedAt: string;
	admission: FleetAdmissionStatus;
	running: RunningRow[];
	retrying: Array<Record<string, unknown>>;
	totals: { total: Displayed; input: Displayed; output: Displayed; usd: Displayed; elapsed: Displayed };
}

/**
 * Whether runs.json holds no row by the ledger's own reading (src/domains/dispatch/state.ts readRuns): no file, an
 * empty file, a document that is not an array, or an empty array. A file that does not read or parse answers false,
 * so opening the ledger raises the error it always raised.
 */
function ledgerHasNoRows(): boolean {
	const path = join(clioStateDir(), "runs.json");
	try {
		if (!existsSync(path)) return true;
		const raw = readFileSync(path, "utf8").trim();
		if (raw.length === 0) return true;
		const parsed = JSON.parse(raw) as unknown;
		return !Array.isArray(parsed) || parsed.length === 0;
	} catch {
		return false;
	}
}

/** fleetTotals (src/domains/telemetry/read-model.ts) over no runs, from the same sum and render primitives. */
function emptyFleetTotals() {
	const fact = sumFactSums([]);
	const count = () => ({ fact, display: renderCountSum(fact) });
	return {
		input: count(),
		output: count(),
		total: count(),
		usd: { fact, display: renderUsdSum(fact, false) },
		elapsed: { fact, display: renderDurationSum(fact) },
	};
}

/**
 * The snapshot with no ledger rows: the settings read (a settings warning still prints; the project scope needs the
 * worktree root only to place a run, so a failure is ignored), then the admission gate through its owner, which
 * takes the state lock and clears an expired drain.
 */
async function emptySnapshot(nowMs: number): Promise<StatusSnapshot> {
	// Loaded here, not imported: the settings schema and the admission store share build chunks with provider and
	// session modules, which this leaf's static closure keeps out (instant-shell-import-graph pins it).
	const { readSettings } = await import("../core/config.js");
	try {
		readSettings();
	} catch {
		// A ledger with no rows needs no worktree root.
	}
	const { capacityDrain } = await import("../domains/dispatch/capacity-lease.js");
	return {
		generatedAt: new Date(nowMs).toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running: [],
		retrying: [],
		totals: emptyFleetTotals(),
	};
}

function isProcessAlive(pid: number | null): boolean {
	if (pid === null || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function rowHeartbeat(row: RunEnvelope): RunningRow["heartbeat"] {
	if (row.status === "stale") return "stale";
	if (row.status === "dead") return "dead";
	return isProcessAlive(row.pid) ? "alive" : "dead";
}

/**
 * The snapshot over ledger rows: the project scope (which reads the settings), the ledger, each visible run's
 * journal folded by the read model, then the admission gate. Only the light reader opens a run journal; the session
 * domain's loader would load the telemetry domain module and the dispatch extension behind it.
 */
async function ledgerSnapshot(all: boolean, nowMs: number): Promise<StatusSnapshot> {
	const [{ fleetInspectionScope }, { openLedger }, { readRunJournalSource }, { fleetTotals, runTelemetry }] =
		await Promise.all([
			import("./fleet-project-scope.js"),
			import("../domains/dispatch/state.js"),
			import("../domains/telemetry/run-journal-read.js"),
			import("../domains/telemetry/read-model.js"),
		]);
	const scope = fleetInspectionScope(all);
	const stateDir = clioStateDir();
	const now = new Date(nowMs);
	const records = openLedger()
		.list()
		.filter(scope.seesRun)
		.map((row) => ({ row, telemetry: runTelemetry(row.id, readRunJournalSource(stateDir, row.id), { now }) }));
	const { capacityDrain } = await import("../domains/dispatch/capacity-lease.js");
	return {
		generatedAt: now.toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running: records
			.filter(({ row }) => row.endedAt === null && (row.status === "running" || row.status === "stale"))
			.map(({ row, telemetry }) => ({
				runId: row.id,
				agentId: row.agentId,
				budget: row.budget ?? null,
				runtimeKind: row.runtimeKind,
				outcomePhase: row.status,
				heartbeat: rowHeartbeat(row),
				lineage: row.lineage ?? { parentRunId: null, rootRunId: row.id, attempt: 0, depth: 0 },
				startedAt: row.startedAt,
				elapsed: telemetry.activity.elapsed,
				tokens: telemetry.tokens,
				usd: telemetry.row.usd,
				node: row.node?.id ?? "local",
			})),
		retrying: [],
		totals: fleetTotals(records.map(({ telemetry }) => telemetry)),
	};
}

async function writeStatusText(out: StatusWriter, snapshot: StatusSnapshot): Promise<void> {
	const admission = snapshot.admission;
	out.write(`dispatch status @ ${snapshot.generatedAt} (ledger: ${clioStateDir()})\n`);
	out.write(
		admission.state === "draining"
			? `admission: draining until ${admission.expiresAt} (requested by pid ${admission.requestedByPid} at ${admission.requestedAt})\n`
			: "admission: open\n",
	);
	if (snapshot.running.length === 0) {
		out.write("running: none\n");
	} else {
		const budgets = snapshot.running.some((row) => row.budget !== null)
			? await import("../domains/dispatch/budget-envelope.js")
			: null;
		out.write("running:\n");
		for (const row of snapshot.running) {
			const lineage = row.lineage;
			out.write(
				`  ${row.runId}  ${row.agentId}  node=${row.node}  ${row.heartbeat}  attempt=${lineage.attempt} depth=${lineage.depth}  ${row.elapsed.display}  ${row.usd.display}\n`,
			);
			const budget = row.budget === null || budgets === null ? undefined : budgets.readRecordedBudgetEnvelope(row.budget);
			if (budget !== undefined && budgets !== null) {
				out.write(`    recipe policy: ${budgets.formatBudgetPolicy(budget)}\n`);
				out.write(`    requested envelope: ${budgets.formatBudgetRequest(budget)}\n`);
				out.write(`    effective envelope: ${budgets.formatEffectiveBudget(budget)}\n`);
				out.write(`    clamp or escalation reason: ${budgets.formatBudgetReasons(budget)}\n`);
			}
		}
	}
	if (snapshot.retrying.length === 0) {
		out.write("retrying: none (retry queue is in-memory and only visible in the owning process)\n");
	} else {
		out.write("retrying:\n");
		for (const row of snapshot.retrying) {
			out.write(`  ${row.runId}  ${row.agentId}  attempt=${row.attempt} due=${row.dueAt}  ${row.reason}\n`);
		}
	}
	const t = snapshot.totals;
	out.write(
		`totals: tokens=${t.total.display} (in=${t.input.display} out=${t.output.display}) cost=${t.usd.display} runtime=${t.elapsed.display}\n`,
	);
}

/** `fleet status` with the arguments after `status`; src/cli/index.ts and fleet.ts both answer it here. */
export async function runFleetStatus(
	flags: ReadonlyArray<string>,
	stdout: StatusWriter = process.stdout,
	stderr: StatusWriter = process.stderr,
): Promise<number> {
	const unknown = flags.find((arg) => arg !== "--json" && arg !== "--all");
	if (unknown) {
		stderr.write(`clio-coder fleet: status: unknown flag: ${unknown}\n`);
		return 2;
	}
	const nowMs = Date.now();
	const snapshot = ledgerHasNoRows() ? await emptySnapshot(nowMs) : await ledgerSnapshot(flags.includes("--all"), nowMs);
	if (flags.includes("--json")) {
		stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}
	await writeStatusText(stdout, snapshot);
	return 0;
}
