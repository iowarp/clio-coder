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

export const SITE_IDS = ["turn", "toolCall", "toolResult", "turnEnd", "relevance", "consult", "drafts"] as const;
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
	 * System One server reports (`jev-1.13.0`), or the LLM engine's composite
	 * build (runtime, host, wire model, readout mode, prompt version).
	 */
	readonly build: string;
	/** Answers per question id. A missing id is an abstention on that question alone. */
	readonly answers: Readonly<Record<string, Answer>>;
	readonly usage?: { readonly input: number; readonly output: number };
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
	/** Why this engine must not be asked `question` for `task`, or null when it may. Pure. */
	unsupported(task: DecisionTask, question: Question, compact?: Question): string | null;
	/** Rejects on transport failure, an unusable reply, or abort. The runner owns deadlines and fallback. */
	decide(request: EngineRequest): Promise<EngineReply>;
}

/**
 * One site's cuts under one build: the fitted table in `calibration.ts`
 * overlaid with `systemOne.cuts` from settings. `fitted` is false when the
 * build has no cut for this site, and a policy that hints, gates or acts must
 * then stay silent.
 */
export interface SiteCuts {
	readonly build: string;
	readonly fitted: boolean;
	/** The cut for `<site>.<key>`, or undefined when nobody fitted it for this build. */
	cut(key: string): number | undefined;
	/**
	 * Where the cut for `key` came from: the measured table in `calibration.ts`,
	 * or an operator's `systemOne.cuts`, which acts but is never reported as a
	 * measured validation.
	 */
	source(key: string): "measured" | "operator" | undefined;
}

export interface SiteDefinition<O, V> {
	readonly id: SiteId;
	/** Bumped whenever wording, state shape or policy changes; recorded with every call. */
	readonly version: string;
	/** Hard deadline for one call. A binding may override it. */
	readonly deadlineMs: number;
	/**
	 * Tells apart definitions that share a site id and its binding but run at
	 * different moments under different deadlines, such as the approval card and
	 * the yolo gate. Each moment trips its own breaker, so a slow card never
	 * opens the gate's.
	 */
	readonly moment?: string;
	/**
	 * Short wordings for renderers with a declared per-option bound, keyed by
	 * question id. They are the site's own text under their own version, which
	 * joins the threshold identity of any build read through them; a question
	 * with none is asked in its full wording or abstained on, never cut.
	 */
	readonly compact?: { readonly version: string; questions(object: O): Readonly<Record<string, Question>> };
	/** The task question `id` serves; absent means the site's primary task. */
	taskOf?(id: string): DecisionTask;
	/** The task whose answers cut `key` is compared with; absent means the site's primary task. */
	cutTask?(key: string): DecisionTask;
	/** The bounded state for this object, or null to ask nothing. Pure: no I/O beyond what the object carries. */
	state(object: O): Readonly<Record<string, unknown>> | null;
	/** Every question about this object, fanned out in one call. */
	questions(object: O): Readonly<Record<string, Question>>;
	/** The typed verdict with the policy applied under this build's cuts, or null when the answers carry no usable opinion. */
	read(answers: Readonly<Record<string, Answer>>, object: O, cuts: SiteCuts): V | null;
	/** What the ledger and the dataset record as the policy outcome. */
	summarize(value: V): Readonly<Record<string, string | number | boolean | null>>;
}

export interface Verdict<V> {
	readonly value: V;
	readonly callId: string;
	readonly engine: string;
	readonly build: string;
	readonly fitted: boolean;
	readonly latencyMs: number;
}

export interface RunOptions {
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
	/** Tasks of this site routed to another engine, by task. */
	readonly routes?: Readonly<Partial<Record<DecisionTask, string>>>;
}

