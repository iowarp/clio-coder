/**
 * Turning model replies into distributions over one question's options.
 *
 * Logprob readout reads the first token's letter alternatives in both option
 * orders and averages them, because position bias is the largest measured
 * error in these readouts. An order that comes back unreadable is dropped and
 * the answer says so (`partial`, uncalibrated) instead of passing one order off
 * as the average. It is never filled in with votes: one call answers in one
 * readout. Answer mode has no probabilities to read, so it asks for five votes
 * with the order alternating and counts them. Questions are never packed into
 * one request: sequences that share a prompt interfere, and the answer to a
 * question would then depend on its siblings.
 */

import { certaintyFromMass } from "../answers.js";
import { temperatureFor } from "../calibration.js";
import type { Answer, Question } from "../types.js";
import type { OptionItem } from "./llm-prompt.js";
import { letterIndex, MAX_LETTERED_OPTIONS, optionItems, renderPrompt, TOURNAMENT_GROUP_SIZE } from "./llm-prompt.js";
import type { Scheduler } from "./llm-schedule.js";
import type { Channel, ChannelUsage, TokenLogprob } from "./llm-wire.js";
import { ChatHttpError } from "./llm-wire.js";
import { LlmAdmissionRefused } from "./shared.js";

/** Votes per group in answer mode: odd, so a two-way split has a winner. */
export const VOTES = 5;
/** Fewer valid votes than this is not an opinion. */
const MIN_VALID_VOTES = 3;
/**
 * A letter absent from the alternatives is at least this far below the least
 * likely one that was seen, in nats. Servers return a truncated top-k, so an
 * absent label is unlikely rather than impossible.
 */
const MISSING_LABEL_FLOOR = 5;
/** Below this much total mass on labels, the model did not answer with one. */
const MIN_LABEL_MASS = 0.5;

/** The target returns no usable first-token logprobs, so the engine falls back to votes. */
export class LogprobsUnavailable extends Error {}

export interface ReadContext {
	readonly mode: "logprobs" | "answer";
	readonly build: string;
	readonly channel: Channel;
	readonly scheduler: Scheduler;
	readonly stateText: string;
	readonly signal: AbortSignal;
	/** Whether a failure of the warm request may downgrade the call instead of failing it. */
	readonly mayDowngrade: boolean;
	readonly usage: { input: number; output: number };
	/** Logprob order requests that came back readable or unreadable, for the binding's partial streak. */
	readonly orders: { read: number; missing: number };
}

interface GroupRead {
	/** Mass per option id, in declared order, summing to 1. */
	readonly mass: ReadonlyMap<string, number>;
	readonly flip: boolean;
	/** An option order was unreadable, so the mass is one order's read. */
	readonly partial: boolean;
}

function addUsage(ctx: ReadContext, usage: ChannelUsage | undefined): void {
	if (usage === undefined) return;
	ctx.usage.input += usage.input;
	ctx.usage.output += usage.output;
}

/** A token such as `A`, ` A`, `A)`, `(A` or `A.` names its letter. */
function normalizeToken(token: string): string {
	return token
		.trim()
		.replace(/^[([]+/u, "")
		.replace(/[).:\]]+$/u, "");
}

function logSumExp(values: ReadonlyArray<number>): number {
	const peak = Math.max(...values);
	return peak + Math.log(values.reduce((sum, value) => sum + Math.exp(value - peak), 0));
}

/**
 * Per-letter log-probabilities from a first token's alternatives, with the
 * floor applied to letters the server did not list. `found` is how many of the
 * `count` letters were listed and `mass` their total probability.
 */
function labelLogprobs(
	tokens: ReadonlyArray<TokenLogprob>,
	count: number,
): { logprobs: number[]; found: number; mass: number } {
	const seen: number[][] = Array.from({ length: count }, () => []);
	for (const { token, logprob } of tokens) {
		const index = letterIndex(normalizeToken(token), count);
		if (index >= 0) seen[index]?.push(logprob);
	}
	const merged = seen.map((values) => (values.length > 0 ? logSumExp(values) : null));
	const present = merged.filter((value): value is number => value !== null);
	if (present.length === 0) return { logprobs: [], found: 0, mass: 0 };
	const floor = Math.min(...present) - MISSING_LABEL_FLOOR;
	return {
		logprobs: merged.map((value) => value ?? floor),
		found: present.length,
		mass: present.reduce((sum, value) => sum + Math.exp(value), 0),
	};
}

function softmax(logprobs: ReadonlyArray<number>, temperature: number): number[] {
	const scaled = logprobs.map((value) => value / temperature);
	const peak = Math.max(...scaled);
	const exps = scaled.map((value) => Math.exp(value - peak));
	const total = exps.reduce((sum, value) => sum + value, 0);
	return exps.map((value) => value / total);
}

