import { renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
/**
 * `clio-coder fleet view <runId|fleetRootId> [--follow]`.
 *
 * Given a fleet root id it renders a step index instead; see the fleet root
 * index section below for why a root cannot be rendered as a run.
 *
 * A read-only viewer for one dispatched run, built from durable state only:
 * the run ledger envelope, the run's display feed
 * (src/domains/dispatch/run-feed.ts), and the run's sealed record once
 * it settles. It shares no memory with the orchestrator, has zero dependency on any
 * pane host, and works over a plain SSH session.
 *
 * Everything the viewer prints comes from `renderRunView`, a pure function over
 * a `RunViewModel`. `--follow` paints that same output into an alternate screen
 * and re-polls the feed at the monitor tool's `WAIT_POLL_MS` cadence until
 * the feed's terminal line lands; it then stays open until `q`. Without
 * `--follow` the snapshot goes to stdout and the process exits.
 *
 * Trust rules the render obeys:
 *   - The run record is checked through `readRunTrust` before any of
 *     its fields are shown. A record that fails integrity contributes its
 *     failure reason and nothing else.
 *   - Task text is operator-supplied and worker-adjacent, so it is sanitized
 *     and bounded before rendering, per the `DispatchRunIdentity` warning in
 *     src/core/telemetry/live-events.ts. Journal event details cross the same seam and
 *     get the same treatment.
 *
 * Terminal primitives come from src/engine/tui-primitives.ts, never from the
 * src/engine/tui.js barrel, and that is load-bearing. See the header of
 * tui-primitives.ts for why an edge from here to the barrel breaks the Stage 0
 * instant-shell chunk budget.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "../core/config.js";
import type { OutputStyle } from "../core/defaults.js";
import { clockLocal, formatCount, formatElapsed } from "../core/format-time.js";
import { GLYPH } from "../core/glyphs.js";
import type { RunTelemetryV1 } from "../core/telemetry/dto.js";
import { terminalBackground } from "../core/terminal-background.js";
import { type ColorDepth, colorDepth } from "../core/terminal-preferences.js";
import { resolveRole, type SemanticRole } from "../core/theme-roles.js";
import { sgrFor } from "../core/theme-sgr.js";
import { clioStateDir, resetXdgCache } from "../core/xdg.js";
import type { ExecutionStepResult } from "../domains/dispatch/execution-scheduler.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import { type RunFeedLine, readRunFeed, runFeedPath } from "../domains/dispatch/run-feed.js";
import type { LedgerSnapshot } from "../domains/dispatch/state.js";
import { openLedger, readFleetRun, readLedgerSnapshot } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { readRunGateIndex, readRunTrust } from "../domains/evidence/run-trust.js";
import { formatTrustSummaryLine } from "../domains/evidence/trust-projection.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { loadRunRecord, loadRunTelemetrySource } from "../domains/session/telemetry-source.js";
import type { SettledRunRecord } from "../domains/telemetry/index.js";
import { routeSettledLabel } from "../domains/telemetry/index.js";
import { runTelemetry } from "../domains/telemetry/read-model.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui-primitives.js";
import { readWatchRequest } from "./fleet-board-model.js";
import { fleetInspectionScope, resolveFleetRootId } from "./fleet-project-scope.js";

const HELP = `clio-coder fleet view <runId|fleetRootId> [--follow] [--all]
clio-coder fleet view <runId> --follow --pane [--all]
clio-coder fleet view <runId> --json [--all]
clio-coder fleet view --watch <selection-file> [--dock-taps <file>] [--color-depth <depth>] [--all]

Follow one dispatched run from its durable state: the run ledger entry, the
run's display feed, and the run's sealed record once it settles.

Once the run's seal verifies, the snapshot also names the model the run
requested next to the models the providers reported, the cost with its pricing
provenance, and the label the route settled with.

  --json       print the snapshot and the sealed run record as JSON
  --follow     keep tailing until the run's terminal line, then stay open (q exits)
  --pane       with --follow: the logs pane, one clipped row per event at the pane's
               width, detail from the TUI's output detail (the logs pane runs this)
  --watch      the workers dashboard: a board of this session's workers, and a
               live takeover of one (Enter, Esc back). The selection file asks
               for a takeover and scopes the board to a session. This is the
               process the workers dock (Alt+W) runs.
  --dock-taps  where the dashboard reports q (hide the dock) and Alt+W to CLIO Coder;
               without it q quits
  --color-depth  with --watch: truecolor, 256, 16 or none, the depth CLIO Coder paints at;
               the workers dock passes it because a pane inherits the multiplexer's
               environment (without it the dashboard reads NO_COLOR, TERM and COLORTERM)
  --all        allow inspection across every project (default: this project)

Without --follow the current snapshot is printed and the command exits.
The transcript comes from <state>/runs/<runId>/feed.jsonl, which the orchestrator
writes when fleet.history.journal is on (the default). A run dispatched with it
off shows its ledger and run record but no transcript.

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
/** Visible width cap for one sanitized feed detail. */
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
	agentLedgerBoard?: string;
	runId: string;
	agentId: string;
	model: string;
	target: string;
	node: string;
	phase: string;
	startedAt: string;
	telemetry?: RunTelemetryV1;
	task: string | undefined;
	transcript: RunViewTranscriptLine[];
	/** True when the writer dropped display lines or the reader skipped a head. */
	transcriptTruncated: boolean;
	journalPresent: boolean;
	journalUnavailableReason?: string;
	journalPath: string;
	/** The run record's trust line, or the reason there is not one. */
	evidence: string;
	/** Present only when the run settled under a seal that verifies. */
	record?: SettledRunRecord;
	outcome: string | null;
	outcomeDetail: string | null;
	/** True once the feed carries its terminal line or the ledger row ended. */
	terminal: boolean;
}

