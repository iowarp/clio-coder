/**
 * Durable host inserts (SPEC §1.3, F6 and F13).
 *
 * Every message the host puts into the model's history outside the event path
 * (a reminder tail, a continuation, a pinned delta, a memory restoration, a
 * recovery exchange) is written as a record holding its exact elements before
 * it reaches the live history. Render places the record where the live
 * request carried it, so a rebuild, a reopen and a fork send the same bytes.
 *
 * The service also keeps the ids of inserts no dispatched attempt has carried,
 * each under the session that wrote it.
 * A checkpoint whose cut removes such an insert's anchor re-issues it after the
 * checkpoint, durably, so the next request still carries it.
 */

import { randomBytes } from "node:crypto";
import type { SessionContract } from "../domains/session/contract.js";
import {
	HOST_INSERT_CUSTOM_TYPE,
	type HostInsertData,
	type HostInsertRecord,
	type HostInsertRestoration,
	type HostInsertSource,
	type SessionEntry,
} from "../domains/session/entries.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { AgentMessage } from "../engine/types.js";
import {
	hostInsertVisible,
	newestRenderedRow,
	readHostInserts,
	selectReplayEntries,
} from "./session-replay-messages.js";

export interface HostInsertsDeps {
	session?: Pick<SessionContract, "current" | "appendEntry" | "flushAppends"> | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	/** The message leaf the next record hangs from, so the active-path filter keeps it. */
	leaf(): string | null;
}

/** The live history a push or a removal acts on. */
export interface LiveHistory {
	agent: { state: { messages: AgentMessage[] } };
}

export interface HostInsertOptions {
	/** Place before this row instead of after the newest rendered one: restoration at submit only. */
	before?: string;
	/** Rows render omits because the record stands for them. */
	replaces?: ReadonlyArray<string>;
	/** Rows that may not anchor the record: a stopped reply the record replaces. */
	exclude?: ReadonlyArray<string>;
	restoration?: HostInsertRestoration;
	/** The rule that emitted a `reminder` record, kept on the record for audit (X6). */
	rule?: string;
}

export interface HostInserts {
	/** Write the record only; the caller hands the elements to the engine, which pushes them itself. */
	record(
		source: HostInsertSource,
		elements: ReadonlyArray<AgentMessage>,
		options?: HostInsertOptions,
	): HostInsertRecord | null;
	/** Write the record, then push its elements onto the live history. Without a session it only pushes. */
	insert(
		runtime: LiveHistory,
		source: HostInsertSource,
		elements: ReadonlyArray<AgentMessage>,
		options?: HostInsertOptions,
	): HostInsertRecord | null;
	/** Reserve the row id the event path will write for a host-authored message a record already holds. */
	reserveRowId(message: object): string;
	reservedRowId(message: unknown): string | undefined;
	/** An attempt was dispatched: the current session's inserts that render on its branch have been carried. */
	dispatched(): void;
	isUnsent(id: string): boolean;
	/** After a checkpoint commits: re-issue each unsent insert whose anchor the cut removed. */
	reissueUnsent(): void;
	/** Withdraw a record durably and take its elements out of the live history. */
	retract(record: HostInsertRecord, runtime?: LiveHistory): void;
	/** The records on the active path, in record order. */
	onPath(): HostInsertRecord[];
	/** Make the live history hold the record's elements exactly once; true when they had to be pushed. */
	ensureLive(runtime: LiveHistory, record: HostInsertRecord): boolean;
	/** Records of this source on the path that an earlier process wrote, each returned once. */
	inherited(source: HostInsertSource): HostInsertRecord[];
}

function newInsertId(): string {
	return BigInt(`0x${randomBytes(8).toString("hex")}`)
		.toString(36)
		.slice(0, 12)
		.padStart(12, "0");
}