/** The letter an answer-mode reply names, or -1. Accepts a bare letter or `{"a":"B"}`. */
function parseVote(text: string, count: number): number {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const letter = typeof parsed === "object" && parsed !== null ? (parsed as { a?: unknown }).a : undefined;
			return typeof letter === "string" ? letterIndex(normalizeToken(letter), count) : -1;
		} catch {
			// Not JSON after all; the letter scan below is the fallback for a plain reply.
		}
	}
	const match = /^\(?([A-Z])(?![A-Za-z])/u.exec(trimmed);
	return match?.[1] === undefined ? -1 : letterIndex(match[1], count);
}

function argmaxId(mass: ReadonlyMap<string, number>): string | null {
	let best: string | null = null;
	let bestMass = -1;
	for (const [id, value] of mass) {
		if (value > bestMass) {
			best = id;
			bestMass = value;
		}
	}
	return best;
}

async function readOrder(
	ctx: ReadContext,
	question: Question,
	ordered: ReadonlyArray<OptionItem>,
	temperature: number,
): Promise<Map<string, number> | null> {
	const prompt = renderPrompt(ctx.stateText, question, ordered);
	const probs = await ctx.scheduler.run(async (warm) => {
		ctx.signal.throwIfAborted();
		let read: Awaited<ReturnType<Channel["firstToken"]>>;
		try {
			read = await ctx.channel.firstToken(prompt);
		} catch (error) {
			// The first request doubles as the capability probe. A 400 or 422 there most
			// often means the server rejected `logprobs` or a thinking switch.
			if (warm && ctx.mayDowngrade && error instanceof ChatHttpError && (error.status === 400 || error.status === 422)) {
				throw new LogprobsUnavailable(error.message);
			}
			throw error;
		}
		addUsage(ctx, read.usage);
		if (read.tokens === null) {
			if (warm) throw new LogprobsUnavailable("the server returned no logprobs");
			return null;
		}
		const labels = labelLogprobs(read.tokens, ordered.length);
		if (labels.found === 0) {
			if (warm) throw new LogprobsUnavailable("the first token was not an option letter");
			return null;
		}
		if (labels.mass < MIN_LABEL_MASS) return null;
		return softmax(labels.logprobs, temperature);
	});
	if (probs === null) {
		ctx.orders.missing += 1;
		return null;
	}
	ctx.orders.read += 1;
	return new Map(ordered.map((item, index) => [item.id, probs[index] as number]));
}

async function readByLogprobs(
	ctx: ReadContext,
	question: Question,
	items: ReadonlyArray<OptionItem>,
): Promise<GroupRead | null> {
	const temperature = temperatureFor(ctx.build, question.type, items.length);
	const [forward, reversed] = await Promise.all([
		readOrder(ctx, question, items, temperature),
		readOrder(ctx, question, [...items].reverse(), temperature),
	]);
	const valid = [forward, reversed].filter((order): order is Map<string, number> => order !== null);
	if (valid.length === 0) return null;
	const mass = new Map<string, number>();
	for (const item of items) {
		mass.set(item.id, valid.reduce((sum, order) => sum + (order.get(item.id) ?? 0), 0) / valid.length);
	}
	const flip = forward !== null && reversed !== null && argmaxId(forward) !== argmaxId(reversed);
	return { mass, flip, partial: valid.length < 2 };
}

async function readByVotes(
	ctx: ReadContext,
	question: Question,
	items: ReadonlyArray<OptionItem>,
): Promise<GroupRead | null> {
	const reversed = [...items].reverse();
	const casts = await Promise.allSettled(
		Array.from({ length: VOTES }, async (_unused, vote) => {
			const ordered = vote % 2 === 0 ? items : reversed;
			const prompt = renderPrompt(ctx.stateText, question, ordered);
			const reply = await ctx.scheduler.run(async () => {
				ctx.signal.throwIfAborted();
				return ctx.channel.vote(prompt, ordered.length);
			});
			addUsage(ctx, reply.usage);
			const index = parseVote(reply.text, ordered.length);
			return { id: ordered[index]?.id ?? null, even: vote % 2 === 0 };
		}),
	);
	const refused = casts.find(
		(entry): entry is PromiseRejectedResult => entry.status === "rejected" && entry.reason instanceof LlmAdmissionRefused,
	);
	if (refused !== undefined) throw refused.reason;
	const cast = casts.flatMap((entry) => (entry.status === "fulfilled" && entry.value.id !== null ? [entry.value] : []));
	if (cast.length < MIN_VALID_VOTES) {
		// Every vote failing is a broken target, not an abstention: keep the cause.
		const first = casts.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
		if (first !== undefined && casts.every((entry) => entry.status === "rejected")) throw first.reason;
		return null;
	}
	const tally = (votes: ReadonlyArray<{ id: string | null }>): Map<string, number> => {
		const counts = new Map<string, number>(items.map((item) => [item.id, 0]));
		for (const vote of votes) if (vote.id !== null) counts.set(vote.id, (counts.get(vote.id) ?? 0) + 1);
		return counts;
	};
	const all = tally(cast);
	const mass = new Map([...all].map(([id, count]) => [id, count / cast.length]));
	const even = cast.filter((vote) => vote.even);
	const odd = cast.filter((vote) => !vote.even);
	const flip = even.length > 0 && odd.length > 0 && argmaxId(tally(even)) !== argmaxId(tally(odd));
	return { mass, flip, partial: false };
}

