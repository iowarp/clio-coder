import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import type { AgentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type {
	CandidateWorktree,
	CompeteGroupOwnership,
	CompeteMuxWorktrees,
	cleanupCompeteGroup,
	mergeWinnerBranch,
} from "./compete-worktrees.js";
import type { DispatchBackgroundRegistry } from "./dispatch-background.js";
import type { DispatchPlanView, ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";
import type { DispatchRunEventRegistry } from "./dispatch-run-events.js";

export type DispatchMode = "parallel" | "sequential" | "pipeline" | "compete" | "council";

export interface DispatchCouncilMember {
	label: string;
	target: string;
	model?: string;
	thinking?: string;
	color?: string;
}

export interface DispatchCouncilSettings {
	members: DispatchCouncilMember[];
	synthesis: "none" | "judge" | "vote";
	rounds: number;
	judge?: DispatchCompeteSettings["judge"];
	resolvedTasks?: ReadonlyArray<ResolvedDispatchPlanArtifact["tasks"][number]>;
}

export interface DispatchReviewSettings {
	reviewer?: string;
	maxCycles: number;
	node?: string;
	model?: string;
	target?: string;
	/** Immutable per-cycle builder/reviewer pins expanded by plan admission. */
	resolvedTasks?: ReadonlyArray<ResolvedDispatchPlanArtifact["tasks"][number]>;
}

export interface DispatchCompeteSettings {
	candidates: number;
	judge?: { agent?: string; model?: string; target?: string; node?: string };
	/** Immutable per-candidate and judge pins expanded by plan admission. */
	resolvedTasks?: ReadonlyArray<ResolvedDispatchPlanArtifact["tasks"][number]>;
}

/** Immutable execution authority captured before an ordinary call can be parked. */
export interface DispatchRunExecutionSnapshot {
	readonly kind: "dispatch";
	readonly planView: DispatchPlanView;
	readonly requests: ReadonlyArray<DispatchRequest>;
	readonly mode: DispatchMode;
	readonly writers: 1 | undefined;
	readonly review: DispatchReviewSettings | undefined;
	readonly compete: DispatchCompeteSettings | undefined;
	readonly council: DispatchCouncilSettings | undefined;
	readonly detach: boolean;
	readonly timeoutMs: number | undefined;
	readonly maxOutputBytes: number;
}

/** Immutable, operator-visible destination of a compete-winner application. */
export interface DispatchApplyWinnerExecutionSnapshot {
	readonly kind: "apply-winner";
	readonly branch: string;
	readonly cwd: string;
}

export interface DispatchListExecutionSnapshot {
	readonly kind: "list";
}

export type DispatchExecutionSnapshot =
	| DispatchRunExecutionSnapshot
	| DispatchApplyWinnerExecutionSnapshot
	| DispatchListExecutionSnapshot;

export interface DispatchToolDeps {
	dispatch: DispatchContract;
	bus?: SafeEventBus;
	/** Instance-scoped owner for ordinary tool-owned run streams and monitor tails. */
	runEvents?: DispatchRunEventRegistry;
	/** Operator-initiated backgrounding of an attached call. */
	background?: DispatchBackgroundRegistry;
	/** Optional compete storage overrides for alternate backends and deterministic fault tests. */
	competeWorktrees?: {
		createCandidate?: (
			ownership: CompeteGroupOwnership,
			index: number,
			baseline: string,
		) => CandidateWorktree | Promise<CandidateWorktree>;
		cleanupGroup?: (...args: Parameters<typeof cleanupCompeteGroup>) => void | Promise<void>;
		mergeWinner?: typeof mergeWinnerBranch;
		/** Optional herdr route; every operation retains native Git fallback. */
		mux?: CompeteMuxWorktrees;
	};
	getAgentCatalog?: () => string;
	getAgentSpecs: () => ReadonlyArray<AgentSpec>;
	getAgentRoleFacts?: AgentRoleFactsResolver;
	getAutonomy?: () => AutonomyLevel;
	getCostCeilingUsd?: () => number;
	getWorkerRosters?: () => Readonly<Record<string, { members: ReadonlyArray<DispatchCouncilMember> }>>;
}
