import type { RouteCandidate, RouteDecisionV1 } from "./route-decision.js";
import type { RoutingPosture } from "./route-policy.js";

export type RoutingLocality = "local-only" | "prefer-local" | "any";
export type RoutingFailover = "none" | "approved";

/** Model-facing routing policy. Every numeric value is a hard bound, never a score. */
export interface RoutingIntent {
	posture: RoutingPosture;
	maxCostUsd: number | null;
	deadlineMs: number | null;
	minimumQuality: number | null;
	requiredCapabilities: ReadonlyArray<string>;
	locality: RoutingLocality;
	failover: RoutingFailover;
}

export interface RoutingPins {
	target?: string;
	model?: string;
	node?: string;
}

export type RoutingIntentResult = { ok: true; intent: RoutingIntent } | { ok: false; errors: ReadonlyArray<string> };

const KEYS = new Set([
	"posture",
	"maxCostUsd",
	"deadlineMs",
	"minimumQuality",
	"requiredCapabilities",
	"locality",
	"failover",
]);
const POSTURES = new Set<RoutingPosture>(["manual", "quality", "balanced", "latency", "economy"]);
const LOCALITIES = new Set<RoutingLocality>(["local-only", "prefer-local", "any"]);
const FAILOVERS = new Set<RoutingFailover>(["none", "approved"]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRoutingIntent(value: unknown): value is RoutingIntent {
	if (!record(value) || Object.keys(value).some((key) => !KEYS.has(key))) return false;
	return (
		typeof value.posture === "string" &&
		POSTURES.has(value.posture as RoutingPosture) &&
		(value.maxCostUsd === null ||
			(typeof value.maxCostUsd === "number" && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0)) &&
		(value.deadlineMs === null ||
			(typeof value.deadlineMs === "number" && Number.isInteger(value.deadlineMs) && value.deadlineMs > 0)) &&
		(value.minimumQuality === null ||
			(typeof value.minimumQuality === "number" && value.minimumQuality >= 0 && value.minimumQuality <= 1)) &&
		Array.isArray(value.requiredCapabilities) &&
		value.requiredCapabilities.every((entry) => typeof entry === "string" && entry.length > 0) &&
		typeof value.locality === "string" &&
		LOCALITIES.has(value.locality as RoutingLocality) &&
		typeof value.failover === "string" &&
		FAILOVERS.has(value.failover as RoutingFailover)
	);
}

/** Strictly parse routing intent and apply the shadow-only default. */
export function parseRoutingIntent(value: unknown, pins: RoutingPins = {}): RoutingIntentResult {
	const errors: string[] = [];
	if (value !== undefined && !record(value)) return { ok: false, errors: ["routing must be an object"] };
	const input = value === undefined ? {} : value;
	for (const key of Object.keys(input)) if (!KEYS.has(key)) errors.push(`routing unknown key: ${key}`);
	const pinned = pins.target !== undefined || pins.model !== undefined || pins.node !== undefined;
	const posture = input.posture ?? (pinned ? "manual" : "balanced");
	if (typeof posture !== "string" || !POSTURES.has(posture as RoutingPosture)) {
		errors.push("routing.posture must be one of: manual|quality|balanced|latency|economy");
	}
	if (pinned && posture !== "manual") errors.push("exact target, model, or node pins require routing.posture manual");
	const positive = (key: "maxCostUsd" | "deadlineMs"): number | null => {
		const candidate = input[key];
		if (candidate === undefined) return null;
		if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
			errors.push(`routing.${key} must be a finite number greater than zero`);
			return null;
		}
		if (key === "deadlineMs" && !Number.isInteger(candidate)) errors.push("routing.deadlineMs must be an integer");
		return candidate;
	};
	const maxCostUsd = positive("maxCostUsd");
	const deadlineMs = positive("deadlineMs");
	let minimumQuality: number | null = null;
	if (input.minimumQuality !== undefined) {
		if (
			typeof input.minimumQuality !== "number" ||
			!Number.isFinite(input.minimumQuality) ||
			input.minimumQuality < 0 ||
			input.minimumQuality > 1
		)
			errors.push("routing.minimumQuality must be between zero and one");
		else minimumQuality = input.minimumQuality;
	}
	const requiredCapabilities = input.requiredCapabilities ?? [];
	if (
		!Array.isArray(requiredCapabilities) ||
		requiredCapabilities.some((entry) => typeof entry !== "string" || entry.trim().length === 0) ||
		new Set(requiredCapabilities).size !== requiredCapabilities.length
	)
		errors.push("routing.requiredCapabilities must be an array of unique non-empty strings");
	const locality = input.locality ?? "any";
	if (typeof locality !== "string" || !LOCALITIES.has(locality as RoutingLocality)) {
		errors.push("routing.locality must be one of: local-only|prefer-local|any");
	}
	const failover = input.failover ?? "none";
	if (typeof failover !== "string" || !FAILOVERS.has(failover as RoutingFailover)) {
		errors.push("routing.failover must be one of: none|approved");
	}
	if (pinned && failover !== "none") errors.push("manual pins imply routing.failover none");
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		intent: {
			posture: posture as RoutingPosture,
			maxCostUsd,
			deadlineMs,
			minimumQuality,
			requiredCapabilities: [...(requiredCapabilities as string[])],
			locality: locality as RoutingLocality,
			failover: failover as RoutingFailover,
		},
	};
}

