import { costWasMeasured } from "../../domains/telemetry/cost.js";
import type { AcpWorkspaceView } from "./types.js";

export type { AcpWorkspaceView } from "./types.js";

import { ACP_PLAN_META_KEY, ACP_WORKSPACE_META_KEY } from "./types.js";

export { ACP_PLAN_META_KEY, ACP_WORKSPACE_META_KEY } from "./types.js";

/**
 * Pushed session telemetry: the standard `usage_update` and `plan` session
 * updates, and the workspace snapshot on `session_info_update`.
 *
 * Every frame here is emitted on change, never on a timer. A model response
 * schedules one coalesced `usage_update`, a settled tool call re-reads the
 * plan, and a tool that can write re-probes the workspace off the loop with at
 * most one probe in flight. The pull methods (`_clio-coder/context/ledger`,
 * `_clio-coder/usage/read`, `_clio-coder/session/board`) stay the full views;
 * these frames carry what a live meter, plan list and branch chip need.
 *
 * None of these frames count toward a turn's `updatesSent`: that counter is
 * how the server tells a refused prompt from a model that said nothing, and a
 * meter frame is not a model saying something.
 */

import type { FactMetric } from "../../core/telemetry/dto.js";
import { factRef } from "../../core/telemetry/dto.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import type { CostProvenance } from "../../domains/providers/types/cost-provenance.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import { ACP_CONTEXT_META_KEY, projectContextLedger } from "./context-ledger.js";
import type { AcpCostAggregate } from "./types.js";
import { ACP_USAGE_META_KEY } from "./types.js";
import { knownFree, knownPart, unknownCallCoverage } from "./usage.js";

const MAX_PLAN_ENTRIES = 100;
const MAX_TEXT_BYTES = 1024;
/** A wedged git must not hold a prompt response; the frame still lands when the probe does. */
const WORKSPACE_SETTLE_BOUND_MS = 2000;
/** A wedged journal writer must not hold one either; the response then reads what the read model folded. */
const FOLD_SETTLE_BOUND_MS = 2000;

/** The operator turns one prompt ran and the call attempts its runs settled; the server fills it from their events. */
export interface AcpPromptTurn {
	turnIds: Set<string>;
	attemptIds: Set<string>;
}

type TurnUsage = ReturnType<typeof turnUsageMeta>;
/** The usage block a prompt response carries: its turn's and, when the read model has the session, the session's. */
export type PromptUsage = TurnUsage & { session?: SessionTotals };

const known = (sum: FactSum) => sum.measured + sum.estimated;

/**
 * `_meta["clio-coder/usage"]` on the prompt response and on in-turn `usage_update` frames: one shape, so the last frame
 * equals the response. Every number is the known part of the read model's sum over the prompt's operator turns, their
 * workers included, as the footer and the transcript receipt read them (#434 §11.3). v1 forces the five token
 * counts; with no view of the session nothing else is claimed.
 */
export function turnUsageMeta(view: TelemetryView | null, turn: AcpPromptTurn) {
	if (view === null)
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costProvenance: "unknown" };
	const turnIds = [...turn.turnIds];
	const sum = (metric: FactMetric) => view.turns(turnIds, metric);
	const usd = sum("usd");
	const calls = sum("calls").fact;
	const cost: AcpCostAggregate = {
		knownUsd: known(usd.fact),
		hasEstimated: usd.fact.coverage.estimated > 0,
		hasUnknown: usd.fact.unknownCount > 0,
		allKnownFree: usd.free && usd.fact.unknownCount === 0 && usd.fact.coverage.estimated === 0,
		calls: known(calls),
		...(calls.unknownCount > 0 ? { unknownCallCoverageRuns: calls.unknownCount } : {}),
	};
	const apiCalls = known(sum("apiCalls").fact);
	const missingTokenCalls = known(sum("missingTokenCalls").fact);
	return {
		input: known(sum("input").fact),
		output: known(sum("output").fact),
		cacheRead: known(sum("cacheRead").fact),
		cacheWrite: known(sum("cacheWrite").fact),
		reasoning: known(sum("reasoning").fact),
		totalTokens: known(sum("total").fact),
		costUsd: cost.knownUsd,
		costDisplay: usd.display,
		costProvenance: provenanceOf(cost),
		costSummary: cost,
		...(apiCalls > 0 ? { apiCalls } : {}),
		...(missingTokenCalls > 0 ? { missingTokenCalls } : {}),
	};
}

