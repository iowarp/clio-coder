import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { createHarnessHold } from "../../tools/registry.js";
import type { DecisionPresentation } from "../safety/decision-presentation.js";
import { hostCheckBaseNote } from "./host-verification-note.js";
import { boundedCheck } from "./merge-gate.js";
import type { RunHostVerification } from "./types.js";

/**
 * The operator's answer to a withheld task-worktree merge. The gate in
 * merge-gate.ts decides that a merge is held; this card lets an attached
 * operator overrule that for one branch. Land is the operator's own action: the
 * host lands the branch with the checks `clio-coder fleet land` runs, outside
 * the agent's sandbox, so landing an approved branch never needs a sandbox
 * escape. A headless run has no operator, and an ACP session has one only when
 * its client advertised interviews. Without one no card is built and the merge
 * stays withheld.
 */
export type MergeCardChoice = "land" | "keep" | "discard";

/** Why the card settled: an answer, or the fallback that applies Keep branch. */
export type MergeCardCause = "answered" | "unlisted" | "escaped" | "aborted";

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
		case "aborted":
			return "the run was cancelled while the card was open";
	}
}

export interface MergeCardInput {
	hostVerification?: RunHostVerification;
	workerFailedChecks?: ReadonlyArray<string>;
	branch: string;
	/** The branch Land would land on, as the source checkout has it checked out now. */
	destination?: string;
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
	/** Ends the card on Keep branch. Without it the card waits for the operator or Esc. */
	signal?: AbortSignal;
	/** Delay between attempts while another overlay owns the screen. */
	retryMs?: number;
}

const LAND = "Land";
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
		kind: "task merge",
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

function destinationOf(input: { destination?: string }): string {
	return input.destination ?? "your current branch";
}

function landAuthorization(destination: { destination?: string }): string {
	return `Land is your action, carried out by CLIO Coder on the host outside the agent's sandbox: it lands the branch on ${destinationOf(destination)} with the checks \`clio-coder fleet land\` runs, and is refused if that checkout has since moved to another branch or the branch moved after this card was shown.`;
}

function choosePresentation(input: MergeCardInput): DecisionPresentation {
	const offerLand = offersLand(input);
	return mergeCardPresentation(
		"Land task branch?",
		offerLand
			? `${landAuthorization(input)} Keep branch merges nothing. Discard asks once more before deleting.`
			: "Keep branch merges nothing. Discard asks once more before deleting. Land is not offered because the branch changes protected paths.",
		offerLand
			? "Reversible: Land and Keep branch can be undone or redone with git. Discard deletes the branch and cannot be undone."
			: "Reversible: Keep branch can be undone with git. Discard deletes the branch and cannot be undone.",
	);
}

const CONFIRM_PRESENTATION = mergeCardPresentation(
	"Discard task branch?",
	"Delete removes the task branch and its worktree. Back returns to the merge choice.",
	"Reversible: no. The deleted branch is not recoverable from CLIO Coder.",
);

function offersLand(input: MergeCardInput): boolean {
	return (input.protectedPaths?.length ?? 0) === 0;
}

function mergeCardQuestion(input: MergeCardInput): AskUserQuestion {
	const total = input.changedPaths.length;
	const listed = input.changedPaths.slice(0, LISTED_PATHS).map((path) => `- ${boundedCheck(path)}`);
	const omitted = total - listed.length;
	const noun = total === 1 ? "path" : "paths";
	const protectedPaths = input.protectedPaths ?? [];
	const options = [
		...(offersLand(input) ? [{ label: LAND, description: `CLIO Coder lands it on ${destinationOf(input)} now.` }] : []),
		{ label: KEEP, description: keepDescription(input.branch) },
		{ label: DISCARD, description: "Delete the branch and its worktree after one more confirmation." },
	];
	return {
		header: "Land task branch?",
		// Opens on Keep branch: an Enter that lands as the card appears must not merge.
		defaultOption: options.findIndex((option) => option.label === KEEP),
		question: [
			`Branch ${input.branch} changes ${total} ${noun}:`,
			...listed,
			...(omitted > 0 ? [`- … and ${omitted} more`] : []),
			"",
			`The merge was held because ${input.reason}.`,
			...(input.workerFailedChecks ?? []).slice(0, 3).map((name) => {
				const compared = input.hostVerification?.checks.find(
					(check) => check.check === name || check.argv.join(" ") === name,
				);
				return `Worker-reported check '${boundedCheck(name)}': ${compared && compared.exitCode !== 0 ? hostCheckBaseNote(compared) : "no matching host failure was compared on the task base; whether the failure predates the worker is unknown"}.`;
			}),
			...(input.hostVerification?.checks
				.filter((check) => check.exitCode !== 0)
				.map((check) => `Host check '${check.check}': ${hostCheckBaseNote(check)}.`) ?? []),
			...(protectedPaths.length > 0
				? [
						`Land is not offered: the branch changes protected ${protectedPaths.length === 1 ? "path" : "paths"} ${protectedPaths.map(boundedCheck).join(", ")}, which a merge never lands.`,
					]
				: []),
		].join("\n"),
		options,
	};
}

