import type { ActionClass } from "./action-classifier.js";
import type { AutonomyExposure } from "./autonomy.js";

/** Closed consequence categories used only to explain an already-made decision request. */
export const DECISION_TIERS = ["conversation", "workspace", "outward", "safety-net", "system", "worker"] as const;

export type DecisionTier = (typeof DECISION_TIERS)[number];
export type DecisionSemanticToken = "accent" | "action" | "warning";
export type DecisionRequestKind = "question" | "permission";
export type DecisionAffectedScope = "conversation" | "workspace" | "outward" | "system";
export type DecisionReversibility = "reversible" | "limited" | "unknown";
export type DecisionAuthorityEffect = "records-answer" | "grants-once";
export type DecisionActionId = "record-answer" | "cancel" | "approve-once" | "deny" | "stop";

export type DecisionAxis =
	| { kind: "answer" }
	| { kind: "autonomy"; level: string }
	| { kind: "safety-net"; ruleId: string };

export type DecisionOrigin = { kind: "main" } | { kind: "worker"; agentId: string; runId: string };

/**
 * Facts the host has already authenticated or derived from enforced policy.
 * No model-authored title, question, reason, summary, or option label belongs
 * here, so prose has no path to the tier selection.
 */
export interface TrustedDecisionFacts {
	requestKind: DecisionRequestKind;
	axis: DecisionAxis;
	exposure: AutonomyExposure;
	affectedScope: DecisionAffectedScope;
	reversibility: DecisionReversibility;
	origin: DecisionOrigin;
	authorityEffect: DecisionAuthorityEffect;
	tool?: string;
	actionClass?: ActionClass;
}

export interface DecisionPresentationAction {
	id: DecisionActionId;
	label: string;
	consequence: string;
}

/**
 * This projection contains display data only. Registry admission and interview
 * settlement never consume it, and it contains no allow, deny, or autonomy
 * disposition that an execution layer could mistake for authority.
 */
export interface DecisionPresentation {
	tier: DecisionTier;
	tierLabel: string;
	title: string;
	semanticToken: DecisionSemanticToken;
	authorizationCopy: string;
	consequenceCopy: string;
	reversibilityCopy: string;
	requestedByCopy: string;
	requiredActions: ReadonlyArray<DecisionPresentationAction>;
}

const ACTION_CLASSES = new Set<ActionClass>([
	"read",
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
	"unknown",
]);

/** Unknown or malformed action classes classify conservatively as unknown. */
export function decisionActionClass(value: unknown): ActionClass {
	return typeof value === "string" && ACTION_CLASSES.has(value as ActionClass) ? (value as ActionClass) : "unknown";
}

function actionConsequence(actionClass: ActionClass): {
	affectedScope: DecisionAffectedScope;
	reversibility: DecisionReversibility;
} {
	switch (actionClass) {
		case "read":
			return { affectedScope: "workspace", reversibility: "reversible" };
		case "write":
			return { affectedScope: "workspace", reversibility: "reversible" };
		case "execute":
		case "dispatch":
			return { affectedScope: "workspace", reversibility: "limited" };
		case "system_modify":
		case "git_destructive":
		case "unknown":
			return { affectedScope: "system", reversibility: "unknown" };
	}
}

export function decisionFactsForPermission(input: {
	tool: string;
	actionClass: ActionClass;
	axis: Exclude<DecisionAxis, { kind: "answer" }>;
	origin: DecisionOrigin;
	exposure?: AutonomyExposure;
}): TrustedDecisionFacts {
	const exposure = input.exposure ?? "local";
	const consequence = actionConsequence(input.actionClass);
	return {
		requestKind: "permission",
		axis: input.axis,
		exposure,
		affectedScope: exposure === "outward" ? "outward" : consequence.affectedScope,
		reversibility: exposure === "outward" ? "limited" : consequence.reversibility,
		origin: input.origin,
		authorityEffect: "grants-once",
		tool: input.tool,
		actionClass: input.actionClass,
	};
}

export function decisionFactsForAnswer(exposure: AutonomyExposure): TrustedDecisionFacts {
	return {
		requestKind: "question",
		axis: { kind: "answer" },
		exposure,
		affectedScope: exposure === "outward" ? "outward" : "conversation",
		reversibility: exposure === "outward" ? "limited" : "reversible",
		origin: { kind: "main" },
		authorityEffect: "records-answer",
	};
}

function classifyTier(facts: TrustedDecisionFacts): DecisionTier {
	if (facts.origin.kind === "worker") return "worker";
	if (facts.affectedScope === "system") return "system";
	if (facts.exposure === "outward" || facts.affectedScope === "outward") return "outward";
	if (facts.axis.kind === "safety-net") return "safety-net";
	if (facts.authorityEffect === "grants-once") return "workspace";
	return "conversation";
}

