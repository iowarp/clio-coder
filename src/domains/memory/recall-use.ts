import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { MiddlewareHookRegistration } from "../middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../middleware/types.js";
import { memoryGateTerms } from "./relevance.js";
import { loadMemoryRecordsSync } from "./store.js";
import type { MemoryRecord } from "./types.js";

/**
 * Recall versus use. A memory record the host carried into a turn (the
 * `# Memory` selection, a lesson reminder, a `memory_recall` hit) counts as
 * recalled; it counts as used when the turn's own output acts on it: the model
 * cites its id, repeats a literal it names (a path, a command, a backticked
 * span), or carries most of its distinctive terms that the operator's request
 * did not already supply. Records recalled `MEMORY_DEMOTE_AFTER_UNUSED` turns
 * running without use are demoted: the relevance gate then asks more of them.
 * Nothing is deleted or unapproved; one use clears the demotion.
 */

export const MEMORY_DEMOTE_AFTER_UNUSED = 5;
/** Ids kept; the store holds at most 500 records, so this only bounds a store churned through over time. */
const RECALL_USE_MAX_ENTRIES = 1_000;
const RECALL_USE_LOCK_TIMEOUT_MS = 500;
/** Bounded evidence per turn; a huge tool argument says no more about use than its head. */
const EVIDENCE_MAX_CHARS = 64_000;

export interface RecallUseEntry {
	recalled: number;
	used: number;
	consecutiveUnused: number;
	lastRecalledAt: string;
	lastUsedAt?: string;
}

export interface RecallUseLedger {
	version: 1;
	records: Record<string, RecallUseEntry>;
}

export type MemoryUseSignal = "cited" | "literal" | "terms";

function recallUseLedgerPath(stateDir: string): string {
	return join(stateDir, "memory", "recall-use-v1.json");
}

