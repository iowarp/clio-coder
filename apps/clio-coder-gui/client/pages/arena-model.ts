import type { ArenaMatch, ArenaStandings, ArenaStartRequest } from "../../contracts/arena.js";
import { eyebrow, type PanelCopy } from "../design/panel-model.js";
import type { SplitterSpec } from "../design/Splitter.js";

export type ArenaChoice = "A" | "B" | "C" | "D" | "tie" | "both-bad";
type ArenaLabel = ArenaMatch["entries"][number]["label"];

export const ARENA_PANEL: PanelCopy = {
	eyebrow: eyebrow("Arena matches", "this workspace", "run and vote"),
	title: "Arena",
	boundary:
		"Matches, contender streams, diffs and votes live under .clio-coder/arena in this workspace. Clio records your vote and never judges a match itself.",
};

export const ARENA_MIN_CONTENDERS = 2;
export const ARENA_MAX_CONTENDERS = 4;
export const ARENA_PROMPT_MAX = 8000;

/** One grip per inner column edge; the last column takes what is left. */
export function arenaColumnSpec(index: number): SplitterSpec {
	return {
		storageKey: `clio-coder-gui-arena-column-${index}`,
		cssVar: `--arena-col-${index}`,
		min: 240,
		max: 1400,
		initial: 420,
		maxShare: 0.75,
	};
}

/** Unsized columns share the row evenly; a column the operator dragged keeps its width. */
export function arenaGridTemplate(columns: number): string {
	const tracks: string[] = [];
	for (let index = 0; index < columns; index++)
		tracks.push(index === columns - 1 ? "minmax(240px, 1fr)" : `var(--arena-col-${index}, minmax(240px, 1fr))`);
	return tracks.join(" ");
}

export interface VoteOption {
	choice: ArenaChoice;
	label: string;
}

/** The labels this match has, then the two verdicts that name no contender. */
export function voteOptions(labels: readonly ArenaLabel[]): VoteOption[] {
	return [
		...labels.map((label) => ({ choice: label, label: `${label} is better` })),
		{ choice: "tie", label: "Tie" },
		{ choice: "both-bad", label: "All bad" },
	];
}

export type VoteState =
	| { kind: "waiting"; reason: string }
	| { kind: "open" }
	| { kind: "recorded"; choice: ArenaChoice; note: string | null };

export function voteState(match: Pick<ArenaMatch, "status" | "vote">): VoteState {
	if (match.vote) return { kind: "recorded", choice: match.vote.choice, note: match.vote.note };
	if (match.status === "running") return { kind: "waiting", reason: "Contenders are still running." };
	if (match.status === "failed")
		return { kind: "waiting", reason: "This match did not finish, so Clio does not take a vote on it." };
	return { kind: "open" };
}

export function choiceText(choice: ArenaChoice): string {
	if (choice === "tie") return "Tie";
	if (choice === "both-bad") return "All bad";
	return `${choice} won`;
}

export interface EntryFact {
	label: string;
	value: string;
}

const count = (value: number | null) => (value === null ? "not recorded" : String(value));

/** The facts a voter may weigh: what each contender did, never who it is or what it cost. */
export function entryFacts(entry: ArenaMatch["entries"][number]): EntryFact[] {
	const facts: EntryFact[] = [
		{ label: "Status", value: entry.timedOut ? "timed out" : entry.status },
		{ label: "Turns", value: count(entry.turns) },
		{ label: "Tool calls", value: count(entry.toolCalls) },
		{ label: "Tool errors", value: count(entry.toolErrors) },
		{ label: "Writes", value: count(entry.writes) },
		{ label: "Blocked", value: count(entry.blocks) },
		{
			label: "Diff",
			value: entry.diffStat
				? `${entry.diffStat.files} files, +${entry.diffStat.insertions} -${entry.diffStat.deletions}`
				: "none",
		},
	];
	if (entry.check)
		facts.push({
			label: `Check ${entry.check.id}`,
			value: entry.check.exitCode === 0 ? "passed" : `exit ${entry.check.exitCode ?? "none"}`,
		});
	if (entry.reveal) {
		facts.push(
			{ label: "Contender", value: `${entry.reveal.target}/${entry.reveal.model}` },
			{
				label: "Duration",
				value: entry.reveal.durationMs === null ? "not recorded" : `${(entry.reveal.durationMs / 1000).toFixed(1)} s`,
			},
			{ label: "Tokens", value: entry.reveal.tokens },
			{ label: "Cost", value: entry.reveal.cost },
		);
	}
	return facts;
}

export interface ContenderDraft {
	target: string;
	model: string;
}

export interface ArenaDraft {
	prompt: string;
	contenders: readonly ContenderDraft[];
	timeoutSeconds: string;
	suite: string;
	check: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

/** The request the form would send, or the first reason it cannot be sent yet. */
export function arenaRequest(draft: ArenaDraft): { request: ArenaStartRequest } | { problem: string } {
	const prompt = draft.prompt.trim();
	if (!prompt) return { problem: "Write the prompt every contender gets." };
	if (prompt.length > ARENA_PROMPT_MAX) return { problem: `The prompt is longer than ${ARENA_PROMPT_MAX} characters.` };
	const contenders = draft.contenders.filter((contender) => contender.target || contender.model);
	if (contenders.length < ARENA_MIN_CONTENDERS) return { problem: "Pick at least two contenders." };
	if (contenders.length > ARENA_MAX_CONTENDERS) return { problem: "A match takes at most four contenders." };
	for (const [index, contender] of contenders.entries()) {
		if (!ID.test(contender.target)) return { problem: `Contender ${index + 1} needs a target.` };
		if (!MODEL.test(contender.model)) return { problem: `Contender ${index + 1} needs a model id.` };
	}
	const timeoutSeconds = Number(draft.timeoutSeconds);
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600)
		return { problem: "The timeout is a whole number of seconds from 30 to 3600." };
	const suite = draft.suite.trim();
	if (suite && !ID.test(suite)) return { problem: "A suite name uses letters, digits, dots, dashes and underscores." };
	const check = draft.check.trim();
	if (check && !ID.test(check)) return { problem: "A check is a verifier id from verifiers.yaml." };
	return {
		request: {
			prompt,
			contenders: contenders.map(({ target, model }) => ({ target, model })),
			timeoutSeconds,
			...(suite ? { suite } : {}),
			...(check ? { check } : {}),
		},
	};
}

export interface StandingRow {
	identity: string;
	votes: number;
	record: string;
	bad: number;
	score: string;
}

export function standingRows(standings: ArenaStandings): StandingRow[] {
	return standings.standings.map((standing) => ({
		identity: standing.identity,
		votes: standing.votes,
		record: `${standing.wins}-${standing.losses}-${standing.ties}`,
		bad: standing.bad,
		score:
			standing.score === null
				? `needs ${standings.minVotesForScore - standing.votes} more ${standings.minVotesForScore - standing.votes === 1 ? "vote" : "votes"}`
				: String(standing.score),
	}));
}
