/**
 * `consult`: the main agent asks the bound System One engine for advice.
 *
 * It is a direct tool, registered only on the session registry and only when a
 * `systemOne.use` route is named at startup. Unnamed, the registry, the gateway
 * listing, the tool signature and the prompt are exactly what they were before
 * the tool existed. Workers never get it: a worker runs one assigned task under
 * a result contract, and the main agent is the one responsible for choices.
 *
 * Two forms. A `filter` scores items the agent does not hold against one
 * criterion, and only ids and scores cross into the agent's context: the fast
 * model's real value is reading what the agent has not paid for. `questions`
 * ask up to four typed questions over a small `state` and up to eight workspace
 * files. Everything read here answers to the same containment and protected-path
 * policy as the read tool, is charged against the turn's observation budget and
 * is redacted for secrets before anything leaves the process.
 *
 * The result is a hint. It carries what the engine returned, which build answered
 * and how long it took, and never a chosen option: a `pick` comes back as mass per
 * option, not as a winner. The agent decides.
 */

import { isUtf8 } from "node:buffer";
import { glob, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { createRedactionTally, redactSecretsText } from "../domains/evidence/redact.js";
import { estimateTokens } from "../domains/system-one/formation.js";
import {
	CONSULT_FILTER_MAX_CHARS,
	CONSULT_MAX_FILE_CHARS,
	consultFilterPoint,
	consultPoint,
	fitFilterItems,
	smallestRequestWindow,
} from "../domains/system-one/points/index.js";
import { pick, pointQuestion, rate, yesNo } from "../domains/system-one/questions.js";
import type { Question, SystemOne } from "../domains/system-one/types.js";
import { StringEnum } from "../engine/ai.js";
import type { ObservationReservation } from "./observation.js";
import {
	commitObservationReservation,
	createObservationPathFilter,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath, toPosixPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { isSessionOffloadPath } from "./result-shaping.js";

export const CONSULT_LIMITS = {
	callsPerTurn: 3,
	questionsPerCall: 4,
	/** Bytes of `state` serialized as JSON. */
	stateBytes: 2048,
	/** Code points of one question's text. */
	questionChars: 400,
	/** Code points of one option, rung or yes/no description. */
	criterionChars: 200,
	/** Options in a pick and rungs on a rate ladder. */
	criteria: 8,
	/** Workspace files carried as evidence. */
	files: 8,
	/** Code points of one file's head. */
	fileChars: CONSULT_MAX_FILE_CHARS,
	/** Items one filter carries. Past this they count as unscored. */
	filterItems: 256,
	/** Code points of one `items` or `capabilities` entry. */
	filterItemChars: 240,
	/** Code points of one file head or output chunk under a filter. */
	filterHeadChars: 512,
	/** Item text across one filter. */
	filterTotalChars: CONSULT_FILTER_MAX_CHARS,
	filterMatchesMax: 32,
	filterMatchesDefault: 16,
	outputChunkLines: 16,
	outputChunkLinesMax: 2000,
	/** Code points of one item id, which comes back to the agent. */
	filterIdChars: 160,
} as const;

/** A glob stops here: a pattern this wide is a mistake, and counting it further costs a walk. */
const GLOB_MATCHES = 16_384;
/** Directories a glob never enters: their files are not evidence anyone authored here. */
const GLOB_EXCLUDED = new Set([".git", "node_modules"]);
/** An offload is capped well under this, so a larger file is not one. */
const OUTPUT_READ_BYTES = 32 * 1024 * 1024;

const SOURCES = ["items", "files", "output", "capabilities"] as const;
type FilterSource = (typeof SOURCES)[number];

/** One capability a filter may score: its name is the id that comes back. */
export interface ConsultCapability {
	readonly name: string;
	readonly description: string;
}

export interface ConsultDeps {
	/** The session's System One instance. `routes` says what the ask has to fit. */
	systemOne: Pick<SystemOne, "ask" | "routes">;
	/** The workspace file paths are resolved against and contained in. */
	cwd?: () => string;
	/**
	 * The information-flow restrictions the evidence carries: the turn's own plus
	 * those of the files read here, which reach the engine without passing a read
	 * tool result. Supplied by the composition root from the safety domain; its
	 * value is passed to System One unread. A throw withholds the call.
	 */
	flowFor?: (files: ReadonlyArray<string>, options: ToolInvokeOptions | undefined) => unknown;
	/** The MCP and gateway capabilities this run may reach, which the prompt does not list. */
	capabilities?: (options: ToolInvokeOptions | undefined) => ReadonlyArray<ConsultCapability>;
}

const KINDS = ["yesNo", "pick", "rate"] as const;
type ConsultKind = (typeof KINDS)[number];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export const consultParameters = Type.Object({
	filter: Type.Optional(
		Type.Object({
			criterion: Type.String({
				description: "What an item must show to match, one claim judged on each item alone. Up to 200 characters.",
			}),
			source: StringEnum(SOURCES, {
				description:
					"files: heads of workspace files you do not hold. output: chunks of one offloaded result. capabilities: MCP and gateway tools the prompt does not list. items: your own id-to-text map.",
			}),
			items: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: `source items: id to text, up to ${CONSULT_LIMITS.filterItems}, each read up to ${CONSULT_LIMITS.filterItemChars} characters.`,
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: `source files: workspace paths or globs; the first ${CONSULT_LIMITS.filterHeadChars} characters of each file are read.`,
				}),
			),
			path: Type.Optional(Type.String({ description: "source output: the offload path a truncated result named." })),
			chunkLines: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: CONSULT_LIMITS.outputChunkLinesMax,
					description: `source output: lines per chunk, default ${CONSULT_LIMITS.outputChunkLines}; the first ${CONSULT_LIMITS.filterHeadChars} characters of each chunk are read.`,
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: CONSULT_LIMITS.filterMatchesMax,
					description: `Matches returned, default ${CONSULT_LIMITS.filterMatchesDefault}; matchCount still counts them all.`,
				}),
			),
		}),
	),
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: "Short identifier for this question, e.g. risky." }),
				kind: StringEnum(KINDS, {
					description: "yesNo: probability a statement holds. pick: mass over named options. rate: position on a ladder.",
				}),
				question: Type.String({ description: "The question, answerable from state alone." }),
				whenTrue: Type.Optional(
					Type.String({ description: "yesNo, required: what a true answer looks like in the evidence." }),
				),
				whenFalse: Type.Optional(
					Type.String({ description: "yesNo, required: what a false answer looks like in the evidence." }),
				),
				options: Type.Optional(
					Type.Record(Type.String(), Type.String(), {
						description: "pick: option name to the description that defines it; 2 to 8 options.",
					}),
				),
				ladder: Type.Optional(
					Type.Array(Type.String(), { description: "rate: 2 to 8 rungs, lowest first, each saying what it means." }),
				),
			}),
			{ description: "1 to 4 independent questions over the same state." },
		),
	),
	state: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "questions: the evidence they are about, at most 2 KB as JSON. The model sees nothing else.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: `questions: up to ${CONSULT_LIMITS.files} workspace files whose head (${CONSULT_LIMITS.fileChars} characters each, secrets redacted) is sent as evidence beside state.`,
		}),
	),
});

