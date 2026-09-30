import { isAbsolute } from "node:path";
import type { PendingSkillToolPolicy, SkillToolSurfaceViolation } from "../../core/skill-activation.js";
import { evaluateSkillToolSurface } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { turnAllowsTool } from "../../core/turn-constraints.js";
import type { ActionClass, ClassifierCall } from "./action-classifier.js";
import type { AutonomyExposure, AutonomyLevel } from "./autonomy.js";
import { autonomyAskRejection, DEFAULT_AUTONOMY_LEVEL, mapAutonomy } from "./autonomy.js";
import { autonomyCallInputs } from "./autonomy-inputs.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";

/**
 * The one admission evaluator (Codex review, "One shared admission
 * evaluator"). Native registry admission, the Claude SDK bridge and the ACP
 * mediator all decide a call here; each adapter only translates its transport
 * into an {@link AdmissionInput} and its answer back out. Parking, prompting,
 * audit rows and wire events stay in the adapters.
 *
 * Evaluation order, each step dominating every later one:
 *   1. the safety net over every effect: any hard block wins;
 *   2. hard permit limits: read-only, tool scope, skill surface, git_destructive;
 *   3. confirmation obligations the net or the tool raises;
 *   4. autonomy (main) or the worker's standing allowance;
 *   5. a matching authorization, which clears only what it is allowed to clear.
 */

export type AdmissionPrincipal = "main" | "worker";

/** Hard limits the run carries, independent of autonomy. */
export interface AdmissionConstraints {
	/** Dispatch-owned read-only restriction. */
	readOnly?: boolean;
	/** Host-owned task scope. */
	turnConstraints?: TurnConstraints;
	/** The tool surface this run was admitted to, when narrower than the adapter's inventory. */
	allowedTools?: ReadonlyArray<string> | ReadonlySet<string>;
	/** Skill-declared tool narrowing armed for this session or run. */
	pendingSkillPolicy?: PendingSkillToolPolicy;
}

/** A structured one-shot authorization for exactly one parked call. */
export interface AdmissionAuthorization {
	/** Action class the approver saw; a different class is not covered. */
	actionClass: ActionClass;
}

export interface AdmissionInput {
	principal: AdmissionPrincipal;
	/**
	 * Executable effects of the call, each judged as the direct call it stands
	 * for. Must be non-empty: a call with no evaluable effect fails closed.
	 */
	effects: ReadonlyArray<ClassifierCall>;
	/**
	 * The public capability, when the effects are a trusted projection of it.
	 * Its own hard blocks and confirmation rails apply; autonomy maps the
	 * effects, which is what actually runs.
	 */
	capability?: ClassifierCall;
	/**
	 * Explicit execution cwd for command effects that do not name one. Never
	 * derived from the evaluating process; absent means the policy engine's own
	 * bound cwd.
	 */
	cwd?: string;
	safety: Pick<SafetyContract, "evaluate">;
	/** Operator autonomy. Read for the main principal only; workers never inherit it. */
	autonomy?: AutonomyLevel;
	constraints?: AdmissionConstraints;
	/** A tool-level confirmation rail required at every autonomy level. */
	confirmationRuleId?: string;
	authorization?: AdmissionAuthorization;
	/** Adapter translation of each net decision (a registered tool's base action class). */
	normalize?: (decision: SafetyDecision) => SafetyDecision;
	/** Autonomy inputs a tool declares for itself: ask_user exposure, plan-scale dispatch. */
	autonomyExtra?: { exposure?: AutonomyExposure; dispatchPlanScale?: boolean };
}

export type AdmissionDenyCode =
	| "safety_net"
	| "context"
	| "no_effects"
	| "read_only"
	| "tool_scope"
	| "skills_disabled"
	| "skill_surface"
	| "git_destructive";

export type AdmissionAskSource = "safety-net" | "tool-confirmation" | "autonomy";