/** A path, a flag-bearing command or a backticked span the lesson names, at least 6 characters. */
function lessonLiterals(lesson: string): string[] {
	const ticked = [...lesson.matchAll(/`([^`\n]{6,200})`/gu)].map((match) => match[1] ?? "");
	const tokens = (lesson.match(/[\p{L}\p{N}_@~./:=-]{6,}/gu) ?? [])
		.map((token) => token.replace(/[.:]+$/u, ""))
		.filter((token) => /[/=]|\.[a-z]{1,5}$|^--[a-z]/iu.test(token));
	return [...new Set([...ticked, ...tokens].map((value) => value.trim()).filter((value) => value.length >= 6))];
}

/**
 * Whether a turn's output acted on one record. `task` is the operator's text
 * for the turn: terms it already holds prove nothing, since the model echoes
 * its request whether or not a lesson helped.
 */
export function detectMemoryUse(
	record: Pick<MemoryRecord, "id" | "lesson" | "appliesWhen">,
	evidence: string,
	task = "",
): MemoryUseSignal | null {
	if (evidence.length === 0) return null;
	if (evidence.includes(record.id)) return "cited";
	const lowered = evidence.toLowerCase();
	const request = task.toLowerCase();
	const literals = lessonLiterals(record.lesson)
		.map((literal) => literal.toLowerCase())
		.filter((literal) => !request.includes(literal));
	if (literals.some((literal) => lowered.includes(literal))) return "literal";
	const asked = memoryGateTerms(task);
	const own = [...memoryGateTerms([record.lesson, ...record.appliesWhen].join("\n"))].filter((term) => !asked.has(term));
	if (own.length < 2) return null;
	const said = memoryGateTerms(evidence);
	const carried = own.filter((term) => said.has(term)).length;
	return carried >= Math.min(5, Math.max(2, Math.ceil(own.length * 0.4))) ? "terms" : null;
}

/** Folds one turn into the ledger; returns a new ledger and leaves the input untouched. */
export function foldRecallUse(
	ledger: RecallUseLedger,
	turn: { recalled: ReadonlyArray<string>; used: ReadonlyArray<string>; at: string },
): RecallUseLedger {
	const records: Record<string, RecallUseEntry> = { ...ledger.records };
	const used = new Set(turn.used);
	for (const id of new Set(turn.recalled)) {
		const prior = records[id];
		const hit = used.has(id);
		records[id] = {
			recalled: (prior?.recalled ?? 0) + 1,
			used: (prior?.used ?? 0) + (hit ? 1 : 0),
			consecutiveUnused: hit ? 0 : (prior?.consecutiveUnused ?? 0) + 1,
			lastRecalledAt: turn.at,
			...(hit ? { lastUsedAt: turn.at } : prior?.lastUsedAt !== undefined ? { lastUsedAt: prior.lastUsedAt } : {}),
		};
	}
	const ids = Object.keys(records);
	if (ids.length > RECALL_USE_MAX_ENTRIES) {
		ids
			.sort((a, b) => (records[a]?.lastRecalledAt ?? "").localeCompare(records[b]?.lastRecalledAt ?? ""))
			.slice(0, ids.length - RECALL_USE_MAX_ENTRIES)
			.forEach((id) => {
				delete records[id];
			});
	}
	return { version: 1, records };
}

export function demotedMemoryIds(ledger: RecallUseLedger): Set<string> {
	return new Set(
		Object.entries(ledger.records)
			.filter(([, entry]) => entry.consecutiveUnused >= MEMORY_DEMOTE_AFTER_UNUSED)
			.map(([id]) => id),
	);
}

function isEntry(value: unknown): value is RecallUseEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		Number.isInteger(entry.recalled) &&
		Number.isInteger(entry.used) &&
		Number.isInteger(entry.consecutiveUnused) &&
		typeof entry.lastRecalledAt === "string" &&
		(entry.lastUsedAt === undefined || typeof entry.lastUsedAt === "string")
	);
}

/** The ledger on disk; a missing or unreadable file reads as empty, since the counts are advisory. */
export function readRecallUseLedger(stateDir: string): RecallUseLedger {
	const path = recallUseLedgerPath(stateDir);
	if (!existsSync(path)) return { version: 1, records: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; records?: unknown };
		if (parsed.version !== 1 || typeof parsed.records !== "object" || parsed.records === null)
			return { version: 1, records: {} };
		return {
			version: 1,
			records: Object.fromEntries(Object.entries(parsed.records).filter(([, entry]) => isEntry(entry))),
		};
	} catch {
		return { version: 1, records: {} };
	}
}

async function recordRecallUse(
	stateDir: string,
	turn: { recalled: ReadonlyArray<string>; used: ReadonlyArray<string>; at: string },
): Promise<void> {
	if (turn.recalled.length === 0) return;
	const path = recallUseLedgerPath(stateDir);
	await withStateFileLock(
		path,
		() => {
			const next = foldRecallUse(readRecallUseLedger(stateDir), turn);
			safeResourceWrite(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		},
		{ timeoutMs: RECALL_USE_LOCK_TIMEOUT_MS, note: "memory recall-use" },
	);
}

export const MEMORY_RECALL_USE_REGISTRATION_ID = "observer.memory-recall-use";

export interface MemoryRecallUseDeps {
	dataDir(): string;
	stateDir(): string;
	enabled(): boolean;
	/** The record ids carried into the turn now ending; the call clears them. */
	takeRecalled(): ReadonlyArray<string>;
	/** Each turn's verdict, for tracing and tests. */
	onTurn?(turn: { recalled: ReadonlyArray<string>; used: ReadonlyArray<string> }): void;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

/**
 * Observes a turn (its request, the arguments of every tool it called and its
 * final text) and records recall versus use at `turn_end`, in the awaited
 * phase so the write is never detached. It never emits an effect.
 */
export function createMemoryRecallUseRegistration(deps: MemoryRecallUseDeps): MiddlewareHookRegistration {
	let task = "";
	let evidence: string[] = [];
	let evidenceChars = 0;
	const note = (text: string): void => {
		if (evidenceChars >= EVIDENCE_MAX_CHARS || text.length === 0) return;
		const kept = text.slice(0, EVIDENCE_MAX_CHARS - evidenceChars);
		evidence.push(kept);
		evidenceChars += kept.length;
	};
	return {
		id: MEMORY_RECALL_USE_REGISTRATION_ID,
		description: "record which carried memory records a turn actually used",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "turn_start" && input.metadata?.requestContinuation !== true) {
				task = input.text ?? "";
				evidence = [];
				evidenceChars = 0;
			} else if (input.hook === "after_tool" && input.toolArgs !== undefined) {
				try {
					note(JSON.stringify(input.toolArgs));
				} catch {
					// An argument that cannot be serialized says nothing about memory.
				}
			}
			return NO_EFFECTS;
		},
		async evaluateAsync(input: MiddlewareHookInput): Promise<ReadonlyArray<MiddlewareEffect>> {
			if (input.hook !== "turn_end") return NO_EFFECTS;
			const recalled = [...new Set(deps.takeRecalled())];
			note(input.text ?? "");
			const said = evidence.join("\n");
			evidence = [];
			evidenceChars = 0;
			const stop = input.metadata?.stopReason;
			if (recalled.length === 0 || !deps.enabled() || stop === "aborted" || stop === "error") return NO_EFFECTS;
			try {
				const records = new Map(loadMemoryRecordsSync(deps.dataDir()).map((record) => [record.id, record]));
				const used = recalled.filter((id) => {
					const record = records.get(id);
					return record !== undefined && detectMemoryUse(record, said, task) !== null;
				});
				deps.onTurn?.({ recalled, used });
				await recordRecallUse(deps.stateDir(), { recalled, used, at: new Date().toISOString() });
			} catch {
				// The counts are advisory; a turn never fails on them.
			}
			return NO_EFFECTS;
		},
	};
}
