import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import {
	type AutonomyLevel,
	autonomyAskRejection,
	autonomyDenyRejection,
	DEFAULT_AUTONOMY_LEVEL,
	mapAutonomy,
} from "../../domains/safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../../domains/safety/contract.js";
import type { ClioWorkerEvent } from "../worker-events.js";
import type { ToolFinishEvent, ToolStartEvent } from "../worker-tools.js";

export interface MappedClaudeToolCall {
	claudeToolName: string;
	clioToolName: string;
	args: Record<string, unknown>;
	known: boolean;
}

export type ClaudeToolPermissionDecision =
	| {
			kind: "allow";
			mapped: MappedClaudeToolCall;
			decision: SafetyDecision;
			reason: string;
			reasonCode?: string;
	  }
	| {
			kind: "deny";
			mapped: MappedClaudeToolCall;
			decision: SafetyDecision;
			reason: string;
			/**
			 * Reason code of the final decision when a later axis than the policy
			 * engine denied the call. The carried policy's own reasonCode describes
			 * the net pass ("allowed") and would misstate an autonomy denial, so
			 * autonomy-axis denials set this to `autonomy:<level>` to match the
			 * native registry audit convention (sd-01 §2.5).
			 */
			reasonCode?: string;
			permissionRequired: boolean;
	  };

export interface EvaluateClaudeToolPermissionInput {
	toolName: string;
	input: Record<string, unknown>;
	safety: SafetyContract;
	cwd: string;
	autonomy?: AutonomyLevel;
}

