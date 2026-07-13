import type { TaskMemorySnapshot } from "./task-bank.js";
import type { TaskMemoryPolicyDecision } from "./task-memory-policy.js";

export type TaskMemoryTier = "rules" | "llm";

/** Read-only projection shared by operator surfaces. */
export interface TaskMemoryOperatorStatus {
	enabled: boolean;
	tier: TaskMemoryTier;
	size: number;
	lastDecision: TaskMemoryPolicyDecision | null;
	bank: TaskMemorySnapshot;
}

export function taskMemoryBankSize(snapshot: TaskMemorySnapshot): number {
	return (snapshot.status === null ? 0 : 1) + snapshot.knowledge.length + snapshot.procedural.length;
}