const DESCRIPTION =
	"Get advice from a fast decision model; a design choice you then make goes to `decide`. The strong use is `filter`: score up to 256 things you do not hold (workspace file heads, chunks of an offloaded result, MCP and gateway capabilities, your own items) against one criterion, and read only what matched, because only ids and scores come back. `questions` asks up to four typed questions (yesNo, pick, rate) over `state` and `paths` you supply; a smart if on something you already read is the weak case, since the model knows less than you do. It is advice and never makes the choice. Each route has its own bound (5 s typed, 30 s LLM) and failover totals 45 s at worst; at most 3 calls per turn.";

function codePoints(value: string): number {
	return [...value].length;
}

function refuse(message: string): ToolResult {
	return { kind: "error", message: `consult: ${message}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedQuestion {
	id: string;
	kind: ConsultKind;
	question: Question;
}

function criterionError(id: string, what: string, text: unknown): string | null {
	if (typeof text !== "string" || text.trim().length === 0) return `question ${id}: ${what} must be non-empty text`;
	if (codePoints(text) > CONSULT_LIMITS.criterionChars) {
		return `question ${id}: ${what} is over the ${CONSULT_LIMITS.criterionChars}-character limit`;
	}
	return null;
}

function parseQuestion(raw: unknown): ParsedQuestion | string {
	if (!isRecord(raw)) return "each question must be an object with id, kind and question";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!ID_PATTERN.test(id)) return "question id must start with a letter and use letters, digits, _ or -, up to 40";
	const kind = raw.kind;
	if (typeof kind !== "string" || !(KINDS as ReadonlyArray<string>).includes(kind)) {
		return `question ${id}: kind must be yesNo, pick or rate`;
	}
	const text = typeof raw.question === "string" ? raw.question.trim() : "";
	if (text.length === 0) return `question ${id}: question text is required`;
	if (codePoints(text) > CONSULT_LIMITS.questionChars) {
		return `question ${id}: question text is over the ${CONSULT_LIMITS.questionChars}-character limit`;
	}
	if (kind === "yesNo") {
		const error = criterionError(id, "whenTrue", raw.whenTrue) ?? criterionError(id, "whenFalse", raw.whenFalse);
		if (error !== null) return error;
		const whenTrue = (raw.whenTrue as string).trim();
		const whenFalse = (raw.whenFalse as string).trim();
		return { id, kind: "yesNo", question: yesNo(text, whenTrue, whenFalse) };
	}
	if (kind === "pick") {
		if (!isRecord(raw.options)) return `question ${id}: pick needs options, a map of name to description`;
		const entries = Object.entries(raw.options);
		if (entries.length < 2 || entries.length > CONSULT_LIMITS.criteria) {
			return `question ${id}: pick needs 2 to ${CONSULT_LIMITS.criteria} options`;
		}
		const options: Record<string, string> = {};
		for (const [name, description] of entries) {
			const error = criterionError(id, `option ${name}`, description);
			if (error !== null) return error;
			options[name] = (description as string).trim();
		}
		return { id, kind: "pick", question: pick(text, options) };
	}
	if (!Array.isArray(raw.ladder)) return `question ${id}: rate needs ladder, a list of rungs lowest first`;
	if (raw.ladder.length < 2 || raw.ladder.length > CONSULT_LIMITS.criteria) {
		return `question ${id}: rate needs 2 to ${CONSULT_LIMITS.criteria} rungs`;
	}
	const ladder: string[] = [];
	for (const [index, rung] of raw.ladder.entries()) {
		const error = criterionError(id, `rung ${index}`, rung);
		if (error !== null) return error;
		ladder.push((rung as string).trim());
	}
	return { id, kind: "rate", question: rate(text, ladder) };
}

interface EvidenceFiles {
	readonly files: Record<string, string>;
	readonly skipped: Array<{ path: string; reason: string }>;
	/** Resolved real paths of every file in `files`, for the flow check. */
	readonly realPaths?: string[];
}

function isInside(root: string, real: string): boolean {
	return real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

type FileRead = { readonly key: string; readonly real: string; readonly text: string } | { readonly reason: string };

/** The read tool's rules for one named file, so both forms refuse the same things in the same words. */
async function workspaceReader(
	cwd: string,
	options: ToolInvokeOptions | undefined,
): Promise<(raw: unknown, chars: number) => Promise<FileRead>> {
	const filter = createObservationPathFilter(cwd, options?.allowsObservationPath);
	const tally = createRedactionTally();
	const root = await realpath(cwd);
	const seen = new Set<string>();
	return async (raw, chars) => {
		if (typeof raw !== "string" || raw.trim().length === 0) return { reason: "not a path" };
		if (options?.signal?.aborted === true) return { reason: "cancelled" };
		let real: string;
		try {
			real = await realpath(resolveReadPath(raw.trim(), cwd));
		} catch {
			return { reason: "not found" };
		}
		// Symlinks are resolved first, so a link out of the workspace is outside.
		if (!isInside(root, real)) return { reason: "outside the workspace" };
		if (!filter.allows(real)) return { reason: "withheld by the protected-path policy" };
		const key = toPosixPath(relative(root, real)) || ".";
		if (seen.has(key)) return { reason: "repeated" };
		seen.add(key);
		try {
			const entry = await stat(real);
			if (!entry.isFile()) return { reason: "not a file" };
			const handle = await open(real, "r");
			let head: Buffer;
			try {
				// Room for `chars` code points of any width.
				const buffer = Buffer.alloc(Math.min(entry.size, chars * 4));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				head = buffer.subarray(0, bytesRead);
			} finally {
				await handle.close().catch(() => undefined);
			}
			const decoded = textHead(head, entry.size <= head.length);
			if (decoded === null) return { reason: "binary or not UTF-8" };
			// Redacted before the cut, so the cut cannot shorten a secret past what its pattern recognizes.
			return { key, real, text: headOf(redactSecretsText(decoded, tally), chars) };
		} catch (err) {
			return { reason: err instanceof Error ? err.message : String(err) };
		}
	};
}

/** The first `chars` code points, without spreading a text of any length. */
function headOf(text: string, chars: number): string {
	return [...text.slice(0, chars * 2)].slice(0, chars).join("");
}

function evidenceExhausted(reservation: ObservationReservation, hint: string): ToolResult {
	return observationBudgetExhausted({
		tool: ToolNames.Consult,
		unit: "sections",
		reservation,
		subject: "consult file evidence",
		hint,
	});
}

/**
 * Read the files the agent named, under the read tool's rules. A file that
 * fails any check is skipped with its reason rather than failing the call: the
 * questions may still be answerable from the rest.
 */
async function readEvidenceFiles(
	paths: ReadonlyArray<unknown>,
	cwd: string,
	options: ToolInvokeOptions | undefined,
): Promise<EvidenceFiles | ToolResult> {
	const reservation = reserveObservation(CONSULT_LIMITS.files * CONSULT_LIMITS.fileChars, options);
	if (reservation.exhausted)
		return evidenceExhausted(reservation, "Ask again without paths, or continue in a follow-up turn.");
	// The files go to the engine and only its distribution returns to the model,
	// so the reservation bounds and gates the reads and is refunded, not charged.
	commitObservationReservation(reservation);
	try {
		const files: Record<string, string> = {};
		const realPaths: string[] = [];
		const skipped: Array<{ path: string; reason: string }> = [];
		const read = await workspaceReader(cwd, options);
		let spent = 0;
		for (const raw of paths) {
			const skip = (reason: string): void => {
				skipped.push({ path: (typeof raw === "string" ? raw : String(raw)).slice(0, 200), reason });
			};
			if (spent >= reservation.callCapBytes) {
				skip("turn observation budget");
				continue;
			}
			const file = await read(raw, CONSULT_LIMITS.fileChars);
			if ("reason" in file) {
				skip(file.reason);
				continue;
			}
			files[file.key] = file.text;
			realPaths.push(file.real);
			spent += Buffer.byteLength(file.text, "utf8");
		}
		return { files, skipped, realPaths };
	} finally {
		releaseObservation(reservation);
	}
}

/**
 * Evidence files dropped from the end until the ask fits the smallest whole-request
 * window, each reported. Formation would otherwise refuse the request outright, and the
 * files named first are the ones the agent ranked first.
 */
function fitEvidenceFiles(
	evidence: EvidenceFiles,
	state: Readonly<Record<string, unknown>>,
	parsed: ReadonlyArray<ParsedQuestion>,
	window: number | null,
): EvidenceFiles {
	if (window === null) return evidence;
	const fixed = parsed.reduce((sum, entry) => sum + estimateTokens(entry.question), 0);
	const files = { ...evidence.files };
	const realPaths = [...(evidence.realPaths ?? [])];
	const skipped = [...evidence.skipped];
	const keys = Object.keys(files);
	while (keys.length > 0 && fixed + estimateTokens({ ...state, files }) > window) {
		const last = keys.pop() as string;
		delete files[last];
		realPaths.pop();
		skipped.push({ path: last.slice(0, 200), reason: "over the smallest route's window" });
	}
	return { files, skipped, realPaths };
}

/**
 * The head of a file as text, or null when it is binary. A window cut inside a
 * multibyte sequence is still text, so up to three trailing bytes may be dropped
 * to find a valid boundary; a file read whole gets no such allowance.
 */
function textHead(head: Buffer, whole: boolean): string | null {
	if (head.includes(0)) return null;
	for (let drop = 0; drop <= (whole ? 0 : 3); drop += 1) {
		const candidate = head.subarray(0, head.length - drop);
		if (isUtf8(candidate)) return candidate.toString("utf8");
	}
	return null;
}

interface ParsedFilter {
	readonly criterion: string;
	readonly source: FilterSource;
	readonly items: Readonly<Record<string, unknown>>;
	readonly paths: ReadonlyArray<unknown>;
	readonly path: string;
	readonly chunkLines: number;
	readonly limit: number;
}

function boundedInteger(value: unknown, fallback: number, max: number, name: string): number | string {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
		return `filter.${name} must be a whole number from 1 to ${max}`;
	}
	return value;
}

function parseFilter(raw: unknown): ParsedFilter | string {
	if (!isRecord(raw)) return "filter must be an object with criterion and source";
	const criterion = typeof raw.criterion === "string" ? raw.criterion.trim() : "";
	if (criterion.length === 0) return "filter.criterion is required";
	if (codePoints(criterion) > CONSULT_LIMITS.criterionChars) {
		return `filter.criterion is over the ${CONSULT_LIMITS.criterionChars}-character limit`;
	}
	const source = raw.source;
	if (typeof source !== "string" || !(SOURCES as ReadonlyArray<string>).includes(source)) {
		return "filter.source must be items, files, output or capabilities";
	}
	if (source === "items" && !isRecord(raw.items)) return "filter source items needs items, a map of id to text";
	if (source === "files" && (!Array.isArray(raw.paths) || raw.paths.length === 0)) {
		return "filter source files needs paths, workspace paths or globs";
	}
	if (source === "output" && typeof raw.path !== "string") return "filter source output needs path, an offload path";
	const limit = boundedInteger(raw.limit, CONSULT_LIMITS.filterMatchesDefault, CONSULT_LIMITS.filterMatchesMax, "limit");
	if (typeof limit === "string") return limit;
	const chunkLines = boundedInteger(
		raw.chunkLines,
		CONSULT_LIMITS.outputChunkLines,
		CONSULT_LIMITS.outputChunkLinesMax,
		"chunkLines",
	);
	if (typeof chunkLines === "string") return chunkLines;
	return {
		criterion,
		source: source as FilterSource,
		items: isRecord(raw.items) ? raw.items : {},
		paths: Array.isArray(raw.paths) ? raw.paths : [],
		path: typeof raw.path === "string" ? raw.path : "",
		chunkLines,
		limit,
	};
}

/**
 * What one filter offers. Every item ends up scored or counted under a reason, so
 * `offered` is always `scored + unscored` and the sum of `skipped` is `unscored`.
 */
class FilterGathering {
	readonly items: Record<string, string> = {};
	readonly charsRead: Record<string, number> = {};
	readonly skipped: Record<string, number> = {};
	readonly realPaths: string[] = [];
	offered = 0;

	skip(reason: string, count = 1): void {
		this.offered += count;
		this.note(reason, count);
	}

	/** A reason for something already offered. */
	note(reason: string, count = 1): void {
		this.skipped[reason] = (this.skipped[reason] ?? 0) + count;
	}

	get full(): boolean {
		return Object.keys(this.items).length >= CONSULT_LIMITS.filterItems;
	}

	get overLimit(): string {
		return `over the ${CONSULT_LIMITS.filterItems}-item limit`;
	}

	/** The id comes back to the agent and the text goes to the engine, so both are checked here. */
	add(id: string, text: unknown, chars: number): boolean {
		if (this.full) {
			this.skip(this.overLimit);
			return false;
		}
		if (typeof text !== "string" || text.trim().length === 0) {
			this.skip("empty or not text");
			return false;
		}
		if (!usableItemId(id)) {
			this.skip("unusable id");
			return false;
		}
		const shown = headOf(redactSecretsText(text, createRedactionTally()), chars);
		this.offered += 1;
		this.items[id] = shown;
		this.charsRead[id] = codePoints(shown);
		return true;
	}
}

/** Ids stay exact through redaction, because answers come back under them, so one holding a secret never goes. */
function usableItemId(id: string): boolean {
	return (
		id.trim().length > 0 &&
		id !== "__proto__" &&
		codePoints(id) <= CONSULT_LIMITS.filterIdChars &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
		!/[\u0000-\u001f\u007f]/u.test(id) &&
		redactSecretsText(id, createRedactionTally()) === id
	);
}

/** A glob's files, sorted so an over-limit call keeps the same ones each time; null past the walk's bound. */
async function expandGlob(pattern: string, cwd: string, signal: AbortSignal | undefined): Promise<string[] | null> {
	const found: string[] = [];
	for await (const entry of glob(pattern, {
		cwd,
		withFileTypes: true,
		exclude: (dirent) => GLOB_EXCLUDED.has(dirent.name),
	})) {
		if (signal?.aborted === true) break;
		if (entry.isDirectory()) continue;
		if (found.length >= GLOB_MATCHES) return null;
		found.push(resolve(cwd, entry.parentPath, entry.name));
	}
	return found.sort();
}

async function existingPath(raw: string, cwd: string): Promise<boolean> {
	try {
		await stat(resolveReadPath(raw, cwd));
		return true;
	} catch {
		return false;
	}
}

async function gatherFiles(
	filter: ParsedFilter,
	cwd: string,
	options: ToolInvokeOptions | undefined,
	gathering: FilterGathering,
): Promise<ToolResult | null> {
	const candidates = new Set<unknown>();
	for (const raw of filter.paths) {
		// A literal name wins, so a file such as `pages/[id].tsx` is not read as a character class.
		if (typeof raw === "string" && /[*?[{]/u.test(raw) && !(await existingPath(raw, cwd))) {
			const matches = await expandGlob(raw.trim(), cwd, options?.signal);
			if (matches === null) gathering.skip(`pattern matched over ${GLOB_MATCHES} paths; narrow it`);
			for (const match of matches ?? []) candidates.add(match);
			continue;
		}
		candidates.add(raw);
	}
	const heads = Math.min(candidates.size, CONSULT_LIMITS.filterItems);
	const reservation = reserveObservation(heads * CONSULT_LIMITS.filterHeadChars, options);
	if (reservation.exhausted) return evidenceExhausted(reservation, "Continue in a follow-up turn.");
	// Bounds and gates the reads and is refunded, not charged: only ids and scores reach the model.
	commitObservationReservation(reservation);
	try {
		const read = await workspaceReader(cwd, options);
		let spent = 0;
		for (const raw of candidates) {
			if (gathering.full) {
				gathering.skip(gathering.overLimit);
				continue;
			}
			if (spent >= reservation.callCapBytes) {
				gathering.skip("turn observation budget");
				continue;
			}
			const file = await read(raw, CONSULT_LIMITS.filterHeadChars);
			if ("reason" in file) {
				gathering.skip(file.reason);
				continue;
			}
			if (gathering.add(file.key, file.text, CONSULT_LIMITS.filterHeadChars)) {
				gathering.realPaths.push(file.real);
				spent += Buffer.byteLength(file.text, "utf8");
			}
		}
		return null;
	} finally {
		releaseObservation(reservation);
	}
}

/** One offloaded result split into chunks whose ids are the line ranges to read next. Offloads sit outside the turn pool, as for the read tool. */
async function gatherOutput(
	filter: ParsedFilter,
	options: ToolInvokeOptions | undefined,
	gathering: FilterGathering,
): Promise<ToolResult | null> {
	const path = filter.path.trim();
	if (!isSessionOffloadPath(path, options?.sessionId)) {
		return refuse("filter.path must be an offload path a truncated result in this session named");
	}
	let text: string | null;
	try {
		// lstat so a link planted in the scratch directory cannot stand in for an offload.
		const entry = await lstat(path);
		if (!entry.isFile()) return refuse("filter.path is not a file");
		if (entry.size > OUTPUT_READ_BYTES) return refuse("filter.path is too large to be an offload");
		text = textHead(await readFile(path), true);
	} catch (err) {
		return refuse(`could not read filter.path (${err instanceof Error ? err.message : String(err)})`);
	}
	if (text === null) return refuse("filter.path is binary or not UTF-8");
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (let start = 0; start < lines.length; start += filter.chunkLines) {
		const end = Math.min(start + filter.chunkLines, lines.length);
		const chunk = lines.slice(start, end).join("\n");
		gathering.add(`L${start + 1}-${end}`, chunk, CONSULT_LIMITS.filterHeadChars);
	}
	gathering.realPaths.push(path);
	return null;
}

function gatherEntries(entries: Iterable<readonly [string, unknown]>, gathering: FilterGathering): void {
	for (const [id, text] of entries) gathering.add(id, text, CONSULT_LIMITS.filterItemChars);
}

/** Numbers vary per item, so a reason keeps its words and each number becomes `N`. */
function reasonKey(reason: string): string {
	return reason.replace(/\d+/gu, "N");
}

function publicReadout(readout: string | undefined): string | undefined {
	return readout === "categorical" ? "label" : readout;
}

const FILTER_NOTE =
	"Advice from a decision model, not a decision. charsRead says how much of each item it saw: a miss on a partly read item does not prove the item is irrelevant.";

function requestWindow(deps: ConsultDeps): number | null {
	try {
		return smallestRequestWindow(deps.systemOne.routes());
	} catch {
		// Routes that cannot be listed cannot answer either, and the ask reports why.
		return null;
	}
}

async function runFilter(
	filter: ParsedFilter,
	deps: ConsultDeps,
	options: ToolInvokeOptions | undefined,
	spendCall: () => void,
	remainingCalls: () => number,
): Promise<ToolResult> {
	const gathering = new FilterGathering();
	if (filter.source === "items") gatherEntries(Object.entries(filter.items), gathering);
	if (filter.source === "capabilities") {
		try {
			const capabilities = deps.capabilities?.(options) ?? [];
			gatherEntries(
				capabilities.map((entry) => [entry.name, `${entry.name}: ${entry.description}`] as const),
				gathering,
			);
		} catch (err) {
			return refuse(`the capability list could not be read (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	if (filter.source === "files") {
		const stopped = await gatherFiles(filter, deps.cwd?.() ?? process.cwd(), options, gathering);
		if (stopped !== null) return stopped;
	}
	if (filter.source === "output") {
		const stopped = await gatherOutput(filter, options, gathering);
		if (stopped !== null) return stopped;
	}
	const { fitted, overTotal, overWindow } = fitFilterItems({
		source: filter.source,
		criterion: filter.criterion,
		items: gathering.items,
		window: requestWindow(deps),
	});
	if (overTotal.length > 0)
		gathering.note(`over the ${CONSULT_LIMITS.filterTotalChars}-character total`, overTotal.length);
	if (overWindow.length > 0) gathering.note("over the smallest route's window", overWindow.length);
	const empty = (note: string, error?: string): ToolResult => {
		const counted = Object.values(gathering.skipped).reduce((sum, count) => sum + count, 0);
		const output = {
			answered: false,
			note,
			...(error !== undefined ? { error } : {}),
			offered: gathering.offered,
			scored: 0,
			matchCount: 0,
			matches: [],
			unscored: counted,
			skipped: gathering.skipped,
			remainingCalls: remainingCalls(),
		};
		return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
	};
	if (Object.keys(fitted).length === 0) return empty("Nothing was sent: no item could be read and fitted.");
	let flow: unknown;
	if (deps.flowFor !== undefined) {
		try {
			flow = deps.flowFor(gathering.realPaths, options);
		} catch (err) {
			return refuse(
				`the evidence's information-flow restrictions could not be resolved (${err instanceof Error ? err.message : String(err)}); nothing was sent`,
			);
		}
	}
	spendCall();
	let failure: string | undefined;
	const verdict = await deps.systemOne.ask(
		consultFilterPoint(filter.criterion, fitted),
		{ source: filter.source },
		{
			onFailure: (reason) => {
				failure = redactSecretsText(reason, createRedactionTally());
			},
			...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { ref: options.toolCallId } : {}),
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
			...(flow !== undefined ? { flow } : {}),
		},
	);
	if (verdict === null) {
		gathering.note("no route answered", Object.keys(fitted).length);
		return empty(
			failure
				? `The decision model could not answer: ${failure}. Proceed on your own judgment.`
				: "The decision model gave no usable answer. Proceed on your own judgment.",
			failure,
		);
	}
	const { matches, scored, unscored, readout } = verdict.value;
	for (const reason of Object.values(unscored)) gathering.note(reasonKey(reason));
	const unscoredCount = Object.values(gathering.skipped).reduce((sum, count) => sum + count, 0);
	const output = {
		answered: true,
		note: FILTER_NOTE,
		offered: gathering.offered,
		scored: scored.length,
		matchCount: matches.length,
		matches: matches.slice(0, filter.limit),
		unscored: unscoredCount,
		skipped: gathering.skipped,
		charsRead: Object.fromEntries(scored.map((id) => [id, gathering.charsRead[id] ?? 0])),
		...(verdict.usage !== undefined ? { tokens: verdict.usage } : {}),
		readout: publicReadout(readout),
		model: verdict.build,
		engine: verdict.engine,
		latencyMs: verdict.latencyMs,
		remainingCalls: remainingCalls(),
	};
	return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
}

export function createConsultTool(deps: ConsultDeps): ToolSpec {
	let turn: { id: string; calls: number } = { id: "", calls: 0 };
	return {
		name: ToolNames.Consult,
		description: DESCRIPTION,
		parameters: consultParameters,
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const turnId = options?.turnId ?? options?.runId ?? "";
			if (turn.id !== turnId) turn = { id: turnId, calls: 0 };
			if (turn.calls >= CONSULT_LIMITS.callsPerTurn) {
				return refuse(
					`the limit of ${CONSULT_LIMITS.callsPerTurn} calls per turn is spent; decide from what you already have`,
				);
			}
			const remainingCalls = (): number => CONSULT_LIMITS.callsPerTurn - turn.calls;
			if (args.filter !== undefined) {
				if (args.questions !== undefined || args.state !== undefined || args.paths !== undefined) {
					return refuse("a call holds either questions or one filter; state and paths belong to questions");
				}
				const filter = parseFilter(args.filter);
				if (typeof filter === "string") return refuse(filter);
				const spendCall = (): void => {
					turn.calls += 1;
				};
				return runFilter(filter, deps, options, spendCall, remainingCalls);
			}
			const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
			if (rawQuestions.length === 0) return refuse("a call needs questions or one filter");
			if (rawQuestions.length > CONSULT_LIMITS.questionsPerCall) {
				return refuse(`${rawQuestions.length} questions is over the limit of ${CONSULT_LIMITS.questionsPerCall} per call`);
			}
			const state = isRecord(args.state) ? args.state : {};
			const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
			if (stateBytes > CONSULT_LIMITS.stateBytes) {
				return refuse(
					`state is ${stateBytes} bytes as JSON, over the limit of ${CONSULT_LIMITS.stateBytes}; send only the evidence the questions need`,
				);
			}
			const rawPaths = Array.isArray(args.paths) ? args.paths : [];
			if (rawPaths.length > CONSULT_LIMITS.files) {
				return refuse(`${rawPaths.length} paths is over the limit of ${CONSULT_LIMITS.files} per call`);
			}
			const parsed: ParsedQuestion[] = [];
			for (const raw of rawQuestions) {
				const question = parseQuestion(raw);
				if (typeof question === "string") return refuse(question);
				if (parsed.some((entry) => entry.id === question.id)) return refuse(`question id ${question.id} is repeated`);
				parsed.push(question);
			}
			let evidence: EvidenceFiles = { files: {}, skipped: [] };
			if (rawPaths.length > 0) {
				const read = await readEvidenceFiles(rawPaths, deps.cwd?.() ?? process.cwd(), options);
				if ("kind" in read) return read;
				evidence = fitEvidenceFiles(read, state, parsed, requestWindow(deps));
			}
			let flow: unknown;
			if (deps.flowFor !== undefined) {
				try {
					flow = deps.flowFor(evidence.realPaths ?? [], options);
				} catch (err) {
					return refuse(
						`the evidence's information-flow restrictions could not be resolved (${err instanceof Error ? err.message : String(err)}); nothing was sent`,
					);
				}
			}
			turn.calls += 1;
			const remaining = remainingCalls();
			const questions = Object.fromEntries(parsed.map((entry) => [entry.id, pointQuestion(entry.question)]));
			let failure: string | undefined;
			const verdict = await deps.systemOne.ask(
				consultPoint(questions),
				{ state, files: evidence.files },
				{
					onFailure: (reason) => {
						failure = redactSecretsText(reason, createRedactionTally());
					},
					...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { ref: options.toolCallId } : {}),
					...(options?.signal !== undefined ? { signal: options.signal } : {}),
					...(flow !== undefined ? { flow } : {}),
				},
			);
			const evidenceNote = {
				filesRead: Object.keys(evidence.files),
				...(evidence.skipped.length > 0 ? { filesSkipped: evidence.skipped } : {}),
			};
			if (verdict === null) {
				const output = {
					answered: false,
					note: failure
						? `The decision model could not answer: ${failure}. Proceed on your own judgment.`
						: "The decision model gave no usable answer. Proceed on your own judgment.",
					...(failure !== undefined ? { error: failure } : {}),
					...evidenceNote,
					remainingCalls: remaining,
				};
				return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
			}
			const output = {
				answered: true,
				note: "Advice from a decision model, not a decision. You choose what to do.",
				answers: verdict.value.answers,
				...(verdict.value.readout !== undefined ? { readout: publicReadout(verdict.value.readout) } : {}),
				model: verdict.build,
				engine: verdict.engine,
				latencyMs: verdict.latencyMs,
				...evidenceNote,
				remainingCalls: remaining,
			};
			return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
		},
	};
}
