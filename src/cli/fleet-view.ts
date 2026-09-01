/**
 * `clio-coder fleet view <runId|fleetRootId> [--follow]`.
 *
 * Given a fleet root id it renders a step index instead; see the fleet root
 * index section below for why a root cannot be rendered as a run.
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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir, resetXdgCache } from "../core/xdg.js";
import type { ExecutionStepResult } from "../domains/dispatch/execution-scheduler.js";
import {
	type RunEventJournalLine,
	readRunEventJournal,
	runEventJournalPath,
} from "../domains/dispatch/run-event-journal.js";
import { openLedger, readFleetRun } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { formatTrustSummaryLine } from "../domains/evidence/trust-projection.js";
import { inspectRunReceiptTrustStatus } from "../domains/evidence/trust-status.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui-primitives.js";

const HELP = `clio-coder fleet view <runId|fleetRootId> [--follow]
clio-coder fleet view --watch <selection-file>

Follow one dispatched run from its durable state: the run ledger entry, the
run event journal, and the sealed receipt once it exists.

  --follow    keep tailing until the run's terminal line, then stay open (q exits)
  --watch     follow whichever run id the selection file names, retargeting
              live as the file changes (q exits). This is the process the
              interactive workers view (Alt+W) runs inside its watch pane.

Without --follow the current snapshot is printed and the command exits.
The transcript comes from <state>/runs/<runId>/events.ndjson, which the
orchestrator writes when panes.journal is on (the default). A run dispatched
with the journal off shows its ledger and receipt but no transcript.

Given the fleet root id that \`fleet run\` prints (fleet-<hex>), this prints the
run's step index instead: one line per step with its run id and outcome. Pass
one of those run ids back to see that step.
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

/** Wrap a viewer value inside the columns left by its one-time field label. */
function wrapViewerValue(prefix: string, value: string, columns: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, columns - prefixWidth);
	return wrapTextWithAnsi(value, valueWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
	);
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
		lines.push(...wrapViewerValue("task ", model.task, columns));
	}
	lines.push(rule);
	if (!model.journalPresent) {
		lines.push("no event journal for this run.");
		lines.push(
			...wrapViewerValue("expected ", `${model.journalPath} (panes.journal may have been off when it ran)`, columns),
		);
	} else if (model.transcript.length === 0) {
		lines.push("journal is empty; no events recorded yet.");
	} else {
		if (model.transcriptTruncated) lines.push("… earlier events dropped (journal truncated)");
		for (const entry of model.transcript) {
			const head = `${clockOf(entry.at)} ${entry.label}`;
			if (entry.detail === undefined) lines.push(truncateToWidth(head, columns, "…", false));
			else lines.push(...wrapViewerValue(`${head}: `, entry.detail, columns));
		}
	}
	lines.push(rule);
	lines.push(...wrapViewerValue("evidence  ", model.evidence, columns));
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
	lines.push(...wrapViewerValue("outcome   ", outcome, columns));
	return lines;
}

/**
 * The watch surface as lines. Pure for the same reason {@link renderRunView}
 * is. A missing selection and a selection the ledger does not know yet are the
 * two states the run renderer cannot say anything about, and both are normal:
 * the first is the pane before any worker was entered, the second is a queued
 * run the operator selected before its ledger row landed.
 */
export function renderWatchView(
	runId: string | null,
	model: RunViewModel | null,
	width: number = DEFAULT_WIDTH,
	ledgerRoot: string = clioStateDir(),
): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	if (runId === null) {
		return [
			"no worker selected.",
			"",
			"In clio-coder, open the workers view (Alt+W), pick a run, press Enter.",
			"Arrow keys there retarget this pane live.",
		];
	}
	if (model === null) {
		const missing = `run ${sanitizeBounded(runId, 64)} is not in the run ledger under ${ledgerRoot}.`;
		const wrappedMissing: string[] = [];
		for (let offset = 0; offset < missing.length; offset += columns) {
			wrappedMissing.push(missing.slice(offset, offset + columns));
		}
		return [
			...wrappedMissing,
			"",
			"If this run is queued, it has not started yet; this view will update when its ledger entry appears.",
			"If it already started or finished, it was not found in this ledger.",
		];
	}
	return renderRunView(model, columns);
}

