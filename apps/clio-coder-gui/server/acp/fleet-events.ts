import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
	ACP_TO_WEB_EVENT,
	FleetFact,
	type FleetItem,
	HEALTH_EVENT_TYPES,
	HealthFact,
	type HealthItem,
} from "../../contracts/fleet-events.js";
import { AppProblem } from "../services/problem.js";
import { record } from "./client.js";

const HEALTH = new Set<string>(HEALTH_EVENT_TYPES);

export type AcpEvent =
	| { type: (typeof ACP_TO_WEB_EVENT)[keyof typeof ACP_TO_WEB_EVENT]; item: FleetItem | HealthItem; sequence: number }
	| { type: null; item: null; sequence: number };

/**
 * Projects one `_clio-coder/event` frame, or reports that it is not projectable.
 *
 * Two failures are deliberately not the same thing. A kind this build has never
 * heard of is a newer engine talking to an older app: it comes back with
 * `type: null` and the caller logs and drops it, because killing a live session
 * over a fact the UI would not have drawn anyway is the worse outcome. A frame
 * of a kind this app DOES claim to handle, whose envelope or payload is wrong,
 * is a broken or hostile peer and still throws: that is the case where
 * continuing means rendering something no contract describes. The envelope
 * check comes first either way, because an out-of-order or foreign-session
 * frame is malformed whatever kind it names.
 */
export function fleetEvent(value: unknown, sessionId: string, previousSequence: number): AcpEvent {
	const event = record(value),
		kind = event.kind;
	if (
		event.version !== 1 ||
		event.sessionId !== sessionId ||
		typeof kind !== "string" ||
		!Number.isSafeInteger(event.sequence) ||
		(event.sequence as number) <= previousSequence
	)
		throw new AppProblem("upstream_acp", "Invalid or out-of-order ACP event envelope.");
	const sequence = event.sequence as number;
	if (!Object.hasOwn(ACP_TO_WEB_EVENT, kind)) return { type: null, item: null, sequence };
	const type = ACP_TO_WEB_EVENT[kind as keyof typeof ACP_TO_WEB_EVENT];
	const schema = HEALTH.has(type) ? HealthFact : FleetFact;
	const fact = Value.Clean(schema, { type, payload: event.payload });
	if (!Value.Check(schema, fact) || Buffer.byteLength(JSON.stringify(fact)) > 8192)
		throw new AppProblem("upstream_acp", "ACP event exceeds its public projection contract.");
	const item = { id: randomUUID(), at: new Date().toISOString(), sourceSequence: sequence, fact } as
		| FleetItem
		| HealthItem;
	return { type, item, sequence };
}
