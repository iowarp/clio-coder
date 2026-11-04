/** What a message typed during a run is to the work in progress, and how soon it should land. Triage reads and shows these. */

export const STEER_RELATIONS = {
	correction: "Corrects, narrows or redirects the work in progress: a different file, approach, scope or constraint",
	addition: "Adds to the current task without changing its direction: one more thing to cover on the same work",
	newTask: "Asks for something unrelated to the work in progress, a separate task of its own",
	stop: "Tells the assistant to stop, wait, hold, or undo what it is doing right now",
	question: "Asks about the work, the code or the plan without asking for a change",
} as const;
export type SteerRelation = keyof typeof STEER_RELATIONS;

export const STEER_URGENCIES = {
	now: "Must land before anything else the assistant does; waiting for the current step to finish would waste work",
	nextSlot: "Should land before the assistant's next decision, once the current step finishes",
	endOfTurn: "Can wait until the current task is complete",
} as const;
export type SteerUrgency = keyof typeof STEER_URGENCIES;
