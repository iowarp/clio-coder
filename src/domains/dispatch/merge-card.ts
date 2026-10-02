import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { createHarnessHold } from "../../tools/registry.js";
import type { DecisionPresentation } from "../safety/decision-presentation.js";
import { hostCheckBaseNote } from "./host-verification-note.js";
import { boundedCheck } from "./merge-gate.js";
import type { RunHostVerification } from "./types.js";

/**
 * The operator's answer to a withheld task-worktree merge. The gate in
 * merge-gate.ts decides that a merge is held; this card lets an attached
 * operator overrule that for one branch. Headless and ACP surfaces have no
 * operator and never build one, so they keep withholding.
 */
export type MergeCardChoice = "merge" | "keep" | "discard";

/** Why the card settled: an answer, or the fallback that applies Keep branch. */
export type MergeCardCause = "answered" | "unlisted" | "escaped" | "timeout" | "aborted";

export interface MergeCardOutcome {
	choice: MergeCardChoice;
	cause: MergeCardCause;
}

/** How a Keep branch came about, for the receipt detail. */
export function mergeCardCauseNote(cause: MergeCardCause): string {
	switch (cause) {
		case "answered":
			return "Keep branch chosen on the card";
		case "unlisted":
			return "the answer typed on the card was not one of its options";
		case "escaped":
			// Esc, Ctrl+C, and a handler that went away all settle the round as cancelled.
			return "the card was dismissed without an answer";
		case "timeout":
			return "no answer before the escalation timeout";
		case "aborted":
			return "the run was canceled while the card was open";
	}
}

export interface MergeCardInput {
	hostVerification?: RunHostVerification;
	branch: string;
	changedPaths: ReadonlyArray<string>;
	/** The gate's reason clause, as `mergeGateVerdict` words it. */
	reason: string;
	/**
	 * Protected paths the branch changes. A merge of such a branch fails closed,
	 * so the card does not offer it and says why instead of offering a choice
	 * that can only be refused afterwards.
	 */
	protectedPaths?: ReadonlyArray<string>;
}

export interface MergeCardDeps {
	ask: AskUserHandler;
	/**
	 * Bounds the whole card, including a wait for a busy screen and the discard
	 * confirm. Absent, the card waits for the operator, Esc, or an abort.
	 */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Delay between attempts while another overlay owns the screen. */
	retryMs?: number;
}

const MERGE = "Merge";
const KEEP = "Keep branch";
const DISCARD = "Discard";
const DELETE = "Delete";
const BACK = "Back";
const LISTED_PATHS = 8;
const DEFAULT_RETRY_MS = 500;

function mergeCardPresentation(title: string, authorization: string, reversibility: string): DecisionPresentation {
	return {
		tier: "workspace",
		tierLabel: "Task merge",
		title,
		semanticToken: "action",
		authorizationCopy: authorization,
		consequenceCopy: "The answer decides what happens to this task's branch and worktree.",
		reversibilityCopy: reversibility,
		requestedByCopy: "the dispatch merge gate",
		requiredActions: [
			{ id: "record-answer", label: "Choose", consequence: "Applies the highlighted option to this task branch." },
			{ id: "cancel", label: "Keep branch", consequence: "Leaves the branch preserved and merges nothing." },
		],
	};
}

function choosePresentation(offerMerge: boolean): DecisionPresentation {
	return mergeCardPresentation(
		"Merge task branch?",
		offerMerge
			? "Merge lands the branch on your current branch through the same guarded path as an ordinary merge. Keep branch merges nothing. Discard asks once more before deleting."
			: "Keep branch merges nothing. Discard asks once more before deleting. Merge is not offered because the branch changes protected paths.",
		offerMerge
			? "Reversible: Merge and Keep branch can be undone or redone with git. Discard deletes the branch and cannot be undone."
			: "Reversible: Keep branch can be undone with git. Discard deletes the branch and cannot be undone.",
	);
}

const CONFIRM_PRESENTATION = mergeCardPresentation(
	"Discard task branch?",
	"Delete removes the task branch and its worktree. Back returns to the merge choice.",
	"Reversible: no. The deleted branch is not recoverable from Clio.",
);

function offersMerge(input: MergeCardInput): boolean {
	return (input.protectedPaths?.length ?? 0) === 0;
}

