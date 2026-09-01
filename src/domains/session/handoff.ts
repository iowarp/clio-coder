/**
 * `/handoff <goal>`: carry one session's working state into a fresh session.
 *
 * A handoff is a session operation and nothing else. It never writes a memory
 * promotion candidate, never touches the memory domain, and never calls the
 * task-memory bank. What it produces is one reviewed Markdown document, seeded
 * into a newly minted session as bounded data, plus a terminal note in the old
 * session naming where the work continued.
 *
 * Everything in this module is pure. The model round, the operator review, and
 * the session writes live in the interactive layer; the rules that decide what
 * a handoff may contain live here so they can be asserted without a provider,
 * a terminal, or a session directory.
 *
 * The one rule worth stating twice is path validation. Every file the model
 * names is checked against this session's read ledger, meaning the set of
 * workspace-relative paths its own persisted tool calls read, edited, wrote,
 * listed, or grepped. It is never checked against the filesystem: a path that
 * exists on disk but that this session never touched is still an invention, and
 * the point of the check is to show the operator what the model invented rather
 * than to confirm that the repository has files in it.
 */

import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { DecisionLedgerEntry, SessionEntry } from "./entries.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";

// ---------------------------------------------------------------------------
// Goal gate
// ---------------------------------------------------------------------------

/** Shortest goal a handoff accepts. Anything shorter cannot name what to continue. */
export const HANDOFF_MIN_GOAL_LENGTH = 12;

/**
 * Goals that name no goal. Each of these says "carry on" without saying what
 * to carry on with, which is exactly the state a handoff exists to end.
 */
export const HANDOFF_GOAL_STOPLIST: ReadonlyArray<string> = [
	"continue",
	"keep going",
	"same",
	"next",
	"go on",
	"proceed",
	"resume",
];

export type HandoffGoalVerdict = { ok: true; goal: string } | { ok: false; reason: string };

/**
 * The gate, stated as the rule it enforces. A refusal names the rule so the
 * operator can see which of the two conditions rejected the line rather than
 * guessing at a usage string.
 *
 * The stoplist is checked before the length, because every stoplist entry is
 * also shorter than the minimum and the length message would be the less useful
 * of the two. An operator who typed "continue" wants to hear that it names no
 * goal, not that it is four characters short.
 */
export function validateHandoffGoal(raw: string): HandoffGoalVerdict {
	const goal = raw.trim();
	if (HANDOFF_GOAL_STOPLIST.includes(goal.toLowerCase())) {
		return {
			ok: false,
			reason: `/handoff refuses "${goal}" because it names no goal; say what the next session should accomplish`,
		};
	}
	if (goal.length < HANDOFF_MIN_GOAL_LENGTH) {
		return {
			ok: false,
			reason: `/handoff needs a goal of at least ${HANDOFF_MIN_GOAL_LENGTH} characters; "${goal}" is ${goal.length}`,
		};
	}
	return { ok: true, goal };
}

// ---------------------------------------------------------------------------
// Extraction shape and bounds
// ---------------------------------------------------------------------------

export interface HandoffDecision {
	summary: string;
	rationale?: string;
}

export interface HandoffFile {
	path: string;
	why: string;
}

export interface HandoffCommand {
	argv: string;
	why: string;
}

export interface HandoffExtraction {
	decisions: HandoffDecision[];
	facts: string[];
	files: HandoffFile[];
	commands: HandoffCommand[];
	openQuestions: string[];
}

/** Per-list item ceilings. Over-bound output is truncated, never refused. */
export const HANDOFF_LIST_BOUNDS = {
	decisions: 24,
	facts: 32,
	files: 48,
	commands: 16,
	openQuestions: 16,
} as const;

/** Ceiling for every string in the extraction, marker included. */
export const HANDOFF_MAX_STRING_BYTES = 512;

/** Visible flag appended to a string the byte bound cut. */
export const HANDOFF_TRUNCATION_MARKER = "…[truncated]";

