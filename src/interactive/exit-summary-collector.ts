import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { FactMetric } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { plainOutcomeLabel, settledRunCaveat, TOOL_GUARD_REASON_CODE } from "../domains/dispatch/failure-headline.js";
import { summarizeTrustStatus } from "../domains/evidence/trust-projection.js";
import { mutatingReceipts } from "../domains/safety/finish-contract.js";
import { UNATTENDED_DECIDED_BY } from "../domains/safety/unattended.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetryContract } from "../domains/telemetry/index.js";
import type { ChatLoopEvent } from "../session-control/chat-loop.js";
import type { WorkerRunResultFacts } from "../session-control/worker-stream.js";
import { effectiveToolCall, gatewayChainReceipts } from "../tools/surface.js";
import {
	SENT_DISPOSITIONS,
	sentCallCount,
	sessionVerifiedOutcomes,
	usageCoverage,
	usageEstimatedCalls,
	usageEstimates,
	usageGap,
	usageLineFigure,
	usageLineNotes,
	type VerifiedOutcomeWords,
	verifiedOutcomeWords,
} from "./usage-words.js";

export interface ExitSummarySnapshot {
	sessionId: string;
	sessionName: string | null;
	wallMs: number;
	turns: number;
	models: ReadonlyArray<{ target: string; model: string }>;
	/** Whole-session spend across every branch, read from the telemetry read model at exit (#434 §11.3). */
	spend: ExitSpend;
	tools: ReadonlyArray<{ tool: string; count: number; failures: number }>;
	files: ReadonlyArray<string>;
	fileChanges: ReadonlyArray<{ path: string; count: number }>;
	workers: ReadonlyArray<{
		runId: string;
		agent: string;
		target: string;
		model: string;
		outcome: string;
		/**
		 * Why a run whose process finished cannot be leaned on, such as `validation failed`, from its sealed record
		 * through the rule the worker card and Fleet read. The card said `2 succeeded` beside Fleet's two failures.
		 */
		against?: string;
		record: string;
	}>;
	permissions: { granted: number; denied: number; expired: number; blocked: number };
	/**
	 * What Clio answered itself because nobody answered in time (#421):
	 * ask_user questions it chose for, and permission cards it denied.
	 */
	unattended: { questions: number; permissions: number };
	timeline: ReadonlyArray<{ elapsedMs: number; text: string }>;
	timelineOmitted: number;
	compactions: number;
	/**
	 * Git hook files added, changed or removed during this visit, by workspace
	 * path. A hook runs outside Clio's sandbox on the next git command, so the
	 * summary names them whatever its style. `key` names an executable git
	 * config value; `path` is then the config file that sets it.
	 */
	gitHooks?: ReadonlyArray<{ path: string; kind: string; key?: string }>;
	/**
	 * Git operations Clio ran itself after such a change, by `outcome`: a
	 * mutation with hooks off and the changed config overridden (`hooks-off`)
	 * or as configured under yolo (`yolo`), and its read-only git with the
	 * changed config overridden (`overridden`) or not run (`skipped`)
	 * (src/domains/safety/internal-git-policy.ts).
	 */
	internalGit?: ReadonlyArray<{
		operation: string;
		outcome: string;
		changes: ReadonlyArray<{ path: string; kind: string; key?: string }>;
	}>;
}

