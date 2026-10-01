import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNonSourcePath } from "../../core/test-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import { isProjectVerifierCheckId, isVerificationScriptName } from "../../core/verification-scripts.js";
import { effectiveToolCall, expandChainMessages } from "../../tools/surface.js";
import { type DeclaredCheckSourceRef, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "../../tools/verify/catalog.js";
import { assessQualityPolicy, loadQualityPolicy, type QualityFinding } from "../../tools/verify/quality-policy.js";
import { validateTrustStatus } from "../evidence/trust-status.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import {
	detectValidationCommand,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	scanShellLike,
	toolMutationPaths,
} from "./protected-artifacts.js";
import type { Rigor } from "./rigor.js";

export const FINISH_CONTRACT_ADVISORY_MESSAGE =
	"[Clio Coder] finish-contract advisory: you changed files this turn without recording validation evidence or a limitation receipt. Report the change as unverified. Run checks only within the operator's authorized scope; this advisory does not authorize tests, scripts, or additional tools.";

export const FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE =
	"[Clio Coder] finish-contract advisory: checks passed; behavior coverage unverified. Passing receipts establish the recorded checks, not every changed behavior. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

export const FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE =
	"[Clio Coder] finish-contract advisory: validation evidence recorded; behavior coverage unverified. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

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

interface ValidationExecutionEvidence {
	source?: DeclaredCheckSourceRef;
	cwd?: string;
	argv?: ReadonlyArray<string>;
	durationMs?: number;
}

export interface FinishContractEvidence extends ValidationExecutionEvidence {
	kind: FinishContractEvidenceKind;
	summary: string;
	check?: string;
	paths?: ReadonlyArray<string>;
	turnId?: string;
}

/** CLB-3: declared checks and freshness are useful evidence, but neither records runtime behavior coverage. */
export interface FinishContractVerificationScope {
	behaviorCoverage: "unknown";
	passedChecks: ReadonlyArray<string>;
	acceptance: ReadonlyArray<{ check: string; state: "passed" | "limited" | "unverified" }>;
	limitations: ReadonlyArray<FinishContractEvidence>;
}

/** Why the contract settled. Every branch is auditable from the ledger alone. */
export type FinishContractReason =
	| "no_mutation"
	| "no_net_mutation"
	| "deletion_only"
	| "validation_evidence"
	| "explicit_limitation"
	| "unvalidated_mutation";

export type FinishContractAssessment =
	| {
			kind: "ok";
			reason: "no_mutation" | "no_net_mutation" | "deletion_only" | "validation_evidence" | "explicit_limitation";
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
			quality?: ReadonlyArray<QualityFinding>;
			verificationScope?: FinishContractVerificationScope;
			advisory?: string;
	  }
	| {
			kind: "engage";
			reason: "unvalidated_mutation";
			message: string;
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
			quality?: ReadonlyArray<QualityFinding>;
			verificationScope?: FinishContractVerificationScope;
	  };

export interface FinishContractInput {
	sessionEntries?: ReadonlyArray<unknown>;
	assistantTurnId?: string | null;
	recentEntryLimit?: number;
	rigor?: Rigor;
	activeAcceptance?: UserTaskAcceptance;
	/** Owning session workspace, supplied by the finish registration. */
	workspaceRoot?: string;
	/**
	 * Mutation targets whose state at turn end matches what it was before the
	 * turn first touched them: a create-then-delete probe changed nothing.
	 */
	unchangedPaths?: ReadonlySet<string>;
}

interface ToolCallEvidenceCandidate {
	turnId?: string;
	toolCallId: string;
	command: string;
	check?: string;
	paths?: string[];
	execution?: ValidationExecutionEvidence;
}

