import { ToolNames } from "../../core/tool-names.js";
import { isProjectVerifierCheckId, isVerificationScriptName } from "../../core/verification-scripts.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import {
	detectValidationCommand,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	toolMutationPaths,
} from "./protected-artifacts.js";
import type { Rigor } from "./rigor.js";

export const FINISH_CONTRACT_ADVISORY_MESSAGE =
	"[Clio Coder] finish-contract advisory: you changed files this turn without recording validation evidence or a limitation receipt. Run a verification command or call limitation with the scope and reason.";

/**
 * The recent-window cap (entries since the last user message). Exported so a
 * tail-scoped reader can size its read as a multiple of this and stay in lockstep
 * with the window the contract actually inspects.
 */
export const DEFAULT_RECENT_ENTRY_LIMIT = 80;

export type FinishContractEvidenceKind =
	| "validation_command"
	| "protected_artifact"
	| "dispatch_receipt"
	| "limitation";

export interface FinishContractEvidence {
	kind: FinishContractEvidenceKind;
	summary: string;
	check?: string;
	paths?: ReadonlyArray<string>;
	turnId?: string;
}

/** Why the contract settled. Every branch is auditable from the ledger alone. */
export type FinishContractReason =
	| "no_mutation"
	| "validation_evidence"
	| "explicit_limitation"
	| "unvalidated_mutation";

export type FinishContractAssessment =
	| {
			kind: "ok";
			reason: "no_mutation" | "validation_evidence" | "explicit_limitation";
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
	  }
	| {
			kind: "engage";
			reason: "unvalidated_mutation";
			message: string;
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
	  };

export interface FinishContractInput {
	sessionEntries?: ReadonlyArray<unknown>;
	assistantTurnId?: string | null;
	recentEntryLimit?: number;
	rigor?: Rigor;
	activeAcceptance?: UserTaskAcceptance;
}

interface ToolCallEvidenceCandidate {
	turnId?: string;
	toolCallId: string;
	command: string;
	check?: string;
	paths?: string[];
}

interface MutationCandidate {
	toolCallId: string;
	paths: string[];
}

/**
 * Action-scoped completion contract. The engine keys off what the turn actually
 * DID, not how the prompt was phrased: it engages only when the recent window
 * mutated workspace state and then settled (turn_end) without recording
 * validation evidence or a limitation receipt. The turn settling is itself
 * the completion signal, so the model never has to type "done" to be gated, and
 * a work request phrased as a question cannot bypass the gate.
 *
 * Decision order (pure function of ledger receipts):
 *   1. no mutating receipt in the window        -> ok/no_mutation
 *   2. validation evidence present              -> ok/validation_evidence
 *   3. successful `limitation` receipt present  -> ok/explicit_limitation
 *   4. otherwise                                -> engage/unvalidated_mutation
 *
 * The assistant's prose never enters the decision. A limitation counts only
 * as a `limitation` tool_call paired with a non-error tool_result inside the
 * same window the mutation scan uses, so a run cannot satisfy the contract by
 * wording alone and a real limitation is never missed for its phrasing.
 */
export function assessFinishContract(input: FinishContractInput): FinishContractAssessment {
	const sessionEntries = input.sessionEntries ?? [];
	const assistantTurnId = input.assistantTurnId ?? null;
	const window = recentEntries(sessionEntries, assistantTurnId, input.recentEntryLimit ?? DEFAULT_RECENT_ENTRY_LIMIT);

	const mutatedPaths = mutatingReceipts(window);
	if (mutatedPaths.length === 0) {
		return { kind: "ok", reason: "no_mutation", evidence: [], mutatedPaths };
	}

	const acceptanceChecks = new Set(input.activeAcceptance?.verification.map((item) => item.check) ?? []);
	const evidence = collectValidationEvidence(window, acceptanceChecks);
	const limitations = collectLimitationEvidence(window);
	const required = input.rigor === "high" ? (input.activeAcceptance?.verification ?? []) : [];
	if (required.length > 0) {
		const passes = new Set(evidence.filter((item) => item.kind === "validation_command").map((item) => item.check));
		const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
		const missing = [...new Set(required.map((item) => item.check))].filter(
			(check) => !passes.has(check) && !limited.has(check),
		);
		if (missing.length > 0)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[Clio Coder] high-rigor finish gate: operator acceptance still requires passing validation for: ${missing.join(", ")}. Run each named check or include its exact id in limitation.paths.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
			};
		return {
			kind: "ok",
			reason: required.every((item) => passes.has(item.check)) ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
		};
	}
	if (evidence.length > 0) {
		return { kind: "ok", reason: "validation_evidence", evidence, mutatedPaths };
	}

	if (limitations.length > 0) {
		return { kind: "ok", reason: "explicit_limitation", evidence: limitations, mutatedPaths };
	}

	return {
		kind: "engage",
		reason: "unvalidated_mutation",
		message: FINISH_CONTRACT_ADVISORY_MESSAGE,
		evidence: [],
		mutatedPaths,
	};
}