/**
 * The output contract for the extraction round, in the JSON-schema subset
 * `src/core/response-schema.ts` validates. A runtime that speaks the response
 * schema dialect can enforce it on the wire; every other runtime receives it as
 * the round's stated contract and has its answer validated here on the way
 * back. Either way the parse below is the authority.
 */
export const HANDOFF_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["decisions", "facts", "files", "commands", "openQuestions"],
	properties: {
		decisions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["summary"],
				properties: { summary: { type: "string" }, rationale: { type: "string" } },
			},
		},
		facts: { type: "array", items: { type: "string" } },
		files: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "why"],
				properties: { path: { type: "string" }, why: { type: "string" } },
			},
		},
		commands: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["argv", "why"],
				properties: { argv: { type: "string" }, why: { type: "string" } },
			},
		},
		openQuestions: { type: "array", items: { type: "string" } },
	},
};

export interface HandoffParseResult {
	extraction: HandoffExtraction;
	/** One line per bound that fired, rendered into the document so nothing is cut silently. */
	truncations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cut a string to the byte ceiling and flag it. The marker counts against the
 * ceiling, so the returned string is never longer than the bound, and the cut
 * lands on a whole code point rather than mid-sequence.
 */
function boundHandoffString(value: string): { text: string; truncated: boolean } {
	const text = value.trim();
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= HANDOFF_MAX_STRING_BYTES) return { text, truncated: false };
	const markerBytes = Buffer.byteLength(HANDOFF_TRUNCATION_MARKER, "utf8");
	const room = Math.max(0, HANDOFF_MAX_STRING_BYTES - markerBytes);
	// `Buffer.toString` on a cut that lands mid-sequence yields a replacement
	// character; dropping trailing replacement characters keeps the result a
	// prefix of the original rather than a prefix plus a glyph the model never
	// produced.
	const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/�+$/u, "");
	return { text: `${head}${HANDOFF_TRUNCATION_MARKER}`, truncated: true };
}

function boundList<T>(items: ReadonlyArray<T>, limit: number, label: string, truncations: string[]): ReadonlyArray<T> {
	if (items.length <= limit) return items;
	truncations.push(`${label}: kept ${limit} of ${items.length}; the rest were dropped by the ${label} bound`);
	return items.slice(0, limit);
}

function stringsFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => (typeof item === "string" && item.trim().length > 0 ? [item.trim()] : []));
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord);
}

function requiredField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * The first JSON object in the round's answer. Providers that honor the schema
 * return the object alone; providers that do not often wrap it in a fenced
 * block or a sentence, and refusing those would throw away a usable answer.
 */
function extractJsonObject(text: string): string | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = (fenced?.[1] ?? text).trim();
	const start = candidate.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < candidate.length; index += 1) {
		const char = candidate[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return candidate.slice(start, index + 1);
		}
	}
	return null;
}

export type HandoffParseOutcome = { ok: true; result: HandoffParseResult } | { ok: false; reason: string };

/**
 * Validate the round's answer against the response schema and bound it.
 *
 * Bounds never refuse. A model that answers with two hundred facts gets the
 * first thirty-two and a line in the document saying so, because an operator
 * reviewing a truncated handoff is strictly better off than one holding a
 * refusal.
 */
