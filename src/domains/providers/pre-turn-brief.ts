/**
 * The one System One call a turn makes before it starts.
 *
 * Every decision site that wants an answer before the prompt is built
 * describes itself as a `PreTurnSite`: which questions it asks, what state it
 * adds, how it reads the answers, and optionally a hint for the main agent and
 * a summary for the session ledger. The brief resolves which sites are bound,
 * groups them by the model that answers them, and sends one request per group.
 * Latency is per call rather than per question (116 to 367ms for 24 to 256
 * questions against jev-latest), so a new pre-turn case costs a question id
 * and a reader, never another round trip.
 *
 * Adding a case is one definition plus one `DECISION_SITES` entry. Nothing
 * here knows which sites exist.
 *
 * Nothing here throws and nothing here blocks past the caller's timeout. An
 * unbound site is never prepared, so an operator who bound nothing pays for no
 * catalog read and no request. A refused connection, a malformed answer and an
 * abstention all produce the same thing: no value for that site, which leaves
 * its caller exactly where it was before the site existed.
 */

import type { DecisionSite } from "../../core/defaults.js";
import { inspectDecisionSite, type ResolveDeciderInput } from "./decision-sites.js";
import type { Decider } from "./decisions.js";
import type { DecisionAnswer, DecisionQuestion } from "./types/inference.js";

/** Code points of task text sent as evidence. Enough to say what the turn is doing. */
const MAX_TASK_CHARS = 600;
/** Code points of the previous assistant message's tail. Enough to say what it proposed. */
const MAX_PREVIOUS_CHARS = 400;

/** The evidence every pre-turn site shares, before bounding. */
export interface PreTurnEvidence {
	/** What the turn was asked to do. */
	readonly task: string;
	/** The last assistant message, or empty on a session's first turn. */
	readonly previous?: string;
}

/** Shared evidence fields a site's wording may refer to. `task` is always sent. */
export type PreTurnEvidenceField = "previous";

export interface PreTurnAsk {
	/** Questions keyed by the site's own ids. The brief namespaces them on the wire. */
	readonly questions: Readonly<Record<string, DecisionQuestion>>;
	/**
	 * State fields beyond the shared evidence. Two sites contributing a map under
	 * the same key are merged one level deep, which is how memory and skills
	 * share one `candidates` map as they always have.
	 */
	readonly state?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	/** Shared evidence fields this site's wording names. Only named fields are sent. */
	readonly uses?: ReadonlyArray<PreTurnEvidenceField>;
}

/** A value to show in the session ledger next to the site and its wording version. */
export type PreTurnSummary = Readonly<Record<string, string | number | boolean | null>>;

export interface PreTurnSite<T> {
	readonly site: DecisionSite;
	/** Bumped whenever the wording changes, so recorded answers can be told apart. */
	readonly version: string;
	/**
	 * This turn's questions, or null to ask nothing. Called only when the site is
	 * bound, so reading an expensive catalog here costs an unbound operator
	 * nothing. A throw skips the site for this turn.
	 */
	prepare(evidence: Readonly<Required<PreTurnEvidence>>): PreTurnAsk | null;
	/**
	 * The site's value from its own answers, keyed by its own question ids, or
	 * null when the answers carry no usable opinion.
	 */
	read(answers: Readonly<Record<string, DecisionAnswer>>, ask: PreTurnAsk): T | null;
	/**
	 * One line of advice for the main agent, delivered in the submitted user
	 * message where the cached prefix is untouched. The main agent stays
	 * responsible for what it does; a hint never gates or narrows anything.
	 */
	hint?(value: T): string | null;
	/** What the ledger records for this turn. Omitted means the site is not recorded. */
	summarize?(value: T): PreTurnSummary;
}

/** One site's settled answer. */
export interface PreTurnAnswer<T> {
	readonly value: T;
	readonly version: string;
	/** Target and model, which is both the batching key and the reported source. */
	readonly source: string;
	readonly latencyMs: number;
}

export type PreTurnBrief = ReadonlyMap<DecisionSite, PreTurnAnswer<unknown>>;

const EMPTY_BRIEF: PreTurnBrief = new Map();