export type AdmissionDisposition =
	| {
			kind: "allow";
			/** The net decision of the call that runs. */
			decision: SafetyDecision;
			/** True when a matching authorization, not policy, admitted the call. */
			authorized: boolean;
	  }
	| {
			kind: "deny";
			code: AdmissionDenyCode;
			reason: string;
			/** Hard denials never park and no authorization clears them. */
			hard: true;
			/** The net decision the denial was judged against. */
			decision: SafetyDecision;
			skillViolation?: SkillToolSurfaceViolation;
	  }
	| {
			kind: "ask";
			source: AdmissionAskSource;
			reason: string;
			/** The parked decision: the net rail, or an autonomy ask naming the level. */
			decision: SafetyDecision;
			/** The net decision behind an autonomy ask. */
			netDecision: SafetyDecision;
			level: AutonomyLevel;
			exposure: AutonomyExposure;
			readOutsideWorkspace: boolean;
	  };

function deny(
	code: AdmissionDenyCode,
	reason: string,
	decision: SafetyDecision,
	extra: { skillViolation?: SkillToolSurfaceViolation } = {},
): AdmissionDisposition {
	return { kind: "deny", code, reason, hard: true, decision, ...extra };
}

function syntheticBlock(reason: string): SafetyDecision {
	return {
		kind: "block",
		classification: { actionClass: "unknown", reasons: [reason] },
		rejection: { short: reason, detail: reason, hints: [] },
	};
}

function withCwd(call: ClassifierCall, cwd: string | undefined): ClassifierCall {
	if (cwd === undefined || call.tool !== ToolNames.Bash) return call;
	const args = call.args ?? {};
	if (typeof args.cwd === "string" && args.cwd.length > 0) return call;
	return { ...call, args: { ...args, cwd } };
}

function toolInScope(allowed: ReadonlyArray<string> | ReadonlySet<string>, tool: string): boolean {
	return Array.isArray(allowed) ? allowed.includes(tool) : (allowed as ReadonlySet<string>).has(tool);
}

function activatesSkill(call: ClassifierCall): boolean {
	return call.tool === ToolNames.Context && call.args?.scope === "skills" && typeof call.args?.name === "string";
}

