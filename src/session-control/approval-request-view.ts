import type { ActionClass } from "../domains/safety/action-classifier.js";
import type { AutonomyExposure } from "../domains/safety/autonomy.js";

/**
 * Facts about a parked mutation that may cross every process boundary: what
 * kind it is, how big it is, and the digest that binds a preview to it. No part
 * of the mutation text appears here, which is why this is the shape the
 * approval view, the transcript row, and any notice may carry.
 */
export interface MutationFacts {
	kind: "write" | "edit";
	/** Bytes of proposed content (write), or of the replacement text across every edit. */
	bytes: number;
	/** Replacements in the edit list. One for a write. */
	replacements: number;
	/** Truncated SHA-256 over the exact call arguments this decision applies to. */
	digest: string;
}

export interface ApprovalRequestView {
	requestId: string;
	tool: string;
	actionClass: ActionClass;
	axis: { kind: "net"; ruleId: string } | { kind: "autonomy"; level: string };
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string; endsWithTurn?: boolean };
	/** Admission-normalized exposure. Caller prose never supplies presentation fields. */
	exposure?: AutonomyExposure;
	reason: string;
	/**
	 * The safety-net rule's own reason text, set for a net-axis ask so the card can say what
	 * triggered it. `reason` is the raw rejection short and stays off the card.
	 */
	netReason?: string;
	/**
	 * What a bash command would do, one sentence per step, from the pure
	 * classifier in `command-consequence`. Text for the card only: admission never
	 * reads it and no ask or block depends on it.
	 */
	consequence?: ReadonlyArray<string>;
	/**
	 * Typed, sanitized multi-line artifact that this one approval authorizes: a
	 * dispatch plan, or the exact settings diff a `configure_clio` apply saves.
	 */
	artifact?: { kind: "dispatch-plan" | "settings-change"; text: string };
	/**
	 * One-line preview of the call's allowlisted object fields. The operator is
	 * deciding whether to allow this exact call, so the overlay must show what
	 * the call will touch, not just the tool name. Unlisted fields appear only as
	 * type-and-size summaries. Main-agent asks derive it from the parked call's
	 * args; worker escalations carry it in the escalation payload. Absent only
	 * when nothing meaningful is derivable.
	 */
	target?: string;
	/**
	 * Size and digest facts for a parked `write` or `edit`, and nothing else
	 * about it. The mutation text is deliberately absent: this view is what
	 * reaches the transcript row, the parked notice, and the approval-state
	 * event, so anything on it has already left the overlay. The text itself is
	 * held by the inspector the overlay opener is given (issue #254).
	 */
	mutation?: MutationFacts;
	queueDepth?: number;
	/**
	 * The newest message the operator typed on the active path, sanitized and
	 * bounded; `via` names the machine origin of the current turn when it has
	 * one. Never model-authored text: a job's prompt or follow-up and a yolo
	 * continuation are not the operator's (T-01).
	 */
	task?: { text: string; via?: string };
	/**
	 * The build that answered the System One gate, set only on the card the gate
	 * raised. The card and the transcript rows name it so an operator can tell
	 * which build's judgment they overrode.
	 */
	/**
	 * A worker ask routed through the main agent (Phase D): who may discharge
	 * it, and whether the main agent asked for it. The card names both so the
	 * operator knows whose request they are answering.
	 */
	workerGrant?: {
		authority: "main" | "operator";
		forwardedByMain: boolean;
		/** The safety judge held this request and passed it on: changed git hooks are the person's call. */
		fromJudge?: boolean;
	};
	/** What an unanswered worker ask becomes, so the card can say so before it happens. */
	workerFallback?: "deny" | "fail";
}