interface MutationCandidate {
	toolCallId: string;
	paths: string[];
	/** Targets the call wrote or created, as opposed to only removed. */
	writes: string[];
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
 *   2. validation evidence present              -> ok/validation_evidence, with bounded scope advisory
 *   3. successful `limitation` receipt present  -> ok/explicit_limitation
 *   4. otherwise                                -> engage/unvalidated_mutation
 *
 * The assistant's prose never enters the decision. A limitation counts only
 * as a `limitation` tool_call paired with a non-error tool_result inside the
 * same window the mutation scan uses, so a run cannot satisfy the contract by
 * wording alone and a real limitation is never missed for its phrasing.
 */
export function assessFinishContract(input: FinishContractInput): FinishContractAssessment {
	const assessment = assessMutationFinishContract(input);
	if (assessment.mutatedPaths.length === 0 || assessment.reason === "deletion_only") return assessment;
	const limitations = assessment.evidence.filter((item) => item.kind === "limitation");
	const passedChecks = [
		...assessment.evidence.filter((item) => item.kind === "validation_command").map((item) => item.check ?? item.summary),
		...(assessment.quality?.filter((finding) => finding.state === "passed").map((finding) => finding.check) ?? []),
	];
	const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
	const verificationScope: FinishContractVerificationScope = {
		behaviorCoverage: "unknown",
		passedChecks: [...new Set(passedChecks)],
		acceptance: (input.activeAcceptance?.verification ?? []).map((required) => ({
			check: required.check,
			state: assessment.evidence.some((item) => acceptanceCheckPassed(item, required, input.workspaceRoot))
				? "passed"
				: limited.has(required.check)
					? "limited"
					: "unverified",
		})),
		limitations,
	};
	// CLB-3: an OK decision permits completion; it is not a correctness verdict.
	// No current receipt describes runtime behavior coverage, including a fresh
	// quality snapshot or a pass for an explicitly requested acceptance check.
	const hasPassedChecks = passedChecks.length > 0;
	const hasEvidence = hasPassedChecks || assessment.evidence.some((item) => item.kind !== "limitation");
	return {
		...assessment,
		verificationScope,
		...(assessment.kind === "ok" && hasEvidence
			? {
					advisory: hasPassedChecks
						? FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE
						: FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE,
				}
			: {}),
	};
}

function assessMutationFinishContract(input: FinishContractInput): FinishContractAssessment {
	const sessionEntries = input.sessionEntries ?? [];
	const assistantTurnId = input.assistantTurnId ?? null;
	const window = recentEntries(sessionEntries, assistantTurnId, input.recentEntryLimit ?? DEFAULT_RECENT_ENTRY_LIMIT);

	const { paths: touchedPaths, written } = mutatingReceipts(window);
	if (touchedPaths.length === 0) {
		return { kind: "ok", reason: "no_mutation", evidence: [], mutatedPaths: touchedPaths };
	}
	const unchanged = input.unchangedPaths;
	// The contract guards workspace state. A note written outside the workspace
	// is not a code change that needs validation evidence.
	const inWorkspace = input.workspaceRoot
		? touchedPaths.filter((path) => isWithinWorkspace(path, input.workspaceRoot as string))
		: touchedPaths;
	const mutatedPaths = inWorkspace.filter(
		(path) => !unchanged?.has(path) && !isClioConfigurationPath(path, input.workspaceRoot),
	);
	if (mutatedPaths.length === 0) {
		return { kind: "ok", reason: "no_net_mutation", evidence: [], mutatedPaths };
	}

	const acceptanceChecks = new Set(input.activeAcceptance?.verification.map((item) => item.check) ?? []);
	const evidence = collectValidationEvidence(window, acceptanceChecks, input.workspaceRoot);
	const limitations = collectLimitationEvidence(window);
	let quality: QualityFinding[] = [];
	if (input.workspaceRoot) {
		const loaded = loadQualityPolicy(input.workspaceRoot);
		if (!loaded.ok)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[Clio Coder] quality policy cannot be assessed: ${loaded.reason}. Report the change as unverified; this notice grants no additional authority.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
			};
		if (loaded.policy)
			quality = assessQualityPolicy(input.workspaceRoot, loaded.policy, mutatedPaths, capabilityEntries(window));
		const outstanding = quality.filter((finding) => finding.state !== "passed" && finding.state !== "limited");
		if (outstanding.length)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[Clio Coder] project quality policy has outstanding checks: ${outstanding.map((finding) => `${finding.rule}/${finding.check}: ${finding.state} (${finding.message})`).join("; ")}. Run checks only within the operator's authorized scope; this notice grants no additional authority.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				quality,
			};
	}
	const required = input.rigor === "high" ? (input.activeAcceptance?.verification ?? []) : [];
	if (required.length > 0) {
		const passes = new Set(
			required.filter((check) => evidence.some((item) => acceptanceCheckPassed(item, check, input.workspaceRoot))),
		);
		const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
		const missing = [
			...new Set(required.filter((check) => !passes.has(check) && !limited.has(check.check)).map((item) => item.check)),
		];
		if (missing.length > 0)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[Clio Coder] High-rigor finish gate: operator acceptance still requires passing validation for: ${missing.join(", ")}. Run each named check or include its exact id in limitation.paths.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				...(quality.length ? { quality } : {}),
			};
		return {
			kind: "ok",
			reason: passes.size === required.length ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
			...(quality.length ? { quality } : {}),
		};
	}
	if (quality.length > 0)
		return {
			kind: "ok",
			reason: quality.every((finding) => finding.state === "passed") ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
			quality,
		};
	if (evidence.length > 0) {
		return { kind: "ok", reason: "validation_evidence", evidence: [...evidence, ...limitations], mutatedPaths };
	}

	if (limitations.length > 0) {
		return { kind: "ok", reason: "explicit_limitation", evidence: limitations, mutatedPaths };
	}
	// Removing tests or docs leaves nothing to check (D2-t2-b). Removing source
	// can break imports or the build, so it still earns the advisory unless the
	// operator's own message asked for that removal (F-Y1); quality and
	// acceptance gates above applied either way.
	const request = latestUserText(sessionEntries, assistantTurnId);
	if (
		mutatedPaths.every(
			(path) => !written.has(path) && (isNonSourcePath(path) || operatorRequestedDeletion(path, request)),
		)
	) {
		return { kind: "ok", reason: "deletion_only", evidence: [], mutatedPaths };
	}

	return {
		kind: "engage",
		reason: "unvalidated_mutation",
		message: FINISH_CONTRACT_ADVISORY_MESSAGE,
		evidence: [],
		mutatedPaths,
	};
}

