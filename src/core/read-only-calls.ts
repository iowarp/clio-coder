import { ToolNames } from "./tool-names.js";

export const EXPLORATION_TOOL_NAMES = new Set<string>([
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.CodeNav,
	ToolNames.Context,
	ToolNames.Git,
]);
export const READ_ONLY_SHELL_COMMAND_PATTERN = /^\s*(?:awk|cat|fd|find|git|grep|head|jq|ls|rg|sed|tail|tree|wc)\b/;

export function isReadOnlyCall(toolName: string, args: Readonly<Record<string, unknown>> | undefined): boolean {
	if (EXPLORATION_TOOL_NAMES.has(toolName)) return true;
	return (
		toolName === ToolNames.Bash && typeof args?.command === "string" && READ_ONLY_SHELL_COMMAND_PATTERN.test(args.command)
	);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: null;
}

/**
 * Resolve the effective agents for an ordinary dispatch using the same weak-
 * model task normalization and agent aliases as the live dispatch parser.
 * Share this mirror between middleware guards without importing the tool layer.
 */
function ordinaryDispatchAgents(args: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<string> | null {
	if (
		!args ||
		args.list === true ||
		args.apply_winner !== undefined ||
		(args.review !== undefined && args.review !== false) ||
		args.mode === "compete"
	) {
		return null;
	}

	let tasks: unknown = args.tasks;
	if (typeof tasks === "string") {
		const raw = tasks.trim();
		if (raw.startsWith("[") || raw.startsWith("{")) {
			try {
				tasks = JSON.parse(raw) as unknown;
			} catch {
				// Leave malformed JSON in its original shape, as the tool does.
			}
		}
	}
	if (recordValue(tasks) !== null || typeof tasks === "string") tasks = [tasks];
	if (tasks === undefined && typeof args.task === "string") tasks = [{ task: args.task }];
	if (!Array.isArray(tasks) || tasks.length === 0) return null;

	const sharedAgent = stringValue(args.agent) ?? stringValue(args.agent_id) ?? "coder";
	const agents: string[] = [];
	for (const task of tasks) {
		if (typeof task === "string") {
			if (stringValue(task) === null) return null;
			agents.push(sharedAgent);
			continue;
		}
		const record = recordValue(task);
		if (!record || stringValue(record.task) === null) return null;
		// Task-local agent/agent_id overrides the shared default. `agentId` is
		// intentionally ignored because the production parser does not accept it.
		agents.push(stringValue(record.agent) ?? stringValue(record.agent_id) ?? sharedAgent);
	}
	return agents;
}

/** True only when every task of an ordinary dispatch names Scout. A mixed call also carries non-scout work. */
export function dispatchTargetsOnlyScouts(args: Readonly<Record<string, unknown>> | undefined): boolean {
	const agents = ordinaryDispatchAgents(args);
	return agents !== null && agents.length > 0 && agents.every((agent) => agent.toLowerCase() === "scout");
}

export function dispatchTargetsScout(args: Readonly<Record<string, unknown>> | undefined): boolean {
	return ordinaryDispatchAgents(args)?.some((agent) => agent.toLowerCase() === "scout") === true;
}
