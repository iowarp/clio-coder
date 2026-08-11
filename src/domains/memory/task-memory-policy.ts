import {
	buildMemoryInterventionUserPrompt,
	MEMORY_INTERVENTION_SYSTEM_PROMPT,
} from "../prompts/memory-intervention.js";
import { TASK_MEMORY_CONTENT_MAX_CHARS, type TaskMemoryBank, type TaskMemoryRenderableClass } from "./task-bank.js";

export const TASK_MEMORY_POLICY_MAX_OPERATIONS = 8;
export const TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS = 20_000;
/**
 * The envelope itself needs a few hundred tokens. The rest is headroom for a
 * model that reasons despite thinking being requested off: measured preambles on
 * a 9B local route ran past 1,800 tokens before the first `<operations>` byte,
 * and a budget that runs out mid-thought yields an empty response, no bank
 * writes, and no way for the operator to tell that from a deliberate silence.
 */
export const TASK_MEMORY_POLICY_MODEL_MAX_OUTPUT_TOKENS = 4_000;

export interface TaskMemoryTrajectoryStep {
	step: number;
	toolName: string;
	fingerprint: string;
	callDescription: string;
	outcome: "ok" | "error";
	resultDigest: string;
}

export interface TaskMemoryModelRequest {
	systemPrompt: string;
	userPrompt: string;
	maxTokens: number;
	signal: AbortSignal;
}

export interface TaskMemoryModelResponse {
	text: string;
	inputTokens?: number;
	outputTokens?: number;
}

export interface TaskMemoryModelClient {
	complete(input: TaskMemoryModelRequest): Promise<TaskMemoryModelResponse>;
}

export type TaskMemoryPolicyDecision = "silent" | "injected" | "gated" | "timeout" | "malformed";

/**
 * Why a step ended where it did.
 *
 * `decision` alone cannot be acted on. Six distinct situations resolve to a
 * null reminder, and they call for opposite responses: a route that refused the
 * connection needs the server started, a model that wrote `<no_intervention/>`
 * needs nothing at all, and an answer whose every operation named an invented
 * verb needs the prompt changed. A session that recorded four `silent` steps and
 * zero bank writes was indistinguishable from a healthy quiet one, which is how
 * a broken tier survived a whole session unnoticed.
 */
export type TaskMemoryPolicyReason =
	/** A cited reminder reached the visible channel. */
	| "intervened"
	/** The model answered and chose `<no_intervention/>` or wrote no phase two. */
	| "model_silent"
	/** The reminder repeated the one already on screen. */
	| "duplicate_reminder"
	/** The rules tier already spoke for this boundary; phase one still applied. */
	| "suppressed"
	/** A spontaneous reminder cited no bank entry. */
	| "uncited"
	/** The reminder exceeded the token cap and was dropped rather than truncated. */
	| "over_budget"
	/** No envelope was found, or its operation list violated the grammar. */
	| "unparseable"
	/** Every operation named a verb the bank has no writer for. */
	| "all_operations_invalid"
	/** The request did not answer inside the policy timeout. */
	| "deadline"
	/** The model client threw: unreachable route, auth failure, malformed request. */
	| "client_error"
	/** No background role is configured, so the llm tier never ran. */
	| "no_client"
	/**
	 * Nothing in this process can consume a reminder, so no step was started. A
	 * headless run submits no further turn, and the step is detached from the
	 * boundary that triggered it, so the process exits before it can land.
	 */
	| "no_consumer"
	/** A step was already in flight, so this boundary's triggers stayed pending. */
	| "step_in_flight"
	/** Rules tier: the turn ended with no repeated failure worth reporting. */
	| "no_repeated_failure"
	/** Rules tier: compaction reactivation found no knowledge entries to restore. */
	| "bank_empty";

/**
 * The model's own words for one step, handed to an observer before they are
 * discarded. Content-bearing by construction, so the composition root only wires
 * it when the operator asked for a trace.
 */
