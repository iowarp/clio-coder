import { createHash, type Hash } from "node:crypto";
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

const OBJECT = Symbol("object");
const ARRAY = Symbol("array");
const END = Symbol("end");

function plain(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return (
		(Array.isArray(value) || proto === Object.prototype || proto === null) &&
		typeof (value as { toJSON?: unknown }).toJSON !== "function"
	);
}

function traceInto(value: unknown, out: unknown[]): boolean {
	if (value === null || typeof value !== "object") {
		out.push(value);
		return true;
	}
	if (!plain(value)) return false;
	if (Array.isArray(value)) {
		out.push(ARRAY, value.length);
		for (const item of value) if (!traceInto(item, out)) return false;
	} else {
		out.push(OBJECT);
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			out.push(key);
			if (!traceInto(record[key], out)) return false;
		}
	}
	out.push(END);
	return true;
}

/**
 * Every key and leaf of a message in walk order. Strings are immutable, so comparing a fresh walk against it with `===`
 * finds any in-place edit, a same-length one included, at a cost of the message's node count and not its byte count.
 * Null when the message holds anything but plain data (a Date, a class, a `toJSON`), which is then always re-read.
 */
function traceMessage(message: unknown): unknown[] | null {
	const out: unknown[] = [];
	return traceInto(message, out) ? out : null;
}

// One comparison runs at a time, synchronously; module state keeps the walk free of per-call closures.
let expected: ReadonlyArray<unknown> = [];
let cursor = 0;

function matchesFrom(value: unknown): boolean {
	if (value === null || typeof value !== "object") return expected[cursor++] === value;
	if (!plain(value)) return false;
	if (Array.isArray(value)) {
		if (expected[cursor++] !== ARRAY || expected[cursor++] !== value.length) return false;
		for (const item of value) if (!matchesFrom(item)) return false;
	} else {
		if (expected[cursor++] !== OBJECT) return false;
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) if (expected[cursor++] !== key || !matchesFrom(record[key])) return false;
	}
	return expected[cursor++] === END;
}

function matchesTrace(message: unknown, trace: ReadonlyArray<unknown>): boolean {
	expected = trace;
	cursor = 0;
	try {
		return matchesFrom(message) && cursor === trace.length;
	} finally {
		expected = [];
	}
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
				traces.push(traceMessage(message));
				tokens.push(estimateAgentMessageTokens(message));
			}
			const length = snapshot.length;
			const full = hash.copy();
			const digests = prefixDigests;
			const messageTokens = tokens.slice(0, length);
			return {
				messages: snapshot,
				messageTokens,
				digest(count = length): string {
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
