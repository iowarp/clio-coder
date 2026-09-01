import { performance } from "node:perf_hooks";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import {
	type AutonomyLevel,
	autonomyAskRejection,
	autonomyDenyRejection,
	DEFAULT_AUTONOMY_LEVEL,
	mapAutonomy,
} from "../../domains/safety/autonomy.js";
import { describeCallAction } from "../../domains/safety/call-target.js";
import type { SafetyContract, SafetyDecision } from "../../domains/safety/contract.js";
import type { RejectionMessage } from "../../domains/safety/rejection-feedback.js";
import type { ToolFinishEvent, ToolStartEvent } from "../../tools/agent-tools.js";
import type { ClioWorkerEvent } from "../worker-events.js";

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
	/**
	 * The worker's admitted tool surface (Clio builtin names), already narrowed
	 * by any tool_profile. When present, a mapped Claude tool whose Clio builtin
	 * is not in this set is denied before the safety net runs, so external CLI
	 * runtimes cannot execute out-of-profile tools even if they ignore the
	 * SDK/CLI allow options. Absent means no surface check (legacy callers).
	 */
	allowedTools?: ReadonlySet<string>;
	/** Optional canonical per-call budget gate used by mediated SDK workers. */
	budgetGate?: {
		attempt(canonicalToolName: string): { kind: "allow" } | { kind: "deny"; reason: string };
		admit(canonicalToolName: string): { kind: "allow" } | { kind: "deny"; reason: string };
	};
}