export interface TaskMemoryEnvelope {
	systemPrompt: string;
	userPrompt: string;
	/** Raw completion text, or empty when the call threw or timed out. */
	response: string;
	decision: TaskMemoryPolicyDecision;
	reason: TaskMemoryPolicyReason;
	bankOperations: number;
	droppedOperations: number;
	reminder: string | null;
	/** Client failure message, redacted of nothing because it never carries bank text. */
	error: string | null;
}

export interface TaskMemoryPolicyInput {
	task: string;
	trajectory: ReadonlyArray<TaskMemoryTrajectoryStep>;
	deterministicTrigger: boolean;
	maxTokens: number;
	timeoutMs?: number;
	/** Phase one still applies; phase two is suppressed when another memory reminder already won this boundary. */
	suppressIntervention?: boolean;
	/** Last visible memory reminder, used to keep repeated model output silent. */
	previousReminder?: string | null;
	/** Opt-in raw-envelope observer. Absent unless an operator turned tracing on. */
	onEnvelope?: (envelope: TaskMemoryEnvelope) => void;
}

export interface TaskMemoryPolicyResult {
	decision: TaskMemoryPolicyDecision;
	reason: TaskMemoryPolicyReason;
	bankOperations: number;
	/** Operations the bank refused. Nonzero with `bankOperations` at zero is a total loss. */
	droppedOperations: number;
	reminder: string | null;
	inputTokens: number;
	outputTokens: number;
}

type TaskMemoryOperation =
	| { op: "update_status"; content: string }
	| { op: "save_knowledge"; content: string; id?: string }
	| { op: "save_procedural"; content: string; id?: string }
	| { op: "delete"; id: string };

interface ParsedMemoryStep {
	operations: TaskMemoryOperation[];
	context: string | null;
}

interface ReadOperationsResult {
	operations: TaskMemoryOperation[];
	/** Entries named an op the bank has no verb for; kept only to detect a total loss. */
	dropped: number;
}

const TASK_PROMPT_MAX_CHARS = 2_000;
const TRAJECTORY_PROMPT_MAX_CHARS = 4_000;

