import { validateInterview, validateInterviewStep } from "../../domains/extensions/interview-schema.js";
import type {
	ExtensionOutputV2,
	Interview,
	InterviewAnswer,
	InterviewNext,
	InterviewStep,
} from "../../domains/extensions/public-api-v2.js";
import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import type { ToolInvokeOptions } from "../../tools/registry.js";
import { createHarnessHold } from "../../tools/registry.js";
import { renderView } from "./view-renderer.js";

export function stepToQuestions(step: InterviewStep): AskUserQuestion[] {
	return step.questions.map((question) => {
		const initial = typeof question.initial === "string" ? question.initial : question.initial?.[0];
		const preferred = question.options?.findIndex((option) => option.value === initial) ?? -1;
		return {
			question: `${question.label}${question.help ? `\n\n${question.help}` : ""}`,
			header: question.label,
			...(question.options?.length
				? {
						options: question.options.map((option) => ({
							label: option.label,
							...(option.detail === undefined ? {} : { description: option.detail }),
						})),
					}
				: {}),
			...(question.kind === "multi" ? { multi_select: true } : {}),
			...(preferred < 0 ? {} : { defaultOption: preferred }),
		};
	});
}

export function resultToAnswer(interview: Interview, step: InterviewStep, result: AskUserResult): InterviewAnswer {
	const base = { id: interview.id, step: step.key };
	if (result.cancelled || result.unavailable)
		return {
			...base,
			answers: {},
			nav: "cancel",
			reason: result.unavailable ? "preempted" : "operator",
		};
	if (result.answers.length !== step.questions.length) throw new Error("interview round did not answer every question");
	const answers: InterviewAnswer["answers"] = {};
	for (const [index, question] of step.questions.entries()) {
		const answer = result.answers[index];
		if (answer === undefined) throw new Error(`missing answer for ${question.id}`);
		// Typed input is the submitted value, even when attached to selected
		// choices; the overlay's joined display string is not that value (S4).
		if (answer.value !== undefined) {
			answers[question.id] = answer.value;
			continue;
		}
		if (question.kind === "text") {
			answers[question.id] = answer.answer;
			continue;
		}
		const options = question.options ?? [];
		const labels = answer.options ?? (options.some((option) => option.label === answer.answer) ? [answer.answer] : []);
		if (labels.length === 0) {
			answers[question.id] = answer.answer;
			continue;
		}
		for (const label of labels) {
			if (!options.some((option) => option.label === label)) throw new Error(`unknown selected option for ${question.id}`);
		}
		const selected = options.filter((option) => labels.includes(option.label)).map((option) => option.value);
		if (question.kind === "single") {
			if (selected.length !== 1) throw new Error(`single question ${question.id} has multiple selected options`);
			answers[question.id] = selected[0] ?? "";
		} else answers[question.id] = selected;
	}
	return { ...base, answers, nav: "next" };
}

function initialDrafts(
	step: InterviewStep,
): NonNullable<NonNullable<ToolInvokeOptions["harnessInterview"]>["initial"]> {
	return step.questions.map((question) => {
		if (question.kind === "text") return typeof question.initial === "string" ? { text: question.initial } : {};
		if (question.initial === undefined) return {};
		const values = typeof question.initial === "string" ? [question.initial] : question.initial;
		return {
			selected: (question.options ?? []).flatMap((option, index) => (values.includes(option.value) ? [index] : [])),
		};
	});
}

export interface ExtensionInterviewDeps {
	ask: AskUserHandler;
}

export async function runExtensionInterview(
	deps: ExtensionInterviewDeps,
	interview: Interview,
	owner: { extensionId: string; title: string },
	onAnswer: (answer: InterviewAnswer) => Promise<InterviewNext>,
	signal?: AbortSignal,
): Promise<{ outcome: "done" | "cancelled"; output?: ExtensionOutputV2; reason?: string }> {
	const hold = createHarnessHold();
	let active = interview;
	let position = 1;
	const cancel = async (
		answer: InterviewAnswer,
		reason?: string,
	): Promise<{ outcome: "cancelled"; reason?: string }> => {
		await onAnswer(answer);
		return { outcome: "cancelled", ...(reason === undefined ? {} : { reason }) };
	};
	const interrupted = (reason: string): Promise<{ outcome: "cancelled"; reason?: string }> =>
		cancel(
			{
				id: active.id,
				step: active.step?.key ?? "",
				answers: {},
				nav: "cancel",
				reason: "preempted",
			},
			`${owner.extensionId}: ${reason}`,
		);
	try {
		const validated = validateInterview(interview);
		if (!validated.ok) return await interrupted(`invalid interview at ${validated.path}: ${validated.reason}`);
		active = validated.interview;
		while (true) {
			if (signal?.aborted) return await interrupted("interview aborted");
			const validatedStep = validateInterviewStep(active.step);
			if (!validatedStep.ok) return await interrupted(`invalid step at ${validatedStep.path}: ${validatedStep.reason}`);
			const step = validatedStep.step;
			const intro = step.intro;
			active = { ...active, step };
			let answer: InterviewAnswer;
			try {
				const result = await deps.ask(stepToQuestions(step), {
					origin: "harness",
					harnessHold: hold,
					...(signal === undefined ? {} : { signal }),
					harnessInterview: {
						title: `${owner.title} · ${active.title}`,
						step: position,
						...(active.total === undefined ? {} : { total: active.total }),
						...(intro === undefined ? {} : { intro: (width: number) => renderView(intro, width).lines }),
						initial: initialDrafts(step),
					},
				});
				answer = resultToAnswer(active, step, result);
			} catch (error) {
				return await interrupted(`interview round failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (signal?.aborted) return await interrupted("interview aborted");
			if (answer.nav === "cancel") return await cancel(answer, answer.reason);
			const next = await onAnswer(answer);
			if ("done" in next && next.done === true) {
				const { done: _done, ...output } = next;
				return { outcome: "done", output };
			}
			const candidate = { ...active, ...next, step: "step" in next ? next.step : undefined };
			const validatedNext = validateInterview(candidate);
			if (!validatedNext.ok) {
				active = { ...active, step: candidate.step ?? active.step };
				return await interrupted(`invalid next step at ${validatedNext.path}: ${validatedNext.reason}`);
			}
			active = validatedNext.interview;
			position++;
		}
	} finally {
		hold.release();
	}
}
