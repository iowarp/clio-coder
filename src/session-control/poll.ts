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
