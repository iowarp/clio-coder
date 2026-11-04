/**
 * `triage`: what each operator message queued during a run is, and how soon it should land.
 *
 * Two typed picks per entry replace the side-model round when a route is bound. One ask
 * covers the queue, so a verdict reads one settled snapshot, and each message travels in
 * its own question so a per-question window judges one message at a time and one entry
 * that cannot be carried costs that entry alone.
 *
 * The value is what was picked and the mass behind it. Whether that mass is a real
 * probability is the engine's declaration, which `Verdict.probabilities` carries, and the
 * caller reads it before anything may interrupt.
 */

import type { SteerRelation, SteerUrgency } from "../../../core/steering-vocabulary.js";
import { STEER_RELATIONS, STEER_URGENCIES } from "../../../core/steering-vocabulary.js";
import { chosen } from "../answers.js";
import { pick, pointQuestion } from "../questions.js";
import type { DecisionPoint, PointQuestion } from "../types.js";
import { isAnswered } from "../types.js";
import { boundedHead, boundedTail } from "./bounds.js";

/** Code points of each queued message sent. A steer is short; a pasted file is cut at its head. */
const MAX_MESSAGE_CHARS = 800;
/** Code points of the task the run is working on, from its start. */
const MAX_TASK_CHARS = 400;
/** Code points of the assistant's latest text, from its tail, which is what the operator is reacting to. */
const MAX_PREVIOUS_CHARS = 400;

export interface TriageObject {
	/** The operator's request that started the run. */
	readonly task: string;
	/** The assistant's latest text, or empty. */
	readonly previous: string;
	readonly entries: ReadonlyArray<{
		readonly id: string;
		readonly text: string;
		/** The slot the operator chose by key. */
		readonly kind: "steer" | "follow-up";
	}>;
}

export interface TriagePick {
	readonly id: string;
	readonly relation: SteerRelation;
	readonly urgency: SteerUrgency;
	/** The mass on the picked relation, or 0 when the answer carried none. */
	readonly mass: number;
}

export interface TriageValue {
	/** Entries both picks answered. An entry an engine abstained on is absent and keeps its slot. */
	readonly picks: ReadonlyArray<TriagePick>;
}

function isRelation(value: string | null): value is SteerRelation {
	return value !== null && Object.hasOwn(STEER_RELATIONS, value);
}

function isUrgency(value: string | null): value is SteerUrgency {
	return value !== null && Object.hasOwn(STEER_URGENCIES, value);
}

/** Question ids stay positional: an entry id is redacted like any string in the object, and answers come back under the id. */
const relationId = (index: number): string => `relation${index}`;
const urgencyId = (index: number): string => `urgency${index}`;

/** `deadlineMs` is `chat.steering.triage.timeoutMs`, so the operator's setting bounds the ask. */
export function triagePoint(deadlineMs: number): DecisionPoint<TriageObject, TriageValue> {
	return {
		id: "triage",
		version: "triage-v1",
		deadlineMs,
		// Nobody waits on this directly, and a busy engine falls back to the side-model round rather than queueing.
		optional: true,
		state: (object) => ({
			task: boundedHead(object.task, MAX_TASK_CHARS),
			previous: boundedTail(object.previous, MAX_PREVIOUS_CHARS),
			queued: object.entries.length,
		}),
		questions(object) {
			const questions: Record<string, PointQuestion> = {};
			for (const [index, entry] of object.entries.entries()) {
				const message = boundedHead(entry.text, MAX_MESSAGE_CHARS);
				if (message.length === 0) continue;
				const line = `Message (operator chose: ${entry.kind === "steer" ? "next slot" : "end of turn"}): ${message}`;
				questions[relationId(index)] = pointQuestion(
					pick(`How does \`message\` relate to the work in \`task\`?\n${line}`, STEER_RELATIONS),
				);
				questions[urgencyId(index)] = pointQuestion(pick(`How soon should \`message\` reach the assistant?\n${line}`, STEER_URGENCIES));
			}
			return questions;
		},
		read(answers, object) {
			const picks: TriagePick[] = [];
			for (const [index, entry] of object.entries.entries()) {
				const relationAnswer = answers[relationId(index)];
				const urgencyAnswer = answers[urgencyId(index)];
				if (!isAnswered(relationAnswer) || !isAnswered(urgencyAnswer)) continue;
				const relation = chosen(relationAnswer);
				const urgency = chosen(urgencyAnswer);
				if (!isRelation(relation) || !isUrgency(urgency)) continue;
				const mass = relationAnswer.probabilities?.[relation];
				picks.push({
					id: entry.id,
					relation,
					urgency,
					mass: typeof mass === "number" && Number.isFinite(mass) ? Math.min(1, Math.max(0, mass)) : 0,
				});
			}
			return picks.length > 0 ? { picks } : null;
		},
	};
}