function sanitizeBounded(value: string, maxWidth: number): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "";
	// truncateToWidth appends reset sequences when it elides, so the result goes
	// back through the sanitizer and stays plain text.
	return sanitizeCallTargetText(truncateToWidth(sanitized, maxWidth, "…", false));
}

/** The ANSI-aware TUI truncator appends reset codes; stdout snapshots are plain text. */
function truncatePlain(value: string, width: number): string {
	return truncateToWidth(value, width, "…", false).replaceAll("\u001B[0m", "");
}

/**
 * Read the run's record and reduce it to one status line in the shared trust vocabulary. Nothing from a record whose
 * seal does not verify reaches the line beyond the reason it could not be trusted (#434).
 */
function evidenceLine(run: RunEnvelope): { text: string; record?: SettledRunRecord } {
	let record: RunTelemetryV1 | null = null;
	try {
		record = loadRunRecord(clioStateDir(), run.id);
	} catch (error) {
		return { text: `run record unavailable: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (record?.settled == null)
		return {
			text: run.endedAt === null ? "run pending; it has not settled" : "run record unavailable; it never settled",
		};
	// The same reader `evidence inspect` uses, so the two surfaces cannot disagree on a run's trust (bt-20).
	const { integrity, trust } = readRunTrust(record, readRunGateIndex(clioStateDir())(run.id));
	if (integrity.state === "failed")
		return { text: `RUN SEAL FAILED: ${integrity.reason}; its settled facts are untrusted` };
	if (integrity.state === "unsealed")
		return { text: `run record unsealed: ${integrity.reason}; its settled facts are not yet vouched for` };
	return { text: formatTrustSummaryLine(trust), record: record as SettledRunRecord };
}

/**
 * The requested model next to what the provider reported on the run's calls, each distinct report once. The route a
 * run was dispatched on is configuration; only the providers' responses say what served it.
 */
function modelObservationText(settled: SettledRunRecord["settled"]): string {
	const requested = `requested ${sanitizeBounded(settled.route.wireModelId, 128)}`;
	const reported = settled.upstream.responseModelIds;
	return reported === null
		? `${requested} · no provider response recorded`
		: `${requested} · provider ${sanitizeBounded(reported, 512)}`;
}

/**
 * A feed line in words. The structured facts the workers dashboard reads say
 * the same thing here in one line: a call as its tool and descriptor with its
 * outcome, coalesced prose as the assistant's.
 */
function eventTranscriptLine(line: Extract<RunFeedLine, { kind: "event" }>): RunViewTranscriptLine {
	const detail = line.detail === undefined ? undefined : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH);
	const tool = line.tool === undefined ? "" : sanitizeBounded(line.tool, 64);
	const call = [line.verb === undefined ? "" : sanitizeBounded(line.verb, 32), detail ?? ""].filter(Boolean).join(" ");
	switch (line.type) {
		case "text":
			return { at: line.at, label: "assistant", detail };
		case "thinking":
			return { at: line.at, label: "thinking", detail: undefined };
		case "clio_coder_tool_start":
			if (tool.length > 0) return { at: line.at, label: `${tool} started`, detail: call || undefined };
			break;
		case "clio_coder_tool_finish": {
			if (tool.length === 0) break;
			const took = line.durationMs === undefined ? "" : ` in ${line.durationMs}ms`;
			const reason = line.reason === undefined ? "" : `: ${sanitizeBounded(line.reason, DETAIL_MAX_WIDTH)}`;
			return {
				at: line.at,
				label: `${tool} ${line.outcome ?? "finished"}${took}`,
				detail: `${call}${reason}` || undefined,
			};
		}
		case "clio_coder_helper_result_rejected": {
			// The reason leads; the feed row keeps the whole submission.
			const words = [line.reason, line.detail === undefined ? undefined : `submitted ${line.detail}`]
				.filter((part) => part !== undefined)
				.join(" · ");
			return { at: line.at, label: "result rejected", detail: sanitizeBounded(words, DETAIL_MAX_WIDTH) || undefined };
		}
	}
	return { at: line.at, label: sanitizeBounded(line.type, 64), detail };
}

function transcriptLine(line: RunFeedLine): RunViewTranscriptLine | null {
	switch (line.kind) {
		case "open":
			return { at: line.at, label: `run opened (${sanitizeBounded(line.agentId, 64)})`, detail: undefined };
		case "event":
			return eventTranscriptLine(line);
		case "journal_truncated":
			return { at: line.at, label: "journal truncated", detail: sanitizeBounded(line.reason, 64) };
		case "result":
			return {
				at: line.at,
				label: `result (${sanitizeBounded(line.outcome, 32)}, exit ${line.exitCode ?? "unknown"})`,
				detail: undefined,
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
	now?: () => number;
	scope?: ReturnType<typeof fleetInspectionScope>;
	/** The ledger rows a poller keeps; absent, the run's row is read from runs.json. */
	ledger?: () => ReadonlyArray<RunEnvelope>;
}

/**
 * Resolve a run id the way `fleet status` prints them: an exact ledger id
 * first, then a unique prefix. An ambiguous prefix resolves to nothing so the
 * caller can say which ids it matched.
 */
function resolveRunId(
	runId: string,
	scope: ReturnType<typeof fleetInspectionScope>,
): { runId: string } | { candidates: string[] } {
	const ledger = openLedger();
	const exact = ledger.get(runId);
	if (exact !== null && scope.seesRun(exact)) return { runId };
	const candidates = ledger
		.list()
		.filter((run) => run.id.startsWith(runId) && scope.seesRun(run))
		.map((run) => run.id);
	if (candidates.length === 1 && candidates[0] !== undefined) return { runId: candidates[0] };
	return { candidates };
}

function journalUnavailableReason(): string {
	try {
		if (!readSettings().fleet.history.journal) {
			return "event journaling is currently disabled (fleet.history.journal=false); enable it to record future runs.";
		}
	} catch {
		// A settings read failure cannot establish why a historical file is missing.
	}
	return "the feed file is missing; this run's recording settings and any later removal are not recorded.";
}

function loadRunViewModel(runId: string, options: LoadRunViewOptions = {}): RunViewModel | null {
	const run =
		options.ledger !== undefined ? (options.ledger().find((row) => row.id === runId) ?? null) : openLedger().get(runId);
	if (run === null || (options.scope !== undefined && !options.scope.seesRun(run))) return null;
	const now = options.now ?? (() => Date.now());
	const journal = readRunFeed(runId, { maxLines: TRANSCRIPT_LIMIT });
	const transcript: RunViewTranscriptLine[] = [];
	for (const line of journal.lines) {
		const rendered = transcriptLine(line);
		if (rendered !== null) transcript.push(rendered);
	}
	const evidence = evidenceLine(run);
	const telemetry = runTelemetry(runId, loadRunTelemetrySource(clioStateDir(), runId), { now: new Date(now()) });
	const task = sanitizeBounded(run.task, TASK_MAX_WIDTH);
	return {
		runId: run.id,
		telemetry,
		agentId: run.agentId,
		model: run.wireModelId,
		target: run.targetId,
		node: run.node?.id ?? "local",
		phase: run.outcome ?? run.status,
		startedAt: run.startedAt,
		task: task.length > 0 ? task : undefined,
		transcript,
		transcriptTruncated: journal.truncated,
		journalPresent: journal.present,
		...(!journal.present ? { journalUnavailableReason: journalUnavailableReason() } : {}),
		journalPath: runFeedPath(runId),
		evidence: evidence.text,
		...(evidence.record === undefined ? {} : { record: evidence.record }),
		...(run.projection?.ledgerId
			? { agentLedgerBoard: renderAgentLedgerBoard(run.projection.ledgerId) ?? "No peer contributions yet." }
			: {}),
		outcome: journal.terminal?.outcome ?? run.outcome ?? null,
		outcomeDetail: journal.terminal?.detail ?? run.outcomeDetail ?? null,
		terminal: journal.terminal !== null || run.endedAt !== null,
	};
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

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
function renderRunView(model: RunViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = "─".repeat(columns);
	const lines: string[] = [];
	lines.push(truncatePlain(`run ${model.runId}  ${model.agentId}`, columns));
	lines.push(
		truncatePlain(
			`model ${model.model}  target ${model.target}  node ${model.node}  phase ${model.phase}  elapsed ${model.telemetry?.activity.elapsed.display ?? "not available"}`,
			columns,
		),
	);
	if (model.task !== undefined) {
		lines.push(...wrapViewerValue("task ", model.task, columns));
	}
	lines.push(rule);
	if (!model.journalPresent) {
		lines.push("no display feed was recorded or retained for this run.");
		lines.push(...wrapViewerValue("", model.journalUnavailableReason ?? "the feed file is missing.", columns));
		lines.push(...wrapViewerValue("expected ", model.journalPath, columns));
	} else if (model.transcript.length === 0) {
		lines.push("feed is empty; no events recorded yet.");
	} else {
		if (model.transcriptTruncated) lines.push("… earlier events dropped (feed truncated)");
		for (const entry of model.transcript) {
			const head = `${clockOf(entry.at)} ${entry.label}`;
			if (entry.detail === undefined) lines.push(truncatePlain(head, columns));
			else lines.push(...wrapViewerValue(`${head}: `, entry.detail, columns));
		}
	}
	lines.push(rule);
	lines.push(...wrapViewerValue("evidence  ", model.evidence, columns));
	if (model.agentLedgerBoard) {
		lines.push("", "Shared agent ledger (untrusted peer data):");
		for (const line of model.agentLedgerBoard.split("\n")) {
			lines.push(...wrapTextWithAnsi(sanitizeBounded(line, TASK_MAX_WIDTH), columns));
		}
	}
	if (model.record !== undefined) {
		const settled = model.record.settled;
		lines.push(...wrapViewerValue("model     ", modelObservationText(settled), columns));
		lines.push(truncatePlain(`cost      ${model.telemetry?.row.usd.display ?? "not available"}`, columns));
		lines.push(truncatePlain(`settled   ${sanitizeBounded(routeSettledLabel(settled), 64)}`, columns));
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
function renderWatchView(
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
			"In clio-coder, Alt+W opens the workers dock: a board of this session's",
			"workers, where Enter takes the dock over for one of them.",
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
 * The root is not a run and has no ledger row, no run record, and no journal of
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
	/** The step's task brief from its run's ledger entry; absent when the step never ran or its entry is gone. */
	task?: string;
}

export interface FleetRunViewModel {
	rootId: string;
	fleet: string;
	startedAt: string;
	telemetry?: RunTelemetryV1;
	/** True while the record carries no end stamp. */
	running: boolean;
	resumedFrom: string | null;
	plannedSteps: number;
	recordedSteps: number;
	steps: FleetRunStepRow[];
}

function fleetRunsDir(): string {
	// Mirrors fleetRunPath() in src/domains/dispatch/state.ts, which is private
	// to that module; only the directory is needed here, for naming the path in
	// a "no such root" message.
	return join(clioStateDir(), "fleet-runs");
}

/**
 * Read defensively. A fleet-run record is written by an older or newer build
 * than the one reading it, and a missing field must cost the index one column,
 * never the whole listing.
 */
function stepResultOf(value: unknown): Partial<ExecutionStepResult> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ExecutionStepResult) : {};
}

function loadFleetRunViewModel(
	rootId: string,
	options: { now?: () => number; scope?: ReturnType<typeof fleetInspectionScope> } = {},
): FleetRunViewModel | null {
	const record = readFleetRun(rootId);
	if (record === null) return null;
	const ledger = openLedger();
	if (options.scope !== undefined && !options.scope.seesRoot(record, (id) => ledger.get(id))) return null;
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
		const task = typeof envelope?.task === "string" ? fleetNodeTaskBrief(envelope.task).trim() : "";
		return {
			stepId,
			runId,
			agentId: envelope?.agentId ?? null,
			outcome,
			detail: typeof detail === "string" && detail.length > 0 ? detail : undefined,
			...(task.length > 0 ? { task } : {}),
		};
	});
	const telemetry = runTelemetry(rootId, loadRunTelemetrySource(clioStateDir(), rootId), { now: new Date(now()) });
	return {
		rootId: record.id,
		telemetry,
		fleet: record.fleet,
		startedAt: record.startedAt,
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
function renderFleetRunView(model: FleetRunViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = "─".repeat(columns);
	const lines: string[] = [];
	lines.push(truncatePlain(`fleet ${sanitizeBounded(model.fleet, 64)}  root ${model.rootId}`, columns));
	const resumed = model.resumedFrom === null ? "" : `  resumed from ${sanitizeBounded(model.resumedFrom, 64)}`;
	lines.push(
		truncatePlain(
			`started ${model.startedAt}  elapsed ${model.telemetry?.activity.elapsed.display ?? "not available"}  ${model.recordedSteps} of ${model.plannedSteps} steps recorded${model.running ? "  (running)" : ""}${resumed}`,
			columns,
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
			task: step.task,
		}));
		const stepWidth = Math.max(...rows.map((row) => row.step.length));
		const runWidth = Math.max(...rows.map((row) => row.runId.length));
		const outcomeWidth = Math.max(...rows.map((row) => row.outcome.length));
		for (const row of rows) {
			const head = `${row.step.padEnd(stepWidth)}  ${row.runId.padEnd(runWidth)}  ${row.outcome.padEnd(outcomeWidth)}`;
			const text = row.tail.length === 0 ? head : `${head}  ${sanitizeBounded(row.tail, DETAIL_MAX_WIDTH)}`;
			lines.push(truncatePlain(text.trimEnd(), columns));
			// Row 362: the index says what each step was asked to do, not only which run to open next.
			if (row.task !== undefined)
				lines.push(truncatePlain(`  task ${sanitizeBounded(row.task, TASK_MAX_WIDTH)}`, columns));
		}
	}
	lines.push(rule);
	lines.push("clio-coder fleet view <run id> for one step's transcript, run record, and ledger entry");
	return lines;
}

// ---------------------------------------------------------------------------
// Logs pane (`--follow --pane`)
// ---------------------------------------------------------------------------

/**
 * The logs pane is a host pane beside CLIO Coder, so its rows obey the pane's own width: one row per event, clipped
 * with `…`, never wrapped, holding clock, glyph, object and outcome down to 24 cells. How much it lists follows the
 * TUI's output detail, which the TUI writes as `outputDetail=` into the watch selection file and this pane re-reads
 * on every poll: compact lists tool calls and outcomes, standard adds model replies with their token counts, and
 * detailed adds each event's type and the call's facts.
 */

/** The watch selection file under the state root; mirrors watchSelectionPath in src/interactive/watch-pane.ts. */
const WATCH_SELECTION_FILE = "watch-selection";
/** What `--color-depth` accepts: the depths `colorDepth()` detects. */
const COLOR_DEPTHS: ReadonlyArray<ColorDepth> = ["truecolor", "256", "16", "none"];
const PANE_DEFAULT_WIDTH = 40;
/** Header, rule, rule and status around the event rows. */
const PANE_CHROME_ROWS = 4;
const PANE_SEPARATOR = ` ${GLYPH.sep} `;
const CLOCK_WIDTH = 8;
const TIER_RANK: Readonly<Record<OutputStyle, number>> = { compact: 0, standard: 1, detailed: 2 };
/** Events another row already says, or that carry nothing an operator reads in a log. */
const PANE_QUIET_EVENTS = new Set([
	"text",
	"thinking",
	"agent_start",
	"agent_end",
	"clio_coder_helper_result",
	"clio_coder_model_call",
	"clio_coder_tool_observation",
]);

interface PaneMark {
	glyph: string;
	role: SemanticRole;
}

interface PaneRow {
	/** Operator-local `HH:MM:SS`, empty for a row with no instant of its own. */
	clock: string;
	/** The event type the detailed tier shows in its own column. */
	type: string;
	glyph: PaneMark;
	text: string;
	/** Call facts; detailed only. */
	facts: string | undefined;
	mark: PaneMark | undefined;
	duration: string | undefined;
	/** The lowest tier that lists the row. */
	tier: OutputStyle;
	tool?: string;
	pending?: boolean;
}

interface LogsPaneSource {
	run: RunEnvelope;
	feed: ReturnType<typeof readRunFeed>;
}

interface LogsPaneView {
	runId: string;
	agentId: string;
	rows: PaneRow[];
	terminal: boolean;
	/** Start to end once the run ended. */
	elapsed: string | undefined;
}

interface LogsPaneScroll {
	/** First body row shown; null follows the newest event. */
	top: number | null;
	/** What the last render measured, for the scroll keys. */
	maxTop?: number;
}

type PanePaint = (role: SemanticRole, text: string, chrome?: boolean) => string;

/** Roles through the core palette, which this process paints from because it must not load the interactive theme. */
function createPanePaint(depth: ColorDepth = colorDepth()): PanePaint {
	const background = terminalBackground();
	const codes = new Map<SemanticRole, { open: string; close: string }>();
	return (role, text, chrome = false) => {
		if (text.length === 0) return text;
		let sgr = codes.get(role);
		if (sgr === undefined) {
			const resolved = resolveRole(role);
			const color = sgrFor({ fg: resolved.color }, depth, background);
			const open = [color.open, resolved.bold === true ? "1" : "", chrome && depth === "none" ? "2" : ""].filter(Boolean);
			const close = [color.close, resolved.bold === true || (chrome && depth === "none") ? "22" : ""].filter(Boolean);
			sgr = { open: open.join(";"), close: close.join(";") };
			codes.set(role, sgr);
		}
		return sgr.open.length === 0 ? text : `\u001B[${sgr.open}m${text}\u001B[${sgr.close}m`;
	};
}

/** The tier the TUI last wrote; standard when the file or its line is absent. */
function paneTier(): OutputStyle {
	return readWatchRequest(join(clioStateDir(), WATCH_SELECTION_FILE))?.outputDetail ?? "standard";
}

function toolMark(outcome: "ok" | "error" | "blocked" | undefined): PaneMark | undefined {
	if (outcome === "ok") return { glyph: GLYPH.ok, role: "success" };
	if (outcome === "error") return { glyph: GLYPH.error, role: "error" };
	if (outcome === "blocked") return { glyph: GLYPH.phaseBlocked, role: "warning" };
	return undefined;
}

function runMark(outcome: string): PaneMark {
	if (outcome === "succeeded" || outcome === "completed") return { glyph: GLYPH.ok, role: "success" };
	if (outcome === "cancelled") return { glyph: GLYPH.cancelled, role: "annotation" };
	return { glyph: GLYPH.error, role: "error" };
}

function callFactsText(line: Extract<RunFeedLine, { kind: "event" }>): string | undefined {
	const parts: string[] = [];
	if (line.verb !== undefined) parts.push(sanitizeBounded(line.verb, 32));
	const facts = line.callFacts;
	if (facts !== undefined) {
		if (typeof facts.startLine === "number" && typeof facts.endLine === "number")
			parts.push(`L${facts.startLine}-${facts.endLine}`);
		if (facts.returnedBytes !== undefined) parts.push(`${formatCount(facts.returnedBytes)}B`);
		if (facts.truncated === true) parts.push("truncated");
	}
	if (line.notExecuted === "observation_budget") parts.push("not run: observation budget");
	if (line.callIndex !== undefined) parts.push(`call ${line.callIndex}`);
	const text = parts.filter((part) => part.length > 0).join(PANE_SEPARATOR);
	return text.length > 0 ? text : undefined;
}

function typeName(type: string): string {
	return sanitizeBounded(type.startsWith("clio_coder_") ? type.slice("clio_coder_".length) : type, 32);
}

function elapsedBetween(from: string, to: string): string | undefined {
	const ms = Date.parse(to) - Date.parse(from);
	return Number.isFinite(ms) ? formatElapsed(ms) : undefined;
}

function lastPending(rows: ReadonlyArray<PaneRow>, tool: string): PaneRow | undefined {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		if (row?.pending === true && row.tool === tool) return row;
	}
	return undefined;
}

/** One row per event, a call's start and finish folded into the one row its finish completes. */
function foldPaneRows(lines: ReadonlyArray<RunFeedLine>, truncated: boolean, startedAt: string): PaneRow[] {
	const rows: PaneRow[] = [];
	const pending = new Map<string, PaneRow>();
	const dropped = (clock: string): PaneRow => ({
		clock,
		type: "truncated",
		glyph: { glyph: GLYPH.ellipsis, role: "warning" },
		text: "earlier events dropped",
		facts: undefined,
		mark: undefined,
		duration: undefined,
		tier: "compact",
	});
	let marked = false;
	for (const line of lines) {
		const clock = clockLocal(line.at);
		if (line.kind === "journal_truncated") {
			marked = true;
			rows.push(dropped(clock));
			continue;
		}
		if (line.kind === "terminal") {
			const outcome = sanitizeBounded(line.outcome, 32);
			const detail = line.detail === undefined ? "" : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH);
			const took = elapsedBetween(startedAt, line.at);
			rows.push({
				clock,
				type: "terminal",
				glyph: runMark(line.outcome),
				text: [`${outcome}${detail.length > 0 ? `: ${detail}` : ""}`, took].filter(Boolean).join(PANE_SEPARATOR),
				facts: undefined,
				mark: undefined,
				duration: undefined,
				tier: "compact",
			});
			continue;
		}
		if (line.kind !== "event" || PANE_QUIET_EVENTS.has(line.type)) continue;
		const type = typeName(line.type);
		const detail = line.detail === undefined ? "" : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH);
		const tool = line.tool === undefined ? "" : sanitizeBounded(line.tool, 64);
		const reason = line.reason === undefined ? "" : sanitizeBounded(line.reason, DETAIL_MAX_WIDTH);
		const withReason = (text: string): string => (reason.length > 0 ? `${text}: ${reason}` : text);
		const base = { clock, type, facts: callFactsText(line), mark: undefined, duration: undefined };
		switch (line.type) {
			case "clio_coder_tool_start": {
				if (tool.length === 0) break;
				const row: PaneRow = {
					...base,
					glyph: { glyph: GLYPH.phaseTool, role: "annotation" },
					text: [tool, detail].filter(Boolean).join(" "),
					mark: { glyph: GLYPH.running, role: "annotation" },
					tier: "compact",
					tool,
					pending: true,
				};
				rows.push(row);
				if (line.callId !== undefined) pending.set(line.callId, row);
				break;
			}
			case "clio_coder_tool_finish": {
				if (tool.length === 0) break;
				let row = line.callId === undefined ? undefined : pending.get(line.callId);
				if (line.callId !== undefined) pending.delete(line.callId);
				row ??= lastPending(rows, tool);
				if (row === undefined) {
					row = {
						...base,
						glyph: { glyph: GLYPH.phaseTool, role: "annotation" },
						text: [tool, detail].filter(Boolean).join(" "),
						tier: "compact",
						tool,
					};
					rows.push(row);
				}
				row.pending = false;
				row.type = type;
				row.text = line.outcome === "ok" ? row.text : withReason(row.text);
				row.mark = toolMark(line.outcome);
				row.duration = line.durationMs === undefined ? undefined : formatElapsed(line.durationMs);
				row.facts = base.facts ?? row.facts;
				break;
			}
			case "message_end":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.agent, role: "fieldValue" },
					text: ["reply", line.tokens === undefined ? "" : `${formatCount(line.tokens)} tok`]
						.filter(Boolean)
						.join(PANE_SEPARATOR),
					tier: "standard",
				});
				break;
			case "clio_coder_permission_escalated":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.phaseBlocked, role: "warning" },
					text: ["approval", tool, detail].filter(Boolean).join(" "),
					tier: "compact",
				});
				break;
			case "clio_coder_permission_resolved":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.phaseBlocked, role: "annotation" },
					text: withReason(["approval", tool, detail].filter(Boolean).join(" ")),
					mark: toolMark(line.outcome ?? "blocked"),
					tier: "compact",
				});
				break;
			case "clio_coder_run_outcome":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.error, role: "error" },
					text: withReason(detail.length > 0 ? detail : "run outcome"),
					tier: "compact",
				});
				break;
			case "clio_coder_helper_result_rejected":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.error, role: "error" },
					text: withReason("result rejected"),
					facts: detail.length > 0 ? `submitted ${detail}` : undefined,
					tier: "compact",
				});
				break;
			case "clio_coder_steer_received":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.next, role: "annotation" },
					text: "steering received",
					facts: detail.length > 0 ? detail : undefined,
					tier: "standard",
				});
				break;
			default:
				if (detail.length === 0) break;
				rows.push({ ...base, glyph: { glyph: GLYPH.dot, role: "annotation" }, text: detail, tier: "standard" });
		}
	}
	if (truncated && !marked) rows.unshift(dropped(""));
	return rows;
}

function loadLogsPane(
	runId: string,
	scope: ReturnType<typeof fleetInspectionScope>,
	ledger?: () => ReadonlyArray<RunEnvelope>,
): LogsPaneSource | null {
	const run = ledger !== undefined ? (ledger().find((row) => row.id === runId) ?? null) : openLedger().get(runId);
	if (run === null || !scope.seesRun(run)) return null;
	return { run, feed: readRunFeed(runId, { maxLines: TRANSCRIPT_LIMIT }) };
}

/** The view of one read; `previous` is reused when the feed and the ledger row did not move. */
function logsPaneView(
	source: LogsPaneSource,
	previous: { key: string; view: LogsPaneView } | null,
): { key: string; view: LogsPaneView } {
	const { run, feed } = source;
	const last = feed.lines[feed.lines.length - 1];
	const key = `${feed.bytes}|${feed.lines.length}|${last?.seq ?? -1}|${run.endedAt ?? ""}|${run.agentId}`;
	if (previous !== null && previous.key === key) return previous;
	let end: string | null = run.endedAt;
	for (const line of feed.lines) if (line.kind === "terminal") end = line.at;
	const terminal = feed.terminal !== null || run.endedAt !== null;
	return {
		key,
		view: {
			runId: run.id,
			agentId: sanitizeBounded(run.agentId, 64),
			rows: foldPaneRows(feed.lines, feed.truncated, run.startedAt),
			terminal,
			elapsed: terminal && end !== null ? elapsedBetween(run.startedAt, end) : undefined,
		},
	};
}

/** Leading segments that fit, joined by the separator; the first is clipped when even it does not. */
function fitSegments(segments: ReadonlyArray<string>, width: number): string {
	let line = ` ${segments[0] ?? ""}`;
	for (const segment of segments.slice(1)) {
		const next = `${line}${PANE_SEPARATOR}${segment}`;
		if (visibleWidth(next) > width) break;
		line = next;
	}
	return truncatePlain(line, width);
}

function paneRowLine(row: PaneRow, tier: OutputStyle, typeWidth: number, width: number, paint: PanePaint): string {
	const clock = row.clock.length > 0 ? row.clock : " ".repeat(CLOCK_WIDTH);
	const type = tier === "detailed" ? truncatePlain(row.type, typeWidth).padEnd(typeWidth) : "";
	const text = tier === "detailed" && row.facts !== undefined ? `${row.text}${PANE_SEPARATOR}${row.facts}` : row.text;
	const tail = [row.mark?.glyph, row.duration].filter((part) => part !== undefined && part.length > 0).join(" ");
	const head = ` ${clock} ${type.length > 0 ? `${type} ` : ""}`;
	const fixed = visibleWidth(head) + visibleWidth(row.glyph.glyph) + 1 + (tail.length > 0 ? 1 + visibleWidth(tail) : 0);
	const room = width - fixed;
	if (room < 1) {
		return paint("body", truncatePlain(`${head}${row.glyph.glyph} ${text}${tail.length > 0 ? ` ${tail}` : ""}`, width));
	}
	const shown = truncatePlain(text, room);
	const mark = row.mark === undefined ? "" : paint(row.mark.role, row.mark.glyph);
	const duration = row.duration === undefined ? "" : paint("metadata", row.duration, true);
	return [
		` ${paint("metadata", clock, true)} `,
		type.length > 0 ? `${paint("annotation", type, true)} ` : "",
		paint(row.glyph.role, row.glyph.glyph),
		` ${paint("body", shown)}`,
		tail.length > 0 ? ` ${[mark, duration].filter(Boolean).join(" ")}` : "",
	].join("");
}

/**
 * The pane as lines at one width and tier. Pure. `height` null is the unbounded frame a pipe gets; otherwise the
 * event rows fill the rows between the header pair and the status pair, following the newest event unless scrolled.
 */
function renderLogsPane(
	view: LogsPaneView,
	scroll: LogsPaneScroll,
	width: number,
	height: number | null,
	tier: OutputStyle,
	paint: PanePaint,
): string[] {
	const columns = Math.max(1, width);
	const rule = paint("annotation", GLYPH.rule.repeat(columns), true);
	const paused = scroll.top !== null;
	const state = paused ? "paused" : view.terminal ? "finished" : "following";
	const identity = [`${view.agentId} ${view.runId}`, view.runId];
	const header =
		identity
			.map((who) => ` logs${PANE_SEPARATOR}${who}${PANE_SEPARATOR}${state}`)
			.find((line) => visibleWidth(line) <= columns) ??
		truncatePlain(` logs${PANE_SEPARATOR}${view.runId}${PANE_SEPARATOR}${state}`, columns);
	const scrollKeys = `[${GLYPH.up}${GLYPH.down}] scroll`;
	const status = paused
		? fitSegments(["paused", "[f] follow", "[q] hide"], columns)
		: view.terminal
			? fitSegments(["run finished", view.elapsed ?? "time not recorded", "[q] hide"], columns)
			: fitSegments([scrollKeys, "[f] follow", "[q] hide"], columns);
	const shown = view.rows.filter((row) => TIER_RANK[row.tier] <= TIER_RANK[tier]);
	const typeCap = columns >= 48 ? 14 : columns >= 36 ? 11 : 6;
	const typeWidth = Math.min(typeCap, Math.max(1, ...shown.map((row) => visibleWidth(row.type))));
	const bodyHeight = height === null ? shown.length : Math.max(1, height - PANE_CHROME_ROWS);
	const maxTop = Math.max(0, shown.length - bodyHeight);
	scroll.maxTop = maxTop;
	const top = scroll.top === null ? maxTop : Math.min(scroll.top, maxTop);
	const body =
		shown.length === 0
			? [
					paint(
						"emptyState",
						view.terminal
							? fitSegments(["no events were recorded for this run"], columns)
							: fitSegments(["no events yet", "the pane follows the newest run"], columns),
					),
				]
			: shown.slice(top, top + bodyHeight).map((row) => paneRowLine(row, tier, typeWidth, columns, paint));
	if (height !== null) while (body.length < bodyHeight) body.push("");
	const statusRole: SemanticRole = paused ? "warning" : "annotation";
	return [paint("groupHeading", header), rule, ...body, rule, paint(statusRole, status, !paused)];
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
	tapPath?: string;
	colorDepth?: ColorDepth;
	dirs?: {
		config?: string;
		data?: string;
		state?: string;
		cache?: string;
	};
	follow: boolean;
	pane: boolean;
	all: boolean;
	json: boolean;
	help: boolean;
}

function parseViewArgs(args: ReadonlyArray<string>): ParsedViewArgs | string {
	const parsed: ParsedViewArgs = { follow: false, pane: false, all: false, json: false, help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--follow" || arg === "-f") {
			parsed.follow = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--pane") {
			parsed.pane = true;
			continue;
		}
		if (arg === "--all") {
			parsed.all = true;
			continue;
		}
		if (arg === "--watch") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return "--watch requires a selection-file path";
			parsed.watchPath = value;
			i += 1;
			continue;
		}
		if (arg === "--dock-taps") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return "--dock-taps requires a file path";
			parsed.tapPath = value;
			i += 1;
			continue;
		}
		if (arg === "--color-depth") {
			const value = args[i + 1];
			const depth = COLOR_DEPTHS.find((entry) => entry === value);
			if (depth === undefined) return `--color-depth takes one of ${COLOR_DEPTHS.join(", ")}`;
			parsed.colorDepth = depth;
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
	if (parsed.tapPath !== undefined && parsed.watchPath === undefined) {
		return "--dock-taps belongs to --watch";
	}
	if (parsed.colorDepth !== undefined && parsed.watchPath === undefined) {
		return "--color-depth belongs to --watch";
	}
	if (parsed.json && (parsed.follow || parsed.watchPath !== undefined)) {
		return "--json prints one snapshot; drop --follow and --watch";
	}
	if (parsed.pane && !parsed.follow) {
		return "--pane belongs to --follow";
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
function readWatchSelection(path: string): string | null {
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
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	applyViewDirs(parsed.dirs);
	const scope = fleetInspectionScope(parsed.all);
	if (parsed.watchPath !== undefined) {
		// The watch loop needs an interactive terminal for the same reason
		// --follow does; without one, print the selected run's snapshot and exit.
		if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
			const selected = readWatchSelection(parsed.watchPath);
			const model = selected === null ? null : loadRunViewModel(selected, { scope });
			process.stdout.write(`${renderWatchView(selected, model, terminalWidth()).join("\n")}\n`);
			return 0;
		}
		const { runWorkersDashboard } = await import("./fleet-board.js");
		return runWorkersDashboard({
			selectionPath: parsed.watchPath,
			tapPath: parsed.tapPath ?? null,
			scope,
			...(parsed.colorDepth !== undefined ? { colorDepth: parsed.colorDepth } : {}),
		});
	}
	if (parsed.runId === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	// A fleet root names a whole run, not a dispatched one, so it renders as the
	// step index rather than as a run. --follow has nothing to tail on a root:
	// the index changes only when a step settles.
	if (parsed.runId.startsWith(FLEET_ROOT_PREFIX)) {
		const root = resolveFleetRootId(parsed.runId, scope);
		if (!("rootId" in root)) {
			return root.candidates.length === 0
				? fail(`unknown fleet run '${parsed.runId}' (no record under ${fleetRunsDir()})`)
				: fail(`fleet root id '${parsed.runId}' is ambiguous: ${root.candidates.slice(0, 8).join(", ")}`);
		}
		const fleetModel = loadFleetRunViewModel(root.rootId, { scope });
		if (fleetModel === null) return fail(`unknown fleet run '${root.rootId}'`);
		if (parsed.json) return fail("--json takes a run id; view the fleet root without it to list its step run ids");
		if (parsed.pane) return fail("--pane follows a run id, not a fleet root");
		if (parsed.follow) {
			process.stderr.write("clio-coder fleet view: --follow applies to a run id, not a fleet root; printing the index\n");
		}
		process.stdout.write(`${renderFleetRunView(fleetModel, terminalWidth()).join("\n")}\n`);
		return 0;
	}
	const resolved = resolveRunId(parsed.runId, scope);
	if (!("runId" in resolved)) {
		return resolved.candidates.length === 0
			? fail(`unknown run '${parsed.runId}' (not in the run ledger under ${clioStateDir()})`)
			: fail(`run id '${parsed.runId}' is ambiguous: ${resolved.candidates.slice(0, 8).join(", ")}`);
	}
	const runId = resolved.runId;
	const snapshot = loadRunViewModel(runId, { scope });
	if (snapshot === null) return fail(`unknown run '${runId}'`);
	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}

	if (parsed.pane) {
		if (process.stdout.isTTY === true && process.stdin.isTTY === true) return followPane(runId, scope);
		// One frame of the pane, unpainted, so a pipe still reads what the pane would show.
		process.stderr.write("clio-coder fleet view: --pane needs an interactive terminal; printing one frame\n");
		const source = loadLogsPane(runId, scope);
		const frame =
			source === null
				? [`run ${runId} left the ledger.`]
				: renderLogsPane(
						logsPaneView(source, null).view,
						{ top: null },
						process.stdout.columns ?? PANE_DEFAULT_WIDTH,
						null,
						paneTier(),
						createPanePaint("none"),
					);
		process.stdout.write(`${frame.join("\n")}\n`);
		return 0;
	}
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
	return followRun(runId, scope);
}

/**
 * The logs pane loop: the same poll cadence as {@link followRun}, the tier re-read from the selection file on each
 * tick, and the frame memoized on width, height, tier, scroll and the feed's position so an idle pane renders nothing
 * new. `↑` and `↓` scroll and stop following; `f` follows again; `q` hides the pane by ending its process.
 */
async function followPane(runId: string, scope: ReturnType<typeof fleetInspectionScope>): Promise<number> {
	const { ProcessTerminal, TuiAltScreen, isKeyRelease, matchesKey } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: (text) =>
			import("../engine/clipboard.js")
				.then(({ copyToSystemClipboard }) => copyToSystemClipboard(text, (sequence) => terminal.write(sequence)))
				.catch(() => "Copy failed: clipboard module did not load"),
	});
	let ledger: LedgerSnapshot | null = null;
	const rows = (): ReadonlyArray<RunEnvelope> => {
		ledger = readLedgerSnapshot(ledger);
		return ledger.runs;
	};
	const paint = createPanePaint();
	const scroll: LogsPaneScroll = { top: null };
	let tier = paneTier();
	let current: { key: string; view: LogsPaneView } | null = null;
	const load = (): void => {
		const source = loadLogsPane(runId, scope, rows);
		current = source === null ? null : logsPaneView(source, current);
	};
	load();
	let frameKey = "";
	let frame: string[] = [];

	const view = {
		render(width: number): string[] {
			if (current === null) return [truncatePlain(` run ${runId} left the ledger.`, Math.max(1, width))];
			const height = Math.max(PANE_CHROME_ROWS + 1, terminal.rows);
			const key = `${width}x${height}|${tier}|${current.key}|${scroll.top ?? "follow"}`;
			if (key !== frameKey) {
				frame = renderLogsPane(current.view, scroll, width, height, tier, paint);
				frameKey = key;
			}
			return frame;
		},
		invalidate(): void {
			frameKey = "";
		},
	};
	tui.addChild(view);

	return await new Promise<number>((resolve) => {
		let settled = false;
		const timer = setInterval(() => {
			load();
			tier = paneTier();
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
			if (isKeyRelease(data)) return undefined;
			if (data === "q" || matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
				finish();
				return { consume: true };
			}
			const maxTop = scroll.maxTop ?? 0;
			if (matchesKey(data, "up") || data === "k") scroll.top = Math.max(0, (scroll.top ?? maxTop) - 1);
			else if (matchesKey(data, "down") || data === "j") scroll.top = Math.min(maxTop, (scroll.top ?? maxTop) + 1);
			else if (data === "f") scroll.top = null;
			else return undefined;
			tui.requestRender();
			return { consume: true };
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
async function followRun(runId: string, scope: ReturnType<typeof fleetInspectionScope>): Promise<number> {
	const { ProcessTerminal, TuiAltScreen } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		// #437: confirm copies through a system clipboard tool instead of a bare OSC 52.
		copySelection: (text) =>
			import("../engine/clipboard.js")
				.then(({ copyToSystemClipboard }) => copyToSystemClipboard(text, (sequence) => terminal.write(sequence)))
				.catch(() => "Copy failed: clipboard module did not load"),
	});
	// A follow polls every POLL_MS; runs.json is parsed again only when it changed, so an idle follow stays off the CPU
	// at the 1000-row cap (FL-24).
	let ledger: LedgerSnapshot | null = null;
	const rows = (): ReadonlyArray<RunEnvelope> => {
		ledger = readLedgerSnapshot(ledger);
		return ledger.runs;
	};
	let model = loadRunViewModel(runId, { scope, ledger: rows });
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
			model = loadRunViewModel(runId, { scope, ledger: rows });
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
