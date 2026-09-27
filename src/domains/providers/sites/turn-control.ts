import type { TurnInterpretation } from "../../turn-control/index.js";
import { TURN_INTERPRETATION_VERSION } from "../../turn-control/index.js";
import { answerCertainty, chosen, pick, yesNo } from "../decisions.js";
import type { PreTurnSite } from "../pre-turn-brief.js";
import type { DecisionAnswer } from "../types/inference.js";
import type { DispatchShape } from "./dispatch-forecast.js";
import { DISPATCH_SHAPE_QUESTION, SHAPES } from "./dispatch-forecast.js";
import type { HarnessIntent } from "./harness-routing.js";
import { HARNESS_INTENT_QUESTION, HARNESS_INTENTS } from "./harness-routing.js";

export const TURN_CONTROL_VERSION = "turncontrol-v1";
export const ORIENTATION_WANTED_QUESTION = yesNo(
	"Does `task` ask for orientation in this repository or codebase as a whole, or in a named area of it: a tour, an overview, how it is organized, what it is, where things live? Use `previous` only to read a short follow-up.",
	"Asks to explore, tour, map, or understand the structure, purpose, or layout of the repository or an area of it",
	"Asks about one specific file, symbol, command, setting, or fact; asks for a change; is conversational; or is unrelated to the workspace",
);
export const BREADTH_QUESTION = pick("How broad is the orientation `task` asks for?", {
	repository: "The whole repository or project",
	area: "One named subsystem, directory, or feature area",
	focused: "One file, symbol, command, or fact",
});
export const DIRECTION_REQUESTED_QUESTION = yesNo(
	"Given `previous`, does `task` ask what to do next, for suggestions, or for help choosing, while the user has not stated a task of their own?",
	"Asks for direction, options, or a suggestion; says they are unsure or undecided",
	"States or continues a task, asks a concrete question, approves or corrects work in `previous`, or is a greeting or thanks",
);

export const TURN_CONTROL_QUESTIONS = {
	intent: HARNESS_INTENT_QUESTION,
	orientationWanted: ORIENTATION_WANTED_QUESTION,
	breadth: BREADTH_QUESTION,
	directionRequested: DIRECTION_REQUESTED_QUESTION,
	shape: DISPATCH_SHAPE_QUESTION,
};

export const TURN_INTERPRETATION_SYSTEM_PROMPT = [
	"Interpret the operator's task using previous only as described below. Do not execute work or call tools.",
	...Object.entries(TURN_CONTROL_QUESTIONS).map(
		([id, question]) => `${id}: ${question.instructions}\nCriteria: ${JSON.stringify(question.criteria)}`,
	),
	"Report intentCertainty in [0, 1] as how clearly one intent applies: 1 when one intent plainly applies, 0.5 when two are equally plausible, 0 when you cannot tell.",
	'Answer with one JSON object { "intent": <intent option>, "intentCertainty": <0..1>, "orientationWanted": <0..1>, "breadth": "repository" | "area" | "focused" | null, "directionRequested": <0..1>, "shape": "single" | "parallel" | "sequence" | "council" | null } and nothing else.',
].join("\n");

function probability(answer: DecisionAnswer | undefined): number | null {
	return answer?.type === "noul" &&
		typeof answer.noul === "number" &&
		Number.isFinite(answer.noul) &&
		answer.noul >= 0 &&
		answer.noul <= 1
		? answer.noul
		: null;
}

function certainty(answer: DecisionAnswer | undefined): number {
	const value = answer ? answerCertainty(answer) : 0;
	return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function choice(answer: DecisionAnswer | undefined, minConfidence: number): string | null {
	return certainty(answer) >= minConfidence ? chosen(answer, { minConfidence }) : null;
}

export function createTurnControlSite(): PreTurnSite<TurnInterpretation> {
	return {
		site: "turnControl",
		version: TURN_CONTROL_VERSION,
		prepare: () => ({ uses: ["previous"], questions: TURN_CONTROL_QUESTIONS }),
		read(answers) {
			const wanted = probability(answers.orientationWanted);
			const requested = probability(answers.directionRequested);
			if (wanted === null && requested === null) return null;
			const intent = choice(answers.intent, 0.6);
			const breadth = choice(answers.breadth, 0.5);
			const shape = choice(answers.shape, 0.5);
			return {
				version: TURN_INTERPRETATION_VERSION,
				intent: HARNESS_INTENTS.includes(intent as HarnessIntent) ? (intent as HarnessIntent) : "unknown",
				intentCertainty: certainty(answers.intent),
				orientation: {
					wanted: wanted ?? 0,
					breadth: breadth === "repository" || breadth === "area" || breadth === "focused" ? breadth : null,
					subject: null,
				},
				direction: { requested: requested ?? 0 },
				shape: shape !== null && Object.hasOwn(SHAPES, shape) ? (shape as DispatchShape) : null,
			};
		},
		summarize: (value) => ({
			intent: value.intent,
			intentCertainty: Math.round(value.intentCertainty * 100) / 100,
			orientationWanted: Math.round(value.orientation.wanted * 100) / 100,
			breadth: value.orientation.breadth,
			directionRequested: Math.round(value.direction.requested * 100) / 100,
			shape: value.shape,
		}),
	};
}

export const turnControlSite = createTurnControlSite();
