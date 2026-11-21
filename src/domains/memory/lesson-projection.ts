/**
 * The approved repository lessons an action-time reminder may cite, as an
 * immutable projection of the durable store.
 *
 * Action reminders used to reduce each record to its id and prose, so the
 * conditions stored beside the prose, who approved it and which command its
 * evidence named never reached the reminder. The projection keeps them, and
 * it is cached by the store's revision and the workspace's repository
 * authority: tool boundaries ask for it on every call, and rereading and
 * resorting the whole store there was most of the work.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { MemoryDeliveryMode } from "../../core/defaults.js";
import { canonicalCheckout } from "../../core/project-root.js";
import { COMMAND_EVIDENCE_REF_PREFIX, parseSourceEvidenceRef, type SourceEvidence } from "./command-evidence.js";
import {
	MEMORY_UNSETTLED_SESSIONS_MAX,
	readUnsettledLedger,
	type UnsettledLedger,
	unsettledSessions,
} from "./delivery-ledger.js";
import { evaluateMemoryGate, operatorDecided } from "./guardian-gate.js";
import {
	type LessonCommands,
	lessonCommands,
	lessonSubject,
	programResolves,
	readInsideRoot,
	repositoryRelativePath,
} from "./lesson-evidence.js";
import { canonicalMemoryRepositoryIdentity, cloneMemoryRecord, eligibleMemoryRecords } from "./operations.js";
import { claimDeliveryPathRefusal, memoryRevision, recordClaim } from "./promotion.js";
import { memoryStorePath, mutateMemoryRecords, readMemoryStoreSnapshot } from "./store.js";
import type { MemoryClaimCommand, MemoryRecord } from "./types.js";

/** `note`: an unpromoted fix claim a failed call matched; it rides only `_variant`, labelled unverified (DESIGN 4.4). */
export type KeptLessonApproval = "operator" | "automatic" | "note";

export interface KeptLesson {
	readonly id: string;
	readonly text: string;
	/** Prose conditions; scope identities the eligibility filter already matched are left out. */
	readonly appliesWhen: readonly string[];
	readonly avoidWhen: readonly string[];
	/** An operator approved it, or the evidence gate retained it without one. */
	readonly approval: KeptLessonApproval;
	/** `command:` and `source:` evidence identities recorded with the claim. */
	readonly evidenceRefs: readonly string[];
	readonly commands: LessonCommands;
	readonly paths: readonly string[];
	/** Repository paths its `source:` evidence quotes. */
	readonly sourcePaths: readonly string[];
	/** A fix claim's failed pattern; a failed call reaches the lesson only with this identity. */
	readonly failed?: MemoryClaimCommand;
	/** Changes whenever the text, conditions or approval change; a reminder cites this. */
	readonly revision: string;
}

/** Scope applicability written by promotion; eligibility already decided these. */
const SCOPE_CONDITION = /^(?:repository|runtime|agent):/u;

export function projectKeptLesson(record: MemoryRecord): KeptLesson {
	const appliesWhen = record.appliesWhen.filter((condition) => !SCOPE_CONDITION.test(condition));
	const avoidWhen = [...record.avoidWhen];
	// A record approved before approval stamps existed was reviewed by a person (see guardian-gate).
	const approval: KeptLessonApproval = !record.approved
		? "note"
		: record.approval?.by === "guardian"
			? "automatic"
			: "operator";
	const evidenceRefs = record.evidenceRefs.filter(
		(ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX) || ref.startsWith("source:"),
	);
	const claim = recordClaim(record);
	return Object.freeze({
		id: record.id,
		text: record.lesson,
		appliesWhen: Object.freeze(appliesWhen),
		avoidWhen: Object.freeze(avoidWhen),
		approval,
		evidenceRefs: Object.freeze(evidenceRefs),
		commands: Object.freeze(lessonCommands(record.lesson, record.evidenceRefs)),
		paths: Object.freeze([...lessonSubject(record.lesson).paths]),
		sourcePaths: Object.freeze(evidenceRefs.flatMap((ref) => parseSourceEvidenceRef(ref)?.path ?? [])),
		...(claim?.kind === "fix" ? { failed: claim.failed } : {}),
		revision: createHash("sha256")
			.update(JSON.stringify([record.lesson, appliesWhen, avoidWhen, approval, evidenceRefs]))
			.digest("hex")
			.slice(0, 16),
	});
}

