/**
 * `clio-coder fleet view <runId> [--follow]`.
 *
 * A read-only viewer for one dispatched run, built from durable state only:
 * the run ledger envelope, the run event journal
 * (src/domains/dispatch/run-event-journal.ts), and the sealed receipt once one
 * exists. It shares no memory with the orchestrator, has zero dependency on any
 * pane host, and works over a plain SSH session.
 *
 * Everything the viewer prints comes from `renderRunView`, a pure function over
 * a `RunViewModel`. `--follow` paints that same output into an alternate screen
 * and re-polls the journal at the monitor tool's `WAIT_POLL_MS` cadence until
 * the journal's terminal line lands; it then stays open until `q`. Without
 * `--follow` the snapshot goes to stdout and the process exits.
 *
 * Trust rules the render obeys:
 *   - The receipt is authenticated against the ledger envelope through
 *     `inspectRunReceiptTrustStatus` before any of its fields are shown. A
 *     receipt that fails integrity contributes its failure reason and nothing
 *     else.
 *   - Task text is operator-supplied and worker-adjacent, so it is sanitized
 *     and bounded before rendering, per the `DispatchRunIdentity` warning in
 *     src/core/bus-events.ts:524. Journal event details cross the same seam and
 *     get the same treatment.
 *
 * Terminal primitives come from src/engine/tui-primitives.ts, never from the
 * src/engine/tui.js barrel, and that is load-bearing. See the header of
 * tui-primitives.ts for why an edge from here to the barrel breaks the Stage 0
 * instant-shell chunk budget.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../core/xdg.js";
import {
	type RunEventJournalLine,
	readRunEventJournal,
	runEventJournalPath,
} from "../domains/dispatch/run-event-journal.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { formatTrustSummaryLine } from "../domains/evidence/trust-projection.js";
import { inspectRunReceiptTrustStatus } from "../domains/evidence/trust-status.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth } from "../engine/tui-primitives.js";

const HELP = `clio-coder fleet view <runId> [--follow]

Follow one dispatched run from its durable state: the run ledger entry, the
run event journal, and the sealed receipt once it exists.

  --follow    keep tailing until the run's terminal line, then stay open (q exits)

Without --follow the current snapshot is printed and the command exits.
The transcript comes from <state>/runs/<runId>/events.ndjson, which the
orchestrator writes when panes.journal is on (the default). A run dispatched
with the journal off shows its ledger and receipt but no transcript.
`;

/** Journal poll cadence, matching WAIT_POLL_MS in src/tools/monitor.ts. */
const POLL_MS = 250;
/** Transcript lines kept in the model. Older lines are dropped from the head. */
const TRANSCRIPT_LIMIT = 400;
/** Visible width cap for one sanitized task line before the renderer wraps it. */
const TASK_MAX_WIDTH = 400;
/** Visible width cap for one sanitized journal detail. */
const DETAIL_MAX_WIDTH = 200;
const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 40;
/** Raw-mode Ctrl-C arrives as a byte, not as SIGINT, so the follow loop matches it. */
const QUIT_CTRL_C = String.fromCharCode(3);
const QUIT_ESCAPE = String.fromCharCode(27);

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface RunViewTranscriptLine {
	at: string;
	label: string;
	detail: string | undefined;
}

export interface RunViewModel {
	runId: string;
	agentId: string;
	model: string;
	target: string;
	node: string;
	phase: string;
	startedAt: string;
	elapsedMs: number;
	task: string | undefined;
	transcript: RunViewTranscriptLine[];
	/** True when the writer dropped display lines or the reader skipped a head. */
	transcriptTruncated: boolean;
	journalPresent: boolean;
	journalPath: string;
	/** Authenticated receipt status line, or the reason there is not one. */
	evidence: string;
	receiptPath: string | null;
	outcome: string | null;
	outcomeDetail: string | null;
	/** True once the journal carries its terminal line or the ledger row ended. */
	terminal: boolean;
}

function sanitizeBounded(value: string, maxWidth: number): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "";
	// truncateToWidth appends reset sequences when it elides, so the result goes
	// back through the sanitizer and stays plain text.
	return sanitizeCallTargetText(truncateToWidth(sanitized, maxWidth, "…", false));
}

function receiptPathFor(run: RunEnvelope): string {
	return run.receiptPath ?? join(clioStateDir(), "receipts", `${run.id}.json`);
}

/**
 * Authenticate the receipt, then reduce it to one status line in the shared
 * trust vocabulary. Nothing from an unauthenticated receipt reaches the line
 * beyond the reason it could not be trusted.
 */
