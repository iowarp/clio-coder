import { detectValidationCommand } from "./protected-artifacts.js";

export const FINISH_CONTRACT_ADVISORY_MESSAGE =
	"[Clio Coder] finish-contract advisory: completion claim found, but no recent validation evidence or explicit limitation was recorded. Run validation or state what could not be verified.";

const DEFAULT_RECENT_ENTRY_LIMIT = 80;

export type FinishContractEvidenceKind = "validation_command" | "protected_artifact" | "dispatch_receipt";

export interface FinishContractEvidence {
	kind: FinishContractEvidenceKind;
	summary: string;
	turnId?: string;
}

export type FinishContractAssessment =
	| {
			kind: "ok";
			reason: "no_completion_claim" | "validation_evidence" | "explicit_limitation";
			evidence: ReadonlyArray<FinishContractEvidence>;
	  }
	| {
			kind: "advisory";
			message: string;
			evidence: ReadonlyArray<FinishContractEvidence>;
	  };

export interface FinishContractInput {
	assistantText: string;
	sessionEntries?: ReadonlyArray<unknown>;
	assistantTurnId?: string | null;
	recentEntryLimit?: number;
}

interface ToolCallEvidenceCandidate {
	turnId?: string;
	toolCallId: string;
	command: string;
}

const TYPED_VALIDATION_TOOL_SUMMARIES = new Map<string, string>([
	["run_tests", "run_tests"],
	["run_lint", "run_lint"],
	["run_build", "run_build"],
]);
const PACKAGE_VALIDATION_SCRIPTS = new Set(["test", "test:e2e", "lint", "build", "typecheck", "ci"]);

const COMPLETION_PATTERNS: ReadonlyArray<RegExp> = [
	/\b(?:done|finished|complete|completed|implemented|fixed|resolved|updated|added|changed|removed|wired|shipped)\b/i,
	/\ball set\b/i,
	/\bready for (?:review|handoff|use)\b/i,
	/\b(?:tests?|validation|typecheck|lint)\s+(?:pass|passes|passed|succeed|succeeded|ok)\b/i,
	/^\s*(?:Changed|Summary)\s*:/im,
	/^\s*Tests\s*:/im,
];

const LIMITATION_PATTERNS: ReadonlyArray<RegExp> = [
	/\b(?:blocked by|blocker|blockers|unable to|not able to|could not|couldn't|cannot|can't)\b/i,
	/\b(?:did not|didn't|have not|haven't|has not|hasn't|was not able|wasn't able)\b/i,
	/\b(?:not complete|incomplete)\b/i,
	/\b(?:not|un)(?:\s|-)?(?:validated|verified|tested)\b/i,
	/^\s*Tests\s*:\s*(?:not run|not executed|not available|failed|blocked|skipped)\b/im,
	/^\s*Known gaps?\s*:\s*(?!\s*(?:none|no\b|n\/a|not applicable)\b).+/im,
	/\bremaining(?:\s+\w+){0,3}\s+(?:work|issue|issues|gap|gaps|blocker|blockers)\b/i,
];

export function assessFinishContract(input: FinishContractInput): FinishContractAssessment {
	const assistantText = input.assistantText.trim();
	if (!hasCompletionClaim(assistantText)) {
		return { kind: "ok", reason: "no_completion_claim", evidence: [] };
	}

	const evidence = collectRecentEvidence(
		input.sessionEntries ?? [],
		input.assistantTurnId ?? null,
		input.recentEntryLimit ?? DEFAULT_RECENT_ENTRY_LIMIT,
	);
	if (evidence.length > 0) {
		return { kind: "ok", reason: "validation_evidence", evidence };
	}

	if (hasExplicitLimitation(assistantText)) {
		return { kind: "ok", reason: "explicit_limitation", evidence: [] };
	}

	return { kind: "advisory", message: FINISH_CONTRACT_ADVISORY_MESSAGE, evidence: [] };
}