/** How a reminder names who stands behind a lesson. */
export function keptLessonLabel(lesson: KeptLesson): string {
	if (lesson.approval === "operator") return "operator-approved";
	if (lesson.approval === "note") return "unverified note from an earlier session";
	if (lesson.evidenceRefs.length === 0) return "retained automatically";
	// A file quote alone never vouches for a claim, so a lesson the gate kept on
	// one before that rule is labelled as the unreviewed quote it is.
	return lesson.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX))
		? "retained automatically from execution evidence"
		: "unreviewed, quoted from a repository file";
}

/** One reminder line: the claim with its provenance and the conditions stored beside it. */
export function renderKeptLesson(lesson: KeptLesson): string {
	const conditions = [
		lesson.appliesWhen.length ? ` Applies when: ${lesson.appliesWhen.map(compact).join("; ")}.` : "",
		lesson.avoidWhen.length ? ` Avoid when: ${lesson.avoidWhen.map(compact).join("; ")}.` : "",
	].join("");
	return `Memory: [${lesson.id}] (${keptLessonLabel(lesson)}) ${compact(lesson.text)}${conditions}`;
}

export interface KeptLessonSource {
	/**
	 * Approved lessons for the repository the workspace belongs to; empty outside a repository. With `admit`, only
	 * the lessons whose records it admits, asked on every call: delivery decides per session, not per store revision.
	 */
	lessons(workspaceRoot: string, admit?: (record: MemoryRecord) => boolean): readonly KeptLesson[];
}

/**
 * Reads the store only when its file identity changes, and projects only when
 * its content revision or the workspace's repository authority does. An
 * unreadable store yields no lessons; the session continues without them.
 */
export function createKeptLessonSource(dataDir: () => string): KeptLessonSource {
	let file: { path: string; stamp: string; revision: string; records: readonly MemoryRecord[] } | null = null;
	let projected: { key: string; pairs: ReadonlyArray<readonly [MemoryRecord, KeptLesson]> } | null = null;
	const repositories = new Map<string, string | null>();
	const repositoryKey = (root: string): string | null => {
		if (!repositories.has(root)) {
			if (repositories.size >= 32) repositories.delete(repositories.keys().next().value ?? "");
			repositories.set(root, canonicalMemoryRepositoryIdentity(root)?.key ?? null);
		}
		return repositories.get(root) ?? null;
	};
	return {
		lessons(workspaceRoot, admit) {
			const root = dataDir();
			const path = memoryStorePath(root);
			let stamp = "missing";
			try {
				const info = statSync(path);
				stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
			} catch {
				/* A missing store has no lessons; the stamp still keys the empty read. */
			}
			try {
				if (file?.path !== path || file.stamp !== stamp) {
					const snapshot = readMemoryStoreSnapshot(root);
					file = { path, stamp, revision: snapshot.revision, records: snapshot.records };
				}
			} catch {
				file = null;
				projected = null;
				return [];
			}
			const repository = repositoryKey(workspaceRoot);
			if (repository === null) return [];
			const key = JSON.stringify([path, file.revision, repository]);
			if (projected?.key !== key) {
				const eligible = eligibleMemoryRecords(file.records, {
					scopes: ["repo"],
					activeRepository: { kind: "canonical-path", key: repository },
				});
				projected = {
					key,
					pairs: Object.freeze(eligible.map((record) => [record, projectKeptLesson(record)] as const)),
				};
			}
			return projected.pairs.flatMap(([record, lesson]) => (admit === undefined || admit(record) ? [lesson] : []));
		},
	};
}