// ---------------------------------------------------------------------------
// Fleet root index
// ---------------------------------------------------------------------------

/**
 * `fleet run` advertises a root id (`fleet-<hex>`) that names the whole run,
 * while the ledger and this viewer are keyed by the 12-character run id of one
 * dispatched step. An operator who copies the id off the end of `fleet run` was
 * being told "unknown run".
 *
 * The root is not a run and has no ledger row, no receipt, and no journal of
 * its own, so it cannot be rendered as one. What it does have is a durable
 * record under `<state>/fleet-runs/<rootId>.json` listing the planned steps and,
 * for each step that settled, the run id it terminated on. That is enough for an
 * index: one line per step naming the run id to view next. Deliberately not a
 * combined transcript. Steps interleave across waves, and splicing several runs
 * into one scroll would invent an ordering the durable record does not have.
 */

/** Fleet root ids are `fleet-` plus hex; see newFleetRootId in src/cli/fleet.ts. */
const FLEET_ROOT_PREFIX = "fleet-";
/** Visible cap for one sanitized step name before the index elides it. */
const STEP_ID_MAX_WIDTH = 32;

export interface FleetRunStepRow {
	stepId: string;
	/** The run the step terminated on, or null when the step never ran. */
	runId: string | null;
	agentId: string | null;
	outcome: string;
	detail: string | undefined;
}

export interface FleetRunViewModel {
	rootId: string;
	fleet: string;
	startedAt: string;
	elapsedMs: number;
	/** True while the record carries no end stamp. */
	running: boolean;
	resumedFrom: string | null;
	plannedSteps: number;
	recordedSteps: number;
	steps: FleetRunStepRow[];
}

function fleetRunsDir(): string {
	// Mirrors fleetRunPath() in src/domains/dispatch/state.ts, which is private
	// to that module; only the directory is needed here, for prefix resolution
	// and for naming the path in a "no such root" message.
	return join(clioStateDir(), "fleet-runs");
}

/**
 * Resolve a fleet root the way {@link resolveRunId} resolves a run: exact id
 * first, then a unique prefix over the durable fleet-run records. An ambiguous
 * prefix resolves to nothing so the caller can name what it matched.
 */
export function resolveFleetRootId(token: string): { rootId: string } | { candidates: string[] } {
	if (readFleetRun(token) !== null) return { rootId: token };
	let entries: string[];
	try {
		entries = readdirSync(fleetRunsDir());
	} catch {
		return { candidates: [] };
	}
	const candidates = entries
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.filter((id) => id.startsWith(token));
	if (candidates.length === 1 && candidates[0] !== undefined) return { rootId: candidates[0] };
	return { candidates };
}

/**
 * Read defensively. A fleet-run record is written by an older or newer build
 * than the one reading it, and a missing field must cost the index one column,
 * never the whole listing.
 */
function stepResultOf(value: unknown): Partial<ExecutionStepResult> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ExecutionStepResult) : {};
}

export function loadFleetRunViewModel(rootId: string, options: { now?: () => number } = {}): FleetRunViewModel | null {
	const record = readFleetRun(rootId);
	if (record === null) return null;
	const ledger = openLedger();
	const now = options.now ?? (() => Date.now());
	const settled = new Map<string, Partial<ExecutionStepResult>>();
	for (const entry of record.steps ?? []) {
		if (typeof entry?.stepId === "string") settled.set(entry.stepId, stepResultOf(entry.result));
	}
	// Planned order, not settle order: it is the order the operator wrote the
	// fleet in, and a step that never ran still belongs on the index.
	const stepIds = record.stepIds?.length > 0 ? record.stepIds : [...settled.keys()];
	const steps: FleetRunStepRow[] = stepIds.map((stepId) => {
		const result = settled.get(stepId);
		const runId = typeof result?.terminalRunId === "string" ? result.terminalRunId : null;
		if (result === undefined || runId === null) {
			return { stepId, runId: null, agentId: null, outcome: "not run", detail: undefined };
		}
		const envelope = ledger.get(runId);
		const outcome = envelope?.outcome ?? (result.succeeded === true ? "succeeded" : "failed");
		const detail = result.boundaryViolated === true ? WRITE_BOUNDARY_VIOLATION_REASON : result.failureReason;
		return {
			stepId,
			runId,
			agentId: envelope?.agentId ?? null,
			outcome,
			detail: typeof detail === "string" && detail.length > 0 ? detail : undefined,
		};
	});
	const startedMs = Date.parse(record.startedAt);
	const endedMs = record.endedAt === null ? now() : Date.parse(record.endedAt);
	return {
		rootId: record.id,
		fleet: record.fleet,
		startedAt: record.startedAt,
		elapsedMs: Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0,
		running: record.endedAt === null,
		resumedFrom: record.resumedFrom,
		plannedSteps: stepIds.length,
		recordedSteps: settled.size,
		steps,
	};
}

