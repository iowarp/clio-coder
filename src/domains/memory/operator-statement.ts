/**
 * Memory the operator states in their own words: "remember that ...", "don't
 * forget ...", "from now on ...", a leading `# `, or `/remember`. The words are
 * the consent, so a statement is stored approved with `operator-stated`
 * provenance and no propose/approve step. Detection reads only the operator's
 * submitted text; the session-control caller never passes tool output or
 * model text here.
 */
import { randomBytes } from "node:crypto";
import { canonicalMemoryRepositoryIdentity, cloneMemoryRecord } from "./operations.js";
import { redactForMemoryRoute } from "./secret-text.js";
import { mutateMemoryRecords } from "./store.js";
import type { TaskMemoryModelClient } from "./task-memory-policy.js";
import { type MemoryRecord, OPERATOR_STATED_KINDS, type OperatorStatedKind } from "./types.js";

/** Where a stated memory lives: pinned to this session, this project's memory, or the operator's own everywhere. */
export const OPERATOR_MEMORY_SCOPES = ["session", "project", "global"] as const;
export type OperatorMemoryScope = (typeof OPERATOR_MEMORY_SCOPES)[number];

/** Matches the operator-note bound compaction already keeps verbatim. */
export const OPERATOR_STATEMENT_MAX_CHARS = 400;

export type OperatorMemoryIntent =
	| {
			action: "remember";
			text: string;
			/** No model turn follows: the whole submission was the statement. */
			captureOnly: boolean;
			/** Set only when the operator's own words named the scope; those words decide. */
			scope: OperatorMemoryScope | null;
			kind: OperatorStatedKind;
	  }
	| { action: "forget"; text: string; captureOnly: boolean };

const HASH_FORM = /^#[ \t]+(\S[^\n]*)$/u;
const REMEMBER_FORM = /^(?:please\s+)?remember(?:\s*:\s*|\s+that\s+)(\S[\s\S]*)$/iu;
/**
 * "Remember the token is ..." without "that": only when the rest states
 * something, so "Remember the login page we built." stays a plain reference.
 */
const REMEMBER_STATEMENT_FORM = /^(?:please\s+)?remember\s+(?!to\b)(\S[\s\S]*)$/iu;
const STATES_SOMETHING =
	/\b(?:is|are|was|were|uses?|lives?|runs?|means?|needs?|should|must|has|have|takes?|goes|belongs?|requires?)\b/iu;
