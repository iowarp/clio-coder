import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareHookRegistration } from "../middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../middleware/types.js";
import {
	type CommandSegment,
	commandSegment,
	commandSegments,
	receiptVouches,
	successfulShellReceipt,
} from "./command-evidence.js";
import { lessonCommands, lessonSubject, repositoryRelativePath } from "./lesson-evidence.js";
import { loadMemoryRecordsSync } from "./store.js";
import type { MemoryRecord } from "./types.js";

/**
 * Recall versus use. A memory record the host carried into a turn (the
 * `# Memory` selection, a lesson reminder, a `memory_recall` hit) counts as
 * recalled. It counts as used on a typed fact only: the turn cites its id, or
 * a shell call whose evidence identity is the lesson's recommended command
 * succeeded in the turn. Words the turn shares with the lesson are not use;
 * on generic coding vocabulary that rule marked one stale lesson used 202
 * times in 318 recalls (XR-26). Reading or changing a file the lesson names is
 * `exposed`: recorded, and neither use nor a verdict, so it leaves the unused
 * run unchanged. A lesson that recommends no command cannot be scored for use,
 * so an uncited recall of one leaves its unused run unchanged too. Records
 * recalled `MEMORY_DEMOTE_AFTER_UNUSED` scored turns running without use are
 * demoted: the relevance gate then asks more of them. Nothing is deleted or
 * unapproved; one use clears the demotion.
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
	/** Recalled turns that read or changed a file the record names without using it. */
	exposed?: number;
}

export interface RecallUseLedger {
	version: 1;
	records: Record<string, RecallUseEntry>;
}

/** `unscored`: the record recommends no command and was not cited, so the turn says nothing about its use. */
export type MemoryUseSignal = "cited" | "command" | "exposed" | "unscored";

/** What one turn did, in typed facts. */
export interface TurnUseEvidence {
	/** The turn's final text and tool arguments; searched for a cited record id and nothing else. */
	readonly text: string;
	/** Evidence identities of the shell segments that succeeded in the turn. */
	readonly segments: ReadonlyArray<CommandSegment>;
	/** Repository-relative paths the turn read or changed. */
	readonly touched: ReadonlySet<string>;
}

function recallUseLedgerPath(stateDir: string): string {
	return join(stateDir, "memory", "recall-use-v1.json");
}

/**
 * Whether a turn used one record. Use is a cited id, or a succeeded segment that vouches for one of the lesson's
 * recommended commands by evidence identity; a `printf` of that command, a piped run or a run from another
 * checkout has a different identity or none. Reading or changing a file the lesson names is `exposed`. Null means
 * recalled and unused.
 */
export function detectMemoryUse(
	record: Pick<MemoryRecord, "id" | "lesson" | "evidenceRefs">,
	evidence: TurnUseEvidence,
	root?: string,
): MemoryUseSignal | null {
	if (evidence.text.includes(record.id)) return "cited";
	const claims = lessonCommands(record.lesson, record.evidenceRefs, root).recommended.flatMap(
		(command) => commandSegment(command, root) ?? [],
	);
	if (claims.some((claim) => evidence.segments.some((segment) => receiptVouches(claim, segment)))) return "command";
	if (lessonSubject(record.lesson).paths.some((path) => evidence.touched.has(path))) return "exposed";
	return claims.length === 0 ? "unscored" : null;
}

/**
 * One turn: every recalled id, those used, those exposed, and those the turn could not score. Exposed and unscored
 * ids leave the unused run as it was.
 */
export interface RecallUseTurn {
	recalled: ReadonlyArray<string>;
	used: ReadonlyArray<string>;
	exposed?: ReadonlyArray<string>;
	unscored?: ReadonlyArray<string>;
	at: string;
}