function isClioConfigurationPath(path: string, workspaceRoot: string | undefined): boolean {
	const root = resolve(workspaceRoot ?? ".");
	const target = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
	const local = relative(root, target).split(sep).join("/");
	return /^\.clio-coder\/(?:settings(?:\.local)?\.yaml|fleets\/[^/]+\.md)$/u.test(local);
}

/** Relative targets resolve against the workspace; `~` and absolute paths are judged where they land. */
function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
	const root = resolve(workspaceRoot);
	const target = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function acceptanceCheckPassed(
	evidence: FinishContractEvidence,
	required: UserTaskAcceptance["verification"][number],
	workspaceRoot: string | undefined,
): boolean {
	if (evidence.kind !== "validation_command" || evidence.check !== required.check || !workspaceRoot || !evidence.source)
		return false;
	if (evidence.durationMs !== undefined && evidence.durationMs > required.timeoutMs) return false;
	const root = resolve(workspaceRoot);
	if (evidence.source.kind === "project-catalog")
		return evidence.source.path === resolve(root, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH);
	return (
		evidence.source.path === resolve(root, "package.json") &&
		evidence.cwd === root &&
		validationCheckId(evidence.argv?.join(" ") ?? "") === required.check
	);
}

/**
 * Recent entries as the capabilities that ran. The coordinator reaches verify,
 * bash and limitation only through gateway op=call or op=chain, so a scan keyed
 * on the recorded name would never see that evidence and would keep demanding
 * validation the model already ran. Result entries keep their own ids.
 */
