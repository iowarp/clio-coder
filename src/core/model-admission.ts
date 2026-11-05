/**
 * What stands between a model request and the provider, as the code doing the waiting observed it. A reconciler reports
 * each step on the request's own reporter, so a probe or a background memory step can never paint another request's
 * rail, and silence stays silence: nothing here is inferred from a quiet socket.
 */

/** Who holds the residency lock, as its record says. Null `host` is this machine. */
export interface ResidencyLockHolder {
	pid: number;
	host: string | null;
	/** This very process holds it, through another of its own requests. */
	self: boolean;
	/** The model the holder was making resident, when its record names one. */
	wants: string | null;
}

export type ModelAdmissionEvent =
	| { stage: "lock"; holder: ResidencyLockHolder | null }
	/** A release that leaves the requested model where it was. */
	| { stage: "unloading"; model: string }
	/** A release made so the requested model can take its place. */
	| { stage: "switching"; from: string; to: string }
	/**
	 * `requested` means a load was asked for and the target has said nothing since. `reported` is the target's own word,
	 * and `startedElsewhere` is a load already running when Clio looked.
	 */
	| { stage: "loading"; model: string; evidence: "requested" | "reported"; startedElsewhere?: boolean }
	/** Putting back a model an abandoned load evicted, which survives the cancel by design. */
	| { stage: "restoring"; model: string }
	/** The target loads on demand and said just now that the model is not serving, so this request pays for it. */
	| { stage: "cold"; state: "absent" | "sleeping" }
	/** Nothing further stands in the way: the request goes out now. */
	| { stage: "admitted" }
	| { stage: "abandoned" };

export type ModelAdmissionReporter = (event: ModelAdmissionEvent) => void;

export type ModelAdmissionWait = Extract<
	ModelAdmissionEvent,
	{ stage: "lock" | "unloading" | "switching" | "loading" | "restoring" }
> & {
	/** Epoch ms this step began. A fresher report of the same step does not move it. */
	since: number;
	/** The model a switch earlier in this admission took out. */
	replacing?: string;
};

export interface ModelAdmissionFacts {
	/** The step in progress; absent once nothing is in the way. */
	admission?: ModelAdmissionWait | null | undefined;
	/** How long the load this request waited for took. */
	loadedInMs?: number | undefined;
	/** The target's word, just before the send, that the model was not serving. */
	coldAtSend?: "absent" | "sleeping" | undefined;
	/** Epoch ms this request first stood behind a step, which says `sentAt` was re-stamped at admission. */
	admissionBeganAt?: number | undefined;
	/** A probe's last word on this model before the request, standing only until a reconcile looks for itself. */
	probedResidency?: "absent" | "loading" | undefined;
}

/**
 * Fold one report into a request's facts. The request is not on its way until admission ends, so `sentAt` moves there:
 * "request sent" during a load was the claim this exists to retire.
 */
export function applyModelAdmission(
	facts: ModelAdmissionFacts & { sentAt: number },
	event: ModelAdmissionEvent,
	now: number,
): void {
	const current = facts.admission ?? null;
	switch (event.stage) {
		case "cold":
			facts.coldAtSend = event.state;
			return;
		case "abandoned":
			facts.admission = null;
			return;
		case "admitted": {
			if (current?.stage === "loading") facts.loadedInMs = Math.max(0, now - current.since);
			facts.admission = null;
			facts.probedResidency = undefined;
			if (facts.admissionBeganAt !== undefined) facts.sentAt = now;
			return;
		}
		default: {
			facts.admissionBeganAt ??= now;
			const replacing = current?.stage === "switching" ? current.from : current?.replacing;
			facts.admission = {
				...event,
				since: current?.stage === event.stage ? current.since : now,
				...(replacing !== undefined ? { replacing } : {}),
			};
		}
	}
}
