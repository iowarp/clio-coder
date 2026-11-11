/**
 * `/report` review: the exact text a report sends, and the keys that decide whether it goes.
 *
 * One frame, four steps. Review shows the title and body as they will be posted, with what Clio masked; attach offers
 * the diagnostic bundle as ticks (never pre-ticked), lists its inventory, and `v` pages every member byte for byte; send lists the network actions in order and is the only step where a key
 * (`s`) sends. Enter never sends: a typed-ahead Enter can walk review and attach, and then stops. Esc goes back one
 * step, and on review it closes and keeps the draft. The controller is pure, so the promise is testable without a TUI.
 */

import {
	type DuplicateChoice,
	maskNoun,
	planHeadline,
	REPORT_THANKS,
	type RelatedVerdict,
	type ReportDraft,
	type ReportFlowOutcome,
	type ReportMask,
	type ReportPlan,
	relatedLine,
	SECRET_MASK_ID,
	sentLine,
} from "../../domains/report/index.js";
import {
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	stripTerminalSequences,
	type TUI,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import {
	createCachedBody,
	FocusBox,
	fitHintEntries,
	type HintEntry,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import { clioTheme, GLYPH, positionRow, sectionRule, selectionRow } from "../theme/index.js";

export const REPORT_REVIEW_TITLE = "Report to Clio Coder's maintainers";

export type ReportReviewStep = "review" | "masks" | "attach" | "bundle" | "send" | "sending" | "duplicates" | "done";

/** The attach step's ticks. Only `attach` adds a bundle; the rest refine it and are off until ticked. */
export interface ReportBundleChoice {
	attach: boolean;
	dataset: boolean;
	transcript: boolean;
	anonymizeModels: boolean;
}

/** A bundle built for the ticks on screen: its hash, its inventory lines, and every member as text for the pager. */
export interface ReportBundleView {
	sha256: string;
	summary: string[];
	pages: string[];
}

export type ChooseDuplicate = (
	verdict: RelatedVerdict,
	options: Array<{ value: DuplicateChoice; label: string }>,
) => Promise<DuplicateChoice>;

export interface ReportReviewOptions {
	draft: ReportDraft;
	/** The plan for a draft. Asked again after every change, and when the host learns who `gh` is signed in as. */
	plan(draft: ReportDraft): ReportPlan;
	/** Open the draft in `$EDITOR`; null when nothing came back. The host owns the terminal around the child. */
	edit(draft: ReportDraft): ReportDraft | null;
	/** False while the host is still learning how the report would go; `s` waits for it. Absent means ready. */
	ready?(): boolean;
	/**
	 * Send exactly the reviewed text. Only `s` on the send step calls it, and only once. `replyCheck` is the send
	 * step's tick: check the filed issue for a maintainer's reply once a day. Off unless ticked.
	 */
	send(
		draft: ReportDraft,
		plan: ReportPlan,
		choose: ChooseDuplicate,
		choices: { replyCheck: boolean; bundle: ReportBundleView | null },
	): Promise<ReportFlowOutcome>;
	/**
	 * Build the bundle for the ticks on screen, writing nothing; called again on every toggle. Absent means this
	 * surface offers no bundle. A rejection is shown as the reason no bundle can be attached.
	 */
	bundle?(choice: ReportBundleChoice): Promise<ReportBundleView>;
	/** Esc on review: the host keeps the draft and closes the review. */
	onCancel(draft: ReportDraft, plan: ReportPlan): void;
	/** The send settled: the host closes the review and leaves a line in the transcript. */
	onDone(outcome: ReportReviewDone): void;
	requestRender(): void;
}

export type ReportReviewDone =
	| { kind: "outcome"; outcome: ReportFlowOutcome }
	| { kind: "error"; message: string; draft: ReportDraft };

export interface ReportReview {
	step(): ReportReviewStep;
	draft(): ReportDraft;
	plan(): ReportPlan;
	/** Re-plan the same draft, for instance once the transport is known. */
	refresh(): void;
	handleInput(data: string): void;
	title(): string;
	hints(): HintEntry[];
	render(width: number, rows: number): string[];
}

const STEP_LABEL: Readonly<Record<ReportReviewStep, string>> = {
	review: "1/4 review",
	masks: "1/4 masks",
	attach: "2/4 attach",
	bundle: "2/4 bundle",
	send: "3/4 send",
	sending: "3/4 sending",
	duplicates: "3/4 already reported?",
	done: "4/4 done",
};

const HINTS: Readonly<Record<ReportReviewStep, ReadonlyArray<HintEntry>>> = {
	review: [
		{ key: "Enter", verb: "continue", critical: true },
		{ key: "e", verb: "edit in $EDITOR", short: "edit" },
		{ key: "m", verb: "mask or unmask a value", short: "masks" },
		{ key: "↑↓", verb: "scroll" },
		{ key: "Esc", verb: "cancel, keep a draft", short: "cancel", critical: true },
	],
	masks: [
		{ key: "Space", verb: "mask or unmask", short: "toggle", critical: true },
		{ key: "↑↓", verb: "select" },
		{ key: "Esc", verb: "back", critical: true },
	],
	attach: [
		{ key: "Enter", verb: "continue", critical: true },
		{ key: "b", verb: "attach a diagnostic bundle", short: "bundle" },
		{ key: "d", verb: "allow datasets", short: "dataset" },
		{ key: "t", verb: "include the transcript", short: "transcript" },
		{ key: "a", verb: "anonymize model ids", short: "anon" },
		{ key: "v", verb: "view every byte", short: "view" },
		{ key: "Esc", verb: "back", critical: true },
	],
	bundle: [
		{ key: "↑↓", verb: "scroll" },
		{ key: "Esc", verb: "back", critical: true },
	],
	send: [
		{ key: "s", verb: "send", critical: true },
		{ key: "c", verb: "credit me", short: "credit" },
		{ key: "r", verb: "check for replies daily", short: "replies" },
		{ key: "Esc", verb: "back", critical: true },
	],
	sending: [],
	duplicates: [
		{ key: "Enter", verb: "choose", critical: true },
		{ key: "↑↓", verb: "select" },
		{ key: "Esc", verb: "cancel", critical: true },
	],
	done: [{ key: "Enter", verb: "close", critical: true }],
};

/** Rows of body shown when the frame has not said how many it has. */
const DEFAULT_BODY_ROWS = 16;

/** Text a person or the model wrote, shown as plain text: no escape sequence from it reaches the terminal. */
function plainRows(text: string, width: number): string[] {
	const rows: string[] = [];
	for (const line of stripTerminalSequences(text).replace(/\t/gu, "  ").split(/\r?\n/u)) {
		if (line.length === 0) rows.push("");
		else rows.push(...wrapTextWithAnsi(line, width));
	}
	return rows;
}

/** "New since your edit: 1 path." for masks that appeared or grew in an edit; null when none did. */
function maskDelta(before: ReadonlyArray<ReportMask>, after: ReadonlyArray<ReportMask>): string | null {
	const previous = new Map(before.map((mask) => [mask.id, mask.count]));
	const totals = new Map<ReportMask["kind"], number>();
	for (const mask of after) {
		const grew = mask.count - (previous.get(mask.id) ?? 0);
		if (grew > 0) totals.set(mask.kind, (totals.get(mask.kind) ?? 0) + grew);
	}
	if (totals.size === 0) return null;
	return `New since your edit: ${[...totals.entries()].map(([kind, count]) => maskNoun(kind, count)).join(", ")}.`;
}

export function createReportReview(options: ReportReviewOptions): ReportReview {
	let draft = options.draft;
	let plan = options.plan(draft);
	let step: ReportReviewStep = "review";
	let scroll = 0;
	let maxScroll = 0;
	let maskCursor = 0;
	let editNote: string | null = null;
	let duplicate: {
		verdict: RelatedVerdict;
		options: Array<{ value: DuplicateChoice; label: string }>;
		cursor: number;
		resolve: (choice: DuplicateChoice) => void;
	} | null = null;
	let finished: ReportReviewDone | null = null;
	let sent = false;
	let replyCheck = false;
	const choice: ReportBundleChoice = { attach: false, dataset: false, transcript: false, anonymizeModels: false };
	let built: ReportBundleView | null = null;
	let building = false;
	let bundleError: string | null = null;
	let generation = 0;
	let pageScroll = 0;
	let pageMax = 0;
	// Every toggle rebuilds; only the newest build lands, so the hash on screen is always the ticks on screen.
	const rebuild = (): void => {
		generation += 1;
		const mine = generation;
		built = null;
		bundleError = null;
		const builder = options.bundle;
		building = choice.attach && builder !== undefined;
		if (!building || builder === undefined) return;
		const ask = { ...choice };
		Promise.resolve()
			.then(() => builder(ask))
			.then(
				(view) => {
					if (mine !== generation) return;
					built = view;
					building = false;
					options.requestRender();
				},
				(error: unknown) => {
					if (mine !== generation) return;
					bundleError = error instanceof Error ? error.message : String(error);
					building = false;
					options.requestRender();
				},
			);
	};
	// A ticked bundle that is not built yet, or failed, holds the attach step: nothing unbuilt is promised.
	const attachReady = (): boolean => !choice.attach || built !== null;
	// The check reads the filed issue through the reporter's gh; a browser, a file or a discussion has nothing to read.
	const canCheckReplies = (): boolean => plan.postedAs.startsWith("posted") && draft.kind !== "question";
	// Every mask seen in this review, so one the operator let through stays listed and can be masked again.
	const known = new Map<string, ReportMask>();
	const remember = (): void => {
		for (const mask of plan.masks) known.set(mask.id, mask);
	};
	remember();

	const replan = (next: ReportDraft): void => {
		draft = next;
		plan = options.plan(draft);
		remember();
	};
	const go = (next: ReportReviewStep): void => {
		step = next;
		options.requestRender();
	};
	const maskList = (): ReportMask[] => [...known.values()];

	const ready = (): boolean => options.ready?.() !== false;
	const startSend = (): void => {
		if (sent || !ready()) return;
		sent = true;
		step = "sending";
		options.requestRender();
		const choose: ChooseDuplicate = (verdict, choices) =>
			new Promise<DuplicateChoice>((resolve) => {
				duplicate = { verdict, options: choices, cursor: 0, resolve };
				go("duplicates");
			});
		const settle = (done: ReportReviewDone): void => {
			finished = done;
			go("done");
		};
		Promise.resolve()
			.then(() =>
				options.send(draft, plan, choose, {
					replyCheck: replyCheck && canCheckReplies(),
					bundle: choice.attach ? built : null,
				}),
			)
			.then(
				(outcome) => settle({ kind: "outcome", outcome }),
				(error: unknown) =>
					settle({ kind: "error", message: error instanceof Error ? error.message : String(error), draft }),
			);
	};

	const chooseDuplicate = (choice: DuplicateChoice): void => {
		const pending = duplicate;
		if (pending === null) return;
		duplicate = null;
		go("sending");
		pending.resolve(choice);
	};

	const handleInput = (data: string): void => {
		if (isKeyRelease(data)) return;
		switch (step) {
			case "review": {
				if (matchesKey(data, "enter")) {
					if (plan.gates.length === 0) go("attach");
					return;
				}
				if (matchesKey(data, "escape")) {
					options.onCancel(draft, plan);
					return;
				}
				if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
				else if (matchesKey(data, "down")) scroll = Math.min(maxScroll, scroll + 1);
				else if (matchesKey(data, "e") || matchesKey(data, "shift+e")) {
					const before = plan.masks;
					const edited = options.edit(draft);
					if (edited !== null) {
						replan(edited);
						editNote = maskDelta(before, plan.masks);
						scroll = 0;
					}
				} else if (matchesKey(data, "m")) {
					if (known.size > 0) {
						maskCursor = 0;
						step = "masks";
					}
				}
				options.requestRender();
				return;
			}
			case "masks": {
				const masks = maskList();
				if (matchesKey(data, "escape") || matchesKey(data, "m")) go("review");
				else if (matchesKey(data, "up")) {
					maskCursor = Math.max(0, maskCursor - 1);
					options.requestRender();
				} else if (matchesKey(data, "down")) {
					maskCursor = Math.min(masks.length - 1, maskCursor + 1);
					options.requestRender();
				} else if (matchesKey(data, "space") || matchesKey(data, "enter")) {
					const mask = masks[maskCursor];
					if (mask === undefined || mask.id === SECRET_MASK_ID) return;
					const unmasked = draft.unmasked.includes(mask.id)
						? draft.unmasked.filter((id) => id !== mask.id)
						: [...draft.unmasked, mask.id];
					replan({ ...draft, unmasked });
					options.requestRender();
				}
				return;
			}
			case "attach": {
				if (matchesKey(data, "enter")) {
					if (attachReady()) go("send");
					return;
				}
				if (matchesKey(data, "escape")) {
					go("review");
					return;
				}
				if (options.bundle === undefined) return;
				const tick = (["b", "d", "t", "a"] as const).find((key) => matchesKey(data, key));
				if (tick !== undefined) {
					if (tick === "b") choice.attach = !choice.attach;
					else if (!choice.attach) return;
					else if (tick === "d") choice.dataset = !choice.dataset;
					else if (tick === "t") choice.transcript = !choice.transcript;
					else choice.anonymizeModels = !choice.anonymizeModels;
					rebuild();
					options.requestRender();
				} else if (matchesKey(data, "v") && built !== null) {
					pageScroll = 0;
					go("bundle");
				}
				return;
			}
			case "bundle":
				if (matchesKey(data, "escape") || matchesKey(data, "v") || matchesKey(data, "q")) go("attach");
				else if (matchesKey(data, "up")) pageScroll = Math.max(0, pageScroll - 1);
				else if (matchesKey(data, "down")) pageScroll = Math.min(pageMax, pageScroll + 1);
				else if (matchesKey(data, "pageUp")) pageScroll = Math.max(0, pageScroll - 10);
				else if (matchesKey(data, "pageDown")) pageScroll = Math.min(pageMax, pageScroll + 10);
				options.requestRender();
				return;
			case "send":
				// Enter is deliberately inert here, so an Enter typed ahead through the first two steps cannot send.
				if (matchesKey(data, "s")) startSend();
				else if (matchesKey(data, "c")) {
					replan({ ...draft, credit: draft.credit !== true });
					options.requestRender();
				} else if (matchesKey(data, "r")) {
					if (canCheckReplies()) replyCheck = !replyCheck;
					options.requestRender();
				} else if (matchesKey(data, "escape")) go("attach");
				return;
			case "sending":
				return;
			case "duplicates": {
				const pending = duplicate;
				if (pending === null) return;
				if (matchesKey(data, "up")) pending.cursor = Math.max(0, pending.cursor - 1);
				else if (matchesKey(data, "down")) pending.cursor = Math.min(pending.options.length - 1, pending.cursor + 1);
				else if (matchesKey(data, "enter")) {
					const choice = pending.options[pending.cursor];
					if (choice !== undefined) chooseDuplicate(choice.value);
					return;
				} else if (matchesKey(data, "escape")) {
					if (pending.options.some((option) => option.value === "stop")) chooseDuplicate("stop");
					return;
				}
				options.requestRender();
				return;
			}
			case "done":
				if ((matchesKey(data, "enter") || matchesKey(data, "escape")) && finished !== null) options.onDone(finished);
				return;
		}
	};

	const render = (width: number, rows: number): string[] => {
		const theme = clioTheme();
		const w = Math.max(1, Math.floor(width));
		// A written file or an opened browser form has not reached GitHub yet.
		const sentAlready =
			finished?.kind === "outcome" &&
			finished.outcome.kind === "sent" &&
			["sent", "commented", "reacted"].includes(finished.outcome.result.status);
		const head = wrapTextWithAnsi(
			theme.fg(
				"annotation",
				`${planHeadline(plan, ` ${GLYPH.dot} `)}${sentAlready ? "" : ` ${GLYPH.dot} nothing sent yet`}`,
			),
			w,
		);
		const warn = (text: string): string[] => wrapTextWithAnsi(theme.fg("warning", `${GLYPH.warn} ${text}`), w);
		const note = (text: string): string[] => wrapTextWithAnsi(theme.fg("annotation", text), w);
		switch (step) {
			case "review": {
				const tail = [
					...note(plan.maskSummary),
					...(editNote !== null ? note(editNote) : []),
					...plan.gates.flatMap((gate) => warn(`Cannot send yet: ${gate}`)),
				];
				const document = [...plainRows(plan.rendered.body, w)];
				const title = plainRows(plan.rendered.title, w).map((line) => theme.style("menuOption", line, { bold: true }));
				const fixed = head.length + 1 + title.length + 1 + tail.length;
				const budget = rows > 0 ? Math.max(3, rows - fixed) : DEFAULT_BODY_ROWS;
				const fits = document.length <= budget;
				const pane = windowRows(document, scroll, fits ? budget : budget - 1);
				maxScroll = pane.maxScroll;
				scroll = Math.min(scroll, maxScroll);
				return [
					...head,
					sectionRule(theme, w, "Title"),
					...title,
					sectionRule(theme, w, "Body, exactly as it will be sent"),
					...pane.window,
					...(pane.position === null ? [] : [positionRow(theme, pane.position, w)]),
					...tail,
				];
			}
			case "masks": {
				const lines = [...head, sectionRule(theme, w, "What Clio masked")];
				maskList().forEach((mask, index) => {
					const secret = mask.id === SECRET_MASK_ID;
					const masked = secret || !draft.unmasked.includes(mask.id);
					lines.push(
						...selectionRow(theme, {
							focused: index === maskCursor,
							label: `[${masked ? "x" : " "}] ${maskNoun(mask.kind, mask.count)}`,
							meta: secret ? "always masked" : masked ? "masked" : "sent as written",
							width: w,
						}),
					);
				});
				lines.push(...note("Values never leave this machine to be shown here; only their kind and count."));
				return lines;
			}
			case "attach": {
				const tickRow = (on: boolean, key: string, label: string): string[] =>
					wrapTextWithAnsi(`  [${on ? "x" : " "}] ${key}  ${label}`, w);
				const offer = tickRow(choice.attach, "b", "Attach a diagnostic bundle: this session's telemetry mechanics");
				if (options.bundle === undefined || !choice.attach)
					return [
						...head,
						sectionRule(theme, w, "Attach"),
						...wrapTextWithAnsi("No diagnostic bundle is attached.", w),
						...note("Only the title and body you just reviewed are sent."),
						...(options.bundle !== undefined ? ["", ...offer] : []),
					];
				return [
					...head,
					sectionRule(theme, w, "Attach"),
					...offer,
					...tickRow(choice.dataset, "d", "Also allow its mechanics in public datasets"),
					...tickRow(choice.transcript, "t", "Include the transcript: your prompts and code"),
					...tickRow(choice.anonymizeModels, "a", "Anonymize model ids"),
					"",
					...(building ? note(`Building the bundle${GLYPH.ellipsis}`) : []),
					...(bundleError !== null ? warn(`No bundle can be attached: ${bundleError}`) : []),
					...(built !== null ? built.summary.flatMap((line) => plainRows(line, w)) : []),
					...(built !== null ? note("v shows every byte of it.") : []),
				];
			}
			case "bundle": {
				const document = (built?.pages ?? []).flatMap((line) => plainRows(line, w));
				const budget = rows > 0 ? Math.max(3, rows - head.length - 2) : DEFAULT_BODY_ROWS;
				const pane = windowRows(document, pageScroll, budget);
				pageMax = pane.maxScroll;
				pageScroll = Math.min(pageScroll, pageMax);
				return [
					...head,
					sectionRule(theme, w, `Bundle sha256 ${built?.sha256.slice(0, 12) ?? ""}`),
					...pane.window,
					...(pane.position === null ? [] : [positionRow(theme, pane.position, w)]),
				];
			}
			case "send":
			case "sending": {
				const login = plan.postedAs.startsWith("posted as ") ? plan.postedAs.slice("posted as ".length) : "me";
				return [
					...head,
					sectionRule(theme, w, step === "sending" ? `Sending${GLYPH.ellipsis}` : "Send"),
					...wrapTextWithAnsi("Sending will, in this order:", w),
					...plan.actions.flatMap((action, index) => wrapTextWithAnsi(`  ${index + 1}. ${action}`, w)),
					"",
					...wrapTextWithAnsi(`  [${plan.credit ? "x" : " "}] Credit ${login} in the release notes when this is fixed`, w),
					...(canCheckReplies()
						? wrapTextWithAnsi(
								`  [${replyCheck ? "x" : " "}] Check this issue once a day for a maintainer's reply, using your gh`,
								w,
							)
						: []),
					...(choice.attach && built !== null
						? note(
								`The diagnostic bundle (sha256 ${built.sha256.slice(0, 12)}) is kept on this machine with the report; clio-coder report show ${draft.id} --bundle prints it.`,
							)
						: []),
					...(plan.rateWarning !== null ? warn(plan.rateWarning) : []),
					...(step === "send" && !ready() ? note(`Checking how this report would be sent${GLYPH.ellipsis}`) : []),
				];
			}
			case "duplicates": {
				const pending = duplicate;
				const lines = [...head, sectionRule(theme, w, "This may already be reported")];
				if (pending === null) return lines;
				if ("issue" in pending.verdict) lines.push(...plainRows(relatedLine(pending.verdict.issue), w), "");
				pending.options.forEach((option, index) => {
					lines.push(...selectionRow(theme, { focused: index === pending.cursor, label: option.label, width: w }));
				});
				return lines;
			}
			case "done": {
				const lines = [...head, sectionRule(theme, w, "Done")];
				if (finished === null) return lines;
				if (finished.kind === "error")
					return [
						...lines,
						...warn(`Not sent: ${finished.message}.`),
						...note("The draft is kept; /report status lists it."),
					];
				const outcome = finished.outcome;
				if (outcome.kind === "stopped")
					return [
						...lines,
						...wrapTextWithAnsi("Nothing was sent.", w),
						...note("Kept as a draft; /report status lists it."),
					];
				if (outcome.result.status === "failed")
					return [
						...lines,
						...warn(sentLine(outcome.result)),
						...note(`The draft is kept; /report send ${outcome.draft.id} tries again.`),
					];
				return [
					...lines,
					...plainRows(sentLine(outcome.result), w),
					...wrapTextWithAnsi(REPORT_THANKS, w),
					...note("/report status lists it."),
				];
			}
		}
	};

	return {
		step: () => step,
		draft: () => draft,
		plan: () => plan,
		refresh(): void {
			replan(draft);
			options.requestRender();
		},
		handleInput,
		title: () => `${REPORT_REVIEW_TITLE} ${GLYPH.dot} ${STEP_LABEL[step]}`,
		hints: () => {
			if (step === "review" && plan.gates.length > 0) return HINTS.review.filter((hint) => hint.key !== "Enter");
			if (step === "review" && known.size === 0) return HINTS.review.filter((hint) => hint.key !== "m");
			if (step === "attach") {
				const offered = options.bundle !== undefined;
				return HINTS.attach.filter((hint) => {
					if (hint.key === "Enter") return attachReady();
					if (hint.key === "Esc") return true;
					if (hint.key === "b") return offered;
					if (hint.key === "v") return built !== null;
					return offered && choice.attach;
				});
			}
			if (step === "send")
				return HINTS.send.filter((hint) => (hint.key !== "s" || ready()) && (hint.key !== "r" || canCheckReplies()));
			return [...HINTS[step]];
		},
		render,
	};
}

const REPORT_REVIEW_MIN_WIDTH = 44;
const REPORT_REVIEW_MAX_WIDTH = 100;

export interface ReportReviewOverlaySession extends OverlayHandle {
	review: ReportReview;
}

/** The review in the neutral frame; the headline stays pinned on its first row at every step. */
export function openReportReviewOverlay(
	tui: TUI,
	options: Omit<ReportReviewOptions, "requestRender"> & { columns: number },
): ReportReviewOverlaySession {
	let touch = (): void => {};
	const review = createReportReview({
		...options,
		requestRender: () => {
			touch();
			tui.requestRender(true);
		},
	});
	const body = createCachedBody((width, rows) => review.render(width, rows));
	touch = () => body.touch();
	const focus = new FocusBox(body, { onInput: (data) => review.handleInput(data) });
	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: Math.max(REPORT_REVIEW_MIN_WIDTH, Math.min(REPORT_REVIEW_MAX_WIDTH, options.columns - 4)),
		markerId: "report-review",
		title: () => review.title(),
		footerHint: (innerWidth) => fitHintEntries(review.hints(), innerWidth - 3),
	});
	return { ...handle, review };
}
