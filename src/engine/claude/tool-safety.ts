import nodePath from "node:path";
import { performance } from "node:perf_hooks";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { AdmissionDisposition, ApprovalAuthority } from "../../domains/safety/admission.js";
import { evaluateAdmission } from "../../domains/safety/admission.js";
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
			/** Who could answer the ask behind a permission-required denial. */
			approvalAuthority?: ApprovalAuthority;
	  };

export interface EvaluateClaudeToolPermissionInput {
	toolName: string;
	input: Record<string, unknown>;
	safety: SafetyContract;
	cwd: string;
	readOnly?: boolean;
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

/**
 * Arguments for the SDK's search tools. They search `path`, so that key wins
 * over the file keys a model may add. Their glob can also leave the search
 * directory, by an absolute pattern or a `..` segment, and then the literal
 * directory prefix of the glob is where the search reaches and the path the
 * policy judges.
 */
function searchArgs(input: Record<string, unknown>, globKey: "pattern" | "glob" | null): Record<string, unknown> {
	const base = stringField(input, "path", "file_path", "filePath");
	const glob = globKey === null ? undefined : stringField(input, globKey);
	if (glob !== undefined && (nodePath.isAbsolute(glob) || glob.split("/").includes(".."))) {
		const literal = glob.split("/");
		const firstMagic = literal.findIndex((segment) => /[*?[\]{}]/u.test(segment));
		const prefix = (firstMagic === -1 ? literal.slice(0, -1) : literal.slice(0, firstMagic)).join("/") || "/";
		return { ...input, path: base === undefined || nodePath.isAbsolute(prefix) ? prefix : nodePath.join(base, prefix) };
	}
	return base === undefined ? { ...input } : { ...input, path: base };
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
			return { claudeToolName: toolName, clioToolName: ToolNames.Grep, args: searchArgs(input, "glob"), known: true };
		case "Glob":
			return { claudeToolName: toolName, clioToolName: ToolNames.Find, args: searchArgs(input, "pattern"), known: true };
		case "LS":
		case "Ls":
			return { claudeToolName: toolName, clioToolName: ToolNames.Ls, args: searchArgs(input, null), known: true };
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

function toReadOnlyBlock(decision: SafetyDecision, tool: string): SafetyDecision {
	return {
		kind: "block",
		classification: decision.classification,
		rejection: {
			short: `${tool} denied: this run is read-only`,
			detail: "The dispatch that started this run is read-only, so this call cannot execute.",
			hints: [
				"Describe the proposed change as text for the dispatching agent.",
				"Inspection tools remain available inside the workspace.",
			],
		},
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
	// The shared evaluator decides (native and ACP call the same function). The
	// admitted-surface gate inside it is the authoritative narrowing enforcement
	// for SDK workers: it does not depend on the external CLI honoring the
	// allow/disallow options. Only mapped (known) Claude tools are gated;
	// unmapped Claude-internal tools defer to the safety net as before.
	const admission = evaluateAdmission({
		principal: "worker",
		effects: [call],
		cwd: input.cwd,
		safety: input.safety,
		constraints: {
			...(input.readOnly === true ? { readOnly: true } : {}),
			...(input.allowedTools !== undefined && mapped.known ? { allowedTools: input.allowedTools } : {}),
		},
	});
	if (admission.kind === "allow") {
		const decision = admission.decision;
		const budget = input.budgetGate?.admit(mapped.clioToolName);
		if (budget?.kind === "deny") return budgetDenial(input, mapped, call, budget.reason);
		return { kind: "allow", mapped, decision, reason: decision.policy?.reasonCode ?? "allowed" };
	}
	if (admission.kind === "ask") {
		// Nobody can answer a Claude SDK worker's ask; it resolves through
		// fleet.permissions.mode as a permission-required denial.
		return {
			kind: "deny",
			mapped,
			decision: admission.decision,
			reason: rejectionText(admission.decision),
			...(admission.source === "autonomy" ? { reasonCode: `autonomy:${admission.level}` } : {}),
			permissionRequired: true,
			approvalAuthority: admission.approvalAuthority,
		};
	}
	return deniedDecision(input, mapped, call, admission);
}

function deniedDecision(
	input: EvaluateClaudeToolPermissionInput,
	mapped: MappedClaudeToolCall,
	call: ClassifierCall,
	admission: Extract<AdmissionDisposition, { kind: "deny" }>,
): ClaudeToolPermissionDecision {
	const decision = admission.decision;
	if (admission.code === "safety_net") {
		return { kind: "deny", mapped, decision, reason: rejectionText(decision), permissionRequired: false };
	}
	if (admission.code === "read_only") {
		const blocked = toReadOnlyBlock(decision, call.tool);
		return {
			kind: "deny",
			mapped,
			decision: blocked,
			reason: rejectionText(blocked),
			reasonCode: "dispatch:read_only",
			permissionRequired: false,
		};
	}
	const profile = admission.code === "tool_scope";
	const rejection: RejectionMessage = profile
		? {
				short: `${mapped.clioToolName} is not in this worker's tool profile`,
				detail: `Tool '${mapped.clioToolName}' is outside the dispatched worker's admitted tool surface, so the request is denied. Use only the tools granted to this run.`,
				hints: [],
			}
		: { short: admission.reason, detail: admission.reason, hints: [] };
	const reasonCode = profile
		? "tool-profile"
		: admission.code === "git_destructive"
			? "classification:git_destructive"
			: `admission:${admission.code}`;
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection,
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
	input.safety.audit.recordToolCall?.({
		tool: mapped.clioToolName,
		classification: decision.classification,
		decision: "denied",
		args: mapped.args,
		reasons: [rejection.detail],
		reasonCode,
	});
	return { kind: "deny", mapped, decision: blocked, reason: rejection.short, reasonCode, permissionRequired: false };
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
						? `permission required for ${decision.mapped.clioToolName}; fleet.permissions.mode=fail ends this run`
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