function compact(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** What the delivery check reads: a checkout file once per session, `null` when it is gone, `undefined` unread. */
interface DeliveryCheckInput {
	/** The checkout root of the session's workspace: source and program paths resolve here, never against its cwd. */
	readonly root: string;
	readonly file: (path: string) => SourceFile | null | undefined;
}

/** A source file as delivery read it, with the digests of its line windows computed on first need. */
interface SourceFile {
	readonly content: string;
	windows?: Set<string>;
}

/**
 * The delivery check of DESIGN 4.3, made when a lesson is loaded for delivery. It withholds only a lesson that is
 * certainly dead: the first word of the command it recommends no longer resolves (a program on `PATH`, a repository
 * program, a known runner), a file it quotes is gone, or the span it pins is known exactly (found as whole lines of
 * the file, or recovered from the lesson's own words) and the file no longer holds it. A lesson that binds a path
 * outside its repository checkout (another worktree, another checkout) is refused as at write (CLI-P25), with scratch
 * placement left to the writer. A
 * span it cannot locate either way is undecided, and the lesson is delivered. Null when nothing is certainly dead,
 * otherwise why. It proves nothing about a subcommand, a flag or the claim; validity rests on verdicts.
 */
function memoryDeliveryCheck(record: MemoryRecord, input: DeliveryCheckInput): string | null {
	const claim = recordClaim(record);
	// The write-time path rule, applied to repository lessons written before it: a lesson binding another worktree or a
	// path outside the checkout holds for one run only, yet reached every session of the repository. Judged against the
	// repository's canonical root (a legacy key may name a subdirectory), never against the reader's scratch roots.
	if (record.scope === "repo" && claim !== null) {
		const key = record.repository?.key ?? input.root;
		const boundPath = claimDeliveryPathRefusal(claim, canonicalMemoryRepositoryIdentity(key)?.key ?? key);
		if (boundPath !== null) return boundPath;
	}
	const recommended = claim?.kind === "command" ? claim.command : claim?.kind === "fix" ? claim.fixed : null;
	if (recommended !== null) {
		const word = recommended.argv[0] ?? "";
		if (!programResolves(word, input.root)) return `its command \`${word}\` no longer resolves here`;
	} else if (
		record.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX)) &&
		lessonCommands(record.lesson, record.evidenceRefs, input.root).recommended.length === 0
	) {
		return "its command no longer resolves here";
	}
	for (const ref of record.evidenceRefs) {
		const source = parseSourceEvidenceRef(ref);
		if (source === null) continue;
		const path = repositoryRelativePath(source.path, [
			input.root,
			...(record.repository === undefined ? [] : [record.repository.key]),
		]);
		if (path === null) continue;
		const file = input.file(path);
		if (file === null) return `${path} is gone`;
		if (file !== undefined && spanState(record, source, file) === "gone")
			return `its quoted span is no longer in ${path}`;
	}
	return null;
}

/**
 * The delivery check for a pass over the store outside a session, `clio-coder memory consolidate`: the same check
 * against one checkout, each of its files read once for the pass. Null when nothing is certainly dead, otherwise why.
 */
export function checkoutDeliveryCheck(root: string): (record: MemoryRecord) => string | null {
	const files = new Map<string, SourceFile | null | undefined>();
	const file = (path: string): SourceFile | null | undefined => {
		const key = resolve(root, path);
		if (!files.has(key)) files.set(key, readSourceFile(root, path));
		return files.get(key);
	};
	return (record) => memoryDeliveryCheck(record, { root, file });
}

/** A checkout file as the check reads it: `null` when it is gone, `undefined` when it exists but is not read. */
function readSourceFile(root: string, path: string): SourceFile | null | undefined {
	if (!existsSync(resolve(root, path))) return null;
	const content = readInsideRoot(root, path);
	return content === null ? undefined : { content };
}