/** A path inside the workspace by its workspace path, any other as given. */
function workspacePath(file: string): string {
	const local = relative(process.cwd(), file);
	return local.startsWith("..") || isAbsolute(local) ? file : local;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Questions Clio answered for an absent operator in one tool result, a gateway chain's steps included. */
function autoResolvedQuestions(toolName: string, result: unknown): number {
	const count = (candidate: unknown): number => {
		const details = isRecord(candidate) ? candidate.details : undefined;
		const unattended = isRecord(details) ? details.unattended : undefined;
		const n = isRecord(unattended) ? unattended.autoResolved : undefined;
		return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
	};
	return count(result) + gatewayChainReceipts(toolName, result).reduce((sum, child) => sum + count(child.result), 0);
}

interface CollectorDeps {
	bus: TelemetryHub;
	telemetry: TelemetryContract;
	dispatch: Pick<DispatchContract, "observedRunWrites">;
	session?: Pick<SessionContract, "current">;
	getTurns: () => number | null;
	getToolCounts: () => ReadonlyMap<string, number>;
	getModel: () => { target: string; model: string } | null;
	/** The session's whole ledger, every branch, for the verified outcomes its spend is divided over. */
	readSessionEntries?: () => ReadonlyArray<unknown>;
	/** The git hook drift guard's account of hook files changed this visit (src/domains/safety/hook-drift.ts). */
	gitHookChanges?: () => ReadonlyArray<{ path: string; kind: string; key?: string }>;
	now?: () => number;
}

/**
 * Every figure is the read model's own display, so the card never sums a number (#434 §11.3). Lines of several facts
 * join them with ` · `, which the formatter wraps at.
 */
export type ExitSpend =
	| { kind: "unavailable" }
	| {
			kind: "ready";
			/** The session total, then the same notes as `breakdown`. */
			tokens: string;
			/** `in · out · cache read · cache write · reasoning` where something was reported, then the notes. */
			breakdown: string;
			cost: string;
			/**
			 * Model calls sent since the visit began, counted by `sentCallCount` as the /usage model calls row counts them:
			 * a retry is another attempt of the same call, and a worker run's calls are included. The card once said
			 * `3 model calls · 2 workers` beside a /usage total of 5, because it left the workers' calls out.
			 */
			visitCalls: number;
			byRole: string;
			/**
			 * Those calls' time from each one starting to its settle, so a model silent before its first token is
			 * counted; null when the visit sent none. Streaming alone (`modelTime`) read 404ms beside a 1m26s turn (B2).
			 */
			callTime: string | null;
			/** `4 calls had no timing data`, said once after the time rather than inside it (F4). */
			callTimeCoverage: string | null;
			models: ReadonlyArray<{ key: string; calls: string; cost: string; breakdown: string }>;
			/** The session's verified outcomes and its tokens and cost per outcome, as /usage words them. */
			verified: VerifiedOutcomeWords;
	  };

/**
 * The session's (or one model group's) token figures and the notes that qualify them, each note said once. The
 * figures carry one mark at most; the notes say which figures nobody reported, how many calls reported nothing, and
 * how many Clio estimated (E1).
 */
function tokenFacts(view: TelemetryView, model?: string): { figures: string[]; total: string; notes: string[] } {
	const quantity = (metric: FactMetric) =>
		view.quantity(
			factRef({
				scope: "session",
				owner: view.sessionId,
				metric,
				...(model === undefined ? {} : { group: { by: "model", key: model } }),
			}),
		);
	// In and out are the amounts; the rest earn a place only with something to say, what nobody reported is said once,
	// and the calls that reported nothing are counted once at the end rather than beside every figure (F4).
	const figures = [
		{ label: "in", quantity: quantity("input") },
		{ label: "out", quantity: quantity("output") },
		{ label: "cache read", quantity: quantity("cacheRead") },
		{ label: "cache write", quantity: quantity("cacheWrite") },
		{ label: "reasoning", quantity: quantity("reasoning") },
	];
	const [input, output] = figures;
	const { shown, notes } = usageLineNotes(figures);
	// Each figure keeps one mark at most; what Clio estimated is said once, by the calls behind the total (E1).
	const estimates = usageEstimates(usageEstimatedCalls(quantity("total")));
	return {
		figures: [
			// Label first, as the turn receipt and /usage write it: one notation for tokens on every surface (U5).
			`in ${usageLineFigure(input?.quantity)}`,
			`out ${usageLineFigure(output?.quantity)}`,
			...shown.map((entry) => `${entry.label} ${usageLineFigure(entry.quantity)}`),
		],
		total: usageLineFigure(quantity("total")),
		notes: [...notes, ...(estimates !== null ? [estimates] : [])],
	};
}

function tokenBreakdown(view: TelemetryView, model?: string): string {
	const { figures, notes } = tokenFacts(view, model);
	return [...figures, ...notes].join(" · ");
}

export function exitSpend(
	view: TelemetryView | null | undefined,
	visitFrom: string,
	entries: ReadonlyArray<unknown> = [],
): ExitSpend {
	if (!view) return { kind: "unavailable" };
	const session = view.session();
	const sessionTokens = tokenFacts(view);
	const visit = view.calls({ from: visitFrom, dispositions: [...SENT_DISPOSITIONS] });
	// `settle` runs from each attempt's start, retries included, so it holds the silent wait for the first token that
	// `modelTime` (first token to settle) leaves out. It also holds any admission hold Clio put on the request.
	const callTime =
		visit.matched > 0
			? view.attempts(
					visit.calls.map((call) => call.attemptId),
					"settle",
				)
			: null;
	return {
		kind: "ready",
		// The total's own gap counts a call that reported in and out but no cache read as a call with no usage data, so
		// the brief line once named more such calls than the standard line beside the same session. Both share notes.
		tokens: [sessionTokens.total, ...sessionTokens.notes].join(" · "),
		breakdown: tokenBreakdown(view),
		cost: session.totals.usd.display,
		visitCalls: sentCallCount(view, { from: visitFrom }),
		byRole: session.byRole.map((row) => `${row.role} ${row.calls.display}`).join(" · "),
		callTime: callTime === null ? null : usageLineFigure(callTime),
		callTimeCoverage: usageCoverage(usageGap(callTime), "timing data"),
		models: view.cost("model").groups.map((group) => ({
			key: group.key,
			calls: group.calls.display,
			cost: group.usd.display,
			breakdown: tokenBreakdown(view, group.key),
		})),
		verified: verifiedOutcomeWords(view, sessionVerifiedOutcomes(view, entries)),
	};
}

/**
 * A settled run's timeline words. The run's settle event said `succeeded` before its sealed record was read, and the
 * timeline kept `verifier succeeded` beside a Workers row that read `validation failed` from that record, so a success
 * is claimed only once the record has been read, in the words the Workers row uses.
 */
function settledWords(worker: ExitSummarySnapshot["workers"][number]): string {
	if (worker.outcome !== "succeeded") return plainOutcomeLabel(worker.outcome);
	if (worker.record === "not available") return "finished, run record not read";
	return worker.against ?? worker.outcome;
}

/** This visit's account. All ledger folds and record reads happen while events arrive. */
const BLOCK_REASON_MAX_CHARS = 120;

/**
 * Who stopped a worker's call, in the timeline's words. Every blocked finish used to read `Worker safety refusal:
 * grep`, so a scout whose repeated grep the loop guard held back sent the operator looking for a safety rule that
 * never fired. A guard block says so and quotes its reason; a policy block names its rule.
 */
function workerBlockWords(
	tool: string,
	payload: { reason?: string; ruleId?: string; reasonCode?: string; redundantRepeat?: boolean },
): { guard: boolean; words: string } {
	// The first sentence says what stopped the call; the rest is recovery advice addressed to the model.
	const reason = (payload.reason ?? "").split(/\n|(?<=\.)\s/u)[0]?.trim() ?? "";
	const clipped = reason.length > BLOCK_REASON_MAX_CHARS ? `${reason.slice(0, BLOCK_REASON_MAX_CHARS)}…` : reason;
	if (payload.redundantRepeat === true || payload.reasonCode === TOOL_GUARD_REASON_CODE) {
		return { guard: true, words: `Worker tool guard stopped ${tool}${clipped ? `: ${clipped}` : ""}` };
	}
	const rule = payload.ruleId ?? payload.reasonCode;
	return {
		guard: false,
		words: `Worker safety refusal: ${tool}${rule ? ` by rule ${rule}` : ""}${clipped ? `: ${clipped}` : ""}`,
	};
}

export function createExitSummaryCollector(deps: CollectorDeps) {
	const now = deps.now ?? (() => performance.now());
	let startedAt = now();
	let visitFrom = new Date().toISOString();
	let baseTurns = deps.getTurns() ?? 0;
	let priorTurns = 0;
	let hasModelTurn = deps.session?.current()?.hasModelTurn === true;
	/**
	 * The session this visit reopened rather than started. A live session's meta
	 * never carries `hasModelTurn` (only the history scan fills it in), so without
	 * this a resumed session looked empty until a new turn ran, and quitting
	 * printed no resume line for a session that plainly had one. A session already
	 * current when the collector starts is one too: a fresh launch creates its
	 * session on the first prompt.
	 */
	let reopenedSessionId = deps.session?.current()?.id ?? null;
	let compactions = 0;
	const models = new Map<string, { target: string; model: string }>();
	const files = new Map<string, number>();
	const workerPaths = new Map<string, Set<string>>();
	const failures = new Map<string, number>();
	/** A settled run's entry names its run, so its words are read from the run's record when the snapshot is taken. */
	const timeline: Array<{ elapsedMs: number; text: string; runId?: string }> = [];
	let timelineOmitted = 0;
	const permissions = { granted: 0, denied: 0, expired: 0, blocked: 0 };
	const unattended = { questions: 0, permissions: 0 };
	const highlight = (text: string, runId?: string): void => {
		timeline.push({ elapsedMs: Math.max(0, now() - startedAt), text, ...(runId !== undefined ? { runId } : {}) });
		if (timeline.length > 32) {
			timeline.shift();
			timelineOmitted += 1;
		}
	};
	const noteFailure = (tool: string): void => {
		failures.set(tool, (failures.get(tool) ?? 0) + 1);
	};
	const calls = new Map<string, { entry: unknown; cwd: string; tool: string }>();
	const workers = new Map<string, ExitSummarySnapshot["workers"][number]>();
	const workerTools = new Map<string, ReadonlyArray<{ tool: string; count: number }>>();
	const workerCapabilities = new Map<string, string>();
	const noteModel = (target: string, model: string): void => {
		if (target && model) models.set(`${target}\0${model}`, { target, model });
	};
	const noteFiles = (paths: ReadonlyArray<string>, cwd = process.cwd(), seen?: Set<string>): void => {
		for (const path of paths) {
			const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
			const abs = resolve(cwd, expanded);
			const local = relative(process.cwd(), abs);
			const name = local.startsWith("..") || isAbsolute(local) ? abs : local || ".";
			if (seen?.has(name)) continue;
			seen?.add(name);
			files.set(name, (files.get(name) ?? 0) + 1);
		}
	};
	const reset = (): void => {
		startedAt = now();
		visitFrom = new Date().toISOString();
		baseTurns = deps.getTurns() ?? 0;
		priorTurns = 0;
		hasModelTurn = deps.session?.current()?.hasModelTurn === true;
		compactions = 0;
		models.clear();
		files.clear();
		workerPaths.clear();
		failures.clear();
		timeline.length = 0;
		timelineOmitted = 0;
		permissions.granted = permissions.denied = permissions.expired = permissions.blocked = 0;
		unattended.questions = unattended.permissions = 0;
		calls.clear();
		workers.clear();
		workerTools.clear();
		workerCapabilities.clear();
	};
	const settled = (run: { runId: string; agentId: string; outcome: string }): void => {
		const worker = workers.get(run.runId);
		if (!worker) return;
		workers.set(run.runId, { ...worker, outcome: run.outcome });
		highlight(`${run.agentId} ${run.outcome}`, run.runId);
		noteFiles(deps.dispatch.observedRunWrites?.(run.runId) ?? [], process.cwd(), workerPaths.get(run.runId));
	};
	// Like the git hook line, this account is the process's, never reset with the visit.
	const internalGit = new Map<
		string,
		{ operation: string; outcome: string; changes: Map<string, { path: string; kind: string; key?: string }> }
	>();
	const unsubscribers = [
		deps.bus.subscribe("safety.internal_git_drifted", (event) => {
			if (typeof event?.operation !== "string" || !Array.isArray(event.changes)) return;
			const outcome = typeof event.outcome === "string" ? event.outcome : event.hardened === true ? "hooks-off" : "yolo";
			const id = `${event.operation}\0${outcome}`;
			const entry = internalGit.get(id) ?? { operation: event.operation, outcome, changes: new Map() };
			for (const change of event.changes) {
				entry.changes.set(`${change.path}\0${change.key ?? ""}`, {
					path: workspacePath(change.path),
					kind: change.kind,
					...(change.key !== undefined ? { key: change.key } : {}),
				});
			}
			internalGit.set(id, entry);
		}),
		deps.bus.subscribe("session.reattached", ({ sessionId }) => {
			baseTurns = deps.getTurns() ?? 0;
			hasModelTurn ||= deps.session?.current()?.hasModelTurn === true;
			reopenedSessionId = sessionId;
		}),
		deps.bus.subscribe("session.parked", () => {
			reopenedSessionId = null;
			priorTurns += Math.max(0, (deps.getTurns() ?? 0) - baseTurns);
			baseTurns = deps.getTurns() ?? 0;
		}),
		deps.bus.subscribe("context.pruned", () => {
			compactions += 1;
			highlight("Context compacted");
		}),
		deps.bus.subscribe("run.started", (run) => {
			hasModelTurn = true;
			workers.set(run.runId, {
				runId: run.runId,
				agent: run.agentId,
				target: run.targetId,
				model: run.wireModelId,
				outcome: "running",
				record: "not available",
			});
			workerPaths.set(run.runId, new Set());
			highlight(`${run.agentId} started on ${run.targetId}`);
			noteModel(run.targetId, run.wireModelId);
		}),
		deps.bus.subscribe("run.progressed", ({ runId, event }) => {
			if (!workers.has(runId) || !event || typeof event !== "object") return;
			const frame = event as {
				type?: string;
				message?: { role?: string };
				toolName?: string;
				toolCallId?: string;
				args?: unknown;
				payload?: {
					tool?: string;
					toolCallId?: string;
					outcome?: string;
					decision?: string;
					reason?: string;
					ruleId?: string;
					reasonCode?: string;
					redundantRepeat?: boolean;
				};
			};
			if (
				frame.type === "tool_execution_start" &&
				typeof frame.toolName === "string" &&
				typeof frame.toolCallId === "string"
			) {
				workerCapabilities.set(`${runId}\0${frame.toolCallId}`, effectiveToolCall(frame.toolName, frame.args).toolName);
			}
			if (frame.type === "clio_coder_tool_finish" && typeof frame.payload?.tool === "string") {
				const key = `${runId}\0${frame.payload.toolCallId ?? ""}`;
				const tool = workerCapabilities.get(key) ?? frame.payload.tool;
				workerCapabilities.delete(key);
				const stats = new Map((workerTools.get(runId) ?? []).map((stat) => [stat.tool, stat.count]));
				stats.set(tool, (stats.get(tool) ?? 0) + 1);
				workerTools.set(
					runId,
					[...stats].map(([tool, count]) => ({ tool, count })),
				);
				if (frame.payload.outcome === "error") noteFailure(tool);
				if (frame.payload.outcome === "blocked" || frame.payload.decision === "blocked") {
					const blocked = workerBlockWords(tool, frame.payload);
					// A guard holding back a repeated call is no approval or refusal, so it stays out of that tally.
					if (!blocked.guard) permissions.blocked += 1;
					highlight(blocked.words);
				}
			}
		}),
		deps.bus.subscribe("approval.resolved", (event) => {
			permissions[event.status] += 1;
			if (event.decidedBy === UNATTENDED_DECIDED_BY) {
				unattended.permissions += 1;
				highlight(`Permission timed out unanswered, denied${event.tool ? `: ${event.tool}` : ""}`);
				return;
			}
			highlight(`Permission ${event.status}${event.tool ? `: ${event.tool}` : ""}`);
		}),
		deps.bus.subscribe("safety.blocked", (event) => {
			permissions.blocked += 1;
			highlight(`Safety refusal: ${event.tool}`);
		}),
		deps.bus.subscribe("run.completed", settled),
		deps.bus.subscribe("run.failed", settled),
	];
	return {
		reset,
		observeChat(event: ChatLoopEvent): void {
			if (event.type === "agent_start") {
				const model = deps.getModel();
				if (model) {
					if (!models.has(`${model.target}\0${model.model}`)) highlight(`Model ${model.target} / ${model.model}`);
					noteModel(model.target, model.model);
				}
			}
			if (event.type === "message_end" && event.message.role === "assistant") hasModelTurn = true;
			if (event.type === "tool_execution_start") {
				hasModelTurn = true;
				const args = event.args as Record<string, unknown> | undefined;
				const effective = effectiveToolCall(event.toolName, args);
				calls.set(event.toolCallId, {
					tool: effective.toolName,
					entry: {
						kind: "message",
						role: "tool_call",
						payload: { name: event.toolName, args, toolCallId: event.toolCallId },
					},
					cwd: typeof effective.args?.cwd === "string" ? resolve(process.cwd(), effective.args.cwd) : process.cwd(),
				});
			}
			if (event.type === "tool_execution_end") {
				const call = calls.get(event.toolCallId);
				if (event.isError) noteFailure(call?.tool ?? event.toolName);
				const answeredAlone = event.isError ? 0 : autoResolvedQuestions(event.toolName, event.result);
				if (answeredAlone > 0) {
					unattended.questions += answeredAlone;
					highlight(`Clio answered ${answeredAlone} unanswered question${answeredAlone === 1 ? "" : "s"}`);
				}
				if (call) {
					const payload = { ...event };
					noteFiles(mutatingReceipts([call.entry, { kind: "message", role: "tool_result", payload }]).paths, call.cwd);
					calls.delete(event.toolCallId);
				}
			}
		},
		observeRunResult(runId: string, record: WorkerRunResultFacts | null): void {
			const worker = workers.get(runId);
			if (!worker || record === null) return;
			const { against: _prior, ...rest } = worker;
			const caveat = settledRunCaveat(record);
			workers.set(runId, {
				...rest,
				...(caveat?.kind === "against" ? { against: caveat.words } : {}),
				record: record.trust ? summarizeTrustStatus(record.trust).verdict : "unknown",
			});
			if (record.toolCounts) workerTools.set(runId, record.toolCounts);
			noteFiles(record.changedPaths ?? [], process.cwd(), workerPaths.get(runId));
		},
		observeLocalEntry(entry: unknown): void {
			noteFiles(mutatingReceipts([entry]).paths);
		},
		snapshot(): ExitSummarySnapshot | null {
			const session = deps.session?.current();
			if (!session || (!hasModelTurn && reopenedSessionId !== session.id)) return null;
			let gitHooks: ReadonlyArray<{ path: string; kind: string; key?: string }> = [];
			try {
				gitHooks = (deps.gitHookChanges?.() ?? []).map((change) => ({
					path: workspacePath(change.path),
					kind: change.kind,
					...(change.key !== undefined ? { key: change.key } : {}),
				}));
			} catch {
				// The guard reads the filesystem; an unreadable tree leaves the line out rather than the summary.
			}
			const tools = new Map(deps.getToolCounts());
			for (const stats of workerTools.values()) {
				for (const { tool, count } of stats) tools.set(tool, (tools.get(tool) ?? 0) + count);
			}
			let entries: ReadonlyArray<unknown> = [];
			try {
				entries = deps.readSessionEntries?.() ?? [];
			} catch {
				// An unreadable ledger counts no ledger outcome; the card still closes with the spend it has.
			}
			const spend = exitSpend(deps.telemetry.read?.live(), visitFrom, entries);
			return {
				sessionId: session.id,
				sessionName: session.name ?? null,
				wallMs: Math.max(0, now() - startedAt),
				turns: priorTurns + Math.max(0, (deps.getTurns() ?? 0) - baseTurns),
				models: [...models.values()],
				spend,
				tools: [...new Set([...tools.keys(), ...failures.keys()])]
					.map((tool) => ({ tool, count: tools.get(tool) ?? 0, failures: failures.get(tool) ?? 0 }))
					.sort((a, b) => a.tool.localeCompare(b.tool)),
				files: [...files.keys()].sort(),
				fileChanges: [...files].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
				permissions: { ...permissions },
				unattended: { ...unattended },
				timeline: timeline.map(({ elapsedMs, text, runId }) => {
					const worker = runId !== undefined ? workers.get(runId) : undefined;
					return { elapsedMs, text: worker ? `${worker.agent} ${settledWords(worker)}` : text };
				}),
				timelineOmitted,
				workers: [...workers.values()],
				compactions,
				...(gitHooks.length > 0 ? { gitHooks } : {}),
				...(internalGit.size > 0
					? {
							internalGit: [...internalGit.values()].map((entry) => ({
								operation: entry.operation,
								outcome: entry.outcome,
								changes: [...entry.changes.values()],
							})),
						}
					: {}),
			};
		},
		dispose(): void {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
