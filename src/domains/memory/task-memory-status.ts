import type { TaskMemorySnapshot } from "./task-bank.js";
import type { TaskMemoryPolicyDecision, TaskMemoryPolicyReason } from "./task-memory-policy.js";
import type { TaskMemorySpendSummary } from "./task-memory-spend.js";
import type {
	TaskMemoryTelemetryDecision,
	TaskMemoryTelemetryTier,
	TaskMemoryTelemetryTrigger,
} from "./task-memory-telemetry.js";

export type TaskMemoryTier = "rules" | "llm";

/**
 * One completed memory step, projected for operator surfaces. It carries counts
 * and outcomes only, matching the telemetry sink's content-free discipline, so
 * it can be rendered without leaking bank or trajectory text into the TUI.
 */
export interface TaskMemoryActivityEvent {
	at: string;
	triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>;
	tier: TaskMemoryTelemetryTier;
	decision: TaskMemoryTelemetryDecision;
	reason: TaskMemoryPolicyReason;
	citedEntries: number;
	bankWrites: number;
	latencyMs: number;
}

/** Read-only projection shared by operator surfaces. */
export interface TaskMemoryOperatorStatus {
	enabled: boolean;
	tier: TaskMemoryTier;
	size: number;
	lastDecision: TaskMemoryPolicyDecision | null;
	bank: TaskMemorySnapshot;
	/** Newest-first bounded memory-step history; empty until a step completes. */
	activity: ReadonlyArray<TaskMemoryActivityEvent>;
	/** True while a detached background memory step is still running. */
	stepInFlight: boolean;
	/**
	 * Lifetime llm-tier spend and hit rate folded from the telemetry ledger. Null
	 * on a surface that does not read the ledger, which is every surface that
	 * only needs the live bank.
	 */
	spend?: TaskMemorySpendSummary | null;
}

/**
 * Compact operator wording for one memory step, used by the TUI surfaces.
 *
 * The reason rides alongside the decision because `silent` on its own is the
 * line an operator cannot act on: it reads the same whether the model declined
 * to write, the route refused the connection, or the answer was unreadable.
 * `intervened` is omitted, since `injected` already says it.
 */
export function describeTaskMemoryActivity(event: TaskMemoryActivityEvent): string {
	const parts: string[] = [event.decision];
	if (event.reason !== "intervened") parts.push(event.reason);
	if (event.bankWrites > 0) parts.push(`${event.bankWrites}w`);
	if (event.citedEntries > 0) parts.push(`${event.citedEntries} cited`);
	return `${event.triggerReasons.join("+")} ${parts.join(" ")}`;
}

export function taskMemoryBankSize(snapshot: TaskMemorySnapshot): number {
	return (snapshot.status === null ? 0 : 1) + snapshot.knowledge.length + snapshot.procedural.length;
}
