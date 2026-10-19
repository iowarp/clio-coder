import type { WorkerPermissionMode } from "../../core/defaults.js";
import { ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { turnDelegatesTool, workerTurnConstraints } from "../../core/turn-constraints.js";
import type { ActionClass, Classification } from "../safety/action-classifier.js";
import { evaluateAdmission } from "../safety/admission.js";
import type { AutonomyLevel } from "../safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../safety/contract.js";
import { commandInvokesGit, type GitHookDriftGuard, type GitHookDriftReport } from "../safety/hook-drift.js";
import type { SafetyJudgeOutcome, SafetyJudgeSeat } from "../safety/safety-judge.js";
import type { GrantRecord } from "./grant-broker.js";

/**
 * How the main agent's approval of one worker ask is admitted (Phase D,
 * operator decisions Q2 and Q3).
 *
 * - Main at yolo may grant an ordinary autonomy ask when the worker effect,
 *   evaluated as the main agent's own call, is inside the operator's
 *   delegation ceiling and admitted at yolo. The worker still re-admits the
 *   call under its unchanged permit before it runs.
 * - Main at any other level, attended: the approval becomes the main agent's
 *   ask to the operator, who decides with the main request as provenance.
 * - Headless (no operator surface) below yolo: denied at once.
 * - Operator-authority asks, hard blocks, and effects the parent cannot
 *   evaluate are never main-grantable.
 */
export type MainGrantVerdict =
	| { kind: "grant" }
	| { kind: "ask-operator"; reason: string }
	| { kind: "deny"; reason: string };

export interface MainGrantInput {
	record: GrantRecord;
	autonomy: AutonomyLevel;
	/** True when an operator surface in this process answers forwarded worker asks. */
	attended: boolean;
	safety: Pick<SafetyContract, "evaluate">;
	/** The main turn's host constraints; the delegation ceiling is `delegatedTools ?? allowedTools`. */
	turnConstraints?: TurnConstraints;
}

/** Argument keys whose value decides admission; a digested value there cannot be evaluated. */
const DECIDING_ARGUMENT_KEYS = ["command", "path", "file_path", "cwd", "url", "paths", "op", "args", "argv", "script"];

function effectEvaluable(record: GrantRecord): boolean {
	const effect = record.effect;
	if (effect === null) return false;
	// A gateway call is a wrapper whose effect only the worker's own projection
	// knows; judged as the bare wrapper here it would read as harmless.
	if (effect.tool === ToolNames.Gateway) return false;
	for (const key of DECIDING_ARGUMENT_KEYS) {
		const value = effect.args[key];
		if (value !== null && typeof value === "object" && !Array.isArray(value) && "$sha256" in value) return false;
	}
	return true;
}

function inPermit(record: GrantRecord, tool: string): boolean {
	return record.permitTools.includes(tool);
}

export function evaluateMainGrant(input: MainGrantInput): MainGrantVerdict {
	const { record, autonomy, attended } = input;
	const refuse = (reason: string): MainGrantVerdict =>
		attended ? { kind: "ask-operator", reason } : { kind: "deny", reason };
	if (record.approvalAuthority !== "main") {
		return refuse(`${record.tool} raised an operator-authority ask, which only the operator can approve`);
	}
	const effect = record.effect;
	if (effect === null || !effectEvaluable(record)) {
		return refuse(`the ${record.tool} call is too large for the main agent to evaluate`);
	}
	if (!inPermit(record, effect.tool)) {
		return { kind: "deny", reason: `${effect.tool} is outside the worker's permit` };
	}
	if (!turnDelegatesTool(input.turnConstraints, effect.tool)) {
		return { kind: "deny", reason: `${effect.tool} is outside the operator's delegation ceiling for this turn` };
	}
	if (autonomy !== "yolo") {
		return attended
			? { kind: "ask-operator", reason: `the main agent runs at autonomy ${autonomy}, so the operator decides` }
			: {
					kind: "deny",
					reason: `the main agent runs at autonomy ${autonomy} with no operator to ask; only --autonomy yolo lets it grant worker asks`,
				};
	}
	const admission = evaluateAdmission({
		principal: "main",
		effects: [{ tool: effect.tool, args: effect.args }],
		cwd: record.cwd,
		safety: input.safety,
		autonomy: "yolo",
		...(input.turnConstraints !== undefined
			? { constraints: { turnConstraints: workerTurnConstraints(input.turnConstraints) } }
			: {}),
	});
	if (admission.kind === "deny") return { kind: "deny", reason: admission.reason };
	if (admission.kind === "ask") return refuse(`the main agent's own admission asks: ${admission.reason}`);
	return { kind: "grant" };
}

/**
 * The permit mode a dispatch runs `judge` as. The judge answers a worker only
 * where its answer is in force and can reach the worker: the main session at
 * autonomy default with safety.judge on, a dispatch bundle seated in the
 * process that holds the judge, and a runtime that parks a call for a bound
 * grant. Anywhere else the run gets the deny permit, so a yolo worker keeps
 * its inherited permit unchanged and no dispatch is refused for a route the
 * operator never chose.
 */
export function effectiveWorkerPermissionMode(input: {
	mode: WorkerPermissionMode;
	autonomy: AutonomyLevel;
	judgeEnabled: boolean;
	/** True when this dispatch bundle has the main session's judge seat. */
	judgeSeated: boolean;
	/** True when the runtime parks a call for a grant bound to its attempt (native workers). */
	boundGrants: boolean;
}): WorkerPermissionMode {
	if (input.mode !== "judge") return input.mode;
	return input.judgeSeated && input.judgeEnabled && input.boundGrants && input.autonomy === "default" ? "judge" : "deny";
}

export type JudgedGrantVerdict =
	| { kind: "grant"; reason: string }
	| { kind: "deny"; reason: string }
	/** Git hooks changed since the operator's baseline: only the operator answers, and an allow accepts `drift`. */
	| { kind: "ask-operator"; reason: string; drift: GitHookDriftReport };

export interface JudgedGrantInput {
	record: GrantRecord;
	/** The main session's live autonomy when the ask arrives. */
	autonomy: AutonomyLevel;
	safety: Pick<SafetyContract, "evaluate" | "classify">;
	/** The main session's judge seat; undefined when this process holds none. */
	judge: SafetyJudgeSeat | undefined;
	/** The dispatching turn's host constraints; the delegation ceiling is `delegatedTools ?? allowedTools`. */
	turnConstraints?: TurnConstraints;
	signal?: AbortSignal;
	/** The main session's git hook drift guard; a worker git call after drift is the operator's to answer. */
	hookDrift?: Pick<GitHookDriftGuard, "check">;
}

/** Whether a worker effect runs git: a typed add or commit, a bash command naming git, or a script. */
function effectRunsGit(effect: { tool: string; args: Record<string, unknown> }): boolean {
	if (effect.tool === ToolNames.Git) {
		const op = effect.args.op ?? effect.args.mode ?? effect.args.action;
		return op === "add" || op === "commit";
	}
	if (effect.tool === ToolNames.RunScript) return true;
	const command = effect.args.command;
	return effect.tool === ToolNames.Bash && typeof command === "string" && commandInvokesGit(command);
}

/**
 * The orchestrator's answer to a worker ask under fleet.permissions.mode=judge.
 * Only a main-authority ask is judged; an operator rail is the operator's.
 * The same deterministic refusals as a main grant come first. At yolo the
 * worker inherits the main session's mode and the main agent's own yolo
 * admission decides, as under `main`. At default the main session's safety
 * judge reviews the call with the worker's arguments and Clio's own features,
 * never the dispatch task or the worker's transcript, which a model wrote. An
 * allow grants the call once, inside the worker's permit and OS sandbox; a
 * block, no verdict, an escalated judge or a judge that is off denies it.
 */
export async function evaluateJudgedGrant(input: JudgedGrantInput): Promise<JudgedGrantVerdict> {
	const { record } = input;
	const deny = (reason: string): JudgedGrantVerdict => ({ kind: "deny", reason });
	if (record.approvalAuthority !== "main") {
		return deny(`${record.tool} raised an operator-authority ask, which only the operator can approve`);
	}
	const effect = record.effect;
	if (effect === null || !effectEvaluable(record)) {
		return deny(`the ${record.tool} call is too large for the safety judge to read`);
	}
	if (!inPermit(record, effect.tool)) return deny(`${effect.tool} is outside the worker's permit`);
	if (!turnDelegatesTool(input.turnConstraints, effect.tool)) {
		return deny(`${effect.tool} is outside the operator's delegation ceiling for this turn`);
	}
	if (input.autonomy === "yolo") {
		const verdict = evaluateMainGrant({
			record,
			autonomy: "yolo",
			attended: false,
			safety: input.safety,
			...(input.turnConstraints !== undefined ? { turnConstraints: input.turnConstraints } : {}),
		});
		return verdict.kind === "grant"
			? { kind: "grant", reason: "granted under the main session's yolo" }
			: deny(verdict.reason);
	}
	// A hook changed since the operator's baseline runs on this git call,
	// inside the worker's sandbox when it has one and outside it when it has
	// none, so the judge does not decide it.
	if (input.hookDrift !== undefined && effectRunsGit(effect)) {
		const drift = input.hookDrift.check();
		if (drift !== null) {
			return {
				kind: "ask-operator",
				reason: `${drift.summary}; only the operator can approve this worker's git call`,
				drift,
			};
		}
	}
	if (input.judge === undefined) return deny("no safety judge answers worker asks in this process");
	const call = { tool: effect.tool, args: effect.args };
	let classification: Classification;
	try {
		classification = input.safety.classify(call);
	} catch {
		// The worker's own class still names the call; the judge reads it as a feature only.
		classification = { actionClass: record.actionClass as ActionClass, reasons: [...record.reasons] };
	}
	// Clio's features of the ask, computed here or by the worker's admission;
	// nothing a model wrote besides the call itself.
	const decision: SafetyDecision = {
		kind: "ask",
		classification,
		rejection: { short: record.summary, detail: record.reasons.join("\n"), hints: [] },
	};
	let outcome: SafetyJudgeOutcome;
	try {
		const pending = input.judge.review({
			tool: effect.tool,
			args: effect.args,
			decision,
			source: "autonomy",
			approvalAuthority: "main",
			...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
			...(input.signal !== undefined ? { signal: input.signal } : {}),
			worker: { runId: record.runId, agentId: record.agentId },
		});
		outcome = pending instanceof Promise ? await pending : pending;
	} catch (err) {
		return deny(`the safety judge failed (${err instanceof Error ? err.message : String(err)}), so the ask is denied`);
	}
	switch (outcome.kind) {
		case "allow":
			return { kind: "grant", reason: `the safety judge allowed it (rule ${outcome.rule}): ${sentence(outcome.reason)}` };
		case "block":
			return deny(`the safety judge blocked it (rule ${outcome.rule}): ${sentence(outcome.reason)}`);
		case "skip":
			return deny("the safety judge is off, so the ask is denied");
		case "park":
			return deny(
				outcome.cause === "escalated"
					? "the safety judge blocked repeatedly this session, so worker asks are denied until the operator approves a call"
					: `the safety judge gave no verdict (${outcome.cause}), so the ask is denied`,
			);
	}
}

/** The judge's one sentence without its final stop, so it reads inside the worker's denial line. */
function sentence(text: string): string {
	return text.trim().replace(/[.\s]+$/u, "");
}