export function parseHandoffExtraction(text: string): HandoffParseOutcome {
	const json = extractJsonObject(text);
	if (json === null) return { ok: false, reason: "the extraction round returned no JSON object" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		return { ok: false, reason: `the extraction round returned invalid JSON: ${(error as Error).message}` };
	}
	if (!isRecord(parsed)) return { ok: false, reason: "the extraction round returned a non-object" };

	const truncations: string[] = [];
	let stringsCut = 0;
	const bound = (value: string): string => {
		const result = boundHandoffString(value);
		if (result.truncated) stringsCut += 1;
		return result.text;
	};

	const decisions = boundList(
		recordsFrom(parsed.decisions),
		HANDOFF_LIST_BOUNDS.decisions,
		"decisions",
		truncations,
	).flatMap((record) => {
		const summary = requiredField(record, "summary");
		if (summary === null) return [];
		const rationale = requiredField(record, "rationale");
		return [{ summary: bound(summary), ...(rationale === null ? {} : { rationale: bound(rationale) }) }];
	});
	const facts = boundList(stringsFrom(parsed.facts), HANDOFF_LIST_BOUNDS.facts, "facts", truncations).map(bound);
	const files = boundList(recordsFrom(parsed.files), HANDOFF_LIST_BOUNDS.files, "files", truncations).flatMap(
		(record) => {
			const path = requiredField(record, "path");
			const why = requiredField(record, "why");
			return path === null || why === null ? [] : [{ path: bound(path), why: bound(why) }];
		},
	);
	const commands = boundList(
		recordsFrom(parsed.commands),
		HANDOFF_LIST_BOUNDS.commands,
		"commands",
		truncations,
	).flatMap((record) => {
		const argv = requiredField(record, "argv");
		const why = requiredField(record, "why");
		return argv === null || why === null ? [] : [{ argv: bound(argv), why: bound(why) }];
	});
	const openQuestions = boundList(
		stringsFrom(parsed.openQuestions),
		HANDOFF_LIST_BOUNDS.openQuestions,
		"openQuestions",
		truncations,
	).map(bound);

	if (stringsCut > 0) {
		truncations.push(
			`${stringsCut} ${stringsCut === 1 ? "entry was" : "entries were"} cut to ${HANDOFF_MAX_STRING_BYTES} bytes and marked with ${HANDOFF_TRUNCATION_MARKER}`,
		);
	}

	return { ok: true, result: { extraction: { decisions, facts, files, commands, openQuestions }, truncations } };
}

// ---------------------------------------------------------------------------
// Read ledger
// ---------------------------------------------------------------------------

/**
 * Tool names whose call arguments name a path this session actually touched.
 * `artifact` writes a file, so it counts as a write; `git` and `verify` are
 * command runners whose path argument is a working directory rather than a
 * file, so they do not.
 */
const READ_LEDGER_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "ls", "find", "grep", "artifact"]);

export interface HandoffReadLedgerOptions {
	/** Session working directory. Paths resolve against it and relativize back to it. */
	cwd?: string | null;
	/** Active branch leaf, so an abandoned `/tree` branch contributes nothing. */
	leafTurnId?: string | null;
}

/**
 * Canonical workspace-relative form. Lexical only: no realpath, no filesystem
 * probe, no `process.cwd()` fallback. A path outside the workspace keeps its
 * absolute form, which is what makes it fail the ledger check against paths
 * recorded relative to the workspace root.
 */
function normalizeHandoffPath(value: string, cwd: string | null): string {
	const trimmed = value.trim().replace(/[\\/]+$/u, "");
	if (trimmed.length === 0) return "";
	const absolute = isAbsolute(trimmed) ? normalize(trimmed) : cwd === null ? normalize(trimmed) : resolve(cwd, trimmed);
	if (cwd === null) return absolute;
	const rel = relative(cwd, absolute);
	if (rel.length === 0) return ".";
	return rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
}