/**
 * The step index as lines. Pure, for the same reason {@link renderRunView} is:
 * asserting the strings is asserting what an operator sees.
 */
export function renderFleetRunView(model: FleetRunViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = "─".repeat(columns);
	const lines: string[] = [];
	lines.push(truncateToWidth(`fleet ${sanitizeBounded(model.fleet, 64)}  root ${model.rootId}`, columns, "…", false));
	const resumed = model.resumedFrom === null ? "" : `  resumed from ${sanitizeBounded(model.resumedFrom, 64)}`;
	lines.push(
		truncateToWidth(
			`started ${model.startedAt}  elapsed ${formatElapsed(model.elapsedMs)}  ${model.recordedSteps} of ${model.plannedSteps} steps recorded${model.running ? "  (running)" : ""}${resumed}`,
			columns,
			"…",
			false,
		),
	);
	lines.push(rule);
	if (model.steps.length === 0) {
		lines.push("no steps recorded for this fleet run.");
	} else {
		const rows = model.steps.map((step) => ({
			step: sanitizeBounded(step.stepId, STEP_ID_MAX_WIDTH),
			runId: step.runId ?? "-",
			outcome: sanitizeBounded(step.outcome, 32),
			tail: [step.agentId, step.detail].filter((part) => part !== null && part !== undefined).join(": "),
		}));
		const stepWidth = Math.max(...rows.map((row) => row.step.length));
		const runWidth = Math.max(...rows.map((row) => row.runId.length));
		const outcomeWidth = Math.max(...rows.map((row) => row.outcome.length));
		for (const row of rows) {
			const head = `${row.step.padEnd(stepWidth)}  ${row.runId.padEnd(runWidth)}  ${row.outcome.padEnd(outcomeWidth)}`;
			const text = row.tail.length === 0 ? head : `${head}  ${sanitizeBounded(row.tail, DETAIL_MAX_WIDTH)}`;
			lines.push(truncateToWidth(text.trimEnd(), columns, "…", false));
		}
	}
	lines.push(rule);
	lines.push("clio-coder fleet view <run id> for one step's transcript, receipt, and ledger entry");
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
	watchPath?: string;
	dirs?: {
		config?: string;
		data?: string;
		state?: string;
		cache?: string;
	};
	follow: boolean;
	help: boolean;
}

function parseViewArgs(args: ReadonlyArray<string>): ParsedViewArgs | string {
	const parsed: ParsedViewArgs = { follow: false, help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--follow" || arg === "-f") {
			parsed.follow = true;
			continue;
		}
		if (arg === "--watch") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return "--watch requires a selection-file path";
			parsed.watchPath = value;
			i += 1;
			continue;
		}
		const dirRole =
			arg === "--config-dir"
				? "config"
				: arg === "--data-dir"
					? "data"
					: arg === "--state-dir"
						? "state"
						: arg === "--cache-dir"
							? "cache"
							: null;
		if (dirRole !== null) {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return `${arg} requires a directory path`;
			parsed.dirs ??= {};
			parsed.dirs[dirRole] = value;
			i += 1;
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
	if (parsed.watchPath !== undefined && parsed.runId !== undefined) {
		return "--watch follows the selection file; it does not take a run id";
	}
	if (parsed.watchPath !== undefined && parsed.follow) {
		return "--watch already follows; drop --follow";
	}
	return parsed;
}

