/**
 * `/poll [--options a|b|c] [--models <target[/model]>,...] [--rationale] <n> <question>`:
 * an opinion poll of n independent participants.
 *
 * A poll is a one-round council with vote synthesis and explicit members, so
 * it runs through the same dispatch-tool path `/council` takes: admission, the
 * approval overlay, member cards and the tally are the council's. No member
 * sees another's answer, because a single round never shares peer answers.
 *
 * Pure: no I/O, no dispatch. The caller owns the run.
 */

import {
	COUNCIL_BALLOT_VERDICT_MAX_BYTES,
	COUNCIL_SEAT_NOT_RUN_WORDS,
	isCouncilBallotOption,
	isCouncilSeatNotRun,
} from "../domains/agents/index.js";

/** Council member bounds the dispatch tool admits; a poll seats the same. */
export const POLL_MIN_PARTICIPANTS = 2;
export const POLL_MAX_PARTICIPANTS = 5;

export interface PollSeat {
	target: string;
	model?: string;
}

export interface PollCommandOptions {
	participants: number;
	question: string;
	options?: ReadonlyArray<string>;
	/** `--models` entries, `target` or `target/model`. */
	models?: ReadonlyArray<string>;
	rationale?: boolean;
	memberDeadlineMs?: number;
}

/** `target` or `target/model`, split at the first slash so a model id may itself hold slashes. */
export function parsePollSeat(entry: string): PollSeat | undefined {
	const trimmed = entry.trim();
	if (trimmed.length === 0) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash < 0) return { target: trimmed };
	const target = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	if (target.length === 0 || model.length === 0) return undefined;
	return { target, model };
}

/**
 * Why a `--options` choice cannot bind the ballot, or undefined when it can. The
 * vote recovers the choices from the task this module writes, joined by ", ",
 * so a choice holding that separator would read back as two; and a choice past
 * the verdict bound could never be cast verbatim.
 */
export function pollChoiceProblem(choice: string): string | undefined {
	if (choice.includes(", ")) {
		return `choice "${choice}" holds ", ", which separates the choices each participant reads; drop the comma or the space after it`;
	}
	if (Buffer.byteLength(choice, "utf8") > COUNCIL_BALLOT_VERDICT_MAX_BYTES) {
		return `choice "${choice}" is longer than ${COUNCIL_BALLOT_VERDICT_MAX_BYTES} bytes, the most a verdict holds`;
	}
	if (!isCouncilBallotOption(choice)) return `choice "${choice}" is not a single line a participant can cast verbatim`;
	return undefined;
}

/** The ask every participant receives, before the council's own vote directive is appended. */
export function renderPollQuestion(options: PollCommandOptions): string {
	const parts = [
		"You are one participant in an opinion poll. Answer from your own judgment, independently; do not search the workspace unless the question is about it.",
		`Question: ${options.question}`,
	];
	if (options.options !== undefined && options.options.length > 0) {
		parts.push(
			`Choose exactly one of these options: ${options.options.join(", ")}. Your verdict is that option, verbatim.`,
		);
	}
	parts.push(
		options.rationale === true
			? "In the ballot text give your rationale in at most three sentences."
			: "Keep the ballot text to one sentence.",
	);
	return parts.join("\n");
}

export type PollDispatchArgs = { ok: true; args: Record<string, unknown> } | { ok: false; reason: string };

/**
 * The dispatch-tool arguments this poll becomes. Seats cycle over `--models`;
 * without it every participant runs on the chat target and model.
 */
export function buildPollDispatchArgs(options: PollCommandOptions, chat: Partial<PollSeat>): PollDispatchArgs {
	const n = options.participants;
	if (!Number.isInteger(n) || n < POLL_MIN_PARTICIPANTS || n > POLL_MAX_PARTICIPANTS) {
		return { ok: false, reason: `participants must be an integer ${POLL_MIN_PARTICIPANTS}..${POLL_MAX_PARTICIPANTS}` };
	}
	let seats: PollSeat[];
	if (options.models !== undefined && options.models.length > 0) {
		seats = [];
		for (const entry of options.models) {
			const seat = parsePollSeat(entry);
			if (seat === undefined) return { ok: false, reason: `--models entry "${entry}" is not target or target/model` };
			seats.push(seat);
		}
	} else {
		if (chat.target === undefined || chat.target.length === 0) {
			return { ok: false, reason: "no chat target is set; name participants with --models <target[/model]>" };
		}
		seats = [
			{ target: chat.target, ...(chat.model !== undefined && chat.model.length > 0 ? { model: chat.model } : {}) },
		];
	}
	const members = Array.from({ length: n }, (_, index) => {
		const seat = seats[index % seats.length] as PollSeat;
		return { label: `p${index + 1}`, target: seat.target, ...(seat.model !== undefined ? { model: seat.model } : {}) };
	});
	return {
		ok: true,
		args: {
			mode: "council",
			task: renderPollQuestion(options),
			members,
			synthesis: "vote",
			...(options.memberDeadlineMs !== undefined ? { member_deadline_ms: options.memberDeadlineMs } : {}),
		},
	};
}