function usableCwd(cwd: string | null | undefined): string | null {
	if (typeof cwd !== "string") return null;
	const trimmed = cwd.trim();
	return trimmed.length > 0 && isAbsolute(trimmed) ? normalize(trimmed) : null;
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
	if (record === null) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

function pathFromCall(toolName: string, args: unknown, cwd: string | null, into: Set<string>): void {
	if (!READ_LEDGER_TOOLS.has(toolName)) return;
	const record = isRecord(args) ? args : null;
	const named = stringField(record, "path", "file_path", "filePath");
	// grep, find, and ls all default to the working directory, which is what
	// they actually looked at.
	const raw = named ?? (toolName === "grep" || toolName === "find" || toolName === "ls" ? "." : null);
	if (raw === null) return;
	const normalized = normalizeHandoffPath(raw, cwd);
	if (normalized.length > 0) into.add(normalized);
}

/**
 * Fold this session's persisted tool calls into the set of paths it touched.
 *
 * Entries pass through `filterEntriesToActivePath` first, the same way the task
 * board folds its inputs, so a file read on a `/tree` branch the operator
 * abandoned is not evidence that this session read it.
 */
export function buildHandoffReadLedger(
	entries: ReadonlyArray<SessionEntry>,
	options: HandoffReadLedgerOptions = {},
): ReadonlySet<string> {
	const cwd = usableCwd(options.cwd);
	const active = filterEntriesToActivePath(entries, options.leafTurnId ?? undefined);
	const paths = new Set<string>();
	for (const entry of active) {
		if (entry.kind === "fileEntry") {
			const normalized = normalizeHandoffPath(entry.path, cwd);
			if (normalized.length > 0) paths.add(normalized);
			continue;
		}
		if (entry.kind !== "message") continue;
		const payload = isRecord(entry.payload) ? entry.payload : null;
		if (payload === null) continue;
		if (entry.role === "tool_call") {
			const name = stringField(payload, "name", "toolName", "tool");
			if (name !== null) pathFromCall(name, payload.args ?? payload.arguments ?? payload.input, cwd, paths);
			continue;
		}
		if (entry.role !== "assistant" || !Array.isArray(payload.content)) continue;
		for (const block of payload.content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			const name = stringField(block, "name", "toolName");
			if (name !== null) pathFromCall(name, block.arguments ?? block.args ?? block.input, cwd, paths);
		}
	}
	return paths;
}

export interface HandoffPathVerdict {
	kept: HandoffFile[];
	dropped: HandoffFile[];
}

/**
 * Split the model's file list on the read ledger. A path the session never
 * touched is dropped rather than corrected, and the document lists it so the
 * operator can see what the model invented.
 */
export function validateHandoffFiles(
	files: ReadonlyArray<HandoffFile>,
	ledger: ReadonlySet<string>,
	cwd: string | null = null,
): HandoffPathVerdict {
	const kept: HandoffFile[] = [];
	const dropped: HandoffFile[] = [];
	for (const file of files) {
		const normalized = normalizeHandoffPath(file.path, usableCwd(cwd));
		if (normalized.length > 0 && ledger.has(normalized)) kept.push({ ...file, path: normalized });
		else dropped.push(file);
	}
	return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface MergedHandoffDecision extends HandoffDecision {
	/** True for a decision the session's decision board already settled. */
	settled: boolean;
}

function decisionMatchKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, " ")
		.trim();
}

/**
 * Merge the extracted decisions with the session's settled decision board.
 *
 * The board is the record of what an operator actually answered, so it wins on
 * conflict and its entries carry a settled marker. An extracted decision
 * conflicts when it restates a board decision's key or label, which is how a
 * model paraphrasing an answer the operator already gave gets folded into the
 * answer rather than listed beside it. Superseded board decisions are history
 * and do not travel.
 */