export function defaultRoutingIntent(pins: RoutingPins): RoutingIntent {
	const parsed = parseRoutingIntent(undefined, pins);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.intent;
}

/** Hard intent verdict. `prefer-local` deliberately does not reject. */
export function routingIntentRejection(input: {
	intent: RoutingIntent;
	candidate: RouteCandidate;
	qualityLowerBound: number;
	costUpperBoundUsd: number;
	endToEndUpperBoundMs: number;
	capabilities: ReadonlyArray<string>;
}): string | null {
	const { intent } = input;
	if (intent.minimumQuality !== null && input.qualityLowerBound < intent.minimumQuality) return "minimum-quality";
	if (intent.maxCostUsd !== null && input.costUpperBoundUsd > intent.maxCostUsd) return "max-cost";
	if (intent.deadlineMs !== null && input.endToEndUpperBoundMs > intent.deadlineMs) return "deadline";
	if (intent.locality === "local-only" && input.candidate.nodeId !== "local") return "local-only";
	if (intent.requiredCapabilities.some((capability) => !input.capabilities.includes(capability))) {
		return "required-capabilities";
	}
	return null;
}

/** Soft locality order applied only after both candidates clear every hard filter and otherwise tie. */
export function preferLocalTie(
	left: RouteCandidate,
	right: RouteCandidate,
	locality: RoutingLocality,
): RouteCandidate | null {
	if (locality !== "prefer-local") return null;
	const leftLocal = left.nodeId === "local";
	const rightLocal = right.nodeId === "local";
	if (leftLocal === rightLocal) return null;
	return leftLocal ? left : right;
}

export const ROUTE_EXPLANATION_MAX_BYTES = 4_096;

export interface RouteExplanation {
	mode: RouteDecisionV1["mode"];
	executedRoute: RouteCandidate;
	shadowRecommendation: RouteCandidate | null;
	hardExclusions: ReadonlyArray<string>;
	approvedFallbacks: ReadonlyArray<RouteCandidate>;
	costUpperBoundUsd: number | null;
	deadlineMs: number | null;
	confidence: number;
	activeEligible: boolean;
	reasonCodes: ReadonlyArray<string>;
	decisionHash: string;
}

function safeIdentity(candidate: RouteCandidate): RouteCandidate {
	const safe = (value: string): string => {
		const redacted = /(?:https?:\/\/|api[_-]?key|token|secret|password)/i.test(value) ? "[redacted]" : value;
		return redacted.length <= 128 ? redacted : `${redacted.slice(0, 127)}…`;
	};
	return {
		...candidate,
		agentId: safe(candidate.agentId),
		specFingerprint: safe(candidate.specFingerprint),
		targetId: safe(candidate.targetId),
		modelId: safe(candidate.modelId),
		runtimeId: safe(candidate.runtimeId),
		nodeId: safe(candidate.nodeId),
		...(candidate.thinkingLevel !== undefined ? { thinkingLevel: safe(candidate.thinkingLevel) } : {}),
		toolSignature: safe(candidate.toolSignature),
		promptCompositionHash: safe(candidate.promptCompositionHash),
	};
}

/** Compact receipt-derived explanation; no task, prompt, URL, or credential field is accepted. */
export function explainRouteDecision(decision: RouteDecisionV1, intent: RoutingIntent): RouteExplanation {
	const exclusions = [
		...new Set(decision.candidateEvaluations.flatMap((entry) => (entry.rejection ? [entry.rejection] : []))),
	];
	const explanation: RouteExplanation = {
		mode: decision.mode,
		executedRoute: safeIdentity(decision.executedRoute),
		shadowRecommendation: decision.mode === "shadow" ? safeIdentity(decision.selected) : null,
		hardExclusions: exclusions.slice(0, 16),
		approvedFallbacks: decision.approvedFallbacks.slice(0, 3).map(safeIdentity),
		costUpperBoundUsd: intent.maxCostUsd,
		deadlineMs: intent.deadlineMs,
		confidence: decision.confidence,
		activeEligible: !decision.reasonCodes.includes("posture-floors-unsatisfiable"),
		reasonCodes: decision.reasonCodes.slice(0, 16),
		decisionHash: decision.decisionHash,
	};
	if (Buffer.byteLength(JSON.stringify(explanation), "utf8") > ROUTE_EXPLANATION_MAX_BYTES) {
		return {
			...explanation,
			hardExclusions: explanation.hardExclusions.slice(0, 4),
			reasonCodes: explanation.reasonCodes.slice(0, 4),
		};
	}
	return explanation;
}