export interface EmitClaudeToolPermissionInput extends EvaluateClaudeToolPermissionInput {
	emit(event: ClioWorkerEvent): void;
	onPermission?: "deny" | "fail";
	/** SDK tool-use id shared by the start and finish telemetry events. */
	toolCallId?: string;
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

/**
 * Static map from Claude preset tool names to the Clio builtin they mediate as.
 * The single source of truth for both `mapClaudeToolCall` (forward, per-call)
 * and `claudeToolsOutsideProfile` (reverse, for the SDK/CLI disallow list).
 * Keep in lockstep with the `mapClaudeToolCall` switch below.
 */
const CLAUDE_TOOL_TO_CLIO: Readonly<Record<string, string>> = {
	Bash: ToolNames.Bash,
	Read: ToolNames.Read,
	NotebookRead: ToolNames.Read,
	Edit: ToolNames.Edit,
	MultiEdit: ToolNames.Edit,
	Write: ToolNames.Write,
	Grep: ToolNames.Grep,
	Glob: ToolNames.Find,
	LS: ToolNames.Ls,
	Ls: ToolNames.Ls,
	WebFetch: ToolNames.WebFetch,
	WebSearch: ToolNames.WebFetch,
	Task: ToolNames.Dispatch,
	// TodoWrite mediates as the tasks tool: both are session-scoped plan
	// bookkeeping that never mutates the workspace, so it classifies read and
	// is narrowed away exactly when the profile lacks tasks.
	TodoWrite: ToolNames.Tasks,
};

const CLAUDE_CANONICAL_TOOLS = new Set(Object.values(CLAUDE_TOOL_TO_CLIO));

/** Whether the Claude preset exposes at least one vendor alias for this canonical Clio tool. */
export function isClaudeCanonicalTool(name: string): boolean {
	return CLAUDE_CANONICAL_TOOLS.has(name);
}

/**
 * Claude preset tool names whose Clio builtin is not in the worker's allowed
 * surface. Fed to the SDK's `disallowedTools` option (and the same list is used
 * by the mediation gate as the authoritative check). Only mapped/known tools
 * participate; unmapped Claude-internal tools are left to the safety net.
 */
export function claudeToolsOutsideProfile(allowedTools: ReadonlySet<string>): string[] {
	return Object.entries(CLAUDE_TOOL_TO_CLIO)
		.filter(([, clioName]) => !allowedTools.has(clioName))
		.map(([claudeName]) => claudeName);
}

function mapClaudeToolCall(toolName: string, input: Record<string, unknown>, cwd: string): MappedClaudeToolCall {
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
			return { claudeToolName: toolName, clioToolName: ToolNames.Find, args: pathArgs(input), known: true };
		case "LS":
		case "Ls":
			return { claudeToolName: toolName, clioToolName: ToolNames.Ls, args: pathArgs(input), known: true };
		case "WebFetch":
		case "WebSearch":
			return { claudeToolName: toolName, clioToolName: ToolNames.WebFetch, args: { ...input }, known: true };
		case "Task":
			return { claudeToolName: toolName, clioToolName: ToolNames.Dispatch, args: { ...input }, known: true };
		case "TodoWrite":
			return { claudeToolName: toolName, clioToolName: ToolNames.Tasks, args: { ...input }, known: true };
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

function budgetDenial(
	input: EvaluateClaudeToolPermissionInput,
	mapped: MappedClaudeToolCall,
	call: ClassifierCall,
	reason: string,
): ClaudeToolPermissionDecision {
	const classification = input.safety.classify(call);
	const rejection: RejectionMessage = { short: reason, detail: reason, hints: [] };
	const blocked: SafetyDecision = { kind: "block", classification, rejection };
	input.safety.audit.recordToolCall?.({
		tool: mapped.clioToolName,
		classification,
		decision: "denied",
		args: mapped.args,
		reasons: [reason],
		reasonCode: "worker-budget",
	});
	return {
		kind: "deny",
		mapped,
		decision: blocked,
		reason,
		reasonCode: "worker-budget",
		permissionRequired: false,
	};
}

function evaluateClaudeToolPermission(input: EvaluateClaudeToolPermissionInput): ClaudeToolPermissionDecision {
	const mapped = mapClaudeToolCall(input.toolName, input.input, input.cwd);
	const call: ClassifierCall = { tool: mapped.clioToolName, args: mapped.args };
	const attempt = input.budgetGate?.attempt(mapped.clioToolName);
	if (attempt?.kind === "deny") return budgetDenial(input, mapped, call, attempt.reason);
	// Tool-profile / admitted-surface gate. This is the authoritative narrowing
	// enforcement for SDK workers: it runs before the safety net so an
	// out-of-profile tool (e.g. bash under minimal-local) is denied regardless
	// of the autonomy verdict, and it does not depend on the external CLI
	// honoring the allow/disallow options. Only mapped (known) Claude tools are
	// gated; unmapped Claude-internal tools defer to the safety net as before.
	if (input.allowedTools !== undefined && mapped.known && !input.allowedTools.has(mapped.clioToolName)) {
		const classification = input.safety.classify(call);
		const rejection: RejectionMessage = {
			short: `${mapped.clioToolName} is not in this worker's tool profile`,
			detail: `Tool '${mapped.clioToolName}' is outside the dispatched worker's admitted tool surface, so the request is denied. Use only the tools granted to this run.`,
			hints: [],
		};
		const blocked: SafetyDecision = { kind: "block", classification, rejection };
		input.safety.audit.recordToolCall?.({
			tool: mapped.clioToolName,
			classification,
			decision: "denied",
			args: mapped.args,
			reasons: [rejection.detail],
			reasonCode: "tool-profile",
		});
		return {
			kind: "deny",
			mapped,
			decision: blocked,
			reason: rejection.short,
			reasonCode: "tool-profile",
			permissionRequired: false,
		};
	}
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
		const admission = input.budgetGate?.admit(mapped.clioToolName);
		if (admission?.kind === "deny") return budgetDenial(input, mapped, call, admission.reason);
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
	startedAtClock: number,
	decision: SafetyDecision,
	outcome: ToolFinishEvent["outcome"],
	reason: string,
	reasonCode?: string,
	toolCallId?: string,
): void {
	const event: ToolFinishEvent = {
		tool: mapped.clioToolName,
		...(toolCallId !== undefined ? { toolCallId } : {}),
		posture: "operating",
		durationMs: Math.round(performance.now() - startedAtClock),
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
	emit({ type: "clio_coder_tool_finish", payload: event });
}

export function emitClaudeToolPermissionDecision(input: EmitClaudeToolPermissionInput): ClaudeToolPermissionDecision {
	// Wall read anchors the instant the start event carries; the monotonic twin
	// spans the decision, so the duration survives a clock correction.
	const startedAt = Date.now();
	const startedAtClock = performance.now();
	const decision = evaluateClaudeToolPermission(input);
	const toolCallId = input.toolCallId?.trim() ? input.toolCallId : undefined;
	// Mapped args are this side's own translation of the subprocess call, so the
	// descriptor is composed from them here rather than downstream of the seam.
	const action = describeCallAction(decision.mapped.clioToolName, decision.mapped.args);
	const start: ToolStartEvent = {
		tool: decision.mapped.clioToolName,
		...(toolCallId !== undefined ? { toolCallId } : {}),
		posture: "operating",
		startedAt,
		...(action !== null ? { action } : {}),
	};
	input.emit({ type: "clio_coder_tool_start", payload: start });
	if (decision.kind === "allow") {
		emitToolFinish(
			input.emit,
			decision.mapped,
			startedAtClock,
			decision.decision,
			"ok",
			decision.reason,
			decision.reasonCode,
			toolCallId,
		);
		return decision;
	}
	if (decision.permissionRequired) {
		const mode = input.onPermission ?? "deny";
		input.emit({
			type: "clio_coder_permission_resolved",
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
		startedAtClock,
		decision.decision,
		"blocked",
		decision.reason,
		decision.reasonCode,
		toolCallId,
	);
	return decision;
}

export function coerceToolInput(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
