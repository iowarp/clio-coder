/**
 * `consult`: the main agent asks the bound System One engine a typed question.
 *
 * It sits behind the gateway and is registered only on the session registry,
 * only when the `consult` site is bound at startup. Unbound, the registry, the
 * gateway listing, the tool signature and the prompt are exactly what they were
 * before the tool existed. Workers never get it: a worker runs one assigned
 * task under a result contract, and the main agent is the one responsible for
 * choices.
 *
 * The agent supplies the evidence: a small `state` and, when the question is
 * about code, up to eight workspace files. Files are read here under the same
 * containment and protected-path policy the read tool answers to, charged to
 * the turn's observation budget, cut to a bound and redacted for secrets before
 * anything leaves the process.
 *
 * The result is a hint. It carries the distribution the engine returned, which
 * build answered and how long it took, and never a chosen option: a `pick`
 * comes back as mass per option, not as a winner. The agent decides.
 */

import { isUtf8 } from "node:buffer";
import { open, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { createRedactionTally, redactSecretsText } from "../domains/evidence/redact.js";
import { pick, rate, yesNo } from "../domains/system-one/questions.js";
import { CONSULT_MAX_FILE_CHARS, consultSite } from "../domains/system-one/sites/consult.js";
import type { Question, SystemOne } from "../domains/system-one/types.js";
import { StringEnum } from "../engine/ai.js";
import {
	commitObservationReservation,
	createObservationPathFilter,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath, toPosixPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";

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
} as const;

/** Bytes read from a file: room for `fileChars` code points of any width. */
const FILE_READ_BYTES = CONSULT_LIMITS.fileChars * 4;

export interface ConsultDeps {
	/** The session's System One instance; the `consult` site is read through it. */
	systemOne: Pick<SystemOne, "run">;
	/** The workspace file paths are resolved against and contained in. */
	cwd?: () => string;
	/**
	 * The information-flow restrictions the evidence carries: the turn's own plus
	 * those of the files read here, which reach the engine without passing a read
	 * tool result. Supplied by the composition root from the safety domain; its
	 * value is passed to System One unread. A throw withholds the call.
	 */
	flowFor?: (files: ReadonlyArray<string>, options: ToolInvokeOptions | undefined) => unknown;
}

const KINDS = ["yesNo", "pick", "rate"] as const;
type ConsultKind = (typeof KINDS)[number];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export const consultParameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Short identifier for this question, e.g. risky." }),
			kind: StringEnum(KINDS, {
				description: "yesNo: probability a statement holds. pick: mass over named options. rate: position on a ladder.",
			}),
			question: Type.String({ description: "The question, answerable from state alone." }),
			whenTrue: Type.Optional(Type.String({ description: "yesNo: what a true answer means." })),
			whenFalse: Type.Optional(Type.String({ description: "yesNo: what a false answer means." })),
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
	state: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "The evidence the questions are about, at most 2 KB as JSON. The model sees nothing else.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: `Up to ${CONSULT_LIMITS.files} workspace files whose head (${CONSULT_LIMITS.fileChars} characters each, secrets redacted) is sent as evidence beside state.`,
		}),
	),
});

const DESCRIPTION =
	"Ask the configured decision model up to four typed questions (yesNo, pick, rate) about evidence you supply (a small state and up to eight workspace files), and get back its probability distribution, the answering build and the latency. The answer is advice: it never makes the choice, and you stay responsible for what you do. A few hundred milliseconds per call; at most 3 calls per turn.";

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
		const whenTrue = raw.whenTrue ?? "The statement holds";
		const whenFalse = raw.whenFalse ?? "The statement does not hold";
		const error = criterionError(id, "whenTrue", whenTrue) ?? criterionError(id, "whenFalse", whenFalse);
		if (error !== null) return error;
		return { id, kind: "yesNo", question: yesNo(text, whenTrue as string, whenFalse as string) };
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
	if (reservation.exhausted) {
		return observationBudgetExhausted({
			tool: ToolNames.Consult,
			unit: "sections",
			reservation,
			subject: "consult file evidence",
			hint: "Ask again without paths, or continue in a follow-up turn.",
		});
	}
	// The files go to the engine and only its distribution returns to the model,
	// so the reservation bounds and gates the reads and is refunded, not charged.
	commitObservationReservation(reservation);
	try {
		const files: Record<string, string> = {};
		const realPaths: string[] = [];
		const skipped: Array<{ path: string; reason: string }> = [];
		const filter = createObservationPathFilter(cwd, options?.allowsObservationPath);
		const tally = createRedactionTally();
		const root = await realpath(cwd);
		let spent = 0;
		for (const raw of paths) {
			const label = typeof raw === "string" ? raw : String(raw);
			const skip = (reason: string): void => {
				skipped.push({ path: label.slice(0, 200), reason });
			};
			if (typeof raw !== "string" || raw.trim().length === 0) {
				skip("not a path");
				continue;
			}
			if (options?.signal?.aborted === true) {
				skip("cancelled");
				continue;
			}
			let real: string;
			try {
				real = await realpath(resolveReadPath(raw.trim(), cwd));
			} catch {
				skip("not found");
				continue;
			}
			// Symlinks are resolved first, so a link out of the workspace is outside.
			if (!isInside(root, real)) {
				skip("outside the workspace");
				continue;
			}
			if (!filter.allows(real)) {
				skip("withheld by the protected-path policy");
				continue;
			}
			const key = toPosixPath(relative(root, real)) || ".";
			if (Object.hasOwn(files, key)) {
				skip("repeated");
				continue;
			}
			if (spent >= reservation.callCapBytes) {
				skip("turn observation budget");
				continue;
			}
			try {
				const entry = await stat(real);
				if (!entry.isFile()) {
					skip("not a file");
					continue;
				}
				const handle = await open(real, "r");
				let head: Buffer;
				try {
					const buffer = Buffer.alloc(Math.min(entry.size, FILE_READ_BYTES));
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					head = buffer.subarray(0, bytesRead);
				} finally {
					await handle.close().catch(() => undefined);
				}
				const decoded = textHead(head, entry.size <= head.length);
				if (decoded === null) {
					skip("binary or not UTF-8");
					continue;
				}
				const text = [...decoded].slice(0, CONSULT_LIMITS.fileChars).join("");
				files[key] = redactSecretsText(text, tally);
				realPaths.push(real);
				spent += Buffer.byteLength(files[key] ?? "", "utf8");
			} catch (err) {
				skip(err instanceof Error ? err.message : String(err));
			}
		}
		return { files, skipped, realPaths };
	} finally {
		releaseObservation(reservation);
	}
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
			const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
			if (rawQuestions.length === 0) return refuse("questions must hold at least one question");
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
				evidence = read;
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
			const remaining = CONSULT_LIMITS.callsPerTurn - turn.calls;
			const questions = Object.fromEntries(parsed.map((entry) => [entry.id, entry.question]));
			const verdict = await deps.systemOne.run(
				consultSite(questions),
				{ state, files: evidence.files },
				{
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
					note: "The decision model gave no usable answer. Proceed on your own judgment.",
					...evidenceNote,
					remainingCalls: remaining,
				};
				return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
			}
			const output = {
				answered: true,
				note: "Advice from a decision model, not a decision. You choose what to do.",
				answers: verdict.value.answers,
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