function mergeCardQuestion(input: MergeCardInput): AskUserQuestion {
	const total = input.changedPaths.length;
	const listed = input.changedPaths.slice(0, LISTED_PATHS).map((path) => `- ${boundedCheck(path)}`);
	const omitted = total - listed.length;
	const noun = total === 1 ? "path" : "paths";
	const protectedPaths = input.protectedPaths ?? [];
	const options = [
		...(offersMerge(input) ? [{ label: MERGE, description: "Land it on your current branch now." }] : []),
		{ label: KEEP, description: `Leave it on ${input.branch}; \`git merge ${input.branch}\` applies it later.` },
		{ label: DISCARD, description: "Delete the branch and its worktree after one more confirmation." },
	];
	return {
		header: "Merge task branch?",
		// Opens on Keep branch: an Enter that lands as the card appears must not merge.
		defaultOption: options.findIndex((option) => option.label === KEEP),
		question: [
			`Branch ${input.branch} changes ${total} ${noun}:`,
			...listed,
			...(omitted > 0 ? [`- … and ${omitted} more`] : []),
			"",
			`The merge was held because ${input.reason}.`,
			...(input.hostVerification?.checks
				.filter((check) => check.exitCode !== 0)
				.map((check) => `Host check '${check.check}': ${hostCheckBaseNote(check)}.`) ?? []),
			...(protectedPaths.length > 0
				? [
						`Merge is not offered: the branch changes protected ${protectedPaths.length === 1 ? "path" : "paths"} ${protectedPaths.map(boundedCheck).join(", ")}, which a merge never lands.`,
					]
				: []),
		].join("\n"),
		options,
	};
}

function discardConfirmQuestion(branch: string): AskUserQuestion {
	return {
		header: "Discard",
		// Opens on Back: an Enter that lands as the confirm appears must not delete.
		defaultOption: 1,
		question: `Delete branch ${branch} and its worktree? This cannot be undone.`,
		options: [
			{ label: DELETE, description: "Remove the branch and its worktree." },
			{ label: BACK, description: "Return to the merge choice." },
		],
	};
}

function chose(result: AskUserResult, label: string): boolean {
	// Only a labelled pick counts. Text typed into the implicit Other choice is
	// not consent to merge or delete, whatever it says.
	return result.answers[0]?.options?.includes(label) === true;
}

/**
 * Put the merge card to the operator. Esc, a timeout, and an abort all settle
 * on Keep branch, the behavior of a surface with no operator. Esc on the
 * discard confirm is Back.
 */
export async function askMergeCard(deps: MergeCardDeps, input: MergeCardInput): Promise<MergeCardOutcome> {
	const controller = new AbortController();
	let timedOut = false;
	const timer =
		deps.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, deps.timeoutMs);
	const onParentAbort = (): void => controller.abort();
	if (deps.signal?.aborted === true) controller.abort();
	deps.signal?.addEventListener("abort", onParentAbort, { once: true });
	// Both rounds of the card, and the card again after Back, hold the screen
	// together: a waiting model question must not slip in between them.
	const hold = createHarnessHold();
	const options = { origin: "harness" as const, signal: controller.signal, harnessHold: hold };
	const keep = (cause: MergeCardCause): MergeCardOutcome => ({ choice: "keep", cause });
	const stopped = (): MergeCardOutcome => keep(timedOut ? "timeout" : "aborted");
	const waitForScreen = (): Promise<void> =>
		new Promise((resolve) => {
			const wake = setTimeout(resolve, deps.retryMs ?? DEFAULT_RETRY_MS);
			wake.unref?.();
			controller.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(wake);
					resolve();
				},
				{ once: true },
			);
		});
	// A round another overlay refused is retried until the card's own window
	// closes, so a permission prompt on screen delays the card rather than
	// silently settling it.
	const put = async (question: AskUserQuestion, presentation: DecisionPresentation): Promise<AskUserResult | null> => {
		for (;;) {
			if (controller.signal.aborted) return null;
			const result = await deps.ask([question], { ...options, decisionPresentation: presentation });
			if (controller.signal.aborted) return null;
			if (result.unavailable !== true) return result;
			await waitForScreen();
		}
	};
	try {
		for (;;) {
			const picked = await put(mergeCardQuestion(input), choosePresentation(offersMerge(input)));
			if (picked === null) return stopped();
			if (picked.cancelled === true) return keep("escaped");
			if (offersMerge(input) && chose(picked, MERGE)) return { choice: "merge", cause: "answered" };
			if (!chose(picked, DISCARD)) return { choice: "keep", cause: chose(picked, KEEP) ? "answered" : "unlisted" };
			const confirmed = await put(discardConfirmQuestion(input.branch), CONFIRM_PRESENTATION);
			if (confirmed === null) return stopped();
			// Esc, Back, and anything but a labelled Delete return to the card.
			if (confirmed.cancelled !== true && chose(confirmed, DELETE)) return { choice: "discard", cause: "answered" };
		}
	} finally {
		hold.release();
		clearTimeout(timer);
		deps.signal?.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Runs one card at a time. A batch can withhold several members at once and
 * the screen holds one round, so each member waits its turn here instead of
 * being refused. A member's card window opens when its turn does.
 */
export function createMergeCardQueue(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(task: () => Promise<T>): Promise<T> => {
		const result = tail.then(task);
		tail = result.catch(() => {
			// A failed card must not stall the members queued behind it; each caller sees its own rejection.
		});
		return result;
	};
}