const DONT_FORGET_FORM =
	/^(?:please\s+)?(?:don['’]?t|do\s+not)\s+forget(?:\s*:\s*|\s+that\s+|\s+to\s+|\s+)(\S[\s\S]*)$/iu;
const FROM_NOW_ON_FORM = /^(?:and\s+)?from\s+now\s+on\s*[,:]?\s+(\S[\s\S]*)$/iu;
const FORGET_FORM = /^(?:please\s+)?forget\s+(?:that|about)\s+(\S[\s\S]*)$/iu;

const GLOBAL_WORDS =
	/\b(?:everywhere|globally|in\s+(?:all|every|any)\s+(?:of\s+my\s+)?(?:projects?|repos|repositories|repository|codebases?|sessions?)|across\s+(?:all\s+)?(?:my\s+)?(?:projects|repos|repositories)|for\s+(?:all|every)\s+(?:my\s+)?(?:projects?|repos|repositories))\b/iu;
const SESSION_WORDS =
	/\b(?:just\s+for\s+now|for\s+now|for\s+this\s+session|in\s+this\s+session|this\s+session\s+only|just\s+this\s+session|for\s+the\s+rest\s+of\s+(?:this|the)\s+session|temporarily|for\s+this\s+(?:task|conversation|chat))\b/iu;
const PROJECT_WORDS = /\b(?:(?:in|for)\s+this\s+(?:project|repo|repository|codebase|workspace)|in\s+here)\b/iu;

/** The scope the operator's own words name, or null when they name none. */
function explicitOperatorScope(text: string): OperatorMemoryScope | null {
	if (SESSION_WORDS.test(text)) return "session";
	if (GLOBAL_WORDS.test(text)) return "global";
	if (PROJECT_WORDS.test(text)) return "project";
	return null;
}

/** A first guess at the kind; the background route may refine it. */
function guessOperatorStatedKind(text: string, fromNowOn = false): OperatorStatedKind {
	if (
		/`[^`]+`/u.test(text) &&
		/\b(?:run|build|test|lint|deploy|start|install|invoke|use|call|format|release)\b/iu.test(text)
	)
		return "command";
	if (
		/\b(?:i|we)\s+(?:prefer|like|want|love|hate|dislike|'d\s+rather|would\s+rather)\b|\bprefer(?:s|red)?\b/iu.test(text)
	)
		return "preference";
	if (fromNowOn || /^(?:always|never|don['’]?t|do\s+not|must|avoid|only|stop)\b/iu.test(text)) return "rule";
	return "fact";
}

function sentences(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+/u)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function statementText(raw: string): string {
	const trimmed = raw.trim().replace(/^to\s+/iu, "");
	return trimmed.length === 0 ? trimmed : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * Read a remember or forget request from the operator's typed text. A `# `
 * line is one statement; a phrase counts only at the start of a sentence that
 * is not a question, so "Do you remember that bug?" and "Remember that test
 * from yesterday?" ask nothing to be stored.
 */
export function detectOperatorMemoryIntent(typed: string): OperatorMemoryIntent | null {
	const text = typed.trim();
	if (text.length === 0 || text.startsWith("/")) return null;
	const hash = HASH_FORM.exec(text);
	if (hash !== null) return rememberIntent(hash[1] ?? "", true, false);
	const parts = sentences(text);
	for (const sentence of parts) {
		if (sentence.endsWith("?")) continue;
		const captureOnly = parts.length === 1;
		const forget = FORGET_FORM.exec(sentence);
		if (forget !== null) return { action: "forget", text: statementText(forget[1] ?? ""), captureOnly };
		const statement = REMEMBER_STATEMENT_FORM.exec(sentence);
		const remember =
			REMEMBER_FORM.exec(sentence) ??
			DONT_FORGET_FORM.exec(sentence) ??
			(statement !== null && STATES_SOMETHING.test(statement[1] ?? "") ? statement : null);
		if (remember !== null) return rememberIntent(remember[1] ?? "", captureOnly, false, sentence);
		const fromNowOn = FROM_NOW_ON_FORM.exec(sentence);
		if (fromNowOn !== null) return rememberIntent(fromNowOn[1] ?? "", captureOnly, true, sentence);
	}
	return null;
}

/** `/remember <text>`: the statement as typed, scope words still deciding. */
export function slashRememberIntent(text: string): RememberIntent | null {
	const trimmed = text.trim();
	return trimmed.length === 0 ? null : rememberIntent(trimmed, true, false);
}

export type RememberIntent = Extract<OperatorMemoryIntent, { action: "remember" }>;

function rememberIntent(raw: string, captureOnly: boolean, fromNowOn: boolean, sentence = raw): RememberIntent {
	const text = statementText(raw);
	return {
		action: "remember",
		text,
		captureOnly,
		scope: explicitOperatorScope(sentence),
		kind: guessOperatorStatedKind(text, fromNowOn),
	};
}

const SECRET_NAME =
	/\b(?:api[\s_-]?key|access[\s_-]?key|secret(?:[\s_-]?key)?|token|password|passphrase|passwd|pass|credential|private[\s_-]?key|ssh[\s_-]?key|bearer|pat|client[\s_-]?secret)s?\b/iu;
const SECRET_VALUE_AFTER_NAME =
	/\b(?:api[\s_-]?key|access[\s_-]?key|secret(?:[\s_-]?key)?|token|password|passphrase|passwd|pass|credential|private[\s_-]?key|ssh[\s_-]?key|bearer|pat|client[\s_-]?secret)s?\b\s*(?:is|was|=|:|of)\s*["'`]?([^\s"'`]+)/iu;
const NOT_A_VALUE =
	/^(?:stored|kept|saved|in|at|under|from|read|set|located|available|managed|a|an|the|required|needed|optional|expired|invalid|valid|missing|rotated|not|never|always|only|via|through|loaded|provided|named|called|scoped|short-lived|long-lived|\$[A-Z_][A-Z0-9_]*)$/iu;

/**
 * Whether the statement holds a credential. Memory is plain text read into
 * every later prompt, so a secret is refused, never stored redacted: a
 * redacted "the token is [REDACTED]" would be a useless memory.
 */
export function operatorStatementHoldsSecret(text: string): boolean {
	if (redactForMemoryRoute(text) !== text) return true;
	if (!SECRET_NAME.test(text)) return false;
	const value = SECRET_VALUE_AFTER_NAME.exec(text)?.[1];
	return value !== undefined && !NOT_A_VALUE.test(value.replace(/[.,;]+$/u, ""));
}

export const OPERATOR_SECRET_REFUSAL =
	"Not remembered: that looks like a secret, and memory is plain text read into every later prompt. Keep a provider key in CLIO Coder's credential storage (`clio-coder auth login <target>`) and any other secret in an environment variable or your OS keychain, then tell CLIO Coder the variable's name instead.";

function normalizeOperatorStatement(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[`"'’]/gu, "")
		.replace(/\s+/gu, " ")
		.replace(/[\s.!;,]+$/u, "")
		.trim();
}

function terms(text: string): Set<string> {
	return new Set(
		normalizeOperatorStatement(text)
			.split(/[^\p{L}\p{N}_./-]+/u)
			.filter((term) => term.length > 2 && !STOP_TERMS.has(term)),
	);
}

const STOP_TERMS = new Set(["the", "and", "that", "this", "with", "for", "use", "you", "are", "was", "our", "its"]);

/**
 * How well a forget request names a stored statement: 3 for the same words,
 * 2 when one contains the other, otherwise the share of terms they have in
 * common when at least half do, and 0 for no match.
 */
export function operatorStatementMatch(request: string, stored: string): number {
	const left = normalizeOperatorStatement(request);
	const right = normalizeOperatorStatement(stored);
	if (left.length === 0 || right.length === 0) return 0;
	if (left === right) return 3;
	if (right.includes(left) || left.includes(right)) return 2;
	const a = terms(left);
	const b = terms(right);
	if (a.size === 0 || b.size === 0) return 0;
	const shared = [...a].filter((term) => b.has(term)).length;
	const ratio = shared / Math.min(a.size, b.size);
	return ratio >= 0.5 ? ratio : 0;
}

function isOperatorStated(record: MemoryRecord): boolean {
	return record.provenance?.sourceKind === "operator-stated";
}

/** The store scope a durable operator scope writes. */
export type DurableOperatorScope = Exclude<OperatorMemoryScope, "session">;

export interface OperatorStatementInput {
	text: string;
	kind: OperatorStatedKind;
	scope: DurableOperatorScope;
	/** The workspace a project statement belongs to. */
	cwd: string;
	sessionId: string | null;
	now?: Date;
}

/** One store change and the record it replaced, so undo can put it back exactly. */
export interface OperatorStatementWrite {
	record: MemoryRecord;
	previous: MemoryRecord | null;
}

function applicableTo(record: MemoryRecord, repositoryKey: string | null): boolean {
	if (record.scope === "global") return true;
	return record.scope === "repo" && repositoryKey !== null && record.repository?.key === repositoryKey;
}

/**
 * Store a statement as operator-approved memory. The same words already stated
 * here (global, or this project) update that record in place, moving it to the
 * new scope and kind, instead of adding a second copy.
 */
export async function rememberOperatorStatement(
	dataDir: string,
	input: OperatorStatementInput,
): Promise<OperatorStatementWrite> {
	const now = (input.now ?? new Date()).toISOString();
	const identity = canonicalMemoryRepositoryIdentity(input.cwd);
	if (input.scope === "project" && identity === null)
		throw new Error(`no project identity for ${input.cwd}; say "everywhere" to keep it for all projects`);
	const normalized = normalizeOperatorStatement(input.text);
	return mutateMemoryRecords(dataDir, (records) => {
		const index = records.findIndex(
			(record) =>
				isOperatorStated(record) &&
				applicableTo(record, identity?.key ?? null) &&
				normalizeOperatorStatement(record.lesson) === normalized,
		);
		const previous = index >= 0 ? (records[index] ?? null) : null;
		const next: MemoryRecord =
			previous === null
				? {
						id: `mem-${randomBytes(8).toString("hex")}`,
						scope: "global",
						key: "",
						lesson: input.text,
						evidenceRefs: [],
						appliesWhen: [],
						avoidWhen: [],
						confidence: 1,
						createdAt: now,
						approved: true,
					}
				: cloneMemoryRecord(previous);
		next.lesson = input.text;
		next.key = `operator-stated/${input.kind}/${normalized.slice(0, 80)}`;
		next.scope = input.scope === "project" ? "repo" : "global";
		if (input.scope === "project" && identity !== null) next.repository = identity;
		else Reflect.deleteProperty(next, "repository");
		next.evidenceRefs = [...new Set([...next.evidenceRefs, `operator:${input.sessionId ?? "no-session"}`])].slice(-8);
		next.confidence = 1;
		next.approved = true;
		next.lastVerifiedAt = now;
		next.approval = { by: "operator", at: now };
		next.provenance = {
			sourceKind: "operator-stated",
			statedKind: input.kind,
			...(input.sessionId === null ? {} : { sourceSessionId: input.sessionId }),
		};
		Reflect.deleteProperty(next, "rejectedAt");
		Reflect.deleteProperty(next, "regressions");
		const updated = previous === null ? [...records, next] : records.map((record, at) => (at === index ? next : record));
		return { records: updated, result: { record: next, previous } };
	});
}

/** Undo one write: remove the record it added, or put back the record it replaced. */
export async function restoreOperatorStatement(
	dataDir: string,
	id: string,
	previous: MemoryRecord | null,
): Promise<boolean> {
	return mutateMemoryRecords(dataDir, (records) => {
		const present = records.some((record) => record.id === id);
		if (previous === null) {
			if (!present) return { result: false };
			return { records: records.filter((record) => record.id !== id), result: true };
		}
		return {
			records: present ? records.map((record) => (record.id === id ? previous : record)) : [...records, previous],
			result: true,
		};
	});
}

export interface OperatorRetraction {
	/** The record as it stood before the retraction. */
	previous: MemoryRecord;
	/** False when the record was removed; true when an evidence-backed lesson was rejected instead. */
	rejected: boolean;
}

/**
 * Retract the approved memory that best matches a forget request, among the
 * records this workspace's prompt can carry. An operator-stated record is
 * removed; a lesson that came from evidence is rejected, so the same evidence
 * does not propose it again.
 */
export async function retractOperatorStatement(
	dataDir: string,
	text: string,
	cwd: string,
	now: Date = new Date(),
): Promise<OperatorRetraction | null> {
	const repositoryKey = canonicalMemoryRepositoryIdentity(cwd)?.key ?? null;
	return mutateMemoryRecords<OperatorRetraction | null>(dataDir, (records) => {
		let best: { record: MemoryRecord; score: number } | null = null;
		for (const record of records) {
			if (!record.approved || !applicableTo(record, repositoryKey)) continue;
			const score = operatorStatementMatch(text, record.lesson) + (isOperatorStated(record) ? 0.01 : 0);
			if (score > 0.01 && (best === null || score > best.score)) best = { record, score };
		}
		if (best === null) return { result: null };
		const previous = best.record;
		if (isOperatorStated(previous)) {
			return { records: records.filter((record) => record !== previous), result: { previous, rejected: false } };
		}
		const rejected = cloneMemoryRecord(previous);
		rejected.approved = false;
		rejected.rejectedAt = now.toISOString();
		Reflect.deleteProperty(rejected, "approval");
		return {
			records: records.map((record) => (record === previous ? rejected : record)),
			result: { previous, rejected: true },
		};
	});
}

const CLASSIFY_SYSTEM_PROMPT = [
	"You classify one statement an operator asked a coding agent to remember.",
	'Answer with one JSON object and nothing else: {"scope":"session"|"project"|"global","kind":"fact"|"preference"|"rule"|"command"}.',
	"scope session: it only matters for the current task or conversation.",
	"scope project: it is about this repository or codebase: its build, layout, services, conventions or team.",
	"scope global: it is about the operator personally or how they want any agent to work in every project.",
	"kind fact: how something is. kind preference: what the operator likes. kind rule: always or never do something. kind command: a shell command or invocation to use for a task.",
].join("\n");

export interface OperatorStatementClassification {
	scope: OperatorMemoryScope;
	kind: OperatorStatedKind;
}

/**
 * Ask the background memory route where a statement belongs and what it is.
 * Null on any failure or an answer outside the closed sets: the caller keeps
 * what it already saved.
 */
export async function classifyOperatorStatement(
	client: TaskMemoryModelClient,
	text: string,
	workspace: string,
	signal: AbortSignal,
): Promise<OperatorStatementClassification | null> {
	try {
		const response = await client.complete({
			purpose: "memory.classify",
			systemPrompt: CLASSIFY_SYSTEM_PROMPT,
			userPrompt: redactForMemoryRoute(`Workspace: ${workspace}\nStatement: ${text}`),
			maxTokens: 64,
			signal,
		});
		return parseClassification(response.text);
	} catch {
		return null;
	}
}

function parseClassification(raw: string): OperatorStatementClassification | null {
	const match = /\{[^{}]*\}/u.exec(raw);
	if (match === null) return null;
	try {
		const parsed = JSON.parse(match[0]) as { scope?: unknown; kind?: unknown };
		const scope = OPERATOR_MEMORY_SCOPES.find((value) => value === parsed.scope);
		const kind = OPERATOR_STATED_KINDS.find((value) => value === parsed.kind);
		return scope !== undefined && kind !== undefined ? { scope, kind } : null;
	} catch {
		return null;
	}
}