export function hasCompletionClaim(text: string): boolean {
	const normalized = text.trim();
	if (normalized.length === 0) return false;
	return COMPLETION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasExplicitLimitation(text: string): boolean {
	const normalized = text.trim();
	if (normalized.length === 0) return false;
	return LIMITATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectRecentEvidence(
	entries: ReadonlyArray<unknown>,
	assistantTurnId: string | null,
	recentEntryLimit: number,
): FinishContractEvidence[] {
	const recent = recentEntries(entries, assistantTurnId, recentEntryLimit);
	const evidence: FinishContractEvidence[] = [];
	const toolCalls = new Map<string, ToolCallEvidenceCandidate>();
	const dispatchCalls = new Map<string, ToolCallEvidenceCandidate>();
	const seen = new Set<string>();

	for (const entry of recent) {
		const protectedArtifact = protectedArtifactEvidence(entry);
		if (protectedArtifact !== null) {
			pushEvidence(evidence, seen, protectedArtifact);
			continue;
		}

		const call = bashValidationCall(entry);
		if (call !== null) {
			toolCalls.set(call.toolCallId, call);
			continue;
		}

		const typedValidationCall = validationToolCall(entry);
		if (typedValidationCall !== null) {
			toolCalls.set(typedValidationCall.toolCallId, typedValidationCall);
			continue;
		}

		const dispatchCall = dispatchEvidenceCall(entry);
		if (dispatchCall !== null) {
			dispatchCalls.set(dispatchCall.toolCallId, dispatchCall);
			continue;
		}

		const resultId = successfulToolResultId(entry);
		if (resultId !== null) {
			const dispatchCandidate = dispatchCalls.get(resultId);
			const dispatchReceipt = dispatchReceiptEvidence(entry, dispatchCandidate);
			if (dispatchReceipt !== null) {
				pushEvidence(evidence, seen, dispatchReceipt);
				continue;
			}
			const candidate = toolCalls.get(resultId);
			if (candidate !== undefined) {
				pushEvidence(evidence, seen, validationEvidence(candidate));
			}
			continue;
		}

		const bashExecution = bashExecutionEvidence(entry);
		if (bashExecution !== null) pushEvidence(evidence, seen, bashExecution);
	}

	return evidence;
}

function recentEntries(
	entries: ReadonlyArray<unknown>,
	assistantTurnId: string | null,
	recentEntryLimit: number,
): ReadonlyArray<unknown> {
	const boundedLimit =
		Number.isFinite(recentEntryLimit) && recentEntryLimit > 0 ? Math.floor(recentEntryLimit) : DEFAULT_RECENT_ENTRY_LIMIT;
	const assistantIndex =
		assistantTurnId === null ? -1 : entries.findIndex((entry) => turnIdOf(entry) === assistantTurnId);
	const endExclusive = assistantIndex >= 0 ? assistantIndex : entries.length;
	let startInclusive = Math.max(0, endExclusive - boundedLimit);
	for (let index = endExclusive - 1; index >= startInclusive; index -= 1) {
		if (isUserMessageEntry(entries[index])) {
			startInclusive = index + 1;
			break;
		}
	}
	return entries.slice(startInclusive, endExclusive);
}

function bashValidationCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "bash") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const command = typeof args?.command === "string" ? args.command : null;
	if (command === null) return null;
	const detected = detectValidationCommand(command);
	if (detected.kind !== "validation") return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: detected.matched,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

function dispatchEvidenceCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "dispatch") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const task = typeof args?.task === "string" ? args.task.trim() : "";
	const agentId = stringFromFirst(args ?? {}, ["agent_id", "agentId", "agent"]) ?? "implementer";
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: `agent=${agentId}${task.length > 0 ? ` task=${task}` : ""}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

function validationToolCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName === null) return null;
	const summary = typedValidationSummary(toolName, payload);
	if (summary === null) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: summary,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

function typedValidationSummary(toolName: string, payload: Record<string, unknown>): string | null {
	const simple = TYPED_VALIDATION_TOOL_SUMMARIES.get(toolName);
	if (simple !== undefined) return simple;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	if (toolName === "package_script") {
		const script = typeof args?.script === "string" ? args.script.trim() : "";
		if (!PACKAGE_VALIDATION_SCRIPTS.has(script)) return null;
		return `npm run ${script}`;
	}
	if (toolName === "validate_frontend") {
		const path = typeof args?.path === "string" && args.path.trim().length > 0 ? args.path.trim() : "artifact";
		return `validate_frontend ${path}`;
	}
	return null;
}

function successfulToolResultId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	if (payload.isError === true || payload.error === true) return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (details?.kind === "error") return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
}

function dispatchReceiptEvidence(
	entry: unknown,
	candidate: ToolCallEvidenceCandidate | undefined,
): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["toolName", "name", "tool"]);
	if (toolName !== null && toolName !== "dispatch") return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (details === null) return null;
	if (details.exitCode !== 0) return null;
	const runId = typeof details.runId === "string" && details.runId.length > 0 ? details.runId : "unknown";
	const agentId =
		typeof details.agentId === "string" && details.agentId.length > 0
			? details.agentId
			: (candidate?.command.match(/^agent=([^\s]+)/)?.[1] ?? "unknown");
	const evidence: FinishContractEvidence = {
		kind: "dispatch_receipt",
		summary: `dispatch receipt passed: run ${runId} agent ${agentId}`,
	};
	const turnId = candidate?.turnId ?? turnIdOf(entry);
	if (turnId !== null && turnId !== undefined) evidence.turnId = turnId;
	return evidence;
}

function bashExecutionEvidence(entry: unknown): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true) return null;
	if (record.exitCode !== 0) return null;
	const detected = detectValidationCommand(record.command);
	if (detected.kind !== "validation") return null;
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${detected.matched}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) evidence.turnId = turnId;
	return evidence;
}

function protectedArtifactEvidence(entry: unknown): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "protectedArtifact" || record.action !== "protect") return null;
	const artifact = asRecord(record.artifact);
	const path = typeof artifact?.path === "string" && artifact.path.trim().length > 0 ? artifact.path.trim() : null;
	if (path === null) return null;
	const evidence: FinishContractEvidence = {
		kind: "protected_artifact",
		summary: `protected artifact recorded: ${path}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) evidence.turnId = turnId;
	return evidence;
}

function validationEvidence(candidate: ToolCallEvidenceCandidate): FinishContractEvidence {
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${candidate.command}`,
	};
	if (candidate.turnId !== undefined) evidence.turnId = candidate.turnId;
	return evidence;
}

function pushEvidence(evidence: FinishContractEvidence[], seen: Set<string>, item: FinishContractEvidence): void {
	const key = `${item.kind}\0${item.summary}\0${item.turnId ?? ""}`;
	if (seen.has(key)) return;
	seen.add(key);
	evidence.push(item);
}

function isUserMessageEntry(entry: unknown): boolean {
	const record = asRecord(entry);
	return record?.kind === "message" && record.role === "user";
}

function turnIdOf(entry: unknown): string | null {
	const record = asRecord(entry);
	return typeof record?.turnId === "string" ? record.turnId : null;
}

function stringFromFirst(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