/**
 * Successful `limitation` receipts over the recent window. A receipt is a
 * `limitation` tool_call whose tool_result in the same window is not an
 * error, judged by the same `successfulToolResultId` rule the mutation and
 * validation scans use. A call the tool rejected (bad reason, empty scope)
 * leaves no receipt, so it cannot settle the contract.
 */
function collectLimitationEvidence(recent: ReadonlyArray<unknown>): FinishContractEvidence[] {
	const evidence: FinishContractEvidence[] = [];
	const calls = new Map<string, ToolCallEvidenceCandidate>();
	const seen = new Set<string>();

	for (const entry of recent) {
		const call = limitationToolCall(entry);
		if (call !== null) {
			calls.set(call.toolCallId, call);
			continue;
		}
		const resultId = successfulToolResultId(entry);
		if (resultId === null) continue;
		const candidate = calls.get(resultId);
		if (candidate === undefined) continue;
		const item: FinishContractEvidence = {
			kind: "limitation",
			summary: candidate.command,
			...(candidate.paths ? { paths: candidate.paths } : {}),
		};
		if (candidate.turnId !== undefined) item.turnId = candidate.turnId;
		pushEvidence(evidence, seen, item);
	}

	return evidence;
}

function limitationToolCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== ToolNames.Limitation) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const scope = typeof args?.scope === "string" ? args.scope.trim() : "";
	const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		paths: Array.isArray(args?.paths)
			? args.paths.filter((item): item is string => typeof item === "string").map((item) => item.trim())
			: [],
		command: `limitation recorded: ${scope.length > 0 ? scope : "unspecified"} (reason=${reason.length > 0 ? reason : "unspecified"})`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * Paths the turn actually mutated, drawn only from successful (non-error)
 * receipts inside the window:
 *   - write / edit / artifact, via `toolMutationPaths`.
 *   - bash whose command carries a workspace write or delete target, via
 *     `extractCommandWriteTargets` / `extractCommandDeleteTargets`.
 * Read-only git and pure read/grep/find/ls/exec/web_fetch receipts contribute
 * nothing, so the contract can never fire on a retrieval or execution-only
 * turn. Grounded in the same mutation notion the action classifier records, so
 * the audit ledger and this gate stay consistent about what counts as a change.
 */
function mutatingReceipts(recent: ReadonlyArray<unknown>): string[] {
	const mutationCalls = new Map<string, MutationCandidate>();
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const entry of recent) {
		// A user-run `!` bash execution is self-contained: it carries its own
		// success signal, so any mutation targets count without a paired result.
		const bashMutation = bashExecutionMutationPaths(entry);
		if (bashMutation !== null) {
			for (const path of bashMutation) pushPath(paths, seen, path);
			continue;
		}

		const call = mutatingToolCall(entry);
		if (call !== null) {
			mutationCalls.set(call.toolCallId, call);
			continue;
		}

		const resultId = successfulToolResultId(entry);
		if (resultId !== null) {
			const candidate = mutationCalls.get(resultId);
			if (candidate !== undefined) {
				for (const path of candidate.paths) pushPath(paths, seen, path);
			}
		}
	}

	return paths;
}

/** Mutation targets for a tool call, empty for read-only/execute-only tools. */
function mutationPathsForTool(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName === ToolNames.Bash) {
		const command = typeof args?.command === "string" ? args.command : null;
		if (command === null) return [];
		return [...extractCommandWriteTargets(command), ...extractCommandDeleteTargets(command)];
	}
	return toolMutationPaths(toolName, args);
}

