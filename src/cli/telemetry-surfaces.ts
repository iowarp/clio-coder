import { join } from "node:path";
import { listStateDirectorySync, withinStateRoot } from "../core/state-boundary.js";
import type { TelemetryRecord } from "../core/telemetry/envelope.js";
import { renderCountSum } from "../core/telemetry/render.js";
import { clioStateDir } from "../core/xdg.js";
import { readCallJournalSync } from "../domains/telemetry/call-journal.js";
import { telemetrySessionDirectory, telemetrySessionsDirectory } from "../domains/telemetry/paths.js";
import { foldSideSurfaces, type SideSurfacesFold, type SurfaceLedgerRow } from "../domains/telemetry/read-model.js";
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
ignored, moot, suppressed, exhausted, expired and the rest). A rule that only
reminds or notifies is count only. Without --session it folds every session
journal in the state directory. It reads structure only, never content. --json
emits the fold verbatim.
`;

function outcomesCell(row: SurfaceLedgerRow): string {
	if (row.settling === 0) return "count only";
	const parts = Object.entries(row.outcomes).map(([outcome, count]) => `${outcome} ${count}`);
	if (row.unsettled > 0) parts.push(`unsettled ${row.unsettled}`);
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

/** Every record of a session's journal, or of every session journal when none is named. */
function readRecords(stateDir: string, sessionId: string | null): TelemetryRecord[] {
	const directories =
		sessionId !== null
			? [telemetrySessionDirectory(stateDir, sessionId)]
			: listStateDirectorySync(stateDir, telemetrySessionsDirectory(stateDir))
					.map((name) => join(telemetrySessionsDirectory(stateDir), name))
					.filter((directory) => withinStateRoot(stateDir, directory))
					.sort();
	return directories.flatMap((directory) => readCallJournalSync(directory).records.map(({ record }) => record));
}

export function runTelemetrySurfaces(argv: ReadonlyArray<string>): number {
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
	let records: TelemetryRecord[];
	try {
		records = readRecords(stateDir, sessionId);
	} catch (error) {
		if (sessionId === null && (error as NodeJS.ErrnoException).code === "ENOENT") records = [];
		else return fail("io", `cannot read telemetry: ${error instanceof Error ? error.message : String(error)}`);
	}
	const fold = foldSideSurfaces(records);
	const scope = sessionId !== null ? `session ${sessionId}` : `every session journal in ${stateDir}`;
	process.stdout.write(
		json ? `${JSON.stringify({ scope, ...fold }, null, 2)}\n` : renderSurfaces(fold, `${scope} · structure only`),
	);
	return 0;
}
