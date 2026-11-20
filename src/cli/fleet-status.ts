/**
 * `clio-coder fleet status [--json] [--all]` answered before src/cli/fleet.ts and its domain graph load, the way
 * fleet-help.ts answers the group help. A status with no ledger rows needs no per-run telemetry, so this leaf reads
 * the run ledger's file, the settings (for the warning fleet.ts prints) and the admission gate, and renders the
 * board through the same writers fleet.ts uses. Any ledger row, or a ledger it cannot read, hands the command back
 * to fleet.ts unchanged: per-run telemetry loads the session and telemetry domains.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sumFactSums } from "../core/telemetry/pricing.js";
import { renderCountSum, renderDurationSum, renderUsdSum } from "../core/telemetry/render.js";
import { clioStateDir } from "../core/xdg.js";
import type { CapacityDrain } from "../domains/dispatch/capacity-lease.js";

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

/** The board's first lines: the snapshot time, the ledger location and the admission gate. */
export function writeStatusHeader(out: StatusWriter, generatedAt: string, admission: FleetAdmissionStatus): void {
	out.write(`dispatch status @ ${generatedAt} (ledger: ${clioStateDir()})\n`);
	out.write(
		admission.state === "draining"
			? `admission: draining until ${admission.expiresAt} (requested by pid ${admission.requestedByPid} at ${admission.requestedAt})\n`
			: "admission: open\n",
	);
}

type Displayed = { display: string };

/** The board's last lines: the retry queue and the fleet totals. */
export function writeStatusFooter(
	out: StatusWriter,
	retrying: ReadonlyArray<Record<string, unknown>>,
	totals: { total: Displayed; input: Displayed; output: Displayed; usd: Displayed; elapsed: Displayed },
): void {
	if (retrying.length === 0) {
		out.write("retrying: none (retry queue is in-memory and only visible in the owning process)\n");
	} else {
		out.write("retrying:\n");
		for (const row of retrying) {
			out.write(`  ${row.runId}  ${row.agentId}  attempt=${row.attempt} due=${row.dueAt}  ${row.reason}\n`);
		}
	}
	const t = totals;
	out.write(
		`totals: tokens=${t.total.display} (in=${t.input.display} out=${t.output.display}) cost=${t.usd.display} runtime=${t.elapsed.display}\n`,
	);
}

/**
 * Whether runs.json holds no row by the ledger's own reading (src/domains/dispatch/state.ts readRuns): no file, an
 * empty file, a document that is not an array, or an empty array. A file that does not read or parse answers false,
 * so fleet.ts raises the error it always raised.
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
 * Answer `fleet status` when the ledger has no rows; null hands every other fleet verb, and a status with rows, to
 * fleet.ts. The steps and their side effects follow fleet.ts runStatus: the flag check, the settings read (a
 * settings warning still prints), then the admission gate through its owner, which takes the state lock and clears
 * an expired drain.
 */
export async function answerFleetStatus(
	args: ReadonlyArray<string>,
	stdout: StatusWriter = process.stdout,
	stderr: StatusWriter = process.stderr,
): Promise<number | null> {
	if (args[0] !== "status") return null;
	const flags = args.slice(1);
	const unknown = flags.find((arg) => arg !== "--json" && arg !== "--all");
	if (unknown) {
		stderr.write(`clio-coder fleet: status: unknown flag: ${unknown}\n`);
		return 2;
	}
	const nowMs = Date.now();
	if (!ledgerHasNoRows()) return null;
	// Loaded here, not imported: the settings schema and the admission store share build chunks with provider and
	// session modules, which this leaf's static closure keeps out (instant-shell-import-graph pins it).
	const { readSettings } = await import("../core/config.js");
	try {
		readSettings();
	} catch {
		// fleet.ts reads settings only for the worktree root and ignores a failure; a ledger with no rows needs neither.
	}
	const { capacityDrain } = await import("../domains/dispatch/capacity-lease.js");
	const snapshot = {
		generatedAt: new Date(nowMs).toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running: [] as Array<Record<string, unknown>>,
		retrying: [] as Array<Record<string, unknown>>,
		totals: emptyFleetTotals(),
	};
	if (flags.includes("--json")) {
		stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}
	writeStatusHeader(stdout, snapshot.generatedAt, snapshot.admission);
	stdout.write("running: none\n");
	writeStatusFooter(stdout, snapshot.retrying, snapshot.totals);
	return 0;
}