/**
 * Pin the already-resolved parent layout before any fleet-view read. These are
 * internal self-invocation flags rather than inherited raw environment: the
 * pane shell may discard or replace its environment, but it cannot reinterpret
 * the four absolute values already present in argv.
 */
function applyViewDirs(dirs: ParsedViewArgs["dirs"]): void {
	if (dirs === undefined) return;
	if (dirs.config !== undefined) process.env.CLIO_CODER_CONFIG_DIR = dirs.config;
	if (dirs.data !== undefined) process.env.CLIO_CODER_DATA_DIR = dirs.data;
	if (dirs.state !== undefined) process.env.CLIO_CODER_STATE_DIR = dirs.state;
	if (dirs.cache !== undefined) process.env.CLIO_CODER_CACHE_DIR = dirs.cache;
	resetXdgCache();
}

/**
 * The selection file is one line: the run id the watch view should render.
 * Empty, missing, or torn content reads as "no selection" and costs one poll
 * interval, never a crash; the writer (src/interactive/watch-pane.ts) replaces
 * the file atomically.
 */
export function readWatchSelection(path: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const line = raw.split("\n", 1)[0]?.trim() ?? "";
	return line.length > 0 && line.length <= 128 ? line : null;
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
	applyViewDirs(parsed.dirs);
	if (parsed.watchPath !== undefined) {
		// The watch loop needs an interactive terminal for the same reason
		// --follow does; without one, print the selected run's snapshot and exit.
		if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
			const selected = readWatchSelection(parsed.watchPath);
			const model = selected === null ? null : loadRunViewModel(selected);
			process.stdout.write(`${renderWatchView(selected, model, terminalWidth()).join("\n")}\n`);
			return 0;
		}
		return watchSelection(parsed.watchPath);
	}
	if (parsed.runId === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	// A fleet root names a whole run, not a dispatched one, so it renders as the
	// step index rather than as a run. --follow has nothing to tail on a root:
	// the index changes only when a step settles.
	if (parsed.runId.startsWith(FLEET_ROOT_PREFIX)) {
		const root = resolveFleetRootId(parsed.runId);
		if (!("rootId" in root)) {
			return root.candidates.length === 0
				? fail(`unknown fleet run '${parsed.runId}' (no record under ${fleetRunsDir()})`)
				: fail(`fleet root id '${parsed.runId}' is ambiguous: ${root.candidates.slice(0, 8).join(", ")}`);
		}
		const fleetModel = loadFleetRunViewModel(root.rootId);
		if (fleetModel === null) return fail(`unknown fleet run '${root.rootId}'`);
		if (parsed.follow) {
			process.stderr.write("clio-coder fleet view: --follow applies to a run id, not a fleet root; printing the index\n");
		}
		process.stdout.write(`${renderFleetRunView(fleetModel, terminalWidth()).join("\n")}\n`);
		return 0;
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
 * Alternate-screen watch loop: the workers-view pane process. Every poll it
 * re-reads the selection file and renders whichever run it names, so arrow-key
 * navigation in the TUI retargets this process through one small file write
 * and no socket traffic. It never stops on a terminal run; the selection is
 * the operator's cursor, and the cursor outlives any one run.
 */
async function watchSelection(selectionPath: string): Promise<number> {
	const { ProcessTerminal, TuiAltScreen } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let selected = readWatchSelection(selectionPath);
	let model = selected === null ? null : loadRunViewModel(selected);

	const view = {
		render(width: number): string[] {
			const lines = renderWatchView(selected, model, width);
			lines.push("");
			lines.push("watching the workers-view selection… q to quit");
			return lines;
		},
		invalidate(): void {},
	};
	tui.addChild(view);

	return await new Promise<number>((resolve) => {
		let settled = false;
		const timer = setInterval(() => {
			selected = readWatchSelection(selectionPath);
			model = selected === null ? null : loadRunViewModel(selected);
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
