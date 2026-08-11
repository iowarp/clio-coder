import type { TaskMemorySnapshot } from "./task-bank.js";
import type { TaskMemoryPolicyDecision } from "./task-memory-policy.js";
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
}

/** Compact operator wording for one memory step, used by the TUI surfaces. */
export function describeTaskMemoryActivity(event: TaskMemoryActivityEvent): string {
	const parts: string[] = [event.decision];
	if (event.bankWrites > 0) parts.push(`${event.bankWrites}w`);
	if (event.citedEntries > 0) parts.push(`${event.citedEntries} cited`);
	return `${event.triggerReasons.join("+")} ${parts.join(" ")}`;
}

export function taskMemoryBankSize(snapshot: TaskMemorySnapshot): number {
	return (snapshot.status === null ? 0 : 1) + snapshot.knowledge.length + snapshot.procedural.length;
}