export interface EmitClaudeToolPermissionInput extends EvaluateClaudeToolPermissionInput {
	emit(event: ClioWorkerEvent): void;
	onPermission?: "deny" | "fail";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function pathArgs(input: Record<string, unknown>): Record<string, unknown> {
	const path = stringField(input, "file_path", "filePath", "path", "notebook_path", "source", "target");
	return path ? { ...input, path } : { ...input };
}

function commandArgs(input: Record<string, unknown>, cwd: string): Record<string, unknown> {
	const command = stringField(input, "command", "cmd", "shell", "input", "description") ?? JSON.stringify(input);
	return { ...input, command, cwd: stringField(input, "cwd") ?? cwd };
}

function dynamicToolName(name: string): string {
	return name.trim().length > 0 ? `claude:${name}` : "claude:unknown";
}

export function mapClaudeToolCall(toolName: string, input: Record<string, unknown>, cwd: string): MappedClaudeToolCall {
	switch (toolName) {
		case "Bash":
			return { claudeToolName: toolName, clioToolName: ToolNames.Bash, args: commandArgs(input, cwd), known: true };
		case "Read":
		case "NotebookRead":
			return { claudeToolName: toolName, clioToolName: ToolNames.Read, args: pathArgs(input), known: true };
		case "Edit":
		case "MultiEdit":
			return { claudeToolName: toolName, clioToolName: ToolNames.Edit, args: pathArgs(input), known: true };
		case "Write":
			return { claudeToolName: toolName, clioToolName: ToolNames.Write, args: pathArgs(input), known: true };
		case "Grep":
			return { claudeToolName: toolName, clioToolName: ToolNames.Grep, args: pathArgs(input), known: true };
		case "Glob":
			return { claudeToolName: toolName, clioToolName: ToolNames.Glob, args: pathArgs(input), known: true };
		case "LS":
		case "Ls":
			return { claudeToolName: toolName, clioToolName: ToolNames.Ls, args: pathArgs(input), known: true };
		case "WebFetch":
		case "WebSearch":
			return { claudeToolName: toolName, clioToolName: ToolNames.WebFetch, args: { ...input }, known: true };
		case "Task":
			return { claudeToolName: toolName, clioToolName: ToolNames.Dispatch, args: { ...input }, known: true };
		case "TodoWrite":
			return { claudeToolName: toolName, clioToolName: ToolNames.WritePlan, args: { ...input }, known: true };
		default:
			return { claudeToolName: toolName, clioToolName: dynamicToolName(toolName), args: { ...input }, known: false };
	}
}

function toAutonomyBlock(decision: SafetyDecision, level: AutonomyLevel, call: ClassifierCall): SafetyDecision {
	const actionClass = decision.classification.actionClass;
	return {
		kind: "block",
		classification: decision.classification,
		rejection: autonomyDenyRejection(level, call.tool, actionClass),
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
}

function toAutonomyAsk(decision: SafetyDecision, level: AutonomyLevel, call: ClassifierCall): SafetyDecision {
	const actionClass = decision.classification.actionClass;
	return {
		kind: "ask",
		classification: decision.classification,
		rejection: autonomyAskRejection(level, call.tool, actionClass),
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
}

function rejectionText(decision: SafetyDecision): string {
	if (decision.kind === "allow") return decision.policy?.reasonCode ?? "allowed";
	return decision.rejection.short;
}

export function evaluateClaudeToolPermission(input: EvaluateClaudeToolPermissionInput): ClaudeToolPermissionDecision {
	const mapped = mapClaudeToolCall(input.toolName, input.input, input.cwd);
	const call: ClassifierCall = { tool: mapped.clioToolName, args: mapped.args };
	const decision = input.safety.evaluate(call);
	const level = input.autonomy ?? DEFAULT_AUTONOMY_LEVEL;
	if (decision.kind === "block") {
		return { kind: "deny", mapped, decision, reason: rejectionText(decision), permissionRequired: false };
	}
	if (decision.kind === "ask") {
		if (level === "read-only") {
			const blocked = toAutonomyBlock(decision, level, call);
			return {
				kind: "deny",
				mapped,
				decision: blocked,
				reason: rejectionText(blocked),
				reasonCode: `autonomy:${level}`,
				permissionRequired: false,
			};
		}
		return { kind: "deny", mapped, decision, reason: rejectionText(decision), permissionRequired: true };
	}
	const actionClass = decision.classification.actionClass;
	const disposition = mapAutonomy(level, actionClass, {
		executeRecognized: decision.policy?.execRecognition !== "unrecognized",
	});
	if (disposition === "allow") {
		return { kind: "allow", mapped, decision, reason: decision.policy?.reasonCode ?? "allowed" };
	}
	if (disposition === "deny") {
		const blocked = toAutonomyBlock(decision, level, call);
		return {
			kind: "deny",
			mapped,
			decision: blocked,
			reason: rejectionText(blocked),
			reasonCode: `autonomy:${level}`,
			permissionRequired: false,
		};
	}
	const ask = toAutonomyAsk(decision, level, call);
	return {
		kind: "deny",
		mapped,
		decision: ask,
		reason: rejectionText(ask),
		reasonCode: `autonomy:${level}`,
		permissionRequired: true,
	};
}

function finishDecision(decision: SafetyDecision): NonNullable<ToolFinishEvent["decision"]> {
	if (decision.kind === "allow") return "allowed";
	if (decision.kind === "ask") return "permission_requested";
	return "blocked";
}

function emitToolFinish(
	emit: (event: ClioWorkerEvent) => void,
	mapped: MappedClaudeToolCall,
	startedAt: number,
	decision: SafetyDecision,
	outcome: ToolFinishEvent["outcome"],
	reason: string,
	reasonCode?: string,
): void {
	const event: ToolFinishEvent = {
		tool: mapped.clioToolName,
		posture: "operating",
		durationMs: Date.now() - startedAt,
		outcome,
		actionClass: decision.classification.actionClass,
		decision: finishDecision(decision),
	};
	if (reason.length > 0 && outcome !== "ok") event.reason = reason;
	if (decision.policy?.ruleId !== undefined) event.ruleId = decision.policy.ruleId;
	// Prefer an explicit final reasonCode (later-axis denial) over the policy's
	// own reasonCode, which describes the net pass ("allowed") and would
	// misstate an autonomy denial. Mirrors audit.ts `reasonCode ?? policy`.
	const finalReasonCode = reasonCode ?? decision.policy?.reasonCode;
	if (finalReasonCode !== undefined) event.reasonCode = finalReasonCode;
	if (decision.policy?.policySource !== undefined) event.policySource = decision.policy.policySource;
	emit({ type: "clio_tool_finish", payload: event });
}

export function emitClaudeToolPermissionDecision(input: EmitClaudeToolPermissionInput): ClaudeToolPermissionDecision {
	const startedAt = Date.now();
	const decision = evaluateClaudeToolPermission(input);
	const start: ToolStartEvent = {
		tool: decision.mapped.clioToolName,
		posture: "operating",
		startedAt,
	};
	input.emit({ type: "clio_tool_start", payload: start });
	if (decision.kind === "allow") {
		emitToolFinish(input.emit, decision.mapped, startedAt, decision.decision, "ok", decision.reason, decision.reasonCode);
		return decision;
	}
	if (decision.permissionRequired) {
		const mode = input.onPermission ?? "deny";
		input.emit({
			type: "clio_permission_resolved",
			payload: {
				tool: decision.mapped.clioToolName,
				actionClass: decision.decision.classification.actionClass,
				mode,
				reason:
					mode === "fail"
						? `permission required for ${decision.mapped.clioToolName}; workers.onPermission=fail ends this run`
						: `permission denied by policy: Claude SDK workers run non-interactively; ${decision.reason}`,
			},
		});
	}
	emitToolFinish(
		input.emit,
		decision.mapped,
		startedAt,
		decision.decision,
		"blocked",
		decision.reason,
		decision.reasonCode,
	);
	return decision;
}

export function coerceToolInput(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