/** Lines a pinned span may cover when it is looked for in its file rather than in the lesson's words. */
const SPAN_WINDOW_LINES = 6;
/** Words a span recovered from the lesson's own text may run to. */
const SPAN_WINDOW_WORDS = 64;

function spanDigest(text: string): string {
	return createHash("sha256").update(compact(text)).digest("hex");
}

/**
 * The full digest a short pinned hash stood for, recovered the way delivery finds a span: from a run of the lesson's
 * own words, then from whole-line windows of the file. Null unless exactly one digest has that prefix. Only the memory
 * store upgrade asks, for `source:` refs written before refs carried the full hash.
 */
export function recoverSpanDigest(lesson: string, prefix: string, content: string | null): string | null {
	const found = new Set<string>();
	const words = compact(lesson).split(" ");
	for (let start = 0; start < words.length; start++)
		for (let end = start; end < Math.min(words.length, start + SPAN_WINDOW_WORDS); end++)
			for (const candidate of spanCandidates(words.slice(start, end + 1).join(" "))) {
				const digest = spanDigest(candidate);
				if (digest.startsWith(prefix)) found.add(digest);
			}
	if (found.size === 0 && content !== null)
		for (const digest of lineWindowDigests(content)) if (digest.startsWith(prefix)) found.add(digest);
	const [only] = found;
	return found.size === 1 && only !== undefined ? only : null;
}

/** Outer delimiters a lesson's prose may wrap a quoted span in, each with its closer. */
const SPAN_DELIMITERS: Readonly<Record<string, string>> = { "`": "`", '"': '"', "'": "'", "(": ")", "[": "]" };
/** Sentence punctuation the prose may put after a quoted span. */
const SENTENCE_PUNCTUATION = /[.,;:!?]$/u;
/** Peels tried per run of words: enough for punctuation, a pair, punctuation again and a nested pair. */
const SPAN_PEEL_STEPS = 4;

/**
 * The texts a run of the lesson's words may quote: the run itself, then the run with one outer layer peeled at a
 * time, a matching delimiter pair or one trailing sentence mark, never both at once. A quote that itself ends in
 * punctuation or a quote mark (`"The marker is COBALT."`, `` `MODE = "prod"` ``, `` `runBuild()` ``) is kept whole at
 * some step, so its hash is found. Only an exact hash match is ever acted on, so a wrong peel proves nothing.
 */
function spanCandidates(raw: string): string[] {
	const seen = new Set([raw]);
	let frontier = [raw];
	for (let step = 0; step < SPAN_PEEL_STEPS && frontier.length > 0; step++) {
		const next: string[] = [];
		for (const text of frontier) {
			const closer = SPAN_DELIMITERS[text[0] ?? ""];
			const peeled = [
				...(closer !== undefined && text.length >= 2 && text.endsWith(closer) ? [text.slice(1, -1)] : []),
				...(SENTENCE_PUNCTUATION.test(text) ? [text.slice(0, -1)] : []),
			];
			for (const item of peeled) {
				const trimmed = item.trim();
				if (trimmed.length === 0 || seen.has(trimmed)) continue;
				seen.add(trimmed);
				next.push(trimmed);
			}
		}
		frontier = next;
	}
	return [...seen];
}

/**
 * Whether the file still holds the pinned span. Only its hash is stored. A source lesson quotes what it read, so the
 * span is first recovered from a run of the lesson's own words: then its text is known exactly, and the file holds it
 * or not. Otherwise it is looked for as whole lines of the file. Neither is `unknown`, which withholds nothing.
 */
function spanState(record: MemoryRecord, source: SourceEvidence, file: SourceFile): "held" | "gone" | "unknown" {
	const words = compact(record.lesson).split(" ");
	for (let start = 0; start < words.length; start++)
		for (let end = start; end < Math.min(words.length, start + SPAN_WINDOW_WORDS); end++) {
			for (const candidate of spanCandidates(words.slice(start, end + 1).join(" ")))
				if (spanDigest(candidate) === source.spanHash)
					return holdsTokens(compact(file.content), compact(candidate)) ? "held" : "gone";
		}
	file.windows ??= lineWindowDigests(file.content);
	return file.windows.has(source.spanHash) ? "held" : "unknown";
}

