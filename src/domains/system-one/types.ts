/**
 * The System One contract: typed questions about one object, answered by a
 * pluggable decision engine, read by a site's policy.
 *
 * A site names the object it judges (the operator's request, a proposed tool
 * call, a tool result, a finished turn, a catalog entry, evidence the agent
 * supplies, draft candidates), so every call carries one state and fans out
 * every question about that state at once. An engine is anything that can
 * answer: a `/v1/systemone` server (TypeSafe Jev, Laya, OpenJev, Kev) or an
 * ordinary LLM target read through its logprobs or asked for a vote. A
 * probability means something only for the build that produced it, so every
 * cut is keyed by the answering build, and a build nobody fitted is recorded
 * but never hints, gates or acts.
 *
 * Every entry point here returns null rather than throwing, and null always
 * means the caller behaves exactly as it would with System One absent.
 */

/** Decision sites, named by the object each one judges. */
import type { DecisionTask, ReadoutKind, RendererId } from "./contract.js";
import type { ProfileId } from "./profiles.js";

export const SITE_IDS = ["consult"] as const;
export type SiteId = (typeof SITE_IDS)[number];

export type QuestionType = "noul" | "choice" | "score";

/**
 * One snap judgment. Criteria describe situations, not degrees: a noul names
 * what true and false look like, a choice maps each option key to when it
 * applies (1 to 255 options, give open lists an `other` exit), and a score
 * lists 2 to 10 levels from lowest to highest.
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
	/**
	 * Engine-neutral peakedness in [0, 1]: |2p - 1| for a noul, (n·max - 1)/(n - 1)
	 * over the distribution for a choice or score. Engines disagree on their own
	 * confidence scales, so this is recomputed from the mass, never copied.
	 */
	readonly certainty: number;
	/** False when the mass is not a calibrated probability: vote counts, a tournament readout, or a single option order. */
	readonly calibrated: boolean;
	/**
	 * `flip`: the two option orders disagreed on the winner. `approximate`: a >26-option tournament.
	 * `partial`: an option order came back unreadable, so the mass has no position-bias averaging.
	 */
	readonly flags?: ReadonlyArray<"flip" | "approximate" | "partial">;
	/** What the number is, as the engine's profile declares it. Absent on rows written before profiles. Not a calibration claim. */
	readonly readout?: ReadoutKind;
}

export interface EngineRequest {
	readonly state: Readonly<Record<string, unknown>>;
	readonly questions: Readonly<Record<string, Question>>;
	/** The task each question serves, so a profile renders and reads it under the right semantics. */
	readonly tasks?: Readonly<Record<string, DecisionTask>>;
	/** Site-owned compact wordings by question id, read only by a bounded renderer. Never sent on the legacy wire. */
	readonly compact?: Readonly<Record<string, Question>>;
	readonly signal: AbortSignal;
}

export interface EngineReply {
	/**
	 * What answered, and the key every cut is fitted against: the model a
	 * System One server reports (`jev-1.14.0`), or the LLM engine's composite
	 * build (runtime, host, wire model, readout mode, prompt version).
	 */
	readonly build: string;
	/** Answers per question id. A missing id is an abstention on that question alone. */
	readonly answers: Readonly<Record<string, Answer>>;
	readonly usage?: { readonly input: number; readonly output: number };
	/** The engine's request alone, send to reply; `latencyMs` also counts Clio's preparation. */
	readonly roundTripMs?: number;
	/**
	 * Why the readout is not the one the operator configured, for the ledger and
	 * the dataset: `downgraded: no-logprobs`, `downgraded: partial-logprobs`, or
	 * `partial: 1 of 2 logprob orders unread`. Absent for a readout as configured.
	 */
	readonly note?: string;
	/** Question id to why it was not asked: a task or semantics the profile does not answer, or a declared limit. */
	readonly abstained?: Readonly<Record<string, string>>;
	/** The questions exactly as a non-legacy renderer sent them; absent when what was sent is what the site wrote. */
	readonly rendered?: Readonly<Record<string, Question>>;
}

export type EngineKind = "systemone" | "llm";