/** Folds one turn into the ledger; returns a new ledger and leaves the input untouched. */
export function foldRecallUse(ledger: RecallUseLedger, turn: RecallUseTurn): RecallUseLedger {
	const records: Record<string, RecallUseEntry> = { ...ledger.records };
	const used = new Set(turn.used);
	const exposed = new Set(turn.exposed ?? []);
	const unscored = new Set(turn.unscored ?? []);
	for (const id of new Set(turn.recalled)) {
		const prior = records[id];
		const hit = used.has(id);
		const seen = (prior?.exposed ?? 0) + (!hit && exposed.has(id) ? 1 : 0);
		const unused = prior?.consecutiveUnused ?? 0;
		records[id] = {
			recalled: (prior?.recalled ?? 0) + 1,
			used: (prior?.used ?? 0) + (hit ? 1 : 0),
			// Exposed and unscored turns are no verdict, so only a scored turn without use extends the unused run.
			consecutiveUnused: hit ? 0 : unscored.has(id) || exposed.has(id) ? unused : unused + 1,
			lastRecalledAt: turn.at,
			...(hit ? { lastUsedAt: turn.at } : prior?.lastUsedAt !== undefined ? { lastUsedAt: prior.lastUsedAt } : {}),
			...(seen > 0 ? { exposed: seen } : {}),
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
		(entry.lastUsedAt === undefined || typeof entry.lastUsedAt === "string") &&
		(entry.exposed === undefined || Number.isInteger(entry.exposed))
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

async function recordRecallUse(stateDir: string, turn: RecallUseTurn): Promise<void> {
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
	/** The checkout commands and paths are judged against; the process directory when absent. */
	workspaceRoot?(): string;
	/** Each turn's verdict, for tracing and tests. */
	onTurn?(turn: { recalled: ReadonlyArray<string>; used: ReadonlyArray<string>; exposed: ReadonlyArray<string> }): void;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

/** Segments and paths kept per turn; a turn past these says no more about use than its first ones. */
const TURN_FACTS_MAX = 256;
const PATH_TOOLS: ReadonlySet<string> = new Set([ToolNames.Read, ToolNames.Write, ToolNames.Edit]);

/**
 * Observes a turn (the arguments of every tool it called, the shell tool's own
 * success receipts, the files it read or changed, and its final text) and
 * records recall versus use at `turn_end`, in the awaited phase so the write is
 * never detached. It never emits an effect. Recalled ids carry no position in
 * the turn, so a command that succeeded earlier in the turn than a mid-turn
 * reminder counts as after it.
 */
export function createMemoryRecallUseRegistration(deps: MemoryRecallUseDeps): MiddlewareHookRegistration {
	let text: string[] = [];
	let textChars = 0;
	let segments: CommandSegment[] = [];
	let touched = new Set<string>();
	const root = (): string => {
		try {
			return deps.workspaceRoot?.() ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};
	const note = (value: string): void => {
		if (textChars >= EVIDENCE_MAX_CHARS || value.length === 0) return;
		const kept = value.slice(0, EVIDENCE_MAX_CHARS - textChars);
		text.push(kept);
		textChars += kept.length;
	};
	const reset = (): void => {
		text = [];
		textChars = 0;
		segments = [];
		touched = new Set();
	};
	const observeTool = (input: MiddlewareHookInput): void => {
		const args = input.toolArgs;
		if (args === undefined) return;
		try {
			note(JSON.stringify(args));
		} catch {
			// An argument that cannot be serialized says nothing about memory.
		}
		const ok = input.metadata?.resultKind === "ok";
		if (
			input.toolName === ToolNames.Bash &&
			typeof args.command === "string" &&
			successfulShellReceipt(ok, input.toolResultDetails) &&
			segments.length < TURN_FACTS_MAX
		)
			segments.push(...commandSegments(args.command, root(), typeof args.cwd === "string" ? args.cwd : undefined));
		const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (ok && path !== null && PATH_TOOLS.has(input.toolName ?? "") && touched.size < TURN_FACTS_MAX) {
			const relative = repositoryRelativePath(path, [root()]);
			if (relative !== null) touched.add(relative);
		}
	};
	return {
		id: MEMORY_RECALL_USE_REGISTRATION_ID,
		description: "record which carried memory records a turn actually used",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "turn_start" && input.metadata?.requestContinuation !== true) reset();
			else if (input.hook === "after_tool") observeTool(input);
			return NO_EFFECTS;
		},
		async evaluateAsync(input: MiddlewareHookInput): Promise<ReadonlyArray<MiddlewareEffect>> {
			if (input.hook !== "turn_end") return NO_EFFECTS;
			const recalled = [...new Set(deps.takeRecalled())];
			note(input.text ?? "");
			const evidence: TurnUseEvidence = { text: text.join("\n"), segments, touched };
			reset();
			const stop = input.metadata?.stopReason;
			if (recalled.length === 0 || !deps.enabled() || stop === "aborted" || stop === "error") return NO_EFFECTS;
			try {
				const records = new Map(loadMemoryRecordsSync(deps.dataDir()).map((record) => [record.id, record]));
				const checkout = root();
				const signals = new Map(
					recalled.map((id) => {
						const record = records.get(id);
						return [id, record === undefined ? null : detectMemoryUse(record, evidence, checkout)] as const;
					}),
				);
				const having = (...kinds: MemoryUseSignal[]) =>
					recalled.filter((id) => kinds.includes(signals.get(id) as MemoryUseSignal));
				const used = having("cited", "command");
				const exposed = having("exposed");
				deps.onTurn?.({ recalled, used, exposed });
				await recordRecallUse(deps.stateDir(), {
					recalled,
					used,
					exposed,
					unscored: having("unscored"),
					at: new Date().toISOString(),
				});
			} catch {
				// The counts are advisory; a turn never fails on them.
			}
			return NO_EFFECTS;
		},
	};
}