export function mergeHandoffDecisions(
	extracted: ReadonlyArray<HandoffDecision>,
	board: ReadonlyArray<DecisionLedgerEntry>,
): MergedHandoffDecision[] {
	const settled: MergedHandoffDecision[] = [];
	const claimed: string[] = [];
	for (const interview of board) {
		for (const decision of interview.decisions) {
			if (decision.status !== "active") continue;
			const name = decision.label ?? decision.key;
			const summary = boundHandoffString(`${name}: ${decision.value}`).text;
			const rationale = decision.source_question ?? decision.correction;
			settled.push({
				summary,
				...(rationale ? { rationale: boundHandoffString(rationale).text } : {}),
				settled: true,
			});
			claimed.push(decisionMatchKey(name), decisionMatchKey(decision.key));
		}
	}
	const keys = claimed.filter((key) => key.length > 0);
	const seen = new Set(settled.map((decision) => decisionMatchKey(decision.summary)));
	const merged = [...settled];
	for (const decision of extracted) {
		const key = decisionMatchKey(decision.summary);
		if (seen.has(key)) continue;
		if (keys.some((claim) => key.includes(claim))) continue;
		seen.add(key);
		merged.push({ ...decision, settled: false });
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** Exact heading the dropped paths appear under. Asserted by contract. */
export const HANDOFF_DROPPED_HEADING = "dropped (not in this session's read ledger)";

export interface HandoffDocumentInput {
	goal: string;
	fromSessionId: string;
	decisions: ReadonlyArray<MergedHandoffDecision>;
	facts: ReadonlyArray<string>;
	files: ReadonlyArray<HandoffFile>;
	droppedFiles: ReadonlyArray<HandoffFile>;
	commands: ReadonlyArray<HandoffCommand>;
	openQuestions: ReadonlyArray<string>;
	truncations: ReadonlyArray<string>;
}

function section(lines: string[], title: string, body: ReadonlyArray<string>): void {
	if (body.length === 0) return;
	lines.push(`## ${title}`, "");
	for (const line of body) lines.push(line);
	lines.push("");
}

/** Render the reviewable Markdown document. This is what the operator edits. */
export function renderHandoffDocument(input: HandoffDocumentInput): string {
	const lines: string[] = [];
	lines.push("# Handoff", "");
	lines.push(`**Goal:** ${input.goal}`, "");
	lines.push(`Carried from session \`${input.fromSessionId}\`.`, "");

	section(
		lines,
		"Decisions",
		input.decisions.map((decision) => {
			const marker = decision.settled ? " _(settled)_" : "";
			const rationale = decision.rationale ? `\n  ${decision.rationale}` : "";
			return `- ${decision.summary}${marker}${rationale}`;
		}),
	);
	section(
		lines,
		"Facts",
		input.facts.map((fact) => `- ${fact}`),
	);
	section(
		lines,
		"Files",
		input.files.map((file) => `- \`${file.path}\`: ${file.why}`),
	);
	if (input.droppedFiles.length > 0) {
		lines.push(`### ${HANDOFF_DROPPED_HEADING}`, "");
		for (const file of input.droppedFiles) lines.push(`- \`${file.path}\`: ${file.why}`);
		lines.push("");
	}
	section(
		lines,
		"Commands",
		input.commands.map((command) => `- \`${command.argv}\`: ${command.why}`),
	);
	section(
		lines,
		"Open questions",
		input.openQuestions.map((question) => `- ${question}`),
	);
	section(
		lines,
		"Bounds applied",
		input.truncations.map((note) => `- ${note}`),
	);

	return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Ledger entries
// ---------------------------------------------------------------------------

/** `custom.customType` of the seed entry the new session opens with. */
export const HANDOFF_SEED_CUSTOM_TYPE = "handoffSeed";
/** `custom.customType` of the terminal note the old session closes with. */
export const HANDOFF_NOTE_CUSTOM_TYPE = "handoffNote";

/**
 * How the seed entry introduces itself to the model. It is labelled as carried
 * data from a named session, so the model reads a handoff document rather than
 * an instruction the operator never typed.
 */
export const HANDOFF_SEED_PREFIX = "Handoff document carried from session";

export interface HandoffSeedData {
	fromSessionId: string;
	goal: string;
	document: string;
}

export interface HandoffNoteData {
	toSessionId: string;
	goal: string;
}

/** The model-facing text of a seed entry. Data, labelled by origin, never a user turn. */
export function handoffSeedContextText(data: HandoffSeedData): string {
	return [
		`${HANDOFF_SEED_PREFIX} ${data.fromSessionId}.`,
		"It is reference material the operator reviewed, not a message they wrote.",
		"",
		data.document.trim(),
	].join("\n");
}

export function isHandoffSeedData(value: unknown): value is HandoffSeedData {
	return (
		isRecord(value) &&
		typeof value.fromSessionId === "string" &&
		typeof value.goal === "string" &&
		typeof value.document === "string"
	);
}

export function isHandoffNoteData(value: unknown): value is HandoffNoteData {
	return isRecord(value) && typeof value.toSessionId === "string" && typeof value.goal === "string";
}
