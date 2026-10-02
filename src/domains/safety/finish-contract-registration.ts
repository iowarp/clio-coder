/**
 * Finish-contract assessor, packaged as a turn_end hook registration.
 *
 * The chat-loop fires `turn_end` with the final assistant text and this
 * registration emits an advisory `inject_reminder` (severity "warn") when the
 * turn mutated workspace state but recorded no validation evidence and no
 * `limitation` receipt, or when validation's behavior coverage is unknown.
 * Unknown coverage only advises; it never requests continuation, even at high rigor.
 * The trigger is the observed mutation, not the wording
 * of the assistant's text, and the text never enters the assessment. The chat-loop's generic effect application renders the
 * notice, persists the session entry, and flushes the reminder into the next
 * model request. Every decision is also written to the audit ledger.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { type TurnConstraints, turnAllowsContinuation, turnAllowsTool } from "../../core/turn-constraints.js";
import { VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import { effectiveToolCall } from "../../tools/surface.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import type { CompletionContractAuditInput } from "./audit.js";
import {
	assessFinishContract,
	DEFAULT_RECENT_ENTRY_LIMIT,
	type FinishContractAssessment,
	mutationPathsForTool,
	recentEntries,
} from "./finish-contract.js";
import { extractCommandPathWalks } from "./protected-artifacts.js";
import type { Rigor } from "./rigor.js";

export const FINISH_CONTRACT_REGISTRATION_ID = "assessor.finish-contract";

/**
 * High-rigor re-prompt directive. Injected dynamically via effects (never added
 * to the static system prompt) so the prompt prefix stays byte-stable. It tells
 * the model to validate with a verification-family command or to record a
 * `limitation` receipt before claiming done. The command hint mirrors the
 * vocabulary `detectValidationCommand` and `isVerificationScriptName` accept.
 */
export const HIGH_RIGOR_REVALIDATION_MESSAGE =
	`[Clio Coder] High-rigor finish gate: this completion claim has no validation evidence. ` +
	`Before claiming done, run a verification command (the ${VERIFICATION_SCRIPT_FAMILY_HINT} family, ` +
	`e.g. "npm run test", "npm run lint", "npm run build") or call the limitation tool with the scope ` +
	`and reason of what could not be verified. Do not end the turn until you have validated or recorded the limitation.`;

export interface CreateFinishContractRegistrationOptions {
	getTurnConstraints?: () => TurnConstraints | undefined;
	/**
	 * Current session entries for evidence collection, or null when no session
	 * is active. A null return disables assessment for the turn, matching the
	 * former chat-loop guard (`!deps.session?.current()`).
	 */
	readSessionEntries: () => ReadonlyArray<unknown> | null;
	/**
	 * Resolve the effective rigor for the current turn. Optional; defaults to
	 * `"normal"` (today's soft advisory) when absent. At `"high"` an
	 * unvalidated mutation re-prompts the model to validate or state a
	 * limitation instead of merely warning.
	 */
	resolveRigor?: () => Rigor;
	readActiveAcceptance?: (window: ReadonlyArray<unknown>) => UserTaskAcceptance | undefined;
	/**
	 * Record the contract's decision to the audit ledger. Optional; when wired
	 * (production passes the safety audit sink), every turn_end decision — each
	 * OK reason and each engagement — is written so the outcome is replayable
	 * from the JSONL alone. Failures here never affect the returned effects.
	 */
	recordDecision?: (input: CompletionContractAuditInput) => void;
}

/** Files above this are compared by size and mtime; a rewrite then counts as a change. */
const PATH_STATE_HASH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What a mutation target is right now, cheap enough to take before every
 * mutating call. A directory is its shallow listing, so a tree deleted and
 * recreated reads as changed through its children's new mtimes.
 */