function tierIdentity(tier: DecisionTier): {
	tierLabel: string;
	title: string;
	semanticToken: DecisionSemanticToken;
} {
	switch (tier) {
		case "conversation":
			return { tierLabel: "Conversational answer", title: "Answer a question", semanticToken: "accent" };
		case "workspace":
			return { tierLabel: "Workspace authority", title: "Approve workspace action", semanticToken: "action" };
		case "outward":
			return { tierLabel: "Outward consequence", title: "Confirm outward consequence", semanticToken: "warning" };
		case "safety-net":
			return { tierLabel: "Safety-net confirmation", title: "Safety-net confirmation", semanticToken: "warning" };
		case "system":
			return { tierLabel: "System change", title: "Approve system change", semanticToken: "warning" };
		case "worker":
			return { tierLabel: "Worker escalation", title: "Worker needs approval", semanticToken: "action" };
	}
}

function requestedByCopy(facts: TrustedDecisionFacts): string {
	const requester =
		facts.origin.kind === "worker" ? `worker ${facts.origin.agentId} (run ${facts.origin.runId})` : "main agent";
	if (facts.axis.kind === "answer") return requester;
	if (facts.axis.kind === "safety-net") return `${requester} through safety-net rail ${facts.axis.ruleId}`;
	return `${requester} through autonomy level (${facts.axis.level})`;
}

function authorizationCopy(facts: TrustedDecisionFacts): string {
	if (facts.authorityEffect === "records-answer") {
		return facts.exposure === "outward"
			? "Your response records an answer about an outward step. It does not publish or send anything by itself."
			: "Your response records an answer for this interview. It grants no tool authority.";
	}
	const tool = facts.tool ?? "the presented tool";
	const actionClass = facts.actionClass ?? "unknown";
	if (tool === "ask_user" && facts.exposure === "outward") {
		return "Approval opens this one outward-decision interview. It does not publish or send anything by itself.";
	}
	return `Approval authorizes one ${actionClass} call to ${tool}. It does not change the autonomy level.`;
}

function consequenceCopy(facts: TrustedDecisionFacts, tier: DecisionTier): string {
	switch (tier) {
		case "conversation":
			return "The answer stays in this session's decision record.";
		case "workspace":
			return facts.actionClass === "read"
				? "The call reads within the workspace without mutating it."
				: "The call can affect files or processes inside the workspace.";
		case "outward":
			return "The resulting step can reach people or systems outside the workspace.";
		case "safety-net":
			return "An always-on safety-net rail requires a one-shot operator decision before this call can run.";
		case "system":
			return "The call can change state outside the workspace or state the classifier cannot safely bound.";
		case "worker":
			return "A dispatched worker is parked. Your answer returns only to that run's exact request.";
	}
}

function reversibilityCopy(facts: TrustedDecisionFacts): string {
	if (facts.requestKind === "question") {
		return facts.reversibility === "reversible"
			? "Reversible: yes. The recorded answer can be superseded later."
			: "Reversible: not guaranteed. An outward step that later uses this answer may have lasting effects.";
	}
	if (facts.actionClass === "read" && facts.reversibility === "reversible") {
		return "Reversible: yes. This call does not mutate the workspace.";
	}
	switch (facts.reversibility) {
		case "reversible":
			return "Reversible: yes. Workspace changes can be reviewed and reverted.";
		case "limited":
			return "Reversible: not guaranteed. Effects that already ran or reached an outward system may remain.";
		case "unknown":
			return "Reversible: unknown. Treat the effect as not safely reversible.";
	}
}

function requiredActions(facts: TrustedDecisionFacts, tier: DecisionTier): ReadonlyArray<DecisionPresentationAction> {
	if (facts.authorityEffect === "records-answer") {
		return [
			{
				id: "record-answer",
				label: facts.exposure === "outward" ? "Record outward answer" : "Record answer",
				consequence: "Records the selected or typed answer without granting tool authority.",
			},
			{ id: "cancel", label: "Cancel", consequence: "Closes the interview without recording an answer for this round." },
		];
	}
	const approveLabel =
		tier === "system"
			? "Approve system change once"
			: tier === "safety-net"
				? "Approve guarded action once"
				: tier === "worker"
					? "Approve worker request once"
					: tier === "outward"
						? "Approve outward decision once"
						: "Approve workspace action once";
	const stopConsequence =
		facts.origin.kind === "worker"
			? "Denies this worker request and ends the active main-agent turn. Other worker requests retain their timeout policy."
			: "Denies every parked request from this turn and ends the run.";
	return [
		{
			id: "approve-once",
			label: approveLabel,
			consequence: "Runs only the presented request and does not change the autonomy level.",
		},
		{ id: "deny", label: "Deny this request", consequence: "Denies only the presented request and advances the queue." },
		{ id: "stop", label: "Deny and stop", consequence: stopConsequence },
	];
}

/** Pure presentation classifier. It performs no I/O and has no execution authority. */
export function classifyDecisionPresentation(facts: TrustedDecisionFacts): DecisionPresentation {
	const tier = classifyTier(facts);
	return {
		tier,
		...tierIdentity(tier),
		authorizationCopy: authorizationCopy(facts),
		consequenceCopy: consequenceCopy(facts, tier),
		reversibilityCopy: reversibilityCopy(facts),
		requestedByCopy: requestedByCopy(facts),
		requiredActions: requiredActions(facts, tier),
	};
}