/** The digest of every run of up to `SPAN_WINDOW_LINES` whole lines, computed once per file per session. */
function lineWindowDigests(content: string): Set<string> {
	const lines = content.split("\n");
	const digests = new Set<string>();
	for (let start = 0; start < lines.length; start++)
		for (let end = start; end < Math.min(lines.length, start + SPAN_WINDOW_LINES); end++)
			digests.add(spanDigest(lines.slice(start, end + 1).join("\n")));
	return digests;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** `text` contains `span` with token boundaries: `port = 8080` is not held by `port = 80801`. */
function holdsTokens(text: string, span: string): boolean {
	if (span.length === 0) return false;
	const startsWord = WORD_CHARACTER.test(span[0] ?? "");
	const endsWord = WORD_CHARACTER.test(span.at(-1) ?? "");
	for (let at = text.indexOf(span); at >= 0; at = text.indexOf(span, at + 1)) {
		const before = text[at - 1];
		const after = text[at + span.length];
		if (startsWord && before !== undefined && WORD_CHARACTER.test(before)) continue;
		if (endsWord && after !== undefined && WORD_CHARACTER.test(after)) continue;
		return true;
	}
	return false;
}

/** What delivery does with a kept lesson it loaded. `note` returns it to the note layer; `demote` also records a regression. */
export type MemoryDeliveryVerdict =
	| { readonly deliver: true }
	| {
			readonly deliver: false;
			readonly code: "delivery-check" | "promotion-bar" | "unsettled";
			readonly reason: string;
			readonly action: "withhold" | "note" | "demote";
	  };

/**
 * DESIGN 4.4 at load for delivery. A lesson failing its delivery check is withheld, and demoted unless an operator
 * decided it: an operator-approved lesson is withheld for the session with its approval intact. A guardian approval
 * that does not meet the current promotion bar returns to the note layer. A lesson delivered in three sessions in a
 * row (other than this one) with no verdict, by the state-root ledger, is demoted. Nothing here writes the store.
 */
function memoryDeliveryVerdict(
	record: MemoryRecord,
	input: { check: DeliveryCheckInput; sessionId: string | undefined; unsettled: readonly string[] },
): MemoryDeliveryVerdict {
	const failed = memoryDeliveryCheck(record, input.check);
	const operator = operatorDecided(record);
	if (failed !== null)
		return {
			deliver: false,
			code: "delivery-check",
			reason: `failed its delivery check: ${failed}`,
			action: operator ? "withhold" : "demote",
		};
	if (operator) return { deliver: true };
	if (record.approval?.by === "guardian") {
		const note = cloneMemoryRecord(record);
		note.approved = false;
		Reflect.deleteProperty(note, "approval");
		if (evaluateMemoryGate(note) !== "approve")
			return {
				deliver: false,
				code: "promotion-bar",
				reason: "its automatic approval is below the promotion bar",
				action: "note",
			};
	}
	const unsettled = input.unsettled.filter((id) => id !== input.sessionId);
	if (unsettled.length >= MEMORY_UNSETTLED_SESSIONS_MAX)
		return {
			deliver: false,
			code: "unsettled",
			reason: `delivered in ${unsettled.length} sessions in a row with no verdict`,
			action: "demote",
		};
	return { deliver: true };
}

/**
 * Return lessons delivery refused to the note layer, inside the store's locked read-modify-write. A record an operator
 * decided, or one no longer approved, is left exactly as it is; nothing is deleted. Returns the records it changed.
 */
async function returnLessonsToNotes(
	dataDir: string,
	items: ReadonlyArray<{ id: string; reason: string; regression: boolean }>,
	now: Date = new Date(),
): Promise<MemoryRecord[]> {
	const at = now.toISOString();
	return mutateMemoryRecords(dataDir, (records) => {
		const wanted = new Map(items.map((item) => [item.id, item]));
		const changed: MemoryRecord[] = [];
		const next = records.map((record) => {
			const item = wanted.get(record.id);
			if (item === undefined || !record.approved || operatorDecided(record)) return record;
			const note = cloneMemoryRecord(record);
			note.approved = false;
			Reflect.deleteProperty(note, "approval");
			if (item.regression)
				note.regressions = [...(note.regressions ?? []), `withheld at delivery at ${at}: ${item.reason}`];
			changed.push(note);
			return note;
		});
		return changed.length === 0 ? { result: changed } : { records: next, result: changed };
	});
}

export interface MemoryDeliveryPorts {
	dataDir(): string;
	/** The state root, where the unsettled-session ledger lives beside recall-use. */
	stateDir(): string;
	sessionId(): string | undefined;
	/** Records recall-use demoted for being carried unused; every delivery path honours them. */
	demoted(): ReadonlySet<string>;
	mode(): MemoryDeliveryMode;
	notice(line: string): void;
	diagnostic(line: string): void;
	event(name: "lesson-withheld" | "lesson-demoted", facts: Record<string, unknown>): void;
}

/**
 * Delivery's per-session memory of the verdicts above. Each lesson is checked once per session and revision, the
 * access-driven cadence DESIGN 4.4 takes from the Anthropic study; a refusal is journaled once, an operator-approved
 * lesson is named once in a notice, and a demotion is written once. Every delivery path asks this one gate, so a
 * lesson refused on one path is refused on all of them before the store write lands.
 */
export class MemoryDeliveryGate {
	readonly #ports: MemoryDeliveryPorts;
	#session: string | undefined | null = null;
	readonly #verdicts = new Map<string, MemoryDeliveryVerdict>();
	/** The same verdicts by record object: the store snapshot is cached, so a boundary usually hands the same objects. */
	#byRecord = new WeakMap<MemoryRecord, { root: string; deliver: boolean }>();
	readonly #refused = new Set<string>();
	readonly #inFlight = new Set<Promise<unknown>>();
	/** Per session: each cwd's checkout root, each checkout file as read, and the unsettled-session ledger. */
	readonly #roots = new Map<string, string>();
	readonly #files = new Map<string, SourceFile | null | undefined>();
	#ledger: UnsettledLedger | null = null;

	constructor(ports: MemoryDeliveryPorts) {
		this.#ports = ports;
	}

	mode(): MemoryDeliveryMode {
		try {
			return this.#ports.mode();
		} catch {
			return "decision";
		}
	}

	/** Recall-use's demoted ids, the one source every delivery path reads; none when the ledger cannot be read. */
	demoted(): ReadonlySet<string> {
		try {
			return this.#ports.demoted();
		} catch {
			return new Set();
		}
	}

	/** Whether this session may deliver the record; the first refusal of a record is journaled and acted on. */
	admit(record: MemoryRecord, cwd: string): boolean {
		const session = this.#ports.sessionId();
		if (session !== this.#session) {
			this.#session = session;
			this.#verdicts.clear();
			this.#refused.clear();
			this.#byRecord = new WeakMap();
			this.#roots.clear();
			this.#files.clear();
			this.#ledger = null;
		}
		const root = this.#checkoutRoot(cwd);
		if (this.#refused.has(record.id)) return false;
		const known = this.#byRecord.get(record);
		if (known?.root === root) return known.deliver;
		const key = JSON.stringify([record.id, memoryRevision(record), record.approval?.by ?? null, root]);
		let verdict = this.#verdicts.get(key);
		if (verdict === undefined) {
			try {
				verdict = memoryDeliveryVerdict(record, {
					check: { root, file: (path) => this.#file(root, path) },
					sessionId: session,
					unsettled: unsettledSessions(this.#unsettled(), record.id, memoryRevision(record)),
				});
			} catch {
				// A check that cannot run proves nothing either way; the lesson stands as it did.
				verdict = { deliver: true };
			}
			this.#verdicts.set(key, verdict);
			if (!verdict.deliver) this.#refuse(record, verdict);
		}
		this.#byRecord.set(record, { root, deliver: verdict.deliver });
		return verdict.deliver;
	}

	/** The checkout a session's cwd belongs to, so a session started in a subdirectory resolves repository paths. */
	#checkoutRoot(cwd: string): string {
		let root = this.#roots.get(cwd);
		if (root === undefined) {
			try {
				root = canonicalCheckout(cwd).checkout;
			} catch {
				root = cwd;
			}
			this.#roots.set(cwd, root);
		}
		return root;
	}

	/** A checkout file, read once per session: `null` when it is gone, `undefined` when it exists but is not read. */
	#file(root: string, path: string): SourceFile | null | undefined {
		const key = resolve(root, path);
		if (!this.#files.has(key)) this.#files.set(key, readSourceFile(root, path));
		return this.#files.get(key);
	}

	#unsettled(): UnsettledLedger {
		if (this.#ledger === null) {
			try {
				this.#ledger = readUnsettledLedger(this.#ports.stateDir());
			} catch {
				this.#ledger = { version: 1, records: {} };
			}
		}
		return this.#ledger;
	}

	/** Resolves when every store write this gate started has settled. */
	async whenSettled(): Promise<void> {
		while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
	}

	#refuse(record: MemoryRecord, verdict: Extract<MemoryDeliveryVerdict, { deliver: false }>): void {
		this.#refused.add(record.id);
		const by = operatorDecided(record) ? "operator" : "guardian";
		this.#emit("lesson-withheld", { id: record.id, reason: verdict.code, by });
		if (verdict.action === "withhold") {
			this.#say(
				`Memory: withheld an operator-approved lesson for this session (${record.id}); it ${verdict.reason}. Its approval stands; review it with \`clio-coder memory list\`.`,
			);
			return;
		}
		let dataDir: string;
		try {
			dataDir = this.#ports.dataDir();
		} catch {
			return;
		}
		const write = returnLessonsToNotes(dataDir, [
			{ id: record.id, reason: verdict.reason, regression: verdict.action === "demote" },
		])
			.then((changed) => {
				for (const note of changed) {
					this.#emit("lesson-demoted", { id: note.id, reason: verdict.code });
					this.#say(`Memory: returned a repository lesson to the notes (${note.id}); it ${verdict.reason}.`);
				}
			})
			.catch((error: unknown) => {
				try {
					this.#ports.diagnostic(
						`withheld lesson not returned to the notes: ${error instanceof Error ? error.message : String(error)}`,
					);
				} catch {
					// Diagnostics are best effort.
				}
			});
		const settled = write.finally(() => this.#inFlight.delete(settled));
		this.#inFlight.add(settled);
	}

	#emit(name: "lesson-withheld" | "lesson-demoted", facts: Record<string, unknown>): void {
		try {
			this.#ports.event(name, facts);
		} catch {
			// The journal is best effort; delivery decided already.
		}
	}

	#say(line: string): void {
		try {
			this.#ports.notice(line);
		} catch {
			// A notice sink failure never reaches delivery.
		}
	}
}

/**
 * Which channels a delivery mode opens. The `# Memory` section opens from `section` up; decision-point reminders
 * from `decision` up; the first-change broadcast only under `broadcast`.
 */
export function deliveryOpens(mode: MemoryDeliveryMode, channel: "section" | "decision" | "broadcast"): boolean {
	const order: readonly MemoryDeliveryMode[] = ["off", "section", "decision", "broadcast"];
	return order.indexOf(mode) >= order.indexOf(channel);
}

/** The `# Memory` section carries a lesson with command evidence, or one an operator approved (DESIGN 4.4 channel table). */
export function sectionCarries(record: MemoryRecord): boolean {
	return operatorDecided(record) || record.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX));
}
