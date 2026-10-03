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

import type { CostProvenance } from "../../domains/providers/types/cost-provenance.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import { ACP_CONTEXT_META_KEY, projectContextLedger } from "./context-ledger.js";
import { ACP_USAGE_META_KEY } from "./types.js";
import type { AcpCostAggregate, AcpUsageRow } from "./usage.js";

export const ACP_WORKSPACE_META_KEY = "clio-coder/workspace";
export const ACP_PLAN_META_KEY = "clio-coder/plan";
const MAX_PLAN_ENTRIES = 100;
const MAX_TEXT_BYTES = 1024;
/** A wedged git must not hold a prompt response; the frame still lands when the probe does. */
const WORKSPACE_SETTLE_BOUND_MS = 2000;

/** The per-turn accumulator the server keeps, structurally. */
export interface AcpTurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	costProvenance: CostProvenance;
	costProvenanceObserved: boolean;
}

/** `_meta["clio-coder/usage"]` on the prompt response and on in-turn `usage_update` frames: one shape, so the last frame equals the response. */
export function turnUsageMeta(usage: AcpTurnUsage) {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		reasoning: usage.reasoning,
		totalTokens: usage.totalTokens,
		costUsd: usage.costUsd,
		costProvenance: usage.costProvenance,
	};
}

export interface AcpWorkspaceView {
	version: 1;
	cwd: string;
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
	remoteUrl: string | null;
	projectType: string;
	capturedAt: string;
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

export function projectWorkspace(snapshot: WorkspaceSnapshot): AcpWorkspaceView {
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
export function projectAcpPlan(plan: TaskBoardSnapshot | null) {
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
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	costProvenance: CostProvenance;
	calls: number;
}

const count = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

function provenanceOf(cost: AcpCostAggregate): CostProvenance {
	if (cost.hasUnknown) return "unknown";
	if (cost.hasEstimated) return "estimated";
	return cost.allKnownFree ? "known_free" : "known";
}

/** Same lattice `mergeUsage` folds a turn with: unknown beats estimated beats known beats free. */
function combineProvenance(a: CostProvenance, b: CostProvenance): CostProvenance {
	if (a === "unknown" || b === "unknown") return "unknown";
	if (a === "estimated" || b === "estimated") return "estimated";
	if (a === "known" || b === "known") return "known";
	return "known_free";
}

function sessionBaseline(session: { cost: AcpCostAggregate; rows: ReadonlyArray<AcpUsageRow> }): SessionTotals {
	const totals: SessionTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		costUsd: count(session.cost.knownUsd),
		costProvenance: provenanceOf(session.cost),
		calls: count(session.cost.calls),
	};
	for (const row of session.rows) {
		totals.input += count(row.input);
		totals.output += count(row.output);
		totals.cacheRead += count(row.cacheRead);
		totals.cacheWrite += count(row.cacheWrite);
		totals.reasoning += count(row.reasoningTokens);
		totals.totalTokens += count(row.tokens);
	}
	return totals;
}

export interface AcpLiveTelemetryDeps {
	notify(sessionId: string, update: Record<string, unknown>): void;
	/** The one session this process hosts, or null between sessions. */
	sessionId(): string | null;
	contextLedger?: () => ContextLedger;
	/** The cost ledger the `/usage` view folds; read once per turn as the baseline the turn adds to. */
	sessionUsage?: () => { cost: AcpCostAggregate; rows: ReadonlyArray<AcpUsageRow> };
	plan?: () => TaskBoardSnapshot | null;
	workspace?: (cwd: string) => Promise<WorkspaceSnapshot>;
	cwd: string;
	diagnostics?: (line: string) => void;
}

export interface AcpLiveTelemetry {
	/** A session became the bound one; `replay` re-sends the current meter and plan as a loaded session's state. */
	bind(replay: boolean): void;
	turnStarted(usage: AcpTurnUsage): void;
	/** A model response landed; one `usage_update` follows once the burst settles. */
	modelResponded(): void;
	/** A tool call settled; `mayWrite` re-probes the workspace. */
	toolSettled(mayWrite: boolean): void;
	/** Flushes the meter and plan before the prompt response and waits (bounded) for a workspace probe in flight. */
	turnSettled(): Promise<void>;
	/** The latest workspace view, probing once if none landed yet; null when unwired or the probe failed. */
	workspace(): Promise<AcpWorkspaceView | null>;
	dispose(): void;
}

export function createAcpLiveTelemetry(deps: AcpLiveTelemetryDeps): AcpLiveTelemetry {
	let usageSignature: string | null = null;
	let planSignature = EMPTY_PLAN_SIGNATURE;
	let turn: { usage: AcpTurnUsage; baseline: SessionTotals | null } | null = null;
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
		const baseline =
			turn === null ? (deps.sessionUsage === undefined ? null : sessionBaseline(deps.sessionUsage())) : turn.baseline;
		let session: SessionTotals | null = baseline;
		if (baseline !== null && turn !== null) {
			const live = turn.usage;
			session = {
				input: baseline.input + live.input,
				output: baseline.output + live.output,
				cacheRead: baseline.cacheRead + live.cacheRead,
				cacheWrite: baseline.cacheWrite + live.cacheWrite,
				reasoning: baseline.reasoning + live.reasoning,
				totalTokens: baseline.totalTokens + live.totalTokens,
				costUsd: baseline.costUsd + live.costUsd,
				costProvenance: !live.costProvenanceObserved
					? baseline.costProvenance
					: baseline.calls === 0
						? live.costProvenance
						: combineProvenance(baseline.costProvenance, live.costProvenance),
				calls: baseline.calls,
			};
		}
		// ACP `cost` is a plain amount, so an unknown price stays absent rather than reading as zero.
		const knownCost = session !== null && (session.calls > 0 || turn?.usage.costProvenanceObserved === true);
		return {
			sessionUpdate: "usage_update",
			used: context.usedTokens,
			size: context.contextWindow,
			...(knownCost && session !== null && session.costProvenance !== "unknown"
				? { cost: { amount: session.costUsd, currency: "USD" } }
				: {}),
			_meta: {
				[ACP_CONTEXT_META_KEY]: context,
				[ACP_USAGE_META_KEY]: {
					...(turn !== null ? turnUsageMeta(turn.usage) : {}),
					session:
						session === null
							? null
							: {
									input: session.input,
									output: session.output,
									cacheRead: session.cacheRead,
									cacheWrite: session.cacheWrite,
									reasoning: session.reasoning,
									totalTokens: session.totalTokens,
									costUsd: session.costUsd,
									costProvenance: session.costProvenance,
								},
				},
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

	return {
		bind(replay) {
			usageSignature = null;
			flushUsage(replay);
			// The plan signature carries over: a fork or /tree switch replaces the
			// plan the client already shows, and an empty plan on a first load is
			// not news because a client starts with none.
			flushPlan(replay);
		},
		turnStarted(usage) {
			turn = { usage, baseline: deps.sessionUsage === undefined ? null : sessionBaseline(deps.sessionUsage()) };
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
			flushUsage(true);
			flushPlan(true);
			// The observability ledger has recorded this run by now; the next read is the new baseline.
			turn = null;
			const inFlight = probing;
			if (inFlight === null) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				inFlight,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, WORKSPACE_SETTLE_BOUND_MS);
					timer.unref?.();
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
		},
		async workspace() {
			if (deps.workspace === undefined) return null;
			if (workspaceView === null) await refreshWorkspace();
			return workspaceView;
		},
		dispose() {
			disposed = true;
			if (pendingUsage !== null) clearImmediate(pendingUsage);
			pendingUsage = null;
		},
	};
}