function bounded(text: string): string {
	let safe = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		safe += code <= 0x1f || code === 0x7f ? " " : character;
	}
	if (Buffer.byteLength(safe, "utf8") <= MAX_TEXT_BYTES) return safe;
	let cut = safe.slice(0, MAX_TEXT_BYTES);
	while (Buffer.byteLength(cut, "utf8") > MAX_TEXT_BYTES - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

const optional = (text: string | null) => (text === null ? null : bounded(text));
const nullableCount = (value: number | null) =>
	value === null || !Number.isFinite(value) ? null : Math.max(0, Math.round(value));

/** `origin` is read verbatim from git config, and an https remote may carry a token in its userinfo. */
function redactRemote(url: string | null): string | null {
	if (url === null) return null;
	return bounded(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, "$1"));
}

function projectWorkspace(snapshot: WorkspaceSnapshot): AcpWorkspaceView {
	return {
		version: 1,
		cwd: bounded(snapshot.cwd),
		isGit: snapshot.isGit,
		branch: optional(snapshot.branch),
		dirty: snapshot.dirty,
		ahead: nullableCount(snapshot.ahead),
		behind: nullableCount(snapshot.behind),
		remoteUrl: redactRemote(snapshot.remoteUrl),
		projectType: snapshot.projectType,
		capturedAt: snapshot.capturedAt,
	};
}

const PLAN_STATUS = {
	pending: "pending",
	active: "in_progress",
	completed: "completed",
	blocked: "pending",
} as const;

/**
 * ACP plan entries know pending, in_progress and completed. A blocked task is
 * still owed work, so it travels as pending with its real status and reason
 * under `_meta`; a cancelled task is no longer part of the plan, and a client
 * replaces the whole list on every update, so it is left out and counted.
 * The board has no priority, so every entry says medium.
 */
function projectAcpPlan(plan: TaskBoardSnapshot | null) {
	const tasks = plan?.tasks ?? [];
	const kept = tasks.filter((task) => task.status !== "cancelled");
	return {
		sessionUpdate: "plan" as const,
		entries: kept.slice(0, MAX_PLAN_ENTRIES).map((task) => ({
			content: bounded(task.title),
			priority: "medium" as const,
			status: PLAN_STATUS[task.status as keyof typeof PLAN_STATUS] ?? "pending",
			_meta: {
				[ACP_PLAN_META_KEY]: {
					id: task.id,
					status: task.status,
					origin: task.origin ?? "agent",
					reason: task.reason === undefined || task.reason === "" ? null : bounded(task.reason),
				},
			},
		})),
		_meta: {
			[ACP_PLAN_META_KEY]: {
				version: 1,
				boardId: plan?.boardId ?? null,
				title: plan === null ? null : bounded(plan.title),
				cancelled: tasks.length - kept.length,
				truncated: kept.length > MAX_PLAN_ENTRIES,
			},
		},
	};
}

const EMPTY_PLAN_SIGNATURE = JSON.stringify(projectAcpPlan(null));

interface SessionTotals {
	costDisplay: string;
	costSummary: AcpCostAggregate;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	costProvenance: CostProvenance;
	calls: number;
	unknownCallCoverageRuns?: number;
	missingTokenCalls?: number;
	hasEstimatedCost?: boolean;
}

function provenanceOf(cost: AcpCostAggregate): CostProvenance {
	if (!costWasMeasured(cost) || cost.hasUnknown) return "unknown";
	if (cost.hasEstimated) return "estimated";
	return cost.allKnownFree ? "known_free" : "known";
}