function keepDescription(branch: string): string {
	return `Leave it on ${branch}; the agent's \`dispatch land\` or \`clio-coder fleet land ${branch}\` lands it later.`;
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

interface CardSession {
	put(question: AskUserQuestion, presentation: DecisionPresentation): Promise<AskUserResult | null>;
	close(): void;
}

function openCardSession(deps: MergeCardDeps): CardSession {
	const controller = new AbortController();
	const onParentAbort = (): void => controller.abort();
	if (deps.signal?.aborted === true) controller.abort();
	deps.signal?.addEventListener("abort", onParentAbort, { once: true });
	// Every round of the card, and the card again after Back, holds the screen
	// together: a waiting model question must not slip in between them.
	const hold = createHarnessHold();
	const options = { origin: "harness" as const, signal: controller.signal, harnessHold: hold };
	const waitForScreen = (): Promise<void> =>
		new Promise((resolve) => {
			const settle = (): void => {
				clearTimeout(wake);
				controller.signal.removeEventListener("abort", settle);
				resolve();
			};
			const wake = setTimeout(settle, deps.retryMs ?? DEFAULT_RETRY_MS);
			wake.unref?.();
			controller.signal.addEventListener("abort", settle, { once: true });
			if (controller.signal.aborted) settle();
		});
	return {
		// A round another overlay refused is retried until the card's own window
		// closes, so a permission prompt on screen delays the card rather than
		// silently settling it.
		async put(question, presentation) {
			for (;;) {
				if (controller.signal.aborted) return null;
				const result = await deps.ask([question], { ...options, decisionPresentation: presentation });
				if (controller.signal.aborted) return null;
				if (result.unavailable !== true) return result;
				await waitForScreen();
			}
		},
		close() {
			hold.release();
			deps.signal?.removeEventListener("abort", onParentAbort);
		},
	};
}

/**
 * Put the merge card to the operator. Esc and an abort both settle on Keep
 * branch, the behavior of a surface with no operator. Esc on the discard
 * confirm is Back.
 */
export async function askMergeCard(deps: MergeCardDeps, input: MergeCardInput): Promise<MergeCardOutcome> {
	const session = openCardSession(deps);
	const keep = (cause: MergeCardCause): MergeCardOutcome => ({ choice: "keep", cause });
	try {
		for (;;) {
			const picked = await session.put(mergeCardQuestion(input), choosePresentation(input));
			if (picked === null) return keep("aborted");
			if (picked.cancelled === true) return keep("escaped");
			if (offersLand(input) && chose(picked, LAND)) return { choice: "land", cause: "answered" };
			if (!chose(picked, DISCARD)) return { choice: "keep", cause: chose(picked, KEEP) ? "answered" : "unlisted" };
			const confirmed = await session.put(discardConfirmQuestion(input.branch), CONFIRM_PRESENTATION);
			if (confirmed === null) return keep("aborted");
			// Esc, Back, and anything but a labelled Delete return to the card.
			if (confirmed.cancelled !== true && chose(confirmed, DELETE)) return { choice: "discard", cause: "answered" };
		}
	} finally {
		session.close();
	}
}

export interface LandCardInput {
	branch: string;
	/** The branch Land would land on, as the source checkout has it checked out now. */
	destination?: string;
	/** `<short> <subject>` for the branch's own commits, newest first, as fleet land plans them. */
	commits: ReadonlyArray<string>;
	/** The landing's `git diff --shortstat`. */
	changed: string;
	/** Paths in the kept worktree that Land commits onto the branch first. */
	uncommitted: number;
}

/**
 * The Land card for a task branch an earlier run kept, reopened by the agent's
 * `dispatch land`. It offers Land and Keep branch only; deleting a kept branch
 * stays with the operator. Esc and an abort settle on Keep branch.
 */
export async function askLandCard(deps: MergeCardDeps, input: LandCardInput): Promise<MergeCardOutcome> {
	const session = openCardSession(deps);
	const listed = input.commits.slice(0, LISTED_PATHS).map((line) => `- ${boundedCheck(line)}`);
	const omitted = input.commits.length - listed.length;
	const options = [
		{ label: LAND, description: `CLIO Coder lands it on ${destinationOf(input)} now.` },
		{ label: KEEP, description: keepDescription(input.branch) },
	];
	const question: AskUserQuestion = {
		header: "Land task branch?",
		// Opens on Keep branch: an Enter that lands as the card appears must not merge.
		defaultOption: 1,
		question: [
			`The agent asks to land kept branch ${input.branch} (${boundedCheck(input.changed)}):`,
			...listed,
			...(omitted > 0 ? [`- … and ${omitted} more`] : []),
			...(input.uncommitted > 0
				? [
						`Land first commits ${input.uncommitted} uncommitted ${input.uncommitted === 1 ? "path" : "paths"} in its worktree onto the branch.`,
					]
				: []),
		].join("\n"),
		options,
	};
	const presentation: DecisionPresentation = {
		...mergeCardPresentation(
			"Land task branch?",
			`${landAuthorization(input)} Keep branch merges nothing.`,
			"Reversible: Land and Keep branch can be undone or redone with git.",
		),
		requestedByCopy: "the agent's dispatch land request",
	};
	try {
		const picked = await session.put(question, presentation);
		if (picked === null) return { choice: "keep", cause: "aborted" };
		if (picked.cancelled === true) return { choice: "keep", cause: "escaped" };
		if (chose(picked, LAND)) return { choice: "land", cause: "answered" };
		return { choice: "keep", cause: chose(picked, KEEP) ? "answered" : "unlisted" };
	} finally {
		session.close();
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