/** The distribution a person reads: verdicts by count, with share and a bar. */
export function formatPollTally(tally: Readonly<Record<string, number>>, participants: number): string {
	const ranked = Object.entries(tally).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	const voted = ranked.reduce((sum, [, count]) => sum + count, 0);
	if (ranked.length === 0) return `poll: no participant cast a ballot (0 of ${participants})`;
	const width = Math.max(...ranked.map(([verdict]) => verdict.length));
	const lines = ranked.map(([verdict, count]) => {
		const share = Math.round((count / voted) * 100);
		return `  ${verdict.padEnd(width)}  ${"#".repeat(count)} ${count} (${share}%)`;
	});
	const top = ranked[0] as [string, number];
	const second = ranked[1];
	const headline =
		top[1] > voted / 2
			? `majority: ${top[0]}`
			: second !== undefined && second[1] === top[1]
				? "tie"
				: `plurality: ${top[0]}`;
	return [`poll: ${voted} of ${participants} voted; ${headline}`, ...lines].join("\n");
}

/** A council result's final-round seats from `details.council`, in roster order; undefined when it carries none. */
function councilFinalSeats(
	details: Readonly<Record<string, unknown>> | undefined,
): Array<{ label?: unknown; round?: unknown; runId?: unknown; failed?: unknown }> | undefined {
	const council = details?.council;
	if (council === null || typeof council !== "object") return undefined;
	const raw = (council as { members?: unknown }).members;
	if (!Array.isArray(raw)) return undefined;
	const members = raw.filter(
		(member): member is { label?: unknown; round?: unknown; runId?: unknown; failed?: unknown } =>
			member !== null && typeof member === "object",
	);
	const finalRound = Math.max(...members.map((member) => (typeof member.round === "number" ? member.round : 1)));
	return members.filter((member) => (typeof member.round === "number" ? member.round : 1) === finalRound);
}

/**
 * The final-round members that failed while at least one other answered, from a council result's `details.council`.
 * Undefined when every member answered or none did: only the mixed case is a partial council. A seat whose target was
 * down never ran, so it is neither an answer nor a failure here and the counts are of the seats that ran (FX-20).
 */
export function councilShortfall(
	details: Readonly<Record<string, unknown>> | undefined,
): { answered: number; total: number; failed: string[] } | undefined {
	const finals = councilFinalSeats(details)?.filter((member) => !isCouncilSeatNotRun(member));
	if (finals === undefined) return undefined;
	const failed = finals
		.filter((member) => member.failed !== undefined)
		.map((member) => String(member.label ?? "member"));
	const answered = finals.length - failed.length;
	if (answered === 0 || failed.length === 0) return undefined;
	return { answered, total: finals.length, failed };
}

/**
 * The final-round seats admission skipped because their target was down, with how many of the seats that ran
 * answered, so `/council` names a skipped seat without calling the council partial. Undefined when none was skipped.
 */
export function councilSkippedSeats(
	details: Readonly<Record<string, unknown>> | undefined,
): { answered: number; ran: number; labels: string[] } | undefined {
	const finals = councilFinalSeats(details);
	if (finals === undefined) return undefined;
	const labels = finals.filter(isCouncilSeatNotRun).map((member) => String(member.label ?? "member"));
	if (labels.length === 0) return undefined;
	const ran = finals.filter((member) => !isCouncilSeatNotRun(member));
	return { answered: ran.filter((member) => member.failed === undefined).length, ran: ran.length, labels };
}

/** The words `/council` adds for skipped seats, in the copy every council surface uses. */
export function councilSkippedWords(labels: ReadonlyArray<string>): string {
	return labels.map((label) => `${label}: ${COUNCIL_SEAT_NOT_RUN_WORDS}`).join("; ");
}

/** The vote tally a council result carries in `details.council.synthesis`, when it ran a vote. */
export function voteTally(details: Readonly<Record<string, unknown>> | undefined): Record<string, number> | undefined {
	const council = details?.council;
	if (council === null || typeof council !== "object") return undefined;
	const synthesis = (council as { synthesis?: unknown }).synthesis;
	if (synthesis === null || typeof synthesis !== "object") return undefined;
	const tally = (synthesis as { tally?: unknown }).tally;
	if (tally === null || typeof tally !== "object" || Array.isArray(tally)) return undefined;
	const out: Record<string, number> = {};
	for (const [verdict, count] of Object.entries(tally)) if (typeof count === "number") out[verdict] = count;
	return out;
}
