import { createHash, type Hash } from "node:crypto";
import { matchesTrace, traceValue } from "../core/value-trace.js";
import { estimateAgentMessageTokens } from "../domains/session/context-accounting.js";
import type { AgentMessage } from "../engine/types.js";

export interface MessageListDigests {
	messages: ReadonlyArray<AgentMessage>;
	/** `estimateAgentMessageTokens` of each message, aligned with `messages`. */
	messageTokens: ReadonlyArray<number>;
	/** SHA-256 of `JSON.stringify(messages.slice(0, count))`, the same bytes a whole-list hash reads. */
	digest(count?: number): string;
}

export interface MessageListFold {
	/** Fold `messages` into the running state and return a snapshot of it. */
	observe(messages: ReadonlyArray<AgentMessage>): MessageListDigests;
}

/** The bytes `JSON.stringify` writes for `message` as element `index` of an array, `toJSON(key)` included. */
function elementJson(message: unknown, index: number): string {
	const key = String(index);
	const wrapped = JSON.stringify({ [key]: message });
	return wrapped === "{}" ? "null" : wrapped.slice(key.length + 4, -1);
}

const sha256 = (json: string): string => createHash("sha256").update(json).digest("hex");

/**
 * The conversation's digest and token estimates, kept across publications. Each `observe` checks every message by
 * identity and trace and serializes, hashes and estimates only the messages appended since the last one; an edit
 * re-folds from the first changed message. Hashing the list once per publication grew with the whole history.
 */
export function createMessageListFold(): MessageListFold {
	let messages: AgentMessage[] = [];
	let traces: Array<unknown[] | null> = [];
	let tokens: number[] = [];
	let hash: Hash = createHash("sha256").update("[");
	// Digests of folded prefixes by length; a new map whenever the prefix changes, so older snapshots keep theirs.
	let prefixDigests = new Map<number, string>();

	const rehash = (count: number): void => {
		hash = createHash("sha256").update("[");
		for (let index = 0; index < count; index += 1) {
			hash.update(`${index > 0 ? "," : ""}${elementJson(messages[index], index)}`);
		}
	};

	return {
		observe(input) {
			const snapshot = [...input];
			const folded = Math.min(messages.length, snapshot.length);
			let kept = 0;
			while (kept < folded) {
				const trace = traces[kept];
				if (snapshot[kept] !== messages[kept] || !trace || !matchesTrace(snapshot[kept], trace)) break;
				kept += 1;
			}
			if (kept < messages.length) {
				messages = messages.slice(0, kept);
				traces = traces.slice(0, kept);
				tokens = tokens.slice(0, kept);
				prefixDigests = new Map([...prefixDigests].filter(([count]) => count <= kept));
				rehash(kept);
			}
			for (let index = kept; index < snapshot.length; index += 1) {
				const message = snapshot[index] as AgentMessage;
				hash.update(`${index > 0 ? "," : ""}${elementJson(message, index)}`);
				messages.push(message);
				traces.push(traceValue(message));
				tokens.push(estimateAgentMessageTokens(message));
			}
			const length = snapshot.length;
			const full = hash.copy();
			const digests = prefixDigests;
			const messageTokens = tokens.slice(0, length);
			return {
				messages: snapshot,
				messageTokens,
				digest(requested = length): string {
					// Cached per prefix length, so a count past the end is the whole list and keyed as such.
					const count = Math.min(Math.max(0, requested), length);
					const cached = digests.get(count);
					if (cached !== undefined) return cached;
					const digest =
						count === length ? full.copy().update("]").digest("hex") : sha256(JSON.stringify(snapshot.slice(0, count)));
					digests.set(count, digest);
					return digest;
				},
			};
		},
	};
}
