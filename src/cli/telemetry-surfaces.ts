import { join } from "node:path";
import { listStateDirectorySync, statStatePathSync, withinStateRoot } from "../core/state-boundary.js";
import type { TelemetryRecord } from "../core/telemetry/envelope.js";
import { renderCountSum } from "../core/telemetry/render.js";
import { clioStateDir } from "../core/xdg.js";
import { readCallJournal } from "../domains/telemetry/call-journal.js";
import {
	telemetryRunDirectory,
	telemetryRunsDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "../domains/telemetry/paths.js";
import {
	foldSideSurfaces,
	SIDE_SURFACE_RECORD_KINDS,
	type SideSurfacesFold,
	type SurfaceLedgerRow,
} from "../domains/telemetry/read-model.js";
import { formatColumns } from "./argv.js";
import { writeCliFailure } from "./kit/json-out.js";
import { resolveSessionSelector } from "./telemetry-target.js";

export const SURFACES_HELP = `clio-coder telemetry surfaces [--session <id>] [--json]

surfaces lists every side surface (memory, compaction, the safety judge, triage,
prewarm and the rest) with its calls by disposition, its output tokens and how
many calls left them unknown, and its summed service time. A surface whose calls
never reached a model prints unexercised, never a pass. Below it, every
middleware rule and host surface that fired: firings, those that settle, how
many a request carried, and the outcomes they settled with (acted, recovered,
ignored, moot, suppressed, exhausted, expired and the rest). A rule whose
firings do not settle is count only; a firing drawn inside a worker run that its
run did not settle is shown as in workers, no ledger. With --session it folds
that session's journal and the run journals it links; without, every session
and run journal in the state directory, so a headless run --agent worker's
firings count under its run. A run journal that cannot be read is skipped and
counted. It reads structure only, never content. --json emits the fold verbatim.
`;

function outcomesCell(row: SurfaceLedgerRow): string {
	if (row.settling === 0) return "count only";
	const parts = Object.entries(row.outcomes).map(([outcome, count]) => `${outcome} ${count}`);
	if (row.unsettled > 0) parts.push(`unsettled ${row.unsettled}`);
	if (row.unledgered > 0) parts.push(`in workers, no ledger ${row.unledgered}`);
	if (row.duplicates > 0) parts.push(`duplicate settlements ${row.duplicates}`);
	return parts.join(", ");
}

function renderSurfaces(fold: SideSurfacesFold, scope: string): string {
	const side = formatColumns([
		["surface", "status", "calls", "never sent", "unsettled", "output tokens", "service ms"],
		...fold.surfaces.map((surface) => [
			surface.surface,
			surface.status,
			String(surface.totals.attempts),
			String(surface.totals.neverSent),
			String(surface.totals.sentUnsettled),
			renderCountSum(surface.totals.usage.output),
			String(Math.round(surface.serviceMs)),
		]),
	]).trimEnd();
	const residual = fold.residual.map(
		(row) =>
			`unattributed ${row.role} calls: ${row.totals.attempts}, output tokens ${renderCountSum(row.totals.usage.output)}`,
	);
	const ledger =
		fold.ledger.length === 0
			? "no middleware rule or host surface fired"
			: formatColumns([
					["fired by", "fired", "settling", "admitted", "outcomes"],
					...fold.ledger.map((row) => [
						row.surface,
						String(row.fired),
						String(row.settling),
						String(row.admitted),
						outcomesCell(row),
					]),
				]).trimEnd();
	return `${scope}\n\n${side}\n${residual.length > 0 ? `${residual.join("\n")}\n` : ""}\n${ledger}\n`;
}

/** The scope directories beneath one telemetry root, sorted; a stray file is no scope, and a missing root holds none. */
function scopeDirectories(stateDir: string, root: string): string[] {
	let names: string[];
	try {
		names = listStateDirectorySync(stateDir, root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names
		.map((name) => join(root, name))
		.filter(
			(directory) =>
				withinStateRoot(stateDir, directory) && statStatePathSync(stateDir, directory)?.isDirectory() === true,
		)
		.sort();
}

/** What the fold reads, plus the links `--session` follows to its runs. */
const WANTED: readonly string[] = [...SIDE_SURFACE_RECORD_KINDS, "run.linked"];

/** The surfaces fold over a scope, with how many run journals could not be read and were left out. */
export interface SurfacesReport {
	scope: string;
	unreadableRuns: number;
	fold: SideSurfacesFold;
}

/**
 * Fold a session's journal and the runs it links, or every session and run journal when none is named. A run's records
 * live only in its own journal (the session holds its `run.linked`), so each firing is read once and keys as
 * `run:<runId>` whether a session dispatched the run or a headless `run --agent` owned it. Each journal is read
 * filtered to the kinds the fold uses, one scope at a time, and a run journal that cannot be read is skipped and
 * counted, as the session telemetry source does, instead of failing the whole fold.
 */
export async function loadSurfacesReport(stateDir: string, sessionId: string | null): Promise<SurfacesReport> {
	const records: TelemetryRecord[] = [];
	let unreadableRuns = 0;
	const read = async (directory: string): Promise<void> => {
		for (const { record } of (await readCallJournal(directory, WANTED)).records) records.push(record);
	};
	const readRun = async (directory: () => string): Promise<void> => {
		try {
			const path = directory();
			if (!withinStateRoot(stateDir, path)) throw new Error("run journal outside the state root");
			await read(path);
		} catch {
			unreadableRuns += 1;
		}
	};
	if (sessionId === null) {
		for (const directory of scopeDirectories(stateDir, telemetrySessionsDirectory(stateDir))) await read(directory);
		for (const directory of scopeDirectories(stateDir, telemetryRunsDirectory(stateDir))) await readRun(() => directory);
	} else {
		await read(telemetrySessionDirectory(stateDir, sessionId));
		const runs = new Set<string>();
		for (const record of records)
			if (record.k === "run.linked" || record.k === "call.linked") runs.add(record.data.runId);
		for (const runId of runs) await readRun(() => telemetryRunDirectory(stateDir, runId));
	}
	return {
		scope:
			sessionId !== null ? `session ${sessionId} and the runs it links` : `every session and run journal in ${stateDir}`,
		unreadableRuns,
		fold: foldSideSurfaces(records),
	};
}

export async function runTelemetrySurfaces(argv: ReadonlyArray<string>): Promise<number> {
	let session: string | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--json") json = true;
		else if (arg === "--session" && session === undefined && argv[index + 1]?.startsWith("--") === false) {
			session = argv[index + 1];
			index += 1;
		} else if (!arg.startsWith("--") && session === undefined) session = arg;
		else {
			writeCliFailure({
				path: ["telemetry", "surfaces"],
				slug: arg.startsWith("--") && arg !== "--session" ? "unknown_flag" : "usage",
				message: arg === "--session" ? "--session needs one id" : `unexpected argument: ${arg}`,
				json: argv.includes("--json"),
			});
			return 2;
		}
	}
	const fail = (slug: "not_found" | "ambiguous" | "io", message: string): number => {
		writeCliFailure({ path: ["telemetry", "surfaces"], slug, message, json });
		return 1;
	};
	const stateDir = clioStateDir();
	let sessionId: string | null = null;
	if (session !== undefined) {
		const selected = resolveSessionSelector(stateDir, session);
		if ("miss" in selected)
			return fail(selected.miss.startsWith("no session") ? "not_found" : "ambiguous", selected.miss);
		sessionId = selected.id;
	}
	let report: SurfacesReport;
	try {
		report = await loadSurfacesReport(stateDir, sessionId);
	} catch (error) {
		return fail("io", `cannot read telemetry: ${error instanceof Error ? error.message : String(error)}`);
	}
	const { scope, unreadableRuns, fold } = report;
	const skipped = unreadableRuns > 0 ? `\n${unreadableRuns} unreadable run journal(s) skipped` : "";
	process.stdout.write(
		json
			? `${JSON.stringify({ scope, unreadableRuns, ...fold }, null, 2)}\n`
			: renderSurfaces(fold, `${scope} · structure only${skipped}`),
	);
	return 0;
}
