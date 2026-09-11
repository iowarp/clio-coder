import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { ACP_TO_WEB_EVENT, FleetFact, type FleetItem } from "../../contracts/fleet-events.js";
import { AppProblem } from "../services/problem.js";
import { record } from "./client.js";

export function fleetEvent(value: unknown, sessionId: string, previousSequence: number) {
	const event = record(value),
		kind = event.kind;
	if (
		event.version !== 1 ||
		event.sessionId !== sessionId ||
		typeof kind !== "string" ||
		!Object.hasOwn(ACP_TO_WEB_EVENT, kind) ||
		!Number.isSafeInteger(event.sequence) ||
		(event.sequence as number) <= previousSequence
	)
		throw new AppProblem("upstream_acp", "Invalid or out-of-order ACP event envelope.");
	const type = ACP_TO_WEB_EVENT[kind as keyof typeof ACP_TO_WEB_EVENT];
	const fact = Value.Clean(FleetFact, { type, payload: event.payload });
	if (!Value.Check(FleetFact, fact) || Buffer.byteLength(JSON.stringify(fact)) > 8192)
		throw new AppProblem("upstream_acp", "ACP event exceeds its public projection contract.");
	const item: FleetItem = {
		id: randomUUID(),
		at: new Date().toISOString(),
		sourceSequence: event.sequence as number,
		fact,
	};
	return { type, item };
}