function capabilityEntries(recent: ReadonlyArray<unknown>): unknown[] {
	return expandChainMessages(recent).map((entry) => {
		const record = asRecord(entry);
		if (record?.kind !== "message" || record.role !== "tool_call") return entry;
		const payload = asRecord(record.payload);
		const recorded = payload === null ? null : stringFromFirst(payload, ["name", "toolName", "tool"]);
		if (payload === null || recorded === null) return entry;
		const call = effectiveToolCall(recorded, payload.args ?? payload.arguments ?? payload.input);
		if (!call.viaGateway) return entry;
		return { ...record, payload: { ...payload, name: call.toolName, args: call.args ?? {} } };
	});
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

	for (const entry of capabilityEntries(recent)) {
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
function mutatingReceipts(recent: ReadonlyArray<unknown>): { paths: string[]; written: Set<string> } {
	const mutationCalls = new Map<string, MutationCandidate>();
	const paths: string[] = [];
	const seen = new Set<string>();
	const written = new Set<string>();

	for (const entry of capabilityEntries(recent)) {
		// A user-run `!` bash execution is self-contained: it carries its own
		// success signal, so any mutation targets count without a paired result.
		const bashMutation = bashExecutionMutationPaths(entry);
		if (bashMutation !== null) {
			for (const path of bashMutation.paths) pushPath(paths, seen, path);
			for (const path of bashMutation.writes) written.add(path);
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
				for (const path of candidate.writes) written.add(path);
			}
		}
	}

	return { paths, written };
}

/** Mutation targets for a tool call, empty for read-only/execute-only tools. */
export function mutationPathsForTool(toolName: string, args: Record<string, unknown> | undefined): string[] {
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
	const recordedTool = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (recordedTool === null) return null;
	// An artifact written through the gateway mutates the same path a direct
	// artifact call would, so the call unwraps to the capability first.
	const { toolName, args } = effectiveToolCall(
		recordedTool,
		asRecord(payload.args ?? payload.arguments ?? payload.input) ?? undefined,
	);
	const paths = mutationPathsForTool(toolName, args);
	if (paths.length === 0) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const command = toolName === ToolNames.Bash && typeof args?.command === "string" ? args.command : null;
	return { toolCallId, paths, writes: command === null ? paths : extractCommandWriteTargets(command) };
}

/**
 * Mutation targets of a settled `!` bash execution entry. Returns null when the
 * entry is not a successful bash execution so the caller falls through to the
 * tool_call/tool_result pairing path; returns `[]` for a successful command
 * with no write/delete target (a read-only `!` command is not a mutation).
 */
function bashExecutionMutationPaths(entry: unknown): { paths: string[]; writes: string[] } | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true || record.exitCode !== 0) return null;
	const writes = extractCommandWriteTargets(record.command);
	return { paths: [...writes, ...extractCommandDeleteTargets(record.command)], writes };
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
	workspaceRoot: string | undefined,
): FinishContractEvidence[] {
	const evidence: FinishContractEvidence[] = [];
	const toolCalls = new Map<string, ToolCallEvidenceCandidate>();
	const dispatchCalls = new Map<string, ToolCallEvidenceCandidate>();
	const seen = new Set<string>();

	for (const entry of capabilityEntries(recent)) {
		const protectedArtifact = protectedArtifactEvidence(entry);
		if (protectedArtifact !== null) {
			pushEvidence(evidence, seen, protectedArtifact);
			continue;
		}

		const call = bashValidationCall(entry, acceptanceChecks, workspaceRoot);
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
				pushEvidence(evidence, seen, validationEvidence(candidate, entry));
			}
			continue;
		}

		const bashExecution = bashExecutionEvidence(entry, acceptanceChecks, workspaceRoot);
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