export interface SystemOne {
	/** Whether the site has a usable binding. Cheap: constructs no engine and reads no credential. */
	bound(site: SiteId): boolean;
	/** Ask one site about one object. Never throws. Null means behave as if System One did not exist. */
	run<O, V>(site: SiteDefinition<O, V>, object: O, options?: RunOptions): Promise<Verdict<V> | null>;
	/**
	 * True when the site's binding last answered, recently, from a build with no
	 * fitted cut for the site. Such a call can only be recorded, so a caller on a
	 * hot path may leave it running detached instead of waiting on it. False
	 * before any answer names the build, for a fitted build, and when unbound.
	 */
	shadowed(site: SiteId): boolean;
	/**
	 * What the engine answering `task` at `site` can read in one request, so a
	 * caller can choose a bounded hierarchy over a flat ask. Null when unbound.
	 */
	limits?(
		site: SiteId,
		task: DecisionTask,
	): { readonly windowTokens: number | null; readonly maxOptions: number } | null;
	/** One row per site, bound or not. */
	describe(): ReadonlyArray<SiteBindingInfo>;
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

/**
 * One engine's share of a call. A site whose tasks are routed to different
 * engines leaves one route per engine, each with its own build and threshold
 * identity, so no answer is ever filed under another engine's build.
 */
export interface RouteRecord {
	readonly engine: string;
	readonly kind: EngineKind;
	readonly target: string;
	readonly model: string | null;
	readonly profile: ProfileId | null;
	readonly renderer: RendererId;
	readonly tasks: ReadonlyArray<DecisionTask>;
	/** Question ids this route was given. */
	readonly questions: ReadonlyArray<string>;
	readonly outcome: CallOutcome;
	readonly build: string | null;
	/** `thresholdIdentity(build, renderer)`, the key its cuts are looked up under. */
	readonly identity: string | null;
	/** `measured`, `operator` or `none`: what kind of cut the identity has at this site. */
	readonly validation: "measured" | "operator" | "none";
	readonly error?: string;
	readonly note?: string;
	readonly abstained?: Readonly<Record<string, string>>;
	readonly usage?: { readonly input: number; readonly output: number };
	readonly rendered?: Readonly<Record<string, Question>>;
	/** The site's compact wording version, when a bounded renderer read it. */
	readonly compactVersion?: string;
}

/** Everything one call asked and got back. The recorder redacts before anything is persisted. */
export interface DecisionRecord {
	readonly v: 1;
	readonly callId: string;
	/** ISO time the call started. */
	readonly at: string;
	/**
	 * The session current when the call started, or null when none existed yet. A
	 * slow answer can settle after the operator switched sessions, and its rows
	 * belong to the session that asked. Absent when the runner had no session
	 * source, and the recorder then files the row under the session current when
	 * it arrives.
	 */
	readonly session?: string | null;
	readonly ref?: string;
	readonly site: SiteId;
	readonly siteVersion: string;
	readonly engine: string;
	readonly kind: EngineKind;
	readonly target: string;
	readonly model: string | null;
	/** The build that answered, or null when nothing answered. */
	readonly build: string | null;
	readonly outcome: CallOutcome;
	readonly error?: string;
	readonly latencyMs: number;
	readonly deadlineMs: number;
	/** Exactly the state that was sent. */
	readonly state: Readonly<Record<string, unknown>>;
	readonly questions: Readonly<Record<string, Question>>;
	readonly answers?: Readonly<Record<string, Answer>>;
	readonly usage?: { readonly input: number; readonly output: number };
	readonly note?: string;
	readonly fitted?: boolean;
	readonly policy?: Readonly<Record<string, string | number | boolean | null>>;
	/** Per-engine provenance. Present on every call made since routes existed; one entry for an unrouted site. */
	readonly routes?: ReadonlyArray<RouteRecord>;
}

/** What followed a decision, joined to it by `ref` when the dataset is exported. */
export interface OutcomeRecord {
	readonly ref: string;
	/**
	 * `turn-tokens` amends a cancelled turn's `turn` row with the worker tokens
	 * that sealed after it was written. Readers join it by `ref` like any other.
	 */
	readonly source: "turn" | "turn-tokens" | "next-operator" | "permission" | "follow-up" | "draft" | "compaction";
	/** ISO time the outcome was observed. */
	readonly at: string;
	readonly facts: Readonly<Record<string, unknown>>;
}

/** Where records go. Installed by the composition root; workers install none and record nothing. */
export interface DecisionRecorder {
	decision(record: DecisionRecord): void;
	outcome(record: OutcomeRecord): void;
}