const sameElement = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export function createHostInserts(deps: HostInsertsDeps): HostInserts {
	const reserved = new WeakMap<object, string>();
	let unsent: Array<{ record: HostInsertRecord; sessionId: string }> = [];
	// Ids this process wrote or already reported as inherited.
	const known = new Set<string>();

	const pathEntries = (): SessionEntry[] =>
		filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], deps.leaf() ?? undefined);

	const append = (data: HostInsertData): void => {
		deps.session?.appendEntry({
			kind: "custom",
			customType: HOST_INSERT_CUSTOM_TYPE,
			parentTurnId: deps.leaf(),
			data,
		});
		deps.session?.flushAppends?.();
	};

	const record: HostInserts["record"] = (source, elements, options = {}) => {
		const owner = deps.session?.current();
		if (!owner || elements.length === 0) return null;
		const exclude = new Set(options.exclude ?? []);
		const anchor =
			options.before !== undefined
				? { before: options.before }
				: newestRenderedRow(deps.readSessionEntries?.() ?? [], deps.leaf(), exclude);
		if (anchor === null) return null;
		const data: HostInsertRecord = {
			version: 1,
			id: newInsertId(),
			source,
			elements: elements.map((element) => structuredClone(element)),
			place: typeof anchor === "string" ? { after: anchor } : anchor,
			...(options.replaces && options.replaces.length > 0 ? { replaces: [...options.replaces] } : {}),
			...(options.restoration ? { restoration: options.restoration } : {}),
			...(options.rule !== undefined ? { rule: options.rule } : {}),
		};
		append(data);
		known.add(data.id);
		unsent.push({ record: data, sessionId: owner.id });
		return data;
	};

	const removeLive = (runtime: LiveHistory, elements: ReadonlyArray<AgentMessage>): void => {
		let messages = runtime.agent.state.messages;
		for (const element of elements) {
			const index = messages.findIndex((message) => sameElement(message, element));
			if (index >= 0) messages = [...messages.slice(0, index), ...messages.slice(index + 1)];
		}
		runtime.agent.state.messages = messages;
	};

	return {
		record,
		insert(runtime, source, elements, options) {
			const written = record(source, elements, options);
			runtime.agent.state.messages.push(...elements);
			return written;
		},
		reserveRowId(message) {
			const id = newInsertId();
			reserved.set(message, id);
			return id;
		},
		reservedRowId: (message) => (message !== null && typeof message === "object" ? reserved.get(message) : undefined),
		dispatched() {
			const sessionId = deps.session?.current()?.id;
			if (!unsent.some((item) => item.sessionId === sessionId)) return;
			const entries = deps.readSessionEntries?.() ?? [];
			unsent = unsent.filter(
				(item) => item.sessionId !== sessionId || !hostInsertVisible(entries, deps.leaf(), item.record),
			);
		},
		isUnsent: (id) => unsent.some((item) => item.record.id === id),
		reissueUnsent() {
			const sessionId = deps.session?.current()?.id;
			if (sessionId === undefined || !unsent.some((item) => item.sessionId === sessionId)) return;
			const entries = deps.readSessionEntries?.() ?? [];
			const checkpoint = selectReplayEntries(entries, {
				...(deps.leaf() ? { activeLeafTurnId: deps.leaf() ?? "" } : {}),
			})[0];
			if (checkpoint?.kind !== "compactionSummary") return;
			const live = new Set(readHostInserts(filterEntriesToActivePath(entries, deps.leaf() ?? undefined)).map((r) => r.id));
			unsent = unsent.map((item) => {
				const original = item.record;
				if (item.sessionId !== sessionId || !live.has(original.id) || hostInsertVisible(entries, deps.leaf(), original))
					return item;
				const { place: _place, id: _id, ...rest } = original;
				const next: HostInsertRecord = { ...rest, id: newInsertId(), place: { after: checkpoint.turnId } };
				append(next);
				known.add(next.id);
				return { record: next, sessionId };
			});
		},
		retract(target, runtime) {
			if (deps.session?.current()) append({ version: 1, id: target.id, retract: true });
			unsent = unsent.filter((item) => item.record.id !== target.id);
			if (runtime) removeLive(runtime, target.elements);
		},
		onPath: () => readHostInserts(pathEntries()),
		ensureLive(runtime, target) {
			const first = target.elements[0];
			if (runtime.agent.state.messages.some((message) => sameElement(message, first))) return false;
			runtime.agent.state.messages.push(...target.elements.map((element) => structuredClone(element)));
			return true;
		},
		inherited(source) {
			const found = readHostInserts(pathEntries()).filter((item) => item.source === source && !known.has(item.id));
			for (const item of found) known.add(item.id);
			return found;
		},
	};
}