function mutatingToolCall(entry: unknown): MutationCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName === null) return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input) ?? undefined;
	const paths = mutationPathsForTool(toolName, args);
	if (paths.length === 0) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	return { toolCallId, paths };
}

/**
 * Mutation targets of a settled `!` bash execution entry. Returns null when the
 * entry is not a successful bash execution so the caller falls through to the
 * tool_call/tool_result pairing path; returns `[]` for a successful command
 * with no write/delete target (a read-only `!` command is not a mutation).
 */
function bashExecutionMutationPaths(entry: unknown): string[] | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true || record.exitCode !== 0) return null;
	return [...extractCommandWriteTargets(record.command), ...extractCommandDeleteTargets(record.command)];
}

function pushPath(paths: string[], seen: Set<string>, path: string): void {
	if (path.length === 0 || seen.has(path)) return;
	seen.add(path);
	paths.push(path);
}

/**
 * Receipt-based validation evidence over the recent window. Kept verbatim from
 * the pre-redesign engine minus the requested-inspection path: validation
 * commands (`detectValidationCommand`), verify check runs, passed dispatch
 * receipts, and protected-artifact records.
 * Inspection was removed because inspecting the repo is never a mutation, so it
 * can no longer be on the path to engaging the contract.
 */
function collectValidationEvidence(
	recent: ReadonlyArray<unknown>,
	acceptanceChecks: ReadonlySet<string>,
): FinishContractEvidence[] {
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

		const call = bashValidationCall(entry, acceptanceChecks);
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

		const bashExecution = bashExecutionEvidence(entry, acceptanceChecks);
		if (bashExecution !== null) pushEvidence(evidence, seen, bashExecution);
	}

	return evidence;
}