function evidenceLine(run: RunEnvelope): { text: string; receiptPath: string | null } {
	if (run.receiptPath === null && run.endedAt === null) {
		return { text: "receipt pending; the run has not finalized", receiptPath: null };
	}
	const path = receiptPathFor(run);
	let receipt: RunReceipt;
	try {
		receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
	} catch (error) {
		return {
			text: `receipt unavailable: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`,
			receiptPath: null,
		};
	}
	const inspection = inspectRunReceiptTrustStatus(receipt, run);
	if (!inspection.integrity.ok) {
		return {
			text: `RECEIPT INTEGRITY FAILED: ${inspection.integrity.reason}; stored receipt fields are untrusted`,
			receiptPath: path,
		};
	}
	return { text: formatTrustSummaryLine(inspection.status), receiptPath: path };
}

function transcriptLine(line: RunEventJournalLine): RunViewTranscriptLine | null {
	switch (line.kind) {
		case "open":
			return { at: line.at, label: `run opened (${sanitizeBounded(line.agentId, 64)})`, detail: undefined };
		case "event":
			return {
				at: line.at,
				label: sanitizeBounded(line.type, 64),
				detail: line.detail === undefined ? undefined : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH),
			};
		case "journal_truncated":
			return { at: line.at, label: "journal truncated", detail: sanitizeBounded(line.reason, 64) };
		case "receipt":
			return {
				at: line.at,
				label: `receipt sealed (${sanitizeBounded(line.outcome, 32)})`,
				detail: line.digest === undefined ? undefined : `sha256:${sanitizeBounded(line.digest, 64)}`,
			};
		case "terminal":
			return {
				at: line.at,
				label: `terminal (${sanitizeBounded(line.outcome, 32)})`,
				detail: line.detail === undefined ? undefined : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH),
			};
		default:
			return null;
	}
}

export interface LoadRunViewOptions {
	/** Journal root override; defaults to `<state>/runs`. */
	journalRoot?: string;
	now?: () => number;
}

/**
 * Resolve a run id the way `fleet status` prints them: an exact ledger id
 * first, then a unique prefix. An ambiguous prefix resolves to nothing so the
 * caller can say which ids it matched.
 */
export function resolveRunId(runId: string): { runId: string } | { candidates: string[] } {
	const ledger = openLedger();
	if (ledger.get(runId) !== null) return { runId };
	const candidates = ledger
		.list()
		.filter((run) => run.id.startsWith(runId))
		.map((run) => run.id);
	if (candidates.length === 1 && candidates[0] !== undefined) return { runId: candidates[0] };
	return { candidates };
}