function bashValidationCall(
	entry: unknown,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "bash") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const command = typeof args?.command === "string" ? args.command : null;
	if (command === null) return null;
	const execution = workspaceValidationCommand(command, args?.cwd, workspaceRoot);
	if (execution === null) return null;
	const detected = acceptanceValidationCommand(execution.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: detected.matched,
		...validationCheckFields(detected.matched),
		execution: packageCommandExecution(execution.command, execution.cwd, workspaceRoot),
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
	// A call the safety rails refused or the registry settled as an error ran
	// nothing. The persisted verdict says so even when `isError` is false: a
	// denied write is not a change, and a denied test run is not validation.
	if (payload.outcome === "blocked" || payload.outcome === "error" || typeof payload.blockReason === "string")
		return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (result?.kind === "error" || details?.kind === "error") return null;
	const chainAdmission = asRecord(details?.chainAdmission);
	if (chainAdmission?.outcome === "blocked" || chainAdmission?.outcome === "error") return null;
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
 * run and every run exited cleanly. Current results must also carry verified
 * integrity and validated evidence on their canonical trust axes, so failed or
 * ungrounded checks never become validation evidence through process success.
 */
function passedDispatchReceiptSummary(
	details: Record<string, unknown>,
	candidate: ToolCallEvidenceCandidate | undefined,
): string | null {
	if (Array.isArray(details.runs)) {
		const runs = details.runs.map(asRecord);
		if (runs.length === 0 || runs.some((run) => run === null || !passedDispatchRun(run))) return null;
		if (typeof details.failedCount === "number" && details.failedCount !== 0) return null;
		const first = runs[0];
		const runId = typeof first?.runId === "string" && first.runId.length > 0 ? first.runId : "unknown";
		const agentId = dispatchReceiptAgentId(typeof first?.agentId === "string" ? first.agentId : undefined, candidate);
		const extra = runs.length > 1 ? ` (+${runs.length - 1} more)` : "";
		return `dispatch receipt passed: run ${runId} agent ${agentId}${extra}`;
	}
	if (passedDispatchRun(details)) {
		const runId = typeof details.runId === "string" && details.runId.length > 0 ? details.runId : "unknown";
		const agentId = dispatchReceiptAgentId(typeof details.agentId === "string" ? details.agentId : undefined, candidate);
		return `dispatch receipt passed: run ${runId} agent ${agentId}`;
	}
	return null;
}

function passedDispatchRun(run: Record<string, unknown>): boolean {
	if (run.exitCode !== 0) return false;
	// Historical results predate canonical trust status. For current results,
	// a clean process exit cannot overrule failed, absent, or ungrounded validation.
	if (!("trustStatus" in run)) return true;
	const trust = validateTrustStatus(run.trustStatus);
	return (
		trust.ok &&
		trust.status.artifactIntegrity.state === "verified" &&
		trust.status.validationGrounding.state === "validated"
	);
}

/** Prefer the receipt's own agent id, then the dispatch call's, then unknown. */
function dispatchReceiptAgentId(
	receiptAgentId: string | undefined,
	candidate: ToolCallEvidenceCandidate | undefined,
): string {
	if (receiptAgentId !== undefined && receiptAgentId.length > 0) return receiptAgentId;
	return candidate?.command.match(/^agent=([^\s]+)/)?.[1] ?? "unknown";
}

function bashExecutionEvidence(
	entry: unknown,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true) return null;
	if (record.exitCode !== 0) return null;
	const execution = workspaceValidationCommand(record.command, record.cwd, workspaceRoot);
	if (execution === null) return null;
	const detected = acceptanceValidationCommand(execution.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const contextMarker = record.excludeFromContext === true ? " [not sent to model]" : "";
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${detected.matched}${contextMarker}`,
		...validationCheckFields(detected.matched),
		...packageCommandExecution(execution.command, execution.cwd, workspaceRoot),
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

function validationEvidence(candidate: ToolCallEvidenceCandidate, entry: unknown): FinishContractEvidence {
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${candidate.command}`,
		...(candidate.check ? { check: candidate.check } : {}),
		...(candidate.execution ?? declaredCheckExecution(entry, candidate.check)),
	};
	if (candidate.turnId !== undefined) evidence.turnId = candidate.turnId;
	return evidence;
}

/** Preserve the verifier's execution facts only when they identify the declared check. */
function declaredCheckExecution(entry: unknown, check: string | undefined): ValidationExecutionEvidence {
	const payload = asRecord(asRecord(entry)?.payload);
	const details = asRecord(asRecord(payload?.result)?.details);
	const source = asRecord(details?.source);
	if (
		!details ||
		details.check !== check ||
		details.exitCode !== 0 ||
		details.aborted === true ||
		details.timedOut === true ||
		details.outputCapped === true ||
		(source?.kind !== "package.json" && source?.kind !== "project-catalog") ||
		typeof source.path !== "string" ||
		typeof details.cwd !== "string" ||
		!Array.isArray(details.argv) ||
		!details.argv.every((arg): arg is string => typeof arg === "string")
	)
		return {};
	if (source.kind === "project-catalog") {
		const argv = details.argv;
		if (
			!Array.isArray(details.declaredCommand) ||
			details.declaredCommand.length !== details.argv.length ||
			!details.declaredCommand.every((arg, index) => arg === argv[index]) ||
			typeof details.declaredCwd !== "string" ||
			typeof details.declaredTimeoutMs !== "number" ||
			typeof details.durationMs !== "number" ||
			details.durationMs > details.declaredTimeoutMs ||
			resolve(source.path, "../..", details.declaredCwd) !== details.cwd
		)
			return {};
	}
	return {
		source: { kind: source.kind, path: source.path },
		cwd: details.cwd,
		argv: details.argv,
		...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
	};
}

