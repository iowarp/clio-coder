import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { MEMORY_RECALL_MAX_LIMIT, recallMemory, renderMemoryRecall } from "../domains/memory/recall.js";
import type { TaskMemorySnapshot } from "../domains/memory/task-bank.js";
import type { MemoryRecord, MemoryRetrievalOptions } from "../domains/memory/types.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export interface MemoryRecallDeps {
	/** The live session task bank; null when the session has none. */
	bank: () => TaskMemorySnapshot | null;
	/** The durable store as read now. A throw reports as a tool error. */
	records: () => ReadonlyArray<MemoryRecord>;
	/** Active repository, runtime and agent identity gating durable records. */
	eligibility: () => Omit<MemoryRetrievalOptions, "tokenBudget">;
}

/**
 * Orchestrator-only and read-only: the tool never saves, proposes, approves or
 * rejects. Writes stay with the guardian model and the operator's review.
 */
export function createMemoryRecallTool(deps: MemoryRecallDeps): ToolSpec {
	return {
		name: ToolNames.MemoryRecall,
		description:
			"Search this session's task memory (knowledge and procedural entries) and approved durable memory that applies to this repository and runtime. Read-only: it cannot save, propose or approve memory.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Words to match against memory text." }),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MEMORY_RECALL_MAX_LIMIT, description: "Most entries to return." }),
			),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args): Promise<ToolResult> {
			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (query.length === 0) return { kind: "error", message: "memory_recall: query is required" };
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			try {
				const hits = recallMemory({
					query,
					...(limit !== undefined ? { limit } : {}),
					bank: deps.bank(),
					records: deps.records(),
					eligibility: deps.eligibility(),
				});
				return { kind: "ok", output: renderMemoryRecall(hits), details: { hits } };
			} catch (err) {
				return { kind: "error", message: `memory_recall: ${err instanceof Error ? err.message : String(err)}` };
			}
		},
	};
}
