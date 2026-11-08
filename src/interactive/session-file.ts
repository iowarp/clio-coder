import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Quantity } from "../core/telemetry/dto.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";

/** How the session ended: `/quit`, ctrl+c or a terminating signal, or anything else that ended the process. */
export type SessionFileOutcome = "quit" | "interrupted" | "crashed";

/** One usage figure as the telemetry read model reports it: its words and its fact, never re-added here. */
export interface SessionFileQuantity {
	display: string;
	fact: Quantity["fact"];
}

/** The `--session-file` record. Version 1; a consumer should reject a version it does not know. */
export interface SessionFileRecord {
	version: 1;
	/** Null when the session never reached a model turn, so no session was created. */
	sessionId: string | null;
	sessionName: string | null;
	outcome: SessionFileOutcome;
	exitCode: number | null;
	usage: { tokens: SessionFileQuantity; cost: SessionFileQuantity } | null;
	/** The last model the session used, or null when it used none. */
	model: { target: string; model: string } | null;
	models: ReadonlyArray<{ target: string; model: string }>;
	turns: number;
	cwd: string;
	endedAt: string;
}

const SIGNAL_EXIT_CODES: ReadonlySet<number> = new Set([129, 130, 143]);

/** The outcome a process exit code stands for when no clean exit recorded one first. */
export function sessionFileOutcomeForExitCode(code: number): SessionFileOutcome {
	if (code === 0) return "quit";
	return SIGNAL_EXIT_CODES.has(code) ? "interrupted" : "crashed";
}

function sessionFileRecord(input: {
	snapshot: ExitSummarySnapshot | null;
	outcome: SessionFileOutcome;
	exitCode: number | null;
	cwd: string;
	endedAt: Date;
}): SessionFileRecord {
	const { snapshot } = input;
	const spend = snapshot?.spend;
	const models = snapshot?.models ?? [];
	return {
		version: 1,
		sessionId: snapshot?.sessionId ?? null,
		sessionName: snapshot?.sessionName ?? null,
		outcome: input.outcome,
		exitCode: input.exitCode,
		usage:
			spend?.kind === "ready"
				? {
						tokens: { display: spend.totals.tokens.display, fact: spend.totals.tokens.fact },
						cost: { display: spend.totals.usd.display, fact: spend.totals.usd.fact },
					}
				: null,
		model: models.at(-1) ?? null,
		models: [...models],
		turns: snapshot?.turns ?? 0,
		cwd: input.cwd,
		endedAt: input.endedAt.toISOString(),
	};
}

/**
 * Write the record beside its destination and rename it into place, so a reader sees the whole record or none.
 * The path is the caller's; only its missing parent directories are created.
 */
function writeSessionFile(path: string, record: SessionFileRecord): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export interface SessionFileRecorder {
	/** Write the record once; later calls do nothing. False when this call did not write it. */
	record(outcome: SessionFileOutcome, exitCode: number | null): boolean;
}

/** The exit paths race (clean exit, signal drain, process exit), so the first to arrive writes and the rest are no-ops. */
export function createSessionFileRecorder(deps: {
	path: string;
	snapshot: () => ExitSummarySnapshot | null;
	cwd: string;
	now?: () => Date;
	warn?: (line: string) => void;
}): SessionFileRecorder {
	let done = false;
	return {
		record(outcome, exitCode) {
			if (done) return false;
			done = true;
			try {
				let snapshot: ExitSummarySnapshot | null = null;
				try {
					snapshot = deps.snapshot();
				} catch {
					// A session that cannot be read at exit still gets its outcome on record.
				}
				const endedAt = deps.now?.() ?? new Date();
				writeSessionFile(deps.path, sessionFileRecord({ snapshot, outcome, exitCode, cwd: deps.cwd, endedAt }));
				return true;
			} catch (error) {
				(deps.warn ?? ((line) => process.stderr.write(`${line}\n`)))(
					`Clio Coder: could not write the session record to ${deps.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			}
		},
	};
}