/**
 * The session's whole spend for `usage_update` and the prompt response, read from the telemetry read model: its own
 * calls and the worker runs it referenced (#434 §11.3). Each number is a quantity's known part; the cost's
 * provenance and `missingTokenCalls` say what it leaves out.
 */
export function sessionUsageTotals(view: TelemetryView): SessionTotals {
	const read = (metric: FactMetric) => view.quantity(factRef({ scope: "session", owner: view.sessionId, metric }));
	const total = view.cost("label").total;
	const usd = total.usd;
	const fact = usd.fact;
	const summary: AcpCostAggregate = {
		knownUsd: knownPart(usd),
		hasEstimated: "kind" in fact ? fact.kind === "estimated" : fact.coverage.estimated > 0,
		hasUnknown: "kind" in fact ? fact.kind === "unknown" : fact.unknownCount > 0,
		allKnownFree: knownFree(total.pricedBy, usd),
		calls: knownPart(total.calls),
		...(unknownCallCoverage(total.calls) > 0 ? { unknownCallCoverageRuns: unknownCallCoverage(total.calls) } : {}),
	};
	const missingTokenCalls = knownPart(read("missingTokenCalls"));
	return {
		costSummary: summary,
		costDisplay: usd.display,
		input: knownPart(read("input")),
		output: knownPart(read("output")),
		cacheRead: knownPart(read("cacheRead")),
		cacheWrite: knownPart(read("cacheWrite")),
		reasoning: knownPart(read("reasoning")),
		totalTokens: knownPart(total.tokens),
		costUsd: summary.knownUsd,
		costProvenance: provenanceOf(summary),
		calls: summary.calls,
		...(summary.unknownCallCoverageRuns ? { unknownCallCoverageRuns: summary.unknownCallCoverageRuns } : {}),
		...(missingTokenCalls > 0 ? { missingTokenCalls } : {}),
		...(summary.hasEstimated ? { hasEstimatedCost: true } : {}),
	};
}

export interface AcpLiveTelemetryDeps {
	subscribeUsage?: (listener: () => void) => () => void;
	notify(sessionId: string, update: Record<string, unknown>): void;
	/** The one session this process hosts, or null between sessions. */
	sessionId(): string | null;
	contextLedger?: () => ContextLedger;
	/** The read model's live view of the bound session; read after each model response and each folded batch. */
	sessionTelemetry?: () => TelemetryView | null;
	plan?: () => TaskBoardSnapshot | null;
	workspace?: (cwd: string) => Promise<WorkspaceSnapshot>;
	cwd: string;
	diagnostics?: (line: string) => void;
}

export interface AcpLiveTelemetry {
	/** A session became the bound one; `replay` re-sends the current meter and plan as a loaded session's state. */
	bind(replay: boolean): void;
	turnStarted(turn: AcpPromptTurn): void;
	/** A model response landed; one `usage_update` follows once the burst settles. */
	modelResponded(): void;
	/** A tool call settled; `mayWrite` re-probes the workspace. */
	toolSettled(mayWrite: boolean): void;
	/**
	 * Waits (bounded) until the read model has folded every call the turn's runs settled, flushes the meter and plan,
	 * and waits (bounded) for a workspace probe in flight. Returns the usage block, turn and session, as the last frame
	 * carried it before that wait, for the prompt response to repeat; null when no turn was open.
	 */
	turnSettled(): Promise<PromptUsage | null>;
	/** The latest workspace view, probing once if none landed yet; null when unwired or the probe failed. */
	workspace(): Promise<AcpWorkspaceView | null>;
	dispose(): void;
}

