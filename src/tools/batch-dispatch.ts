import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

interface BatchEntry {
	agent: string;
	task: string;
}

function parseEntries(raw: unknown): { entries: BatchEntry[] } | { error: string } {
	if (!Array.isArray(raw)) {
		return { error: "batch_dispatch: dispatches must be an array" };
	}
	if (raw.length === 0) {
		return { error: "batch_dispatch: dispatches array is empty" };
	}
	const entries: BatchEntry[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const item = raw[i];
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			return { error: `batch_dispatch: dispatches[${i}] must be an object` };
		}
		const record = item as Record<string, unknown>;
		const agent = typeof record.agent === "string" ? record.agent.trim() : "";
		if (!agent) return { error: `batch_dispatch: dispatches[${i}] missing agent` };
		const task = typeof record.task === "string" ? record.task.trim() : "";
		if (!task) return { error: `batch_dispatch: dispatches[${i}] missing task` };
		entries.push({ agent, task });
	}
	return { entries };
}

export const batchDispatchTool: ToolSpec = {
	name: ToolNames.BatchDispatch,
	description: "Dispatch multiple subagents in parallel. Phase 5 stub.",
	baseActionClass: "dispatch",
	async run(args): Promise<ToolResult> {
		const parsed = parseEntries(args.dispatches);
		if ("error" in parsed) return { kind: "error", message: parsed.error };
		const lines = parsed.entries.map((entry, idx) => `  [${idx}] ${entry.agent}: ${entry.task}`);
		const output = [`batch_dispatch stub: would run ${parsed.entries.length} dispatches`, ...lines].join("\n");
		return { kind: "ok", output };
	},
};
