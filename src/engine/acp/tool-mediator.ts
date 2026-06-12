import type { DelegationToolGovernance } from "../../core/defaults.js";
import { ToolNames } from "../../core/tool-names.js";
import type { DelegationToolCallLogEntry } from "../../domains/dispatch/types.js";
import {
	type AutonomyLevel,
	autonomyDenyRejection,
	DEFAULT_AUTONOMY_LEVEL,
	mapAutonomy,
} from "../../domains/safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../../domains/safety/contract.js";
import type {
	AcpPermissionOption,
	AcpRequestPermissionParams,
	AcpRequestPermissionResponse,
	AcpToolCallUpdate,
} from "./types.js";

interface MediatorInput {
	safety: SafetyContract;
	cwd: string;
	toolGovernance: DelegationToolGovernance;
	/**
	 * Session autonomy level (sd-01 §2.5). Applied after the safety net under
	 * clio-policy governance; `ask` dispositions resolve as non-stall denials
	 * because a delegation has no operator to answer a prompt.
	 */
	autonomy?: AutonomyLevel;
}

interface MappedToolCall {
	tool: string;
	args: Record<string, unknown>;
	known: boolean;
	displayTool: string;
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

function optionByKind(options: ReadonlyArray<AcpPermissionOption>, kinds: ReadonlyArray<string>): string | null {
	for (const kind of kinds) {
		const exact = options.find((option) => option.kind === kind);
		if (exact) return exact.optionId;
	}
	for (const option of options) {
		if (kinds.some((kind) => option.kind.startsWith(kind.split("_")[0] ?? kind))) return option.optionId;
	}
	return null;
}

function responseFor(decision: "approved" | "denied" | "cancelled", options: ReadonlyArray<AcpPermissionOption>) {
	if (decision === "cancelled") return { outcome: { outcome: "cancelled" as const } };
	const optionId =
		decision === "approved"
			? optionByKind(options, ["allow_once", "allow_always"])
			: optionByKind(options, ["reject_once", "reject_always"]);
	if (!optionId) return { outcome: { outcome: "cancelled" as const } };
	return { outcome: { outcome: "selected" as const, optionId } };
}

function pathArgs(rawInput: Record<string, unknown>, fallbackTitle: string | undefined): Record<string, unknown> {
	const path = stringField(rawInput, "path", "file", "filePath", "file_path", "target", "uri") ?? fallbackTitle;
	return path ? { path } : {};
}

function commandArgs(
	rawInput: Record<string, unknown>,
	fallbackTitle: string | undefined,
	cwd: string,
): Record<string, unknown> {
	const command = stringField(rawInput, "command", "cmd", "shell", "input", "description") ?? fallbackTitle ?? "";
	return { command, cwd };
}

function mapToolCall(toolCall: AcpToolCallUpdate | undefined, cwd: string): MappedToolCall {
	const kind = typeof toolCall?.kind === "string" ? toolCall.kind.toLowerCase() : "";
	const rawInput = isRecord(toolCall?.rawInput) ? toolCall.rawInput : {};
	const rawTool = stringField(rawInput, "tool", "toolName", "tool_name", "name");
	const title = typeof toolCall?.title === "string" ? toolCall.title : undefined;
	const displayTool = rawTool ?? kind ?? title ?? "unknown";
	if (rawTool === ToolNames.Bash || kind === "execute") {
		return { tool: ToolNames.Bash, args: commandArgs(rawInput, title, cwd), known: true, displayTool };
	}
	if (rawTool === ToolNames.Read || kind === "read" || kind === "fetch") {
		return { tool: ToolNames.Read, args: pathArgs(rawInput, title), known: true, displayTool };
	}
	if (rawTool === ToolNames.Grep || kind === "search") {
		return { tool: ToolNames.Grep, args: pathArgs(rawInput, title), known: true, displayTool };
	}
	if (rawTool === ToolNames.Write || kind === "edit" || kind === "move") {
		return { tool: ToolNames.Edit, args: pathArgs(rawInput, title), known: true, displayTool };
	}
	if (kind === "delete") {
		return { tool: ToolNames.Bash, args: { command: title ?? "delete", cwd }, known: false, displayTool };
	}
	if (rawTool && Object.values(ToolNames).includes(rawTool as (typeof ToolNames)[keyof typeof ToolNames])) {
		return { tool: rawTool, args: rawInput, known: true, displayTool };
	}
	return { tool: displayTool, args: rawInput, known: false, displayTool };
}

function logSafety(decision: SafetyDecision | undefined): DelegationToolCallLogEntry["safetyDecision"] | undefined {
	if (!decision) return undefined;
	const out: NonNullable<DelegationToolCallLogEntry["safetyDecision"]> = {
		kind: decision.kind,
	};
	const policy = decision.policy;
	if (policy?.reasonCode !== undefined) out.reasonCode = policy.reasonCode;
	if (policy?.policySource !== undefined) out.policySource = policy.policySource;
	if (policy?.ruleId !== undefined) out.ruleId = policy.ruleId;
	return out;
}

function rawArguments(
	toolCall: AcpToolCallUpdate | undefined,
	fallback: Record<string, unknown>,
): Record<string, unknown> {
	if (isRecord(toolCall?.rawInput)) return { ...toolCall.rawInput };
	return { ...fallback };
}

export class AcpToolMediator {
	private requested = 0;
	private approved = 0;
	private denied = 0;
	private readonly log: DelegationToolCallLogEntry[] = [];

