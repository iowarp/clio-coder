import { createHash } from "node:crypto";
import type { AgentMessage } from "../engine/types.js";

export interface MessageListDigests {
	messages: ReadonlyArray<AgentMessage>;
	digest(count?: number): string;
}

/** Share exact JSON bytes only within one synchronous accounting publication. */
export function createMessageListDigests(messages: ReadonlyArray<AgentMessage>): MessageListDigests {
	const snapshot = [...messages];
	let fullJson: string | undefined;
	const digests = new Map<number, string>();
	return {
		messages: snapshot,
		digest(count = snapshot.length): string {
			const cached = digests.get(count);
			if (cached !== undefined) return cached;
			let json: string;
			if (count === snapshot.length) {
				fullJson ??= JSON.stringify(snapshot);
				json = fullJson;
			} else if (count === 0) {
				json = "[]";
			} else if (fullJson !== undefined) {
				// Keep the tail's original array indices, including toJSON(key)
				// semantics. Each padded prefix slot contributes exactly "null,".
				// Only the small unanchored tail is serialized a second time;
				// the attested history bytes come from the full serialization.
				const paddedTail: Array<AgentMessage | null> = new Array(snapshot.length).fill(null);
				for (let index = count; index < snapshot.length; index += 1) paddedTail[index] = snapshot[index] ?? null;
				const tailLength = JSON.stringify(paddedTail).length - count * "null,".length;
				json = fullJson.slice(0, fullJson.length - tailLength) + "]";
			} else {
				json = JSON.stringify(snapshot.slice(0, count));
			}
			const digest = createHash("sha256").update(json).digest("hex");
			digests.set(count, digest);
			return digest;
		},
	};
}
