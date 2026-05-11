import { dynamicToolName, type ToolName, ToolNames } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type { Classification, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import type { SafetyPolicyDecision } from "../domains/safety/policy-engine.js";
import type { RejectionMessage } from "../domains/safety/rejection-feedback.js";

const CLAUDE_TO_CLIO_TOOL_ENTRIES: ReadonlyArray<readonly [string, ToolName]> = [
	["Bash", ToolNames.Bash],
	["Edit", ToolNames.Edit],
	["MultiEdit", ToolNames.Edit],
	["Write", ToolNames.Write],
	["Read", ToolNames.Read],
	["NotebookRead", ToolNames.Read],
	["Grep", ToolNames.Grep],
	["Glob", ToolNames.Glob],
	["LS", ToolNames.Ls],
	["WebFetch", ToolNames.WebFetch],
	["WebSearch", dynamicToolName("web_search")],
	["Task", dynamicToolName("dispatch")],
];

const CLAUDE_TO_CLIO_TOOL: ReadonlyMap<string, ToolName> = new Map(CLAUDE_TO_CLIO_TOOL_ENTRIES);

const ROUTED_SEPARATELY = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"]);

export interface ClaudeToolDecision {
	decision: "allow" | "block" | "ask";
	classification: Classification;
	reason: string;
	rejection?: RejectionMessage;
	policy?: SafetyPolicyDecision;
	clioToolName: ToolName | null;
}

export function mapClaudeToolName(claudeTool: string): ToolName | null {
	if (ROUTED_SEPARATELY.has(claudeTool)) return null;
	return CLAUDE_TO_CLIO_TOOL.get(claudeTool) ?? null;
}

export function evaluateClaudeToolCall(
	claudeTool: string,
	args: Record<string, unknown>,
	mode: ModeName,
	safety: SafetyContract,
): ClaudeToolDecision {
	const clioToolName = mapClaudeToolName(claudeTool);
	if (clioToolName === null) {
		return {
			decision: "ask",
			classification: { actionClass: "unknown", reasons: ["unmapped or specially-routed Claude tool"] },
			reason: `claude tool '${claudeTool}' is not mapped to a clio tool`,
			clioToolName: null,
		};
	}

	const call: ClassifierCall = { tool: clioToolName, args: extractRelevantArgs(clioToolName, args) };
	const result = safety.evaluate(call, mode);
	const rejection = result.kind === "allow" ? undefined : result.rejection;
	const reason = result.policy?.reasons.join("; ") || result.policy?.reasonCode || rejection?.detail || result.kind;
	return {
		decision: result.kind,
		classification: result.classification,
		reason,
		...(rejection ? { rejection } : {}),
		...(result.policy ? { policy: result.policy } : {}),
		clioToolName,
	};
}

function extractRelevantArgs(clioToolName: ToolName, args: Record<string, unknown>): Record<string, unknown> {
	switch (clioToolName) {
		case ToolNames.Bash:
			return { command: args.command, cwd: args.cwd };
		case ToolNames.Edit:
		case ToolNames.Write:
		case ToolNames.Read:
		case ToolNames.Ls:
			return { path: args.path ?? args.file_path };
		case ToolNames.Grep:
		case ToolNames.Glob:
			return { pattern: args.pattern ?? args.query };
		case ToolNames.WebFetch:
			return { url: args.url };
		case "web_search":
			return { query: args.query };
		case "dispatch":
			return { description: args.description, subagent_type: args.subagent_type };
		default:
			return args;
	}
}
