/**
 * The System One contract: typed questions about one state, answered by a pluggable
 * decision engine, read by a decision point. An engine is anything that declares
 * what it can carry: a `/v1/systemone` server, a chat target asked in one
 * schema-bound request, or later a model Clio ships.
 *
 * `ask` returns null rather than throwing, and null always means the caller behaves
 * exactly as it would with System One absent.
 */

import type { ReadoutKind, RendererId, SemanticKind } from "./contract.js";
import type { ProfileId } from "./profiles.js";

export type QuestionType = "noul" | "choice" | "score";

/**
 * One snap judgment. Criteria describe situations, not degrees: a noul names what
 * true and false look like, a choice maps each option key to when it applies, and a
 * score lists 2 to 10 levels from lowest to highest.
 */
export type Question =
	| {
			readonly type: "noul";
			readonly instructions: string;
			readonly criteria: { readonly true: string; readonly false: string };
	  }
	| { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
	| { readonly type: "score"; readonly instructions: string; readonly criteria: ReadonlyArray<string> };

export interface Answer {
	readonly type: QuestionType;
	/** noul: probability of true. */
	readonly noul?: number;
	/** choice: the most probable option; always one of the declared keys. */
	readonly choice?: string;
	/** score: expected level, 0-indexed and fractional. */
	readonly score?: number;
	/** choice: option key to mass; score: level index ("0".."n-1") to mass. Sums to 1 within rounding. */
	readonly probabilities?: Readonly<Record<string, number>>;
	/** Engine-neutral peakedness in [0, 1], recomputed from the mass whatever the engine said about itself. */
	readonly certainty: number;
	/** What the number is, as the engine declares it. Not a calibration claim. */
	readonly readout: ReadoutKind;
}

/** A question a route could not or did not answer, and why. Never dropped, never read as a low score. */
export interface Abstention {
	readonly abstained: string;
}

export type AskAnswers = Readonly<Record<string, Answer | Abstention>>;

export function isAnswered(answer: Answer | Abstention | undefined): answer is Answer {
	return answer !== undefined && !("abstained" in answer);
}

export interface EngineRequest {
	readonly state: Readonly<Record<string, unknown>>;
	/** Exactly what this engine reads: formation has already rendered them. */
	readonly questions: Readonly<Record<string, Question>>;
	readonly signal: AbortSignal;
}

export interface EngineReply {
	/** What answered: the model a server reports, or the name a chat response reported. */
	readonly build: string;
	/** Answers per question id. A missing id is an abstention on that question alone. Formation adds readout and certainty. */
	readonly answers: Readonly<Record<string, Omit<Answer, "readout" | "certainty">>>;
	readonly usage?: { readonly input: number; readonly output: number };
	/** The engine's request alone, send to reply. */
	readonly roundTripMs?: number;
}

export type EngineKind = "systemone" | "llm";

/** Where a request leaves for. Null on an engine means no byte leaves the process. */
export interface EngineDestination {
	readonly targetId: string;
	readonly runtimeId: string;
	/** Null only for a typed server asked to answer with whatever it serves. */
	readonly wireModelId: string | null;
	readonly url?: string;
}

/** Everything formation and routing read. No decision is ever driven by a vendor's name. */
export interface EngineCapabilities {
	readonly semantics: ReadonlySet<SemanticKind>;
	readonly readout: Readonly<Record<SemanticKind, ReadoutKind>>;
	/** Whether a yes/no or filter reading is a real probability, rather than a label or an undeclared number. */
	readonly probabilities: boolean;
	readonly renderer: RendererId;
	/** Options of one choice or levels of one score, inclusive. A noul is two. */
	readonly minOptions: number;
	readonly maxOptions: number;
	/** Declared tokens of one option's text, or null for no declared bound. */
	readonly optionTokens: number | null;
	/** Declared tokens of the question with all its options, or null. */
	readonly headTokens: number | null;
	/** Tokens one request may fill, or null when no bound is known. */
	readonly windowTokens: number | null;
	/** Whether the window holds the state and its longest question, or the state and every question. */
	readonly windowCounts: "per-question" | "whole-request";
}

export interface DecisionEngine {
	/** The route name it was built from. */
	readonly name: string;
	readonly kind: EngineKind;
	readonly profile: ProfileId;
	readonly capabilities: EngineCapabilities;
	readonly destination: EngineDestination | null;
	/** Rejects on transport failure, an unusable reply, or abort. The runner owns deadlines and fallback. */
	decide(request: EngineRequest): Promise<EngineReply>;
}

/** One question of a point, with what it means. `compact` is a short wording for a bounded renderer. */
export interface PointQuestion {
	readonly question: Question;
	readonly semantic: SemanticKind;
	readonly compact?: Question;
}

/**
 * A versioned question set, a state builder and a reader. Adding a decision is one of
 * these, one entry in `points/index.ts` and one `ask` at a place that already waits.
 * `id` and `version` are what telemetry groups by and what a later training set joins on.
 */
export interface DecisionPoint<O, V> {
	readonly id: string;
	/** Bumped whenever wording or state shape changes. */
	readonly version: string;
	/** The total across every route. An engine kind's own timeout bounds each route inside it. */
	readonly deadlineMs: number;
	/** What an engine must declare to be asked at all. A route without it is skipped before any byte leaves. */
	readonly requires?: { readonly probabilities?: true };
	/** A use nobody waits on directly. It skips a route whose endpoint has no free slot rather than queueing behind work. */
	readonly optional?: true;
	/** The bounded state, or null to ask nothing. */
	state(object: O): Readonly<Record<string, unknown>> | null;
	questions(object: O): Readonly<Record<string, PointQuestion>>;
	/** The typed value, or null when the answers carry no usable opinion. */
	read(answers: AskAnswers, object: O): V | null;
}

export interface AskOptions {
	/** Per-call failure diagnostics for callers that need to explain a null fallback. */
	readonly onFailure?: (reason: string) => void;
	/** Join key for a later outcome: a tool call id, a request id, a queue entry id. */
	readonly ref?: string;
	readonly signal?: AbortSignal;
	/** The information-flow restrictions the evidence inherited, passed through to the flow check unread. */
	readonly flow?: unknown;
	/** A destination this ask must not use, because the caller's own work is waiting on it. Such a route reads as busy. */
	readonly avoid?: (destination: EngineDestination) => boolean;
}

export type CallOutcome =
	| "answered"
	| "failed"
	| "timeout"
	| "canceled"
	| "overflow"
	| "breaker-open"
	| "unsupported"
	| "flow-denied"
	| "busy";

/** One route's part in an ask. */
export interface RouteAttempt {
	readonly engine: string;
	readonly kind: EngineKind;
	readonly profile: ProfileId;
	readonly outcome: CallOutcome;
	readonly roundTripMs?: number;
	readonly breaker?: "opened" | "probe" | "closed";
}

export interface Verdict<V> {
	readonly value: V;
	readonly askId: string;
	readonly engine: string;
	readonly kind: EngineKind;
	readonly profile: ProfileId;
	/** Whether the answering engine declares its numbers real probabilities, so a caller that acts on one reads this and never a name. */
	readonly probabilities: boolean;
	readonly build: string;
	readonly latencyMs: number;
	readonly usage?: { readonly input: number; readonly output: number };
	readonly routes: ReadonlyArray<RouteAttempt>;
}

export interface RouteInfo {
	/** The route name as `systemOne.use` names it. */
	readonly name: string;
	readonly kind?: EngineKind;
	readonly profile?: ProfileId;
	readonly target?: string;
	readonly model?: string | null;
	/** What one request to this route may fill, for a caller that must fit an ask before making it. */
	readonly windowTokens?: number | null;
	readonly windowCounts?: EngineCapabilities["windowCounts"];
	/** Why this route cannot answer, for status surfaces. */
	readonly problem?: string;
}

/** One engine's timeout breaker, as `/health` shows it (#434 §11.3). */
export interface SystemOneBreakerView {
	readonly engine: string;
	/** `closed` while it counts timeouts, `open` while it cools down, `probing` during the one call past the cooldown, `half-open` once the next call may probe. */
	readonly state: "closed" | "open" | "probing" | "half-open";
	readonly failures: number;
	readonly remainingMs: number;
}

export interface SystemOne {
	/** Whether at least one named route can answer. Cheap: constructs no engine and reads no credential. */
	bound(): boolean;
	/** Ask one decision point about one object. Never throws. */
	ask<O, V>(point: DecisionPoint<O, V>, object: O, options?: AskOptions): Promise<Verdict<V> | null>;
	/** One row per named route, in order. */
	routes(): ReadonlyArray<RouteInfo>;
	/** Every engine breaker that counts a failure or is tripped. */
	breakers?(): ReadonlyArray<SystemOneBreakerView>;
	/** Why each engine's server refused its current model by name; it is not asked again. */
	refusedEngines?(): ReadonlyMap<string, string>;
}