export interface DecisionEngine {
	/** The `systemOne.engines` key it was built from. */
	readonly name: string;
	readonly kind: EngineKind;
	readonly target: string;
	readonly model: string | null;
	/** Tokens one state plus its longest question may use, or null when the engine declares no bound. */
	readonly windowTokens: number | null;
	/** The runtime and resolved endpoint a request leaves for, for the information-flow check. */
	readonly runtime: string;
	readonly url: string | null;
	/** The capability profile, or null for an LLM engine, which renders its own prompt. */
	readonly profile: ProfileId | null;
	readonly renderer: RendererId;
	/** The builds it would answer as, for checking a measurement before any request. Empty when none can be named. Pure. */
	expectedBuilds(): ReadonlyArray<string>;
	/** Why this engine must not be asked `question` for `task`, or null when it may. Pure. */
	unsupported(task: DecisionTask, question: Question, compact?: Question): string | null;
	/** Rejects on transport failure, an unusable reply, or abort. The runner owns deadlines and fallback. */
	decide(request: EngineRequest): Promise<EngineReply>;
}

export interface SiteDefinition<O, V> {
	readonly id: SiteId;
	/** Bumped whenever wording, state shape or policy changes; recorded with every call. */
	readonly version: string;
	/** Hard deadline for one call. A binding may override it. */
	readonly deadlineMs: number;
	/** The bounded state for this object, or null to ask nothing. Pure: no I/O beyond what the object carries. */
	state(object: O): Readonly<Record<string, unknown>> | null;
	/** Every question about this object, fanned out in one call. */
	questions(object: O): Readonly<Record<string, Question>>;
	/** The typed verdict, or null when the answers carry no usable opinion. */
	read(answers: Readonly<Record<string, Answer>>, object: O): V | null;
}

export interface Verdict<V> {
	readonly value: V;
	readonly callId: string;
	readonly engine: string;
	readonly build: string;
	readonly latencyMs: number;
}

export interface RunOptions {
	/** Per-call failure diagnostics for callers that need to explain a null fallback. */
	readonly onFailure?: (reason: string) => void;
	/** Join key for outcome rows: the user turn id, a permission request id, a tool call id. */
	readonly ref?: string;
	readonly signal?: AbortSignal;
	/**
	 * The information-flow restrictions the evidence inherited from where it came
	 * from, passed through to the flow check unread. System One never classifies
	 * content to decide where it may go.
	 */
	readonly flow?: unknown;
}

export interface SiteBindingInfo {
	readonly site: SiteId;
	/** The bound engine name, or null when the site is unbound. */
	readonly engine: string | null;
	readonly kind?: EngineKind;
	readonly target?: string;
	readonly model?: string | null;
	readonly deadlineMs?: number;
	/** Why a configured binding cannot answer, for doctor and the settings overlay. */
	readonly problem?: string;
}

/** One engine's timeout breaker at one site and moment, as `/health` shows it (#434 §11.3). */
export interface SystemOneBreakerView {
	readonly engine: string;
	readonly site: SiteId;
	readonly moment: string | null;
	/**
	 * `closed` while it counts timeouts below the threshold, `open` while it cools down, `probing` while the one call
	 * past the cooldown runs, and `half-open` once the next call may probe.
	 */
	readonly state: "closed" | "open" | "probing" | "half-open";
	/** Consecutive timeouts. */
	readonly failures: number;
	/** Cooldown left while open or probing, else 0. */
	readonly remainingMs: number;
}

export interface SystemOne {
	/** Whether the site has a usable binding. Cheap: constructs no engine and reads no credential. */
	bound(site: SiteId): boolean;
	/** Ask one site about one object. Never throws. Null means behave as if System One did not exist. */
	run<O, V>(site: SiteDefinition<O, V>, object: O, options?: RunOptions): Promise<Verdict<V> | null>;
	/** One row per site, bound or not. */
	describe(): ReadonlyArray<SiteBindingInfo>;
	/** Every engine breaker that counts a failure or is tripped, in this process and the current session. */
	breakers?(): ReadonlyArray<SystemOneBreakerView>;
	/** Why each engine's server refused its current model by name; it is not asked again. */
	refusedEngines?(): ReadonlyMap<string, string>;
}

export type CallOutcome =
	| "answered"
	| "failed"
	| "timeout"
	| "canceled"
	| "overflow"
	| "breaker-open"
	| "unsupported"
	| "flow-denied";
