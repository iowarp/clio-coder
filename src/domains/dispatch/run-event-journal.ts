import type { ToolRoundRecord } from "../../engine/types.js";
/**
 * Run event journal: the sink a run's display feed is written through.
 *
 * Live dispatch events exist only in the orchestrator's heap, so a separate process cannot see a run in flight. The
 * sink writes every display row twice. The run's telemetry journal, `telemetry/runs/<runId>/journal.jsonl` under
 * `clioStateDir()` (src/domains/telemetry/paths.ts), keeps its structural projection as `run.feed_appended` records,
 * written by the run's batched telemetry writer (#434). The run's feed file (src/domains/dispatch/run-feed.ts) keeps
 * the full redacted row as run state, and the workers dashboard and `clio-coder fleet view --follow` read it.
 *
 * Row kinds:
 *   open               run opened, carries agentId
 *   event              one display-tail entry; the only droppable kind
 *   journal_truncated  written once, the moment dropping begins
 *   result             the run's result facts (outcome, exit code)
 *   terminal           always the last write for a run
 *
 * Each store bounds itself: display-only `event` rows are dropped past its cap behind one `journal_truncated` marker,
 * and lifecycle and result rows are never dropped, so a capped feed still answers what the run was and how it ended.
 * Nothing here ever throws into a dispatch.
 */

import type { CallUsage } from "../../core/token-split.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import type { ToolCallFacts } from "../../tools/agent-tools.js";
import { telemetryRunsDirectory } from "../telemetry/index.js";
import { appendRunFeed } from "./run-feed.js";
import { runTelemetryJournal } from "./run-telemetry.js";

/** Per-run size cap; crossing it drops display-only lines behind one marker. */
export const RUN_EVENT_JOURNAL_CAP_BYTES = 2 * 1024 * 1024;
/**
 * Structured facts an `event` line may carry beside its display `detail`, so a
 * viewer can build a live worker card without the event itself. Every field is
 * already bounded and redacted where it was produced: a tool name, the call
 * descriptor's verb (its object rides in `detail`), a finish outcome and
 * duration, and the token counts one model call reported. Arguments, results
 * and reasoning never appear here.
 */
export interface RunEventJournalFacts {
	callFacts?: ToolCallFacts;
	callIndex?: number;
	usage?: CallUsage;
	toolRounds?: ToolRoundRecord[];
	usageScope?: "call" | "run-aggregate";
	tool?: string;
	/** Pairs a tool start with its finish when the producer carried an id. */
	callId?: string;
	/** Present-tense descriptor verb (`reading`); the object is the line's detail. */
	verb?: string;
	outcome?: "ok" | "error" | "blocked";
	durationMs?: number;
	/** Why a call was blocked or failed, or why an approval resolved the way it did. */
	reason?: string;
	/** Tokens one model call processed (input, cache reads, output, cache writes). */
	tokens?: number;
}

/** Everything on a feed row except the `seq`/`at` envelope each store adds. */
export type RunEventJournalBody =
	| { kind: "open"; runId: string; agentId: string }
	| ({ kind: "event"; type: string; detail?: string } & RunEventJournalFacts)
	| { kind: "journal_truncated"; reason: string; droppedFromSeq: number }
	| { kind: "result"; outcome: string; exitCode: number | null; attemptRunId?: string }
	| { kind: "terminal"; outcome: string; detail?: string };

/** One display-tail entry, structurally the registry's `RunTailEntry`, plus optional facts. */
export interface RunEventJournalEntry extends RunEventJournalFacts {
	at: string;
	type: string;
	detail?: string;
}

/** Result facts worth keeping even when display lines are being dropped. */
export interface RunEventJournalResult {
	outcome: string;
	exitCode: number | null;
	/** The terminal attempt's run id, recorded only when it differs from the logical run. */
	attemptRunId?: string | undefined;
}

/**
 * What the run event registry writes to. Every method is best-effort and
 * returns void: a journal that cannot write degrades itself and the dispatch
 * never learns about it.
 */
export interface RunEventJournalSink {
	open(runId: string, agentId: string): void;
	append(runId: string, entry: RunEventJournalEntry): void;
	result(runId: string, result: RunEventJournalResult): void;
	terminal(runId: string, outcome: string, detail?: string): void;
}

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

let configuredEnabled: boolean | undefined;

/**
 * Install the `fleet.history.journal` setting. Called from the composition root beside
 * `configureGuardrails` so the journal never reads settings.yaml itself; a
 * settings read on the dispatch event path would be both a cost and a throw
 * site (readSettings rejects an invalid file).
 */
export function configureRunEventJournal(enabled: boolean | undefined): void {
	configuredEnabled = enabled;
}

/** Effective settings projection, then the shipped default. */
function runEventJournalEnabled(): boolean {
	return configuredEnabled ?? true;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root holding one journal directory per run. */
export function runEventJournalRoot(): string {
	return telemetryRunsDirectory(clioStateDir());
}

/**
 * Run ids are generated by `newRunId()` as base36, and fleet/gate ids add a
 * prefix and hex. Nothing legitimate contains a path separator, so anything
 * that does is refused rather than resolved before a path is built from it.
 */
function isSafeRunId(runId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) && runId !== "." && runId !== "..";
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * The display tail forwards to the run's telemetry writer, which batches its structural projection into the run's
 * journal as `run.feed_appended` records (#434), and to the run's feed file with the full row. A run without an open
 * telemetry owner gets no journal projection: only the telemetry domain writes under the telemetry root, and the open
 * failure that left the run ownerless was already reported where it happened. Its feed file is still written.
 */
function createRunEventJournal(): RunEventJournalSink {
	const forward = (runId: string, body: RunEventJournalBody, at?: string): void => {
		if (!isSafeRunId(runId) || !runEventJournalEnabled() || stateRootRemoved()) return;
		runTelemetryJournal(runId)?.feed(body, RUN_EVENT_JOURNAL_CAP_BYTES);
		appendRunFeed(runId, body, at);
	};
	return {
		open(runId, agentId): void {
			forward(runId, { kind: "open", runId, agentId });
		},
		append(runId, entry): void {
			const { at, ...body } = entry;
			forward(runId, { kind: "event", ...body }, at);
		},
		result(runId, result): void {
			forward(runId, {
				kind: "result",
				outcome: result.outcome,
				exitCode: result.exitCode,
				...(result.attemptRunId !== undefined ? { attemptRunId: result.attemptRunId } : {}),
			});
		},
		terminal(runId, outcome, detail): void {
			forward(runId, { kind: "terminal", outcome, ...(detail !== undefined ? { detail } : {}) });
		},
	};
}

// ---------------------------------------------------------------------------
// Process-wide default sink
// ---------------------------------------------------------------------------

let defaultJournal: RunEventJournalSink | null = null;

/** The sink every run event registry attaches to unless it was handed one; created lazily, shared per process. */
export function defaultRunEventJournal(): RunEventJournalSink {
	defaultJournal ??= createRunEventJournal();
	return defaultJournal;
}
