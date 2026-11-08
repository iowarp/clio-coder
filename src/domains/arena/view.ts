import { renderCompactCount, renderUsdSum } from "../../core/telemetry/render.js";
import { matchLabels } from "./blind.js";
import { readContenderDiff } from "./store.js";
import type {
	ArenaCheckFact,
	ArenaChoice,
	ArenaContenderStatus,
	ArenaDiffStat,
	ArenaLabel,
	ArenaMatch,
	ArenaMatchStatus,
	ArenaVote,
} from "./types.js";

/** What a voter may see before voting: the work and its outcome, not who did it or what it cost. */
export interface ArenaEntryView {
	label: ArenaLabel;
	status: ArenaContenderStatus;
	exitCode: number | null;
	timedOut: boolean;
	turns: number | null;
	toolCalls: number | null;
	toolErrors: number | null;
	writes: number | null;
	blocks: number | null;
	diffStat: ArenaDiffStat | null;
	check: ArenaCheckFact | null;
	finalText: string;
	diff: string | null;
	diffTruncated: boolean;
	error: string | null;
	/** Present only once the match is revealed. */
	reveal: ArenaRevealView | null;
}

export interface ArenaRevealView {
	index: number;
	target: string;
	model: string;
	durationMs: number | null;
	sessionId: string | null;
	tokens: string;
	cost: string;
}

export interface ArenaMatchView {
	id: string;
	createdAt: string;
	completedAt: string | null;
	status: ArenaMatchStatus;
	prompt: string;
	suite: string | null;
	isolation: ArenaMatch["isolation"];
	check: string | null;
	error: string | null;
	revealed: boolean;
	vote: { choice: ArenaChoice; note: string | null; votedAt: string } | null;
	entries: ArenaEntryView[];
}

export class ArenaRevealRefused extends Error {}

const HIDDEN = "[hidden]";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Everything a contender wrote is shown before the vote: its answer, its diff,
 * its check output and any error. Any of it can name the contender, by target
 * or model id, by session id (often inside a session file path), or by a compete
 * worktree or branch path. Worktrees are numbered by blind slot, so such a path
 * only repeats the label, but the absolute prefix and branch are still replaced.
 * The raw text returns with the reveal.
 */
function blindRedactor(match: ArenaMatch): (text: string) => string {
	const names = new Set<string>();
	const sessions = new Set<string>();
	for (const contender of match.contenders) {
		names.add(`${contender.target}/${contender.model}`);
		names.add(contender.target);
		names.add(contender.model);
		if (contender.facts?.sessionId) sessions.add(contender.facts.sessionId);
	}
	const alternation = (terms: Set<string>) =>
		[...terms]
			.filter((term) => term.length > 0)
			.sort((a, b) => b.length - a.length)
			.map(escapeRegExp)
			.join("|");
	// Session ids are unique tokens: replaced wherever they appear, path or not.
	const session = sessions.size === 0 ? null : new RegExp(alternation(sessions), "g");
	// Target and model ids are replaced as whole path segments or words, not inside longer words.
	const named =
		names.size === 0
			? null
			: new RegExp(`(?<![A-Za-z0-9_.-])(?:${alternation(names)})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "g");
	return (text) => {
		let out = text
			.replace(/[^\s'"`]*?\.clio-coder[\\/]worktrees[\\/](?:[^\s'"`\\/]+[\\/])+?candidate-\d+/g, "[worktree]")
			.replace(/\.clio-coder[\\/]worktrees[\\/][^\s'"`]*/g, `.clio-coder/worktrees/${HIDDEN}`)
			.replace(/clio-coder\/compete\/[^\s'"`]*/g, `clio-coder/compete/${HIDDEN}`)
			.replace(/\b(candidate|contender)[- ]\d+/gi, `$1 ${HIDDEN}`);
		if (session !== null) out = out.replace(session, HIDDEN);
		if (named !== null) out = out.replace(named, HIDDEN);
		return out;
	};
}

/**
 * Project a match for a voter. Identity, duration, tokens and cost stay hidden
 * until the vote is in, because each can name the model. Asking to reveal
 * before voting is refused rather than silently honoured.
 */
export function arenaMatchView(
	root: string,
	match: ArenaMatch,
	vote: ArenaVote | null,
	options: { reveal?: boolean; diffs?: boolean } = {},
): ArenaMatchView {
	if (options.reveal === true && vote === null) {
		throw new ArenaRevealRefused(`match ${match.id} has no vote yet; vote before revealing who is who`);
	}
	const revealed = vote !== null;
	const blind = revealed ? (text: string) => text : blindRedactor(match);
	const entries = matchLabels(match).map((label, k): ArenaEntryView => {
		const index = match.order[k] as number;
		const contender = match.contenders.find((c) => c.index === index);
		const facts = contender?.facts ?? null;
		const diff = options.diffs === false ? null : readContenderDiff(root, match.id, index);
		return {
			label,
			status: contender?.status ?? "pending",
			exitCode: facts?.exitCode ?? null,
			timedOut: facts?.timedOut ?? false,
			turns: facts?.turns ?? null,
			toolCalls: facts?.toolCalls ?? null,
			toolErrors: facts?.toolErrors ?? null,
			writes: facts?.writes ?? null,
			blocks: facts?.blocks ?? null,
			diffStat: facts?.diff ?? null,
			check: facts?.check ? { ...facts.check, tail: blind(facts.check.tail) } : null,
			finalText: blind(facts?.finalText ?? ""),
			diff: diff === null ? null : blind(diff.text),
			diffTruncated: diff?.truncated ?? false,
			error: facts?.error ? blind(facts.error) : null,
			reveal:
				revealed && contender !== undefined
					? {
							index,
							target: contender.target,
							model: contender.model,
							durationMs: facts?.durationMs ?? null,
							sessionId: facts?.sessionId ?? null,
							tokens: facts?.totalTokens ? renderCompactCount(facts.totalTokens) : "not measured",
							cost: facts?.cost ? renderUsdSum(facts.cost.usd, facts.cost.free, facts.cost.freeRule) : "not measured",
						}
					: null,
		};
	});
	return {
		id: match.id,
		createdAt: match.createdAt,
		completedAt: match.completedAt,
		status: match.status,
		prompt: match.prompt,
		suite: match.suite,
		isolation: match.isolation,
		check: match.check,
		error: match.error === null ? null : blind(match.error),
		revealed,
		vote: vote === null ? null : { choice: vote.choice, note: vote.note, votedAt: vote.votedAt },
		entries,
	};
}