export async function runTaskMemoryPolicy(
	bank: TaskMemoryBank,
	client: TaskMemoryModelClient,
	input: TaskMemoryPolicyInput,
): Promise<TaskMemoryPolicyResult> {
	const controller = new AbortController();
	const timeoutMs = positiveInteger(input.timeoutMs, TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS);
	const timeoutMarker = Symbol("task-memory-timeout");
	let timer: NodeJS.Timeout | undefined;
	let userPrompt = "";
	let rawResponse = "";
	let clientError: string | null = null;
	// Every exit reports through here so the trace sees the same envelope the
	// telemetry row summarizes, including the paths that used to throw away both.
	const settle = (
		decision: TaskMemoryPolicyDecision,
		reason: TaskMemoryPolicyReason,
		parts: Partial<Omit<TaskMemoryPolicyResult, "decision" | "reason">> = {},
	): TaskMemoryPolicyResult => {
		const result: TaskMemoryPolicyResult = {
			decision,
			reason,
			bankOperations: parts.bankOperations ?? 0,
			droppedOperations: parts.droppedOperations ?? 0,
			reminder: parts.reminder ?? null,
			inputTokens: parts.inputTokens ?? 0,
			outputTokens: parts.outputTokens ?? 0,
		};
		try {
			input.onEnvelope?.({
				systemPrompt: MEMORY_INTERVENTION_SYSTEM_PROMPT,
				userPrompt,
				response: rawResponse,
				decision,
				reason,
				bankOperations: result.bankOperations,
				droppedOperations: result.droppedOperations,
				reminder: result.reminder,
				error: clientError,
			});
		} catch {
			// A failing observer is an operator's diagnostic, never the policy's problem.
		}
		return result;
	};
	try {
		userPrompt = buildMemoryInterventionUserPrompt({
			task: input.task.slice(0, TASK_PROMPT_MAX_CHARS),
			bank: bank.render(input.maxTokens),
			trajectory: JSON.stringify(input.trajectory).slice(0, TRAJECTORY_PROMPT_MAX_CHARS),
		});
		const completion = client.complete({
			systemPrompt: MEMORY_INTERVENTION_SYSTEM_PROMPT,
			userPrompt,
			maxTokens: TASK_MEMORY_POLICY_MODEL_MAX_OUTPUT_TOKENS,
			signal: controller.signal,
		});
		const timeout = new Promise<typeof timeoutMarker>((resolve) => {
			timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
		});
		const response = await Promise.race([completion, timeout]);
		if (response === timeoutMarker) {
			controller.abort();
			void completion.catch(() => undefined);
			return settle("timeout", "deadline");
		}
		rawResponse = typeof response.text === "string" ? response.text : "";
		const usage = {
			inputTokens: nonNegativeInteger(response.inputTokens),
			outputTokens: nonNegativeInteger(response.outputTokens),
		};
		const read = readPolicyStep(rawResponse);
		if (!read.ok) return settle("malformed", read.reason, { ...usage, droppedOperations: read.dropped });
		const operations = resolveOperations(bank, read.step.operations);
		applyOperations(bank, operations);
		// A model's operation is dropped either by the grammar, which does not know
		// the verb, or by identity repair, which could not resolve a delete target.
		// Both are model output the bank refused, so both belong in one count.
		const counts = {
			...usage,
			bankOperations: operations.length,
			droppedOperations: read.dropped + (read.step.operations.length - operations.length),
		};
		if (read.step.context === null) return settle("silent", "model_silent", counts);
		// An over-budget reminder is a phase-two policy violation, not a parse
		// failure. Truncating it would strip the citation that earns it a voice, so
		// the reminder is suppressed while phase one stays applied.
		const reminder = withMemoryPrefix(read.step.context, input.maxTokens);
		if (reminder.length === 0) return settle("gated", "over_budget", counts);
		if (input.suppressIntervention === true) return settle("silent", "suppressed", counts);
		if (reminder === input.previousReminder) return settle("silent", "duplicate_reminder", counts);
		const citedIds = citedRenderableEntryIds(bank, reminder);
		if (!input.deterministicTrigger && citedIds.length === 0) return settle("gated", "uncited", counts);
		bank.recordInjection(citedIds);
		return settle("injected", "intervened", { ...counts, reminder });
	} catch (error) {
		clientError = errorMessage(error);
		return settle("silent", "client_error");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

const OPERATIONS_OPEN = "<operations>";
const OPERATIONS_CLOSE = "</operations>";
const CONTEXT_OPEN = "<context_for_action>";
const CONTEXT_CLOSE = "</context_for_action>";

/**
 * Small local models rarely emit a byte-exact envelope: they wrap it in a
 * markdown fence, prepend a reasoning block, or add a closing sentence. None of
 * that changes what they decided, so the envelope is located rather than
 * matched, and anything outside it is discarded.
 */
function cleanPolicyResponse(raw: string): string {
	return (
		raw
			.replace(/<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
			// An unterminated reasoning block means the output budget ran out mid-thought;
			// nothing after it is trustworthy, and nothing before it is an envelope.
			.replace(/<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*$/iu, " ")
			.replace(/^[^\S\n]*```[^\n]*$/gmu, " ")
			.trim()
	);
}

/**
 * Reminder text rides inside a `<system-reminder>` block on the next user turn.
 * Tag-shaped output from the memory model must not be able to close that block
 * early, so tag shapes are dropped while comparisons and arrows survive.
 */
function stripTagShapes(value: string): string {
	return value.replace(/<\/?[a-zA-Z][^>]*>/gu, " ");
}

type ReadPolicyStepResult =
	| { ok: true; step: ParsedMemoryStep; dropped: number }
	| { ok: false; reason: "unparseable" | "all_operations_invalid"; dropped: number };

/**
 * The rejecting variant of the parser. It separates "the model produced no
 * envelope" from "the model produced an envelope whose every operation named a
 * verb the bank does not have", because those two point at different fixes and
 * the boolean form of this function could not tell them apart.
 */
function readPolicyStep(response: string): ReadPolicyStepResult {
	const unparseable = { ok: false, reason: "unparseable", dropped: 0 } as const;
	if (typeof response !== "string" || response.length === 0) return unparseable;
	const text = cleanPolicyResponse(response);
	const opensAt = text.indexOf(OPERATIONS_OPEN);
	if (opensAt === -1) return unparseable;
	const closesAt = text.indexOf(OPERATIONS_CLOSE, opensAt);
	if (closesAt === -1) return unparseable;
	let rawOperations: unknown;
	try {
		rawOperations = JSON.parse(text.slice(opensAt + OPERATIONS_OPEN.length, closesAt)) as unknown;
	} catch {
		return unparseable;
	}
	const read = readOperations(rawOperations);
	if (read === null) return unparseable;
	// Recovering nothing is not silence. A step whose every operation was invented
	// stays malformed so the operator can see the model answered in a shape the
	// bank could not use.
	if (read.operations.length === 0 && read.dropped > 0) {
		return { ok: false, reason: "all_operations_invalid", dropped: read.dropped };
	}
	return {
		ok: true,
		step: { operations: read.operations, context: readContext(text.slice(closesAt + OPERATIONS_CLOSE.length)) },
		dropped: read.dropped,
	};
}

export function parseTaskMemoryPolicyResponse(response: string): ParsedMemoryStep | null {
	const read = readPolicyStep(response);
	return read.ok ? read.step : null;
}

/**
 * Phase two after the operation list. Explicit silence, a missing decision, and
 * an empty reminder all resolve to silence: the prompt's documented default is
 * `<no_intervention/>`, so an incomplete envelope must never manufacture an
 * intervention out of a model that simply stopped writing.
 */
function readContext(tail: string): string | null {
	const contextAt = tail.indexOf(CONTEXT_OPEN);
	const silenceAt = tail.search(/<no_intervention\s*\/?>/u);
	if (contextAt === -1) return null;
	if (silenceAt !== -1 && silenceAt < contextAt) return null;
	const body = tail.slice(contextAt + CONTEXT_OPEN.length);
	const closesAt = body.lastIndexOf(CONTEXT_CLOSE);
	const context = stripTagShapes(closesAt === -1 ? body : body.slice(0, closesAt))
		.replace(/\s+/gu, " ")
		.trim();
	return context.length === 0 ? null : context;
}

/**
 * Structural violations still reject the batch, because they say the model did
 * not produce an operation list at all. An unrecognized `op` says only that one
 * entry named a verb the bank does not have, and a small model handed a tool
 * trajectory routinely borrows that trajectory's shape for exactly one entry.
 * Dropping it costs one operation, which is the same trade `resolveOperations`
 * already makes for an invented entry id.
 */
function readOperations(value: unknown): ReadOperationsResult | null {
	if (!Array.isArray(value) || value.length > TASK_MEMORY_POLICY_MAX_OPERATIONS) return null;
	const operations: TaskMemoryOperation[] = [];
	let dropped = 0;
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.op !== "string") return null;
		switch (raw.op) {
			case "update_status": {
				if (!hasExactKeys(raw, ["op", "content"])) return null;
				const content = boundedContent(raw.content);
				if (content === null) return null;
				operations.push({ op: raw.op, content });
				break;
			}
			case "save_knowledge":
			case "save_procedural": {
				if (!hasExactKeys(raw, raw.id === undefined ? ["op", "content"] : ["op", "content", "id"])) return null;
				const content = boundedContent(raw.content);
				if (content === null) return null;
				if (raw.id !== undefined && !nonEmptyString(raw.id)) return null;
				const operation: Extract<TaskMemoryOperation, { op: typeof raw.op }> = { op: raw.op, content };
				if (typeof raw.id === "string") operation.id = raw.id;
				operations.push(operation);
				break;
			}
			case "delete":
				if (!hasExactKeys(raw, ["op", "id"]) || !nonEmptyString(raw.id)) return null;
				operations.push({ op: raw.op, id: raw.id });
				break;
			default:
				dropped += 1;
				break;
		}
	}
	return { operations, dropped };
}

/**
 * Reconcile a model's operation list against the bank it actually has.
 *
 * Small local models routinely invent plausible-looking entry ids for content
 * they mean to record for the first time. Rejecting the whole batch over one
 * such id throws away the writes that were the point of the step, so an
 * unresolvable save id is treated as a new entry and an unresolvable delete is
 * dropped. Structural violations are still rejected wholesale, upstream in
 * `readOperations`; this stage only repairs identity.
 */
function resolveOperations(
	bank: TaskMemoryBank,
	operations: ReadonlyArray<TaskMemoryOperation>,
): TaskMemoryOperation[] {
	const snapshot = bank.snapshot();
	const classes = new Map<string, "status" | TaskMemoryRenderableClass>();
	if (snapshot.status !== null) classes.set(snapshot.status.id, "status");
	for (const entry of snapshot.knowledge) classes.set(entry.id, "knowledge");
	for (const entry of snapshot.procedural) classes.set(entry.id, "procedural");
	const resolved: TaskMemoryOperation[] = [];
	for (const operation of operations) {
		switch (operation.op) {
			case "update_status":
				resolved.push(operation);
				break;
			case "save_knowledge":
			case "save_procedural": {
				const expected = operation.op === "save_knowledge" ? "knowledge" : "procedural";
				if (operation.id !== undefined && classes.get(operation.id) === expected) {
					resolved.push(operation);
					break;
				}
				// An id naming nothing, or an entry in the other class, is not an
				// update the bank can honor. The content still deserves a home.
				resolved.push({ op: operation.op, content: operation.content });
				break;
			}
			case "delete":
				if (classes.delete(operation.id)) resolved.push(operation);
				break;
		}
	}
	return resolved;
}

function applyOperations(bank: TaskMemoryBank, operations: ReadonlyArray<TaskMemoryOperation>): void {
	for (const operation of operations) {
		switch (operation.op) {
			case "update_status":
				bank.updateStatus(operation.content);
				break;
			case "save_knowledge":
				bank.saveKnowledge(operation.content, operation.id === undefined ? {} : { id: operation.id });
				break;
			case "save_procedural":
				bank.saveProcedural(operation.content, operation.id === undefined ? {} : { id: operation.id });
				break;
			case "delete":
				bank.deleteEntry(operation.id);
				break;
		}
	}
}

function citedRenderableEntryIds(bank: TaskMemoryBank, reminder: string): string[] {
	const snapshot = bank.snapshot();
	return [...snapshot.knowledge, ...snapshot.procedural]
		.map((entry) => entry.id)
		.filter((id) => reminder.includes(`[${id}]`));
}

function withMemoryPrefix(content: string, maxTokens: number): string {
	const prefixed = content.startsWith("Memory:") ? content : `Memory: ${content}`;
	const maxChars = Math.max(0, maxTokens) * 4;
	return prefixed.length <= maxChars ? prefixed : "";
}

function boundedContent(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length > 0 && normalized.length <= TASK_MEMORY_CONTENT_MAX_CHARS ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: ReadonlyArray<string>): boolean {
	const keys = Object.keys(record).sort();
	return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : 0;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
	return typeof error === "string" && error.length > 0 ? error : "an unknown client failure";
}
