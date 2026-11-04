/**
 * `steer`: what an operator message typed during a run is, read when it is queued.
 *
 * The queue delivers every pending message at the next slot, in order, and the
 * operator chooses the slot by key. This site reads two things about each
 * message as it enters the queue: how it relates to the work in progress (a
 * correction, an addition, a new task, a stop, a question) and how urgently it
 * should land. In 0.6.0 the reading is recorded and nothing reads it: the
 * operator's own key presses, the navigator toggles and the send-now choices
 * are the outcome rows a later gate is fitted against. No cut exists for this
 * site, so a fitted build cannot appear until one is measured.
 */

import type { SteerRelation, SteerUrgency } from "../../../core/steering-vocabulary.js";
import { STEER_RELATIONS, STEER_URGENCIES } from "../../../core/steering-vocabulary.js";
import { chosen } from "../answers.js";
import { pick } from "../questions.js";
import type { SiteDefinition } from "../types.js";
import { boundedHead, boundedTail, round2 } from "./bounds.js";

/** Code points of the queued message sent. A steer is short; a pasted file is cut at its head. */
const MAX_MESSAGE_CHARS = 800;
/** Code points of the task the run is working on, from its start. */
const MAX_TASK_CHARS = 400;
/** Code points of the assistant's latest text, from its tail, which is what the operator is reacting to. */
const MAX_PREVIOUS_CHARS = 400;

const RELATION_QUESTION = pick("How does `message` relate to the work in `task`?", STEER_RELATIONS);
const URGENCY_QUESTION = pick("How soon should `message` reach the assistant?", STEER_URGENCIES);

export interface SteerObject {
	/** The queued message, exactly as the operator submitted it. */
	readonly message: string;
	/** What the run is working on: the operator's request that started it. */
	readonly task: string;
	/** The assistant's latest text when the message was queued, or empty. */
	readonly previous: string;
	/** 1-based place in the queue at enqueue time, and how many entries the queue then held. */
	readonly position: number;
	readonly queued: number;
	/** The slot the operator chose by key. */
	readonly chosen: "next-slot" | "end-of-turn";
}

export interface SteerValue {
	readonly relation: SteerRelation | null;
	readonly relationCertainty: number;
	readonly urgency: SteerUrgency | null;
	readonly urgencyCertainty: number;
}

function isRelation(value: string | null): value is SteerRelation {
	return value !== null && Object.hasOwn(STEER_RELATIONS, value);
}

function isUrgency(value: string | null): value is SteerUrgency {
	return value !== null && Object.hasOwn(STEER_URGENCIES, value);
}

export const STEER_SITE: SiteDefinition<SteerObject, SteerValue> = {
	id: "steer",
	version: "steer-v1",
	deadlineMs: 3000,
	state(object) {
		const message = boundedHead(object.message, MAX_MESSAGE_CHARS);
		if (message.trim().length === 0) return null;
		return {
			message,
			task: boundedHead(object.task, MAX_TASK_CHARS),
			previous: boundedTail(object.previous, MAX_PREVIOUS_CHARS),
			position: object.position,
			queued: object.queued,
			chosen: object.chosen,
		};
	},
	questions: () => ({ relation: RELATION_QUESTION, urgency: URGENCY_QUESTION }),
	read(answers, _object, cuts) {
		const relationAnswer = answers.relation;
		const urgencyAnswer = answers.urgency;
		if (relationAnswer === undefined && urgencyAnswer === undefined) return null;
		// No build has these floors, so a call records its raw answers and names no choice.
		const relationFloor = cuts.cut("relationFloor");
		const urgencyFloor = cuts.cut("urgencyFloor");
		const relation = relationFloor === undefined ? null : chosen(relationAnswer, relationFloor);
		const urgency = urgencyFloor === undefined ? null : chosen(urgencyAnswer, urgencyFloor);
		return {
			relation: isRelation(relation) ? relation : null,
			relationCertainty: relationAnswer?.certainty ?? 0,
			urgency: isUrgency(urgency) ? urgency : null,
			urgencyCertainty: urgencyAnswer?.certainty ?? 0,
		};
	},
	summarize: (value) => ({
		relation: value.relation,
		relationCertainty: round2(value.relationCertainty),
		urgency: value.urgency,
		urgencyCertainty: round2(value.urgencyCertainty),
	}),
};