	constructor(private readonly input: MediatorInput) {}

	async handle(params: unknown): Promise<AcpRequestPermissionResponse> {
		const startedAt = Date.now();
		this.requested += 1;
		const parsed = isRecord(params) ? (params as AcpRequestPermissionParams) : {};
		const options = Array.isArray(parsed.options) ? parsed.options : [];
		const toolCall = isRecord(parsed.toolCall) ? (parsed.toolCall as AcpToolCallUpdate) : undefined;
		const mapped = mapToolCall(toolCall, this.input.cwd);
		let decision: "approved" | "denied" | "cancelled" = "denied";
		let reason: string | undefined;
		let safetyDecision: SafetyDecision | undefined;

		if (this.input.toolGovernance === "agent-managed") {
			decision = "approved";
			reason = "agent-managed governance";
		} else if (this.input.toolGovernance === "deny-all") {
			decision = "denied";
			reason = "deny-all governance";
		} else if (!mapped.known) {
			decision = "denied";
			reason = `unknown ACP tool: ${mapped.displayTool}`;
		} else {
			safetyDecision = this.input.safety.evaluate({ tool: mapped.tool, args: mapped.args });
			if (safetyDecision.kind === "allow") {
				// The net passed; the autonomy mapping decides (sd-01 §2.2). An
				// "ask" disposition resolves as a non-stall denial, exactly like a
				// net confirm rail below: a delegation has no operator to answer.
				const level = this.input.autonomy ?? DEFAULT_AUTONOMY_LEVEL;
				const actionClass = safetyDecision.classification.actionClass;
				const disposition = mapAutonomy(level, actionClass, {
					executeRecognized: safetyDecision.policy?.execRecognition !== "unrecognized",
				});
				if (disposition === "allow") {
					decision = "approved";
					reason = safetyDecision.policy?.reasonCode ?? "allowed";
				} else if (disposition === "ask") {
					decision = "denied";
					reason = `permission_required: autonomy ${level} requires approval for ${actionClass}; denied by non-stall policy (no interactive operator in delegation context)`;
				} else {
					decision = "denied";
					reason = autonomyDenyRejection(level, mapped.tool, actionClass).short;
				}
			} else if (safetyDecision.kind === "ask") {
				// Non-stall policy: a delegation has no operator to answer an
				// interactive prompt, so an "ask" resolves as a bounded denial
				// instead of waiting on input that cannot arrive.
				decision = "denied";
				reason = "permission_required: denied by non-stall policy (no interactive operator in delegation context)";
			} else {
				decision = "denied";
				reason = safetyDecision.policy?.reasonCode ?? safetyDecision.kind;
			}
		}

		if (decision === "approved") this.approved += 1;
		else this.denied += 1;
		const loggedSafety = logSafety(safetyDecision);
		this.log.push({
			callId: toolCall?.toolCallId ?? `permission-${this.requested}`,
			tool: mapped.tool,
			arguments: rawArguments(toolCall, mapped.args),
			decision,
			...(reason !== undefined ? { reason } : {}),
			...(loggedSafety !== undefined ? { safetyDecision: loggedSafety } : {}),
			durationMs: Math.max(0, Date.now() - startedAt),
			timestamp: new Date().toISOString(),
		});
		return responseFor(decision, options);
	}

	snapshot(): {
		toolCallsRequested: number;
		toolCallsApproved: number;
		toolCallsDenied: number;
		toolCallLog: DelegationToolCallLogEntry[];
	} {
		return {
			toolCallsRequested: this.requested,
			toolCallsApproved: this.approved,
			toolCallsDenied: this.denied,
			toolCallLog: [...this.log],
		};
	}
}
