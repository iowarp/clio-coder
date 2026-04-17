import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const dispatchAgentTool: ToolSpec = {
	name: ToolNames.DispatchAgent,
	description: "Dispatch a single subagent by recipe id with a task prompt. Phase 5 stub.",
	baseActionClass: "dispatch",
	async run(args): Promise<ToolResult> {
		const agent = typeof args.agent === "string" ? args.agent.trim() : "";
		if (!agent) return { kind: "error", message: "dispatch_agent: missing agent argument" };
		const task = typeof args.task === "string" ? args.task.trim() : "";
		if (!task) return { kind: "error", message: "dispatch_agent: missing task argument" };
		const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
		const readonly = typeof args.readonly === "boolean" ? args.readonly : undefined;

		const cwdPart = cwd !== undefined ? ` cwd=${cwd}` : "";
		const readonlyPart = readonly !== undefined ? ` readonly=${readonly}` : "";
		const suffix = `${cwdPart}${readonlyPart}`;
		return {
			kind: "ok",
			output: `dispatch_agent stub: would run ${agent} with task="${task}"${suffix}`,
		};
	},
};
