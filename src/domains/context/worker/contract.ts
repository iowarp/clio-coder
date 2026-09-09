import type { AgentMessage } from "../../../engine/types.js";

/** Conversation inheritance is independent of dispatch's scheduling mode. */
export type WorkerContextPolicy =
	| { mode: "isolated" }
	| { mode: "fork"; max_tokens?: number }
	| { mode: "splice"; max_tokens?: number; paths?: string[]; refs?: string[] };

export const WORKER_CONTEXT_SPLICE_TOKENS = 8_000;

export interface WorkerContextSource {
	sessionId: string;
	leafTurnId: string | null;
	cwd: string;
}

/** Host-only snapshot of model-visible messages, never the raw session archive. */
export interface WorkerContextSnapshot {
	version: 1;
	source: WorkerContextSource;
	messages: ReadonlyArray<AgentMessage>;
	excludedTailMessages: number;
	excludedInterruptedMessages: number;
	contentHash: string;
}

/** Integrity-covered receipt metadata; the messages themselves live in a seed artifact. */
export interface WorkerContextProvenance {
	version: 1;
	mode: "fork" | "splice";
	source: WorkerContextSource;
	snapshotHash: string;
	contentHash: string;
	messageCount: number;
	estimatedTokens: number;
	bytes: number;
	omittedMessages: number;
	excludedTailMessages: number;
	excludedInterruptedMessages: number;
	selectedRefs: string[];
}

/** Self-contained seed, usable on a remote native worker without parent filesystem access. */
export interface WorkerContextSeed {
	provenance: WorkerContextProvenance;
	messages: AgentMessage[];
}

export function parseWorkerContextPolicy(value: unknown): WorkerContextPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context must be an object");
	const policy = value as Record<string, unknown>;
	const mode = policy.mode;
	if (mode !== "isolated" && mode !== "fork" && mode !== "splice")
		throw new Error("context.mode must be isolated, fork, or splice");
	const keys =
		mode === "isolated" ? ["mode"] : mode === "fork" ? ["mode", "max_tokens"] : ["mode", "max_tokens", "paths", "refs"];
	for (const key of Object.keys(policy))
		if (!keys.includes(key)) throw new Error(`context.${key} is unsupported for ${mode}`);
	if (mode === "isolated") return { mode };
	const result: Exclude<WorkerContextPolicy, { mode: "isolated" }> = { mode };
	if (policy.max_tokens !== undefined) {
		if (
			!Number.isSafeInteger(policy.max_tokens) ||
			(policy.max_tokens as number) < 256 ||
			(policy.max_tokens as number) > 262_144
		)
			throw new Error("context.max_tokens must be an integer between 256 and 262144");
		result.max_tokens = policy.max_tokens as number;
	}
	if (result.mode === "splice") {
		for (const key of ["paths", "refs"] as const) {
			const items = policy[key];
			if (items === undefined) continue;
			if (
				!Array.isArray(items) ||
				items.length === 0 ||
				items.length > 64 ||
				items.some(
					(item) =>
						typeof item !== "string" ||
						item.trim().length === 0 ||
						item.length > 4096 ||
						Array.from(item).some((char) => char.charCodeAt(0) < 32),
				)
			)
				throw new Error(`context.${key} must contain 1 to 64 nonempty strings`);
			result[key] = [...new Set((items as string[]).map((item) => item.trim()))];
		}
	}
	return result;
}