export function recentEntries(
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

function bashValidationCall(entry: unknown, acceptanceChecks: ReadonlySet<string>): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "bash") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const command = typeof args?.command === "string" ? args.command : null;
	if (command === null) return null;
	const detected = acceptanceValidationCommand(command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: detected.matched,
		...validationCheckFields(detected.matched),
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
	const { agentId, task } = dispatchCallDescriptor(args);
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

/**
 * Agent id and lead task text for a dispatch call, tolerant of both the toolkit
 * v2 `tasks` array (task strings or {agent, task} objects, with an optional
 * shared default agent) and the legacy single `task` argument. Only the first
 * task seeds the summary; it feeds the receipt evidence's agent fallback and the
 * audit line, never the gate decision itself.
 */
function dispatchCallDescriptor(args: Record<string, unknown> | null): { agentId: string; task: string } {
	const defaultAgent = stringFromFirst(args ?? {}, ["agent", "agent_id", "agentId"]);
	const tasks = Array.isArray(args?.tasks) ? args.tasks : null;
	if (tasks !== null && tasks.length > 0) {
		const first = tasks[0];
		if (typeof first === "string") {
			return { agentId: defaultAgent ?? "coder", task: first.trim() };
		}
		const firstRecord = asRecord(first);
		const itemAgent = firstRecord === null ? null : stringFromFirst(firstRecord, ["agent", "agent_id", "agentId"]);
		const itemTask = typeof firstRecord?.task === "string" ? firstRecord.task.trim() : "";
		return { agentId: itemAgent ?? defaultAgent ?? "coder", task: itemTask };
	}
	const singleTask = typeof args?.task === "string" ? args.task.trim() : "";
	return { agentId: defaultAgent ?? "coder", task: singleTask };
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
		...validationCheckFields(summary),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * The canonical command a typed validation tool call stands for, or null when
 * the call is not a validation. Exported because run-effects grounds a mutation
 * report's claimed validations against the same notion this gate uses.
 */
export function typedValidationSummary(toolName: string, payload: Record<string, unknown>): string | null {
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	if (toolName === "verify") {
		const check = typeof args?.check === "string" ? args.check.trim() : "";
		if (check === "frontend") {
			const path = typeof args?.path === "string" && args.path.trim().length > 0 ? args.path.trim() : "artifact";
			return `verify frontend ${path}`;
		}
		if (isVerificationScriptName(check)) return `npm run ${check}`;
		if (isProjectVerifierCheckId(check)) return `verify ${check}`;
		return null;
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
	if (result?.kind === "error" || details?.kind === "error") return null;
	if (typeof details?.exitCode === "number" && details.exitCode !== 0) return null;
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
	const summary = passedDispatchReceiptSummary(details, candidate);
	if (summary === null) return null;
	const evidence: FinishContractEvidence = {
		kind: "dispatch_receipt",
		summary,
	};
	const turnId = candidate?.turnId ?? turnIdOf(entry);
	if (turnId !== null && turnId !== undefined) evidence.turnId = turnId;
	return evidence;
}

/**
 * Summarizes a dispatch result as passed-receipt evidence, or null when it is
 * not a passing dispatch. Handles the toolkit v2 batch shape
 * (`{mode, runIds, receiptCount, failedCount, runs:[{runId, agentId, exitCode}]}`
 * where exit codes live per-run) as well as the legacy single-run shape
 * (`{exitCode, runId, agentId}`). A batch counts only when it has at least one
 * run and every run exited cleanly, so a partially-failed dispatch never poses
 * as validation evidence.
 */
function passedDispatchReceiptSummary(
	details: Record<string, unknown>,
	candidate: ToolCallEvidenceCandidate | undefined,
): string | null {
	if (Array.isArray(details.runs)) {
		const runs = details.runs.map(asRecord);
		if (runs.length === 0 || runs.some((run) => run === null || run.exitCode !== 0)) return null;
		if (typeof details.failedCount === "number" && details.failedCount !== 0) return null;
		const first = runs[0];
		const runId = typeof first?.runId === "string" && first.runId.length > 0 ? first.runId : "unknown";
		const agentId = dispatchReceiptAgentId(typeof first?.agentId === "string" ? first.agentId : undefined, candidate);
		const extra = runs.length > 1 ? ` (+${runs.length - 1} more)` : "";
		return `dispatch receipt passed: run ${runId} agent ${agentId}${extra}`;
	}
	if (details.exitCode === 0) {
		const runId = typeof details.runId === "string" && details.runId.length > 0 ? details.runId : "unknown";
		const agentId = dispatchReceiptAgentId(typeof details.agentId === "string" ? details.agentId : undefined, candidate);
		return `dispatch receipt passed: run ${runId} agent ${agentId}`;
	}
	return null;
}

/** Prefer the receipt's own agent id, then the dispatch call's, then unknown. */
function dispatchReceiptAgentId(
	receiptAgentId: string | undefined,
	candidate: ToolCallEvidenceCandidate | undefined,
): string {
	if (receiptAgentId !== undefined && receiptAgentId.length > 0) return receiptAgentId;
	return candidate?.command.match(/^agent=([^\s]+)/)?.[1] ?? "unknown";
}

function bashExecutionEvidence(entry: unknown, acceptanceChecks: ReadonlySet<string>): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true) return null;
	if (record.exitCode !== 0) return null;
	const detected = acceptanceValidationCommand(record.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const contextMarker = record.excludeFromContext === true ? " [not sent to model]" : "";
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${detected.matched}${contextMarker}`,
		...validationCheckFields(detected.matched),
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
		...(candidate.check ? { check: candidate.check } : {}),
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
	if (record?.kind !== "message" || record.role !== "user") return false;
	const payload = asRecord(record.payload);
	return payload?.synthetic !== true;
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

/** Exact check ids, never substring matches against rendered evidence summaries. */
function validationCheckId(command: string): string | undefined {
	return (
		/^(?:npm|pnpm|yarn|bun) (?:run )?([a-z0-9][a-z0-9._:-]*)$/.exec(command)?.[1] ??
		/^verify ([a-z0-9][a-z0-9._:-]*)$/.exec(command)?.[1]
	);
}

function validationCheckFields(command: string): { check?: string } {
	const check = validationCheckId(command);
	return check ? { check } : {};
}

/** Additional package scripts are admitted only by the operator's typed acceptance. */
function acceptanceValidationCommand(
	command: string,
	checks: ReadonlySet<string>,
): ReturnType<typeof detectValidationCommand> {
	const exact = command.trim();
	const check = /^npm run ([a-z0-9][a-z0-9._:-]*)$/.exec(exact)?.[1];
	if (check && checks.has(check)) return { kind: "validation", matched: exact };
	return detectValidationCommand(command);
}