function bounded(value: string, maxCodePoints: number): string {
	const points = [...value.replace(/\s+/g, " ").trim()];
	return points.length <= maxCodePoints ? points.join("") : `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

/** The tail of the previous message is what it proposed, so the tail is what is kept. */
function boundedTail(value: string, maxCodePoints: number): string {
	const points = [...value.replace(/\s+/g, " ").trim()];
	return points.length <= maxCodePoints
		? points.join("")
		: `…${points.slice(points.length - maxCodePoints + 1).join("")}`;
}

interface Prepared {
	readonly definition: PreTurnSite<unknown>;
	readonly ask: PreTurnAsk;
	readonly decider: Decider;
	readonly source: string;
}

function prepareBound(
	input: ResolveDeciderInput,
	sites: ReadonlyArray<PreTurnSite<unknown>>,
	evidence: Readonly<Required<PreTurnEvidence>>,
): Prepared[] {
	const prepared: Prepared[] = [];
	for (const definition of sites) {
		try {
			const status = inspectDecisionSite(definition.site, input);
			if (!status.bound) continue;
			const ask = definition.prepare(evidence);
			if (ask === null || Object.keys(ask.questions).length === 0) continue;
			prepared.push({
				definition,
				ask,
				decider: status.decider,
				source: `${status.targetId}/${status.model ?? "default"}`,
			});
		} catch {
			// A site that cannot be looked at or cannot build its questions is a
			// site that is off for this turn. The others still ask.
		}
	}
	return prepared;
}

function stateFor(group: ReadonlyArray<Prepared>, evidence: Readonly<Required<PreTurnEvidence>>): object {
	const state: Record<string, unknown> = { task: evidence.task };
	if (group.some((entry) => entry.ask.uses?.includes("previous"))) state.previous = evidence.previous;
	for (const entry of group) {
		for (const [key, fields] of Object.entries(entry.ask.state ?? {})) {
			const existing = state[key];
			state[key] =
				existing !== null && typeof existing === "object" && !Array.isArray(existing)
					? { ...(existing as Record<string, unknown>), ...fields }
					: { ...fields };
		}
	}
	return state;
}

/** Answers for one site, keyed by its own ids again. */
function answersFor(site: DecisionSite, all: Record<string, DecisionAnswer>): Record<string, DecisionAnswer> {
	const prefix = `${site}.`;
	const own: Record<string, DecisionAnswer> = {};
	for (const [id, answer] of Object.entries(all)) {
		if (id.startsWith(prefix)) own[id.slice(prefix.length)] = answer;
	}
	return own;
}

/**
 * Ask every bound site its questions, one request per answering model.
 *
 * Sites normally share one profile and then share one request. They are
 * separately bindable, though, so sites pointed at different targets get one
 * request each rather than a batch that silently asks the wrong model half of
 * its questions.
 */
export async function runPreTurnBrief(
	input: ResolveDeciderInput,
	sites: ReadonlyArray<PreTurnSite<unknown>>,
	evidence: PreTurnEvidence,
	signal?: AbortSignal,
): Promise<PreTurnBrief> {
	const shared: Required<PreTurnEvidence> = {
		task: bounded(evidence.task, MAX_TASK_CHARS),
		previous: boundedTail(evidence.previous ?? "", MAX_PREVIOUS_CHARS),
	};
	let prepared: Prepared[];
	try {
		prepared = prepareBound(input, sites, shared);
	} catch {
		return EMPTY_BRIEF;
	}
	if (prepared.length === 0) return EMPTY_BRIEF;

	const groups = new Map<string, Prepared[]>();
	for (const entry of prepared) {
		const existing = groups.get(entry.source);
		if (existing) existing.push(entry);
		else groups.set(entry.source, [entry]);
	}

	const settled = await Promise.all(
		[...groups.values()].map(async (group) => {
			const startedAt = performance.now();
			try {
				// Building the request is inside the guard too: a site handing back a
				// malformed ask must not reject a function whose contract says it
				// never does.
				const questions: Record<string, DecisionQuestion> = {};
				for (const entry of group) {
					for (const [id, question] of Object.entries(entry.ask.questions)) {
						questions[`${entry.definition.site}.${id}`] = question;
					}
				}
				const answers = await (group[0] as Prepared).decider.ask(stateFor(group, shared), questions, {
					...(signal !== undefined ? { signal } : {}),
				});
				const latencyMs = Math.round(performance.now() - startedAt);
				const out: Array<[DecisionSite, PreTurnAnswer<unknown>]> = [];
				for (const entry of group) {
					try {
						const value = entry.definition.read(answersFor(entry.definition.site, answers), entry.ask);
						if (value === null) continue;
						out.push([entry.definition.site, { value, version: entry.definition.version, source: entry.source, latencyMs }]);
					} catch {
						// One site misreading its answers leaves the others standing.
					}
				}
				return out;
			} catch {
				// A refused connection, a timeout and a contract break all mean the
				// same thing to a caller: behave the way you did before.
				return [];
			}
		}),
	);
	return new Map(settled.flat());
}

export interface PreTurnBriefStoreOptions {
	/**
	 * Settings and the provider registry as they stand this turn, or null when
	 * the host has no authoritative snapshot yet. Null skips the brief.
	 */
	resolve: () => ResolveDeciderInput | null;
	/** Every pre-turn site the host knows. Unbound ones are never prepared. */
	sites: ReadonlyArray<PreTurnSite<unknown>>;
}

/**
 * Per-turn holder for the brief.
 *
 * It exists because the brief is async and its readers are not: the prompt
 * builder, the skills listing and turn_start middleware all run synchronously.
 * One awaited call at the turn boundary fills this, and every reader takes
 * what is there.
 */
export interface PreTurnBriefStore {
	/**
	 * Resolve this turn's answers. Awaited at the turn boundary, so it is the one
	 * place the harness pays for the brief, and it always settles: every failure
	 * clears the store rather than rejecting.
	 */
	refresh(evidence: PreTurnEvidence, signal?: AbortSignal): Promise<void>;
	/** This turn's value for a site, or undefined when it had no opinion. */
	get<T>(site: PreTurnSite<T>): T | undefined;
	/** Every settled answer this turn, for the ledger and the hint registration. */
	current(): PreTurnBrief;
	/** Drop the answers, so a turn that never refreshed cannot read a stale one. */
	clear(): void;
}

export function createPreTurnBriefStore(options: PreTurnBriefStoreOptions): PreTurnBriefStore {
	let brief: PreTurnBrief = EMPTY_BRIEF;
	const clear = (): void => {
		brief = EMPTY_BRIEF;
	};
	return {
		clear,
		current: () => brief,
		get<T>(site: PreTurnSite<T>): T | undefined {
			const answer = brief.get(site.site);
			return answer === undefined ? undefined : (answer.value as T);
		},
		async refresh(evidence, signal) {
			// Last turn's answers are wrong for this one, so they go before the new
			// ones arrive rather than after.
			clear();
			try {
				const input = options.resolve();
				if (input === null) return;
				brief = await runPreTurnBrief(input, options.sites, evidence, signal);
			} catch {
				clear();
			}
		},
	};
}

/** Hint lines for every site that answered and has one, in registration order. */
export function preTurnHints(sites: ReadonlyArray<PreTurnSite<unknown>>, brief: PreTurnBrief): string[] {
	const lines: string[] = [];
	for (const definition of sites) {
		const answer = brief.get(definition.site);
		if (answer === undefined || definition.hint === undefined) continue;
		try {
			const line = definition.hint(answer.value);
			if (line !== null && line.length > 0) lines.push(line);
		} catch {
			// A hint that cannot render is a hint not given.
		}
	}
	return lines;
}

/** Ledger rows for every site that answered and asks to be recorded. */
export function preTurnRecord(
	sites: ReadonlyArray<PreTurnSite<unknown>>,
	brief: PreTurnBrief,
): Array<{ site: DecisionSite; version: string; source: string; latencyMs: number; value: PreTurnSummary }> {
	const rows: Array<{ site: DecisionSite; version: string; source: string; latencyMs: number; value: PreTurnSummary }> =
		[];
	for (const definition of sites) {
		const answer = brief.get(definition.site);
		if (answer === undefined || definition.summarize === undefined) continue;
		try {
			rows.push({
				site: definition.site,
				version: answer.version,
				source: answer.source,
				latencyMs: answer.latencyMs,
				value: definition.summarize(answer.value),
			});
		} catch {
			// Recording is best effort and never costs the turn.
		}
	}
	return rows;
}