function pathState(abs: string): string {
	try {
		const stat = lstatSync(abs);
		if (stat.isDirectory()) {
			const listing = readdirSync(abs, { withFileTypes: true })
				.map((entry) => {
					const child = lstatSync(join(abs, entry.name));
					return `${entry.name}:${child.isDirectory() ? "d" : "f"}:${child.size}:${child.mtimeMs}`;
				})
				.sort();
			return `dir:${createHash("sha256").update(listing.join("\n")).digest("hex")}`;
		}
		if (stat.isSymbolicLink() || stat.size > PATH_STATE_HASH_MAX_BYTES)
			return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
		return `file:${stat.mode}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `unreadable:${String(error)}`;
	}
}

function resolveTarget(raw: string, base: string): string {
	if (raw === "~") return homedir();
	return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(base, raw);
}

export function createFinishContractRegistration(
	options: CreateFinishContractRegistrationOptions,
): MiddlewareHookRegistration {
	// State of each mutation target before the session first touched it, keyed
	// by the raw path the ledger scan reports (#12 in the 0.5.8 probe: a
	// create-then-delete probe was told its change was unverified). The baseline
	// outlives the turn so an undo that returns a file to where the session found
	// it is a net-empty change instead of an unverified one. A target named from
	// two directories is ambiguous and never counts as unchanged.
	const before = new Map<string, { abs: string; state: string; ambiguous: boolean }>();
	let baselineSessionId: string | undefined;
	const recordBefore = (input: MiddlewareHookInput): void => {
		if (input.metadata?.nested === true) return;
		const { toolName, args } = effectiveToolCall(input.toolName ?? "", input.toolArgs);
		const command = toolName === ToolNames.Bash && typeof args?.command === "string" ? args.command : null;
		// A cd moves where relative targets land; those keep the plain rule.
		if (command !== null && extractCommandPathWalks(command).some((walk) => walk.some((e) => e.kind === "cd"))) return;
		const cwd = typeof args?.cwd === "string" && args.cwd.length > 0 ? args.cwd : ".";
		const base = resolve(process.cwd(), cwd);
		for (const raw of mutationPathsForTool(toolName, args)) {
			const abs = resolveTarget(raw, base);
			const seen = before.get(raw);
			if (seen === undefined) before.set(raw, { abs, state: pathState(abs), ambiguous: false });
			else if (seen.abs !== abs) seen.ambiguous = true;
		}
	};
	const unchangedPaths = (): Set<string> =>
		new Set(
			[...before.entries()]
				.filter(([, entry]) => !entry.ambiguous && pathState(entry.abs) === entry.state)
				.map(([raw]) => raw),
		);
	return {
		id: FINISH_CONTRACT_REGISTRATION_ID,
		description: "report completion evidence and advise when a mutation's validation or behavior coverage is unverified",
		hooks: ["turn_start", "before_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput, context): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "turn_start") {
				if (input.sessionId !== undefined && input.sessionId !== baselineSessionId) {
					before.clear();
					baselineSessionId = input.sessionId;
				}
				return [];
			}
			if (input.hook === "before_tool") {
				try {
					recordBefore(input);
				} catch {
					// A path that cannot be read keeps the plain mutation rule.
				}
				return [];
			}
			if (input.hook !== "turn_end") return [];
			if (context?.priorEffects.some(isHardBlockEffect) === true) return [];
			// Only settled stop turns make completion claims; aborted and error
			// turns (including tool-prose interruptions) carry no finish contract.
			// An absent stopReason is treated as "stop".
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			// An empty final text is not a completion claim. The assessor reads
			// only ledger receipts, so the text is otherwise unused here.
			if ((input.text?.trim() ?? "").length === 0) return [];
			let entries: ReadonlyArray<unknown> | null;
			try {
				entries = options.readSessionEntries();
			} catch {
				return [];
			}
			if (entries === null) return [];
			const rigor = options.resolveRigor?.() ?? "normal";
			const activeAcceptance = options.readActiveAcceptance?.(
				recentEntries(entries, input.turnId ?? null, DEFAULT_RECENT_ENTRY_LIMIT),
			);
			const assessment = assessFinishContract({
				sessionEntries: entries,
				workspaceRoot: process.cwd(),
				unchangedPaths: unchangedPaths(),
				rigor,
				...(activeAcceptance ? { activeAcceptance } : {}),
				assistantTurnId: input.turnId ?? null,
			});
			recordDecision(options, input.turnId ?? null, assessment, rigor);
			if (assessment.kind === "ok")
				return assessment.advisory ? [{ kind: "inject_reminder", message: assessment.advisory, severity: "warn" }] : [];
			if (rigor === "high") {
				const constraints = options.getTurnConstraints?.();
				const names = input.metadata?.activeCapabilityNames ?? input.metadata?.activeToolNames;
				const reachable = typeof names === "string" ? names.split(",") : undefined;
				const available = (name: string) =>
					turnAllowsTool(constraints, name) && (reachable === undefined || reachable.includes(name));
				const verificationTools = (assessment.quality?.length ? ["verify"] : ["verify", "bash", "run_script"]).filter(
					available,
				);
				const canRecordLimitation =
					available("limitation") &&
					(assessment.quality
						?.filter((finding) => finding.state !== "passed" && finding.state !== "limited")
						.every((finding) => finding.allowLimitation) ??
						true);
				if (!turnAllowsContinuation(constraints) || (verificationTools.length === 0 && !canRecordLimitation)) {
					return [
						{
							kind: "inject_reminder",
							severity: "warn",
							message: `${assessment.message} The current task scope does not permit automatic validation recovery; report the change as unverified. This notice grants no additional authority.`,
						},
					];
				}
				// Withhold the completion and force a re-prompt: a continuation
				// request carries the turn onward, and the paired reminder gives
				// the directive its own visible system-reminder line.
				const message = assessment.quality?.length
					? `${assessment.message}${canRecordLimitation ? " Alternatively, record a limitation with each outstanding check's exact ID in limitation.paths; these checks remain unverified." : ""}`
					: verificationTools.length > 0 && canRecordLimitation
						? activeAcceptance?.verification.length || assessment.message.includes("quality policy")
							? assessment.message
							: HIGH_RIGOR_REVALIDATION_MESSAGE
						: `[Clio Coder] High-rigor finish gate: validation evidence is missing. ${verificationTools.length > 0 ? `Use an authorized check through ${verificationTools.join(" or ")}; if the operator excluded validation, report the blocker without running it.` : "Record the unavailable validation with limitation."} Do not claim checks passed without evidence.`;
				return [
					{ kind: "request_continuation", message },
					{ kind: "inject_reminder", message, severity: "warn" },
				];
			}
			return [{ kind: "inject_reminder", message: assessment.message, severity: "warn" }];
		},
	};
}

function isHardBlockEffect(effect: MiddlewareEffect): boolean {
	return effect.kind === "block_tool" || (effect.kind === "inject_reminder" && effect.severity === "hard-block");
}

function recordDecision(
	options: CreateFinishContractRegistrationOptions,
	turnId: string | null,
	assessment: FinishContractAssessment,
	rigor: Rigor,
): void {
	if (options.recordDecision === undefined) return;
	const evidenceKinds = Array.from(new Set(assessment.evidence.map((item) => item.kind)));
	try {
		options.recordDecision({
			turnId,
			decision: assessment.kind,
			reason: assessment.reason,
			rigor,
			mutatedPaths: assessment.mutatedPaths,
			evidenceKinds,
			...(assessment.quality ? { quality: assessment.quality } : {}),
			...(assessment.verificationScope ? { verificationScope: assessment.verificationScope } : {}),
		});
	} catch {
		// Audit must never break the hot path; a failed ledger write is silent.
	}
}