/** Decide one call. Pure apart from the policy engine's own audit side effects. */
export function evaluateAdmission(input: AdmissionInput): AdmissionDisposition {
	const principal = input.principal;
	const level: AutonomyLevel =
		principal === "main" ? (input.autonomy ?? DEFAULT_AUTONOMY_LEVEL) : DEFAULT_AUTONOMY_LEVEL;
	const posture = input.authorization !== undefined ? "confirmed" : level === "yolo" ? "yolo" : undefined;
	const normalize = input.normalize ?? ((decision: SafetyDecision) => decision);
	const evaluate = (call: ClassifierCall): SafetyDecision =>
		normalize(input.safety.evaluate(withCwd(call, input.cwd), posture));
	if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
		const reason = `admission cwd must be absolute: ${input.cwd}`;
		return deny("context", reason, syntheticBlock(reason));
	}

	// Step 1: the safety net over the capability and every effect. A hard block
	// anywhere dominates an ask or allow elsewhere, in any order.
	const capabilityDecision = input.capability !== undefined ? evaluate(input.capability) : undefined;
	if (capabilityDecision?.kind === "block") {
		return deny("safety_net", capabilityDecision.rejection.short, capabilityDecision);
	}
	const effectDecisions: SafetyDecision[] = [];
	for (const effect of input.effects) {
		const decision = evaluate(effect);
		if (decision.kind === "block") return deny("safety_net", decision.rejection.short, decision);
		effectDecisions.push(decision);
	}
	const primary = effectDecisions[0];
	if (primary === undefined) {
		const reason = "call has no policy-evaluable effects";
		return deny("no_effects", reason, syntheticBlock(reason));
	}
	const netAsk = capabilityDecision?.kind === "ask" ? capabilityDecision : effectDecisions.find((d) => d.kind === "ask");
	const decision = netAsk ?? primary;
	const call = input.capability ?? input.effects[0] ?? { tool: "unknown" };
	const actionClass = decision.classification.actionClass;
	const readOutside = effectDecisions.some((d) => d.policy?.readScope === "outside-workspace");

	// Step 2: hard permit limits. None of them parks and no approval clears them.
	const constraints = input.constraints ?? {};
	if (
		constraints.readOnly === true &&
		(effectDecisions.some((d) => d.classification.actionClass !== "read") ||
			input.confirmationRuleId !== undefined ||
			readOutside ||
			netAsk !== undefined ||
			activatesSkill(call))
	) {
		return deny("read_only", `${call.tool} denied: this run is read-only`, decision);
	}
	const outsideTurn = !turnAllowsTool(constraints.turnConstraints, call.tool);
	const outsideRun = constraints.allowedTools !== undefined && !toolInScope(constraints.allowedTools, call.tool);
	if (outsideTurn || outsideRun) {
		return deny("tool_scope", `${call.tool} is outside this task's admitted tool scope.`, decision);
	}
	if (
		constraints.turnConstraints?.skills === "disabled" &&
		call.tool === ToolNames.Context &&
		call.args?.scope === "skills"
	) {
		return deny("skills_disabled", "Skills are disabled for this task.", decision);
	}
	const surfaceViolation = evaluateSkillToolSurface(constraints.pendingSkillPolicy, call.tool);
	if (surfaceViolation) {
		return deny("skill_surface", `${call.tool} blocked: outside active skill tool surface`, decision, {
			skillViolation: surfaceViolation,
		});
	}

	const authorized = input.authorization !== undefined && input.authorization.actionClass === actionClass;

	// Step 3: confirmation obligations raised by the net or by the tool itself.
	if (netAsk !== undefined) {
		if (authorized) return { kind: "allow", decision, authorized: true };
		return {
			kind: "ask",
			source: "safety-net",
			reason: netAsk.kind === "ask" ? netAsk.rejection.short : "confirmation required",
			decision: netAsk,
			netDecision: netAsk,
			level,
			exposure: "local",
			readOutsideWorkspace: readOutside,
		};
	}
	if (input.confirmationRuleId !== undefined && !authorized) {
		const ask: SafetyDecision = {
			kind: "ask",
			classification: decision.classification,
			confirmationRuleId: input.confirmationRuleId,
			rejection: {
				short: `${call.tool} needs operator confirmation`,
				detail: `${call.tool} changes a Slurm allocation and requires approval before it reaches the scheduler.`,
				hints: ["Approving resumes only this call."],
			},
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
		};
		return {
			kind: "ask",
			source: "tool-confirmation",
			reason: ask.rejection.short,
			decision: ask,
			netDecision: decision,
			level,
			exposure: "local",
			readOutsideWorkspace: readOutside,
		};
	}
	// An operator-confirmed rail (an authored git ask rule included) admits the
	// exact call it approved without re-entering the autonomy mapping.
	if (authorized) return { kind: "allow", decision, authorized: true };

	// Step 2, continued: a git_destructive class that reached here was not
	// admitted by any rail and stays hard-blocked on every runtime.
	const destructive = effectDecisions.find((d) => d.classification.actionClass === "git_destructive");
	if (destructive !== undefined) {
		return deny("git_destructive", "action git_destructive is hard-blocked", destructive);
	}

	// Step 4: autonomy for the main agent, the default standing allowance for a
	// worker. Every effect must be admitted; the first that is not decides.
	for (let index = 0; index < effectDecisions.length; index += 1) {
		const effectDecision = effectDecisions[index] as SafetyDecision;
		const effect = input.effects[index] as ClassifierCall;
		const inputs = autonomyCallInputs(effect, effectDecision, input.autonomyExtra ?? {});
		const disposition = mapAutonomy(level, effectDecision.classification.actionClass, inputs.options);
		if (disposition === "allow") continue;
		const ask: SafetyDecision = {
			kind: "ask",
			classification: effectDecision.classification,
			rejection: autonomyAskRejection(
				level,
				call.tool,
				effectDecision.classification.actionClass,
				inputs.exposure,
				inputs.readOutsideWorkspace,
			),
			...(effectDecision.policy !== undefined ? { policy: effectDecision.policy } : {}),
		};
		return {
			kind: "ask",
			source: "autonomy",
			reason: ask.rejection.short,
			decision: ask,
			netDecision: effectDecision,
			level,
			exposure: inputs.exposure,
			readOutsideWorkspace: inputs.readOutsideWorkspace,
		};
	}
	return { kind: "allow", decision: primary, authorized: false };
}