/** Resolve a literal leading cd without crediting checks from a different workspace. */
function workspaceValidationCommand(
	command: string,
	cwd: unknown,
	workspaceRoot: string | undefined,
): { command: string; cwd: unknown } | null {
	const tokens = scanShellLike(command);
	if (tokens[0]?.value !== "cd") return { command, cwd };
	const directory = tokens[1];
	const separator = tokens[2];
	if (
		!workspaceRoot ||
		!directory ||
		directory.operator ||
		directory.substitutions?.length ||
		directory.homeRelative ||
		/[$`]/u.test(directory.value) ||
		separator?.operator !== true ||
		separator.value !== "&&"
	)
		return null;
	const executionCwd = resolve(workspaceRoot, typeof cwd === "string" ? cwd : ".", directory.value);
	if (!isWithinWorkspace(executionCwd, workspaceRoot)) return null;
	return { command: command.slice(separator.end).trim(), cwd: executionCwd };
}

/** Exact package commands retain their execution cwd; a matched substring proves no project identity. */
function packageCommandExecution(
	command: string,
	cwd: unknown,
	workspaceRoot: string | undefined,
): ValidationExecutionEvidence {
	if (
		!workspaceRoot ||
		!/^(?:npm|pnpm|yarn|bun) /u.test(command.trim()) ||
		validationCheckId(command.trim()) === undefined
	)
		return {};
	const executionCwd = resolve(workspaceRoot, typeof cwd === "string" ? cwd : ".");
	return {
		source: { kind: "package.json", path: resolve(executionCwd, "package.json") },
		cwd: executionCwd,
		argv: command.trim().split(/\s+/u),
	};
}

function pushEvidence(evidence: FinishContractEvidence[], seen: Set<string>, item: FinishContractEvidence): void {
	const key = JSON.stringify(item);
	if (seen.has(key)) return;
	seen.add(key);
	evidence.push(item);
}

const DELETION_CLAUSE_SPLIT = /[.;\n]|\b(?:then|but)\b/iu;
const DELETION_VERB = /\b(?:delete|remove|rm|drop|get\s+rid\s+of)\b/iu;
const DELETION_NEGATION = /\b(?:do\s+not|don['’]t|never|without)\s+(?:delete|remove|drop)\b/iu;

/** A clause of the operator's message that asks to delete and names this path or its last segment. */
function operatorRequestedDeletion(path: string, request: string | null): boolean {
	if (request === null) return false;
	const trimmed = path.replace(/^\.\//u, "").replace(/\/+$/u, "");
	const leaf = trimmed.split("/").pop() ?? "";
	if (leaf.length === 0) return false;
	const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const names = new RegExp(`(?:^|[\\s\`'"(/])(?:${literal(trimmed)}|${literal(leaf)})(?:$|[\\s\`'",;:)/])`, "u");
	return request
		.split(DELETION_CLAUSE_SPLIT)
		.some((clause) => DELETION_VERB.test(clause) && !DELETION_NEGATION.test(clause) && names.test(clause));
}

/** Text of the last real user message before the assessed turn. */
function latestUserText(entries: ReadonlyArray<unknown>, assistantTurnId: string | null): string | null {
	const assistantIndex =
		assistantTurnId === null ? -1 : entries.findIndex((entry) => turnIdOf(entry) === assistantTurnId);
	for (let index = (assistantIndex >= 0 ? assistantIndex : entries.length) - 1; index >= 0; index -= 1) {
		if (!isUserMessageEntry(entries[index])) continue;
		const payload = asRecord(asRecord(entries[index])?.payload);
		const content = payload?.text ?? payload?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((part) => {
					const text = asRecord(part)?.text;
					return typeof text === "string" ? text : "";
				})
				.join("\n");
		return null;
	}
	return null;
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
