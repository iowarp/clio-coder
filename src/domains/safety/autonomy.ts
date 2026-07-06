import type { ActionClass } from "./action-classifier.js";
import type { RejectionMessage } from "./rejection-feedback.js";

/**
 * The autonomy axis (sd-01 §2.2/§2.3). An ordered operator-set dial that
 * controls exactly one thing: which action classes trigger the approval flow
 * versus run immediately versus auto-deny. It runs AFTER the safety net: a
 * net `block` is final at every level and a net `confirm` always asks; this
 * mapping applies only to level-dependent rows after the net passed.
 * Level-independent rails such as system_modify belong to the policy engine.
 *
 * The mapping is pure. The registry (orchestrator and worker) and the ACP
 * delegation mediator are the only consumers; each resolves an `ask`
 * disposition through its own approvals context (interactive park, headless
 * deterministic deny, workers.onPermission, delegation non-stall deny).
 */

export const AUTONOMY_LEVELS = ["read-only", "suggest", "auto-edit", "full-auto"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "auto-edit";

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return typeof value === "string" && (AUTONOMY_LEVELS as ReadonlyArray<string>).includes(value);
}

export type AutonomyDisposition = "allow" | "ask" | "deny";

export interface AutonomyMappingOptions {
	/**
	 * Execute-class calls only: true when the command is in the no-prompt set
	 * (built-in allowlist, project policy command) or is a typed execution tool
	 * (verify). Raw bash outside that set is unrecognized.
	 */
	executeRecognized?: boolean;
}

/**
 * The §2.3 level-dependent matrix. `git_destructive` never reaches this
 * mapping in practice (the safety net blocks it first); it maps to deny
 * defensively.
 */
export function mapAutonomy(
	level: AutonomyLevel,
	actionClass: ActionClass,
	options: AutonomyMappingOptions = {},
): AutonomyDisposition {
	if (actionClass === "read") return "allow";
	if (actionClass === "git_destructive") return "deny";
	if (level === "read-only") return "deny";
	if (level === "suggest") return "ask";
	// auto-edit and full-auto from here.
	switch (actionClass) {
		case "write":
		case "dispatch":
			return "allow";
		case "execute": {
			if (options.executeRecognized !== false) return "allow";
			return level === "full-auto" ? "allow" : "ask";
		}
		case "unknown":
			// Registered tools that classify as unknown are substituted to their
			// baseActionClass in the registry after safety.evaluate(). Keeping
			// unknown here prevents read-class domain tools from becoming a net
			// confirm rail before that substitution can happen.
			return "ask";
		default:
			return "ask";
	}
}

/**
 * Rejection text for autonomy `deny` dispositions. Only `read-only` produces
 * denies, so the message is the propose-instead contract from §2.3.
 */
export function autonomyDenyRejection(level: AutonomyLevel, tool: string, actionClass: ActionClass): RejectionMessage {
	return {
		short: `${tool} denied: autonomy level is ${level}`,
		detail:
			`Clio is at autonomy ${level}: ${actionClass} actions are denied without prompting. ` +
			"Describe the change you would make instead, so the operator can apply it or raise the autonomy level.",
		hints: ["Propose the exact edit or command as text.", "The operator can change the level in /settings."],
	};
}

/**
 * Rejection text for autonomy `ask` dispositions. Carried on the parked
 * decision so overlays and non-interactive deniers can explain which axis
 * asked (the level, not a safety-net rail).
 */
export function autonomyAskRejection(level: AutonomyLevel, tool: string, actionClass: ActionClass): RejectionMessage {
	return {
		short: `${tool} needs approval (${actionClass}) at autonomy ${level}`,
		detail:
			`Autonomy ${level} routes ${actionClass} actions through operator approval. ` +
			"The call is parked until the operator approves it once or cancels it.",
		hints: [
			"Approving resumes only this call.",
			"Recognized commands can be added to .clio/safety.yaml.",
			// The sanctioned pivots for a gated shell command: typed verification
			// and read-class observe tools run without approval at this level,
			// and models otherwise stall retrying denied bash for checks or
			// directory listings.
			...(actionClass === "execute"
				? [
						'A declared package.json check runs without approval through the verify tool: verify(check="<script>").',
						"Read-only inspection runs without approval through the ls, read, grep, and find tools.",
					]
				: []),
		],
	};
}