export function createAcpLiveTelemetry(deps: AcpLiveTelemetryDeps): AcpLiveTelemetry {
	let usageSignature: string | null = null;
	let accountingSignature: string | null = null;
	let planSignature: string | null = EMPTY_PLAN_SIGNATURE;
	let turn: AcpPromptTurn | null = null;
	/** The turn and session blocks the newest meter frame computed. */
	let framedTurn: TurnUsage | null = null;
	let framedSession: SessionTotals | null = null;
	const foldWaiters = new Set<{ check(): void; release(): void }>();
	let pendingUsage: ReturnType<typeof setImmediate> | null = null;
	let workspaceView: AcpWorkspaceView | null = null;
	let workspaceSignature: string | null = null;
	let probing: Promise<void> | null = null;
	let probeAgain = false;
	let disposed = false;

	const send = (update: Record<string, unknown>): void => {
		const sessionId = deps.sessionId();
		if (sessionId !== null && !disposed) deps.notify(sessionId, update);
	};

	const usageFrame = (): Record<string, unknown> | null => {
		if (deps.contextLedger === undefined) return null;
		let ledger: ContextLedger;
		try {
			ledger = deps.contextLedger();
		} catch (err) {
			deps.diagnostics?.(`usage_update skipped: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
		const context = projectContextLedger(ledger);
		const view = deps.sessionTelemetry?.() ?? null;
		const session = view === null ? null : sessionUsageTotals(view);
		framedTurn = turn === null ? null : turnUsageMeta(view, turn);
		framedSession = session;
		accountingSignature = JSON.stringify(session);
		// ACP `cost` is a plain amount, so an unknown price stays absent rather than reading as zero.
		const knownCost = session !== null && session.calls > 0;
		return {
			sessionUpdate: "usage_update",
			used: context.usedTokens,
			size: context.contextWindow,
			...(knownCost && session !== null && session.costProvenance !== "unknown"
				? { cost: { amount: session.costUsd, currency: "USD" } }
				: {}),
			_meta: {
				[ACP_CONTEXT_META_KEY]: context,
				[ACP_USAGE_META_KEY]: { ...framedTurn, session },
			},
		};
	};

	const flushUsage = (emit: boolean): void => {
		if (pendingUsage !== null) {
			clearImmediate(pendingUsage);
			pendingUsage = null;
		}
		const frame = usageFrame();
		if (frame === null) return;
		const signature = JSON.stringify(frame);
		if (signature === usageSignature) return;
		usageSignature = signature;
		if (emit) send(frame);
	};

	const flushPlan = (emit: boolean): void => {
		if (deps.plan === undefined) return;
		let plan: TaskBoardSnapshot | null;
		try {
			plan = deps.plan();
		} catch (err) {
			deps.diagnostics?.(`plan update skipped: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const frame = projectAcpPlan(plan);
		const signature = JSON.stringify(frame);
		if (signature === planSignature) return;
		planSignature = signature;
		if (emit) send(frame);
	};

	/** Whether the read model holds every call attempt the turn's runs settled. */
	const folded = (settling: AcpPromptTurn): boolean => {
		if (settling.attemptIds.size === 0) return true;
		const view = deps.sessionTelemetry?.() ?? null;
		if (view === null) return false;
		for (const attemptId of settling.attemptIds)
			if (view.quantity(factRef({ scope: "own", owner: view.sessionId, attemptId, metric: "calls" })) === null)
				return false;
		return true;
	};

	// A model response lands before the writer's batch holding its call is durable, and the response must total it.
	const awaitFold = async (settling: AcpPromptTurn): Promise<void> => {
		if (!deps.sessionTelemetry || !deps.subscribeUsage || folded(settling)) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let waiter: { check(): void; release(): void } | undefined;
		await new Promise<void>((resolve) => {
			waiter = { check: () => (folded(settling) ? resolve() : undefined), release: resolve };
			foldWaiters.add(waiter);
			timer = setTimeout(resolve, FOLD_SETTLE_BOUND_MS);
			timer.unref?.();
		});
		if (waiter) foldWaiters.delete(waiter);
		if (timer !== undefined) clearTimeout(timer);
		if (!disposed && !folded(settling))
			deps.diagnostics?.("prompt response sent before the telemetry read model folded all of its calls");
	};

	const probeOnce = async (): Promise<void> => {
		const probe = deps.workspace;
		if (probe === undefined) return;
		do {
			probeAgain = false;
			let view: AcpWorkspaceView;
			try {
				view = projectWorkspace(await probe(deps.cwd));
			} catch (err) {
				deps.diagnostics?.(`workspace probe failed: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			const { capturedAt: _capturedAt, ...facts } = view;
			const signature = JSON.stringify(facts);
			const first = workspaceSignature === null;
			workspaceView = view;
			if (signature === workspaceSignature) continue;
			workspaceSignature = signature;
			// The first view travels on the session/new or session/load response.
			if (!first) send({ sessionUpdate: "session_info_update", _meta: { [ACP_WORKSPACE_META_KEY]: view } });
		} while (probeAgain && !disposed);
	};

	const refreshWorkspace = (): Promise<void> => {
		if (deps.workspace === undefined || disposed) return Promise.resolve();
		if (probing !== null) {
			probeAgain = true;
			return probing;
		}
		probing = probeOnce().finally(() => {
			probing = null;
		});
		return probing;
	};

	// The session/new response waits on this probe; starting it at construction usually has it landed by then.
	void refreshWorkspace();

	// A model response can land before the writer's batch holding its call is folded, so a folded batch flushes again.
	const unsubscribeUsage = deps.subscribeUsage?.(() => {
		for (const waiter of [...foldWaiters]) waiter.check();
		if (disposed || !deps.sessionTelemetry || deps.sessionId() === null || pendingUsage !== null) return;
		const view = deps.sessionTelemetry();
		if (view === null || JSON.stringify(sessionUsageTotals(view)) === accountingSignature) return;
		pendingUsage = setImmediate(() => {
			pendingUsage = null;
			flushUsage(true);
		});
	});

	return {
		bind(replay) {
			usageSignature = null;
			flushUsage(replay);
			// Replay replaces the client's branch state, so even an unchanged or
			// empty plan must be sent again after that reset.
			planSignature = replay ? null : EMPTY_PLAN_SIGNATURE;
			flushPlan(replay);
		},
		turnStarted(started) {
			turn = started;
		},
		modelResponded() {
			if (pendingUsage !== null || deps.contextLedger === undefined) return;
			// The chat reconciles its context snapshot in its own message_end
			// listener; reading after the burst sees that and folds several
			// responses landing in one tick into one frame.
			pendingUsage = setImmediate(() => {
				pendingUsage = null;
				flushUsage(true);
			});
		},
		toolSettled(mayWrite) {
			flushPlan(true);
			if (mayWrite) void refreshWorkspace();
		},
		async turnSettled() {
			const settling = turn;
			if (settling !== null) await awaitFold(settling);
			framedTurn = null;
			framedSession = null;
			flushUsage(true);
			flushPlan(true);
			// The response repeats the last frame, so a batch folded during the workspace wait below reaches neither.
			// flushUsage reassigns both; the casts undo the narrowing to null the resets above left.
			const frame = framedTurn as TurnUsage | null;
			const frameSession = framedSession as SessionTotals | null;
			let usage: PromptUsage | null = null;
			if (settling !== null && frame !== null) {
				usage = { ...frame, ...(frameSession !== null ? { session: frameSession } : {}) };
			} else if (settling !== null) {
				const view = deps.sessionTelemetry?.() ?? null;
				usage = { ...turnUsageMeta(view, settling), ...(view !== null ? { session: sessionUsageTotals(view) } : {}) };
			}
			turn = null;
			const inFlight = probing;
			if (inFlight === null) return usage;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				inFlight,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, WORKSPACE_SETTLE_BOUND_MS);
					timer.unref?.();
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
			return usage;
		},
		async workspace() {
			if (deps.workspace === undefined) return null;
			if (workspaceView === null) await refreshWorkspace();
			return workspaceView;
		},
		dispose() {
			disposed = true;
			for (const waiter of foldWaiters) waiter.release();
			unsubscribeUsage?.();
			if (pendingUsage !== null) clearImmediate(pendingUsage);
			pendingUsage = null;
		},
	};
}