function readGroup(ctx: ReadContext, question: Question, items: ReadonlyArray<OptionItem>): Promise<GroupRead | null> {
	return ctx.mode === "logprobs" ? readByLogprobs(ctx, question, items) : readByVotes(ctx, question, items);
}

/**
 * Two rounds for a question with more options than letters. Round one reads
 * groups of 25 in parallel and keeps each group's two strongest; the finalists
 * are then read together. Options that did not reach the final carry no mass,
 * so the distribution is approximate by construction.
 */
async function tournament(
	ctx: ReadContext,
	question: Question,
	items: ReadonlyArray<OptionItem>,
): Promise<GroupRead | null> {
	let field = items;
	let partial = false;
	while (field.length > MAX_LETTERED_OPTIONS) {
		const groups: OptionItem[][] = [];
		for (let start = 0; start < field.length; start += TOURNAMENT_GROUP_SIZE) {
			groups.push(field.slice(start, start + TOURNAMENT_GROUP_SIZE));
		}
		const reads = await Promise.all(
			groups.map((group) => (group.length === 1 ? Promise.resolve(null) : readGroup(ctx, question, group))),
		);
		partial ||= reads.some((read) => read?.partial === true);
		const survivors: OptionItem[] = [];
		for (const [index, group] of groups.entries()) {
			const read = reads[index];
			if (group.length === 1) {
				survivors.push(...group);
				continue;
			}
			// One unreadable group could hold the winner, so it abstains the question.
			if (read === null || read === undefined) return null;
			const ranked = [...group].sort((a, b) => (read.mass.get(b.id) ?? 0) - (read.mass.get(a.id) ?? 0));
			survivors.push(...ranked.slice(0, 2));
		}
		field = survivors;
	}
	const final = await readGroup(ctx, question, field);
	if (final === null) return null;
	const mass = new Map(items.map((item) => [item.id, final.mass.get(item.id) ?? 0]));
	return { mass, flip: final.flip, partial: partial || final.partial };
}

function assemble(
	question: Question,
	items: ReadonlyArray<OptionItem>,
	read: GroupRead,
	calibrated: boolean,
	approximate: boolean,
): Answer | null {
	const flags: Array<"flip" | "approximate" | "partial"> = [];
	if (read.flip) flags.push("flip");
	if (approximate) flags.push("approximate");
	if (read.partial) flags.push("partial");
	const withFlags = flags.length > 0 ? { flags } : {};
	if (question.type === "noul") {
		const noul = read.mass.get("true");
		if (noul === undefined) return null;
		return {
			type: "noul",
			noul,
			certainty: certaintyFromMass("noul", { noul }),
			calibrated,
			...withFlags,
		};
	}
	const probabilities: Record<string, number> = {};
	for (const item of items) probabilities[item.id] = read.mass.get(item.id) ?? 0;
	const certainty = certaintyFromMass(question.type, { probabilities });
	if (question.type === "choice") {
		const choice = argmaxId(read.mass);
		if (choice === null) return null;
		return { type: "choice", choice, probabilities, certainty, calibrated, ...withFlags };
	}
	const score = items.reduce((sum, item) => sum + Number(item.id) * (read.mass.get(item.id) ?? 0), 0);
	return { type: "score", score, probabilities, certainty, calibrated, ...withFlags };
}

/**
 * One question to one answer, or null when the model gave no usable opinion.
 * A transport failure rejects; an unreadable reply is an abstention.
 */
export async function answerQuestion(ctx: ReadContext, question: Question): Promise<Answer | null> {
	const items = optionItems(question);
	if (question.type === "choice" && items.length === 1) {
		// Nothing to decide, so no request: the only option has all the mass.
		const only = items[0] as OptionItem;
		return assemble(question, items, { mass: new Map([[only.id, 1]]), flip: false, partial: false }, true, false);
	}
	const approximate = items.length > MAX_LETTERED_OPTIONS;
	const read = approximate ? await tournament(ctx, question, items) : await readGroup(ctx, question, items);
	if (read === null) return null;
	// One order has no position-bias averaging, so it is no more a calibrated probability than a vote fraction is.
	return assemble(question, items, read, ctx.mode === "logprobs" && !approximate && !read.partial, approximate);
}
