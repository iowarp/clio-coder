/**
 * Copilot account quota observations as the live stream delivers them. They are account evidence, not step output:
 * each is published the moment it arrives, so an observation after `session.idle` reaches its listeners without
 * waiting for another call, and a one-call run that exits still journals it.
 */

import type { CopilotQuotaObservation } from "./quota.js";

type QuotaListener = (observations: CopilotQuotaObservation[]) => void;

const listeners = new Set<QuotaListener>();
/** The newest observation per account and bucket. */
const held = new Map<string, Map<string, CopilotQuotaObservation>>();

/** Hear every account's held observations, each bucket as of its own time, whenever one changes. */
export function onCopilotQuotaObservations(listener: QuotaListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Hold an observation unless the bucket already holds a newer one (a late arrival never replaces newer evidence). */
export function publishCopilotQuotaObservation(observation: CopilotQuotaObservation): void {
	const account = held.get(observation.accountScope) ?? new Map<string, CopilotQuotaObservation>();
	held.set(observation.accountScope, account);
	const bucket = `${observation.key}\0${observation.unit}`;
	const prior = account.get(bucket);
	if (prior && Date.parse(prior.observedAt) > Date.parse(observation.observedAt)) return;
	account.set(bucket, observation);
	const observations = [...account.values()];
	for (const listener of listeners) {
		try {
			listener(observations);
		} catch {
			// A listener's failure never reaches the session's event stream.
		}
	}
}
