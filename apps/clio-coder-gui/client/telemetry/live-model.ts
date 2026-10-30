import type { TelemetryUpdateV1 } from "../../contracts/wire.js";

/**
 * The live hook (#434 §11.1): a telemetry_update names the topics whose reads moved, and the client answers by
 * re-reading them. Nothing is folded or patched on the client; the read model's next answer is the state. Topics
 * no GUI read shows yet (quota, health) invalidate nothing until a surface reads them.
 */
const TOPIC_READS: Record<TelemetryUpdateV1["topics"][number], readonly string[]> = {
	session: ["telemetry", "session-usage"],
	calls: ["telemetry"],
	cost: ["telemetry", "session-usage"],
	cache: ["telemetry"],
	timeline: ["telemetry"],
	runs: ["telemetry"],
	quota: [],
	health: [],
};

/** The query-key families to refresh for one session, each once, in topic order. */
export function telemetryInvalidations(update: Pick<TelemetryUpdateV1, "topics">): string[] {
	const keys: string[] = [];
	for (const topic of update.topics) for (const key of TOPIC_READS[topic] ?? []) if (!keys.includes(key)) keys.push(key);
	return keys;
}