export function loadRunViewModel(runId: string, options: LoadRunViewOptions = {}): RunViewModel | null {
	const run = openLedger().get(runId);
	if (run === null) return null;
	const now = options.now ?? (() => Date.now());
	const journal = readRunEventJournal(runId, {
		maxLines: TRANSCRIPT_LIMIT,
		...(options.journalRoot === undefined ? {} : { root: options.journalRoot }),
	});
	const transcript: RunViewTranscriptLine[] = [];
	for (const line of journal.lines) {
		const rendered = transcriptLine(line);
		if (rendered !== null) transcript.push(rendered);
	}
	const evidence = evidenceLine(run);
	const startedMs = Date.parse(run.startedAt);
	const endedMs = run.endedAt === null ? now() : Date.parse(run.endedAt);
	const task = sanitizeBounded(run.task, TASK_MAX_WIDTH);
	return {
		runId: run.id,
		agentId: run.agentId,
		model: run.wireModelId,
		target: run.targetId,
		node: run.node?.id ?? "local",
		phase: run.outcome ?? run.status,
		startedAt: run.startedAt,
		elapsedMs: Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0,
		task: task.length > 0 ? task : undefined,
		transcript,
		transcriptTruncated: journal.truncated,
		journalPresent: journal.present,
		journalPath: runEventJournalPath(runId, options.journalRoot === undefined ? undefined : options.journalRoot),
		evidence: evidence.text,
		receiptPath: evidence.receiptPath,
		outcome: journal.terminal?.outcome ?? run.outcome ?? null,
		outcomeDetail: journal.terminal?.detail ?? run.outcomeDetail ?? null,
		terminal: journal.terminal !== null || run.endedAt !== null,
	};
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function clockOf(iso: string): string {
	// The transcript is a within-run timeline, so the date carries no
	// information the header does not already give.
	const time = iso.slice(11, 19);
	return time.length === 8 ? time : iso.slice(0, 8);
}

/**
 * The whole viewer surface as lines. Pure: given the same model and width it
 * returns the same strings, which is what lets the data-source test assert the
 * header and outcome without a PTY.
 */
export function renderRunView(model: RunViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = "─".repeat(columns);
	const lines: string[] = [];
	lines.push(truncateToWidth(`run ${model.runId}  ${model.agentId}`, columns, "…", false));
	lines.push(
		truncateToWidth(
			`model ${model.model}  target ${model.target}  node ${model.node}  phase ${model.phase}  elapsed ${formatElapsed(model.elapsedMs)}`,
			columns,
			"…",
			false,
		),
	);
	if (model.task !== undefined) {
		lines.push(truncateToWidth(`task ${model.task}`, columns, "…", false));
	}
	lines.push(rule);
	if (!model.journalPresent) {
		lines.push("no event journal for this run.");
		lines.push(`expected ${model.journalPath} (panes.journal may have been off when it ran)`);
	} else if (model.transcript.length === 0) {
		lines.push("journal is empty; no events recorded yet.");
	} else {
		if (model.transcriptTruncated) lines.push("… earlier events dropped (journal truncated)");
		for (const entry of model.transcript) {
			const head = `${clockOf(entry.at)} ${entry.label}`;
			lines.push(truncateToWidth(entry.detail === undefined ? head : `${head}: ${entry.detail}`, columns, "…", false));
		}
	}
	lines.push(rule);
	lines.push(truncateToWidth(`evidence  ${model.evidence}`, columns, "…", false));
	if (model.receiptPath !== null) {
		lines.push(truncateToWidth(`receipt   ${model.receiptPath}`, columns, "…", false));
	}
	const outcome =
		model.outcome === null
			? model.terminal
				? "terminal, outcome not recorded"
				: "running"
			: model.outcomeDetail === null || model.outcomeDetail.length === 0
				? model.outcome
				: `${model.outcome} (${sanitizeBounded(model.outcomeDetail, DETAIL_MAX_WIDTH)})`;
	lines.push(truncateToWidth(`outcome   ${outcome}`, columns, "…", false));
	return lines;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function fail(message: string): number {
	process.stderr.write(`clio-coder fleet view: ${message}\n`);
	return 2;
}

interface ParsedViewArgs {
	runId?: string;
	follow: boolean;
	help: boolean;
}

function parseViewArgs(args: ReadonlyArray<string>): ParsedViewArgs | string {
	const parsed: ParsedViewArgs = { follow: false, help: false };
	for (const arg of args) {
		if (arg === "--follow" || arg === "-f") {
			parsed.follow = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg.startsWith("-")) return `unknown flag: ${arg}`;
		if (parsed.runId !== undefined) return `unexpected argument: ${arg}`;
		parsed.runId = arg;
	}
	return parsed;
}

function terminalWidth(): number {
	const columns = process.stdout.columns;
	return typeof columns === "number" && columns >= MIN_WIDTH ? columns : DEFAULT_WIDTH;
}

export async function runFleetView(args: ReadonlyArray<string>): Promise<number> {
	const parsed = parseViewArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`clio-coder fleet view: ${parsed}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.runId === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	const resolved = resolveRunId(parsed.runId);
	if (!("runId" in resolved)) {
		return resolved.candidates.length === 0
			? fail(`unknown run '${parsed.runId}' (not in the run ledger under ${clioStateDir()})`)
			: fail(`run id '${parsed.runId}' is ambiguous: ${resolved.candidates.slice(0, 8).join(", ")}`);
	}
	const runId = resolved.runId;
	const snapshot = loadRunViewModel(runId);
	if (snapshot === null) return fail(`unknown run '${runId}'`);

	// A non-TTY stdout has no alternate screen and no keypresses, so --follow
	// there would spin without ever being readable or quittable. Print the
	// snapshot and say why, rather than hanging a pipe.
	if (!parsed.follow || process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
		if (parsed.follow) {
			process.stderr.write("clio-coder fleet view: --follow needs an interactive terminal; printing a snapshot\n");
		}
		process.stdout.write(`${renderRunView(snapshot, terminalWidth()).join("\n")}\n`);
		return 0;
	}
	return followRun(runId);
}

/**
 * Alternate-screen follow loop on the Clio terminal-engine primitives. The
 * component is a plain line source over the same pure renderer the snapshot
 * path uses, so the two surfaces cannot drift.
 */
async function followRun(runId: string): Promise<number> {
	const { ProcessTerminal, TuiAltScreen } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let model = loadRunViewModel(runId);
	let following = true;

	const view = {
		render(width: number): string[] {
			if (model === null) return [`run ${runId} left the ledger.`];
			const lines = renderRunView(model, width);
			lines.push("");
			lines.push(following ? "following… q to quit" : "run finished. q to quit");
			return lines;
		},
		invalidate(): void {},
	};
	tui.addChild(view);

	return await new Promise<number>((resolve) => {
		let settled = false;
		const timer = setInterval(() => {
			model = loadRunViewModel(runId);
			if (model?.terminal === true) following = false;
			tui.requestRender();
		}, POLL_MS);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			removeInput();
			tui.stop();
			resolve(0);
		};
		const removeInput = tui.addInputListener((data: string) => {
			// The terminal is in raw mode, so Ctrl-C arrives as a byte rather than
			// as SIGINT and has to be honored here.
			if (data === "q" || data === QUIT_CTRL_C || data === QUIT_ESCAPE) {
				finish();
				return { consume: true };
			}
			return undefined;
		});
		tui.start();
		tui.requestRender();
	});
}
