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
}

export interface TaskMemoryPolicyResult {
	decision: TaskMemoryPolicyDecision;
	bankOperations: number;
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
	const empty = (decision: TaskMemoryPolicyDecision): TaskMemoryPolicyResult => ({
		decision,
		bankOperations: 0,
		reminder: null,
		inputTokens: 0,
		outputTokens: 0,
	});
	const controller = new AbortController();
	const timeoutMs = positiveInteger(input.timeoutMs, TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS);
	const timeoutMarker = Symbol("task-memory-timeout");
	let timer: NodeJS.Timeout | undefined;
	try {
		const userPrompt = buildMemoryInterventionUserPrompt({
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
			return empty("timeout");
		}
		const parsed = parseTaskMemoryPolicyResponse(response.text);
		if (parsed === null) {
			return {
				...empty("malformed"),
				inputTokens: nonNegativeInteger(response.inputTokens),
				outputTokens: nonNegativeInteger(response.outputTokens),
			};
		}
		const operations = resolveOperations(bank, parsed.operations);
		applyOperations(bank, operations);
		const usage = {
			inputTokens: nonNegativeInteger(response.inputTokens),
			outputTokens: nonNegativeInteger(response.outputTokens),
		};
		if (parsed.context === null) {
			return { decision: "silent", bankOperations: operations.length, reminder: null, ...usage };
		}
		// An over-budget reminder is a phase-two policy violation, not a parse
		// failure. Truncating it would strip the citation that earns it a voice, so
		// the reminder is suppressed while phase one stays applied.
		const reminder = withMemoryPrefix(parsed.context, input.maxTokens);
		if (reminder.length === 0) {
			return { decision: "gated", bankOperations: operations.length, reminder: null, ...usage };
		}
		if (input.suppressIntervention === true || reminder === input.previousReminder) {
			return { decision: "silent", bankOperations: operations.length, reminder: null, ...usage };
		}
		const citedIds = citedRenderableEntryIds(bank, reminder);
		if (!input.deterministicTrigger && citedIds.length === 0) {
			return { decision: "gated", bankOperations: operations.length, reminder: null, ...usage };
		}
		bank.recordInjection(citedIds);
		return { decision: "injected", bankOperations: operations.length, reminder, ...usage };
	} catch {
		return empty("silent");
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

export function parseTaskMemoryPolicyResponse(response: string): ParsedMemoryStep | null {
	if (typeof response !== "string" || response.length === 0) return null;
	const text = cleanPolicyResponse(response);
	const opensAt = text.indexOf(OPERATIONS_OPEN);
	if (opensAt === -1) return null;
	const closesAt = text.indexOf(OPERATIONS_CLOSE, opensAt);
	if (closesAt === -1) return null;
	let rawOperations: unknown;
	try {
		rawOperations = JSON.parse(text.slice(opensAt + OPERATIONS_OPEN.length, closesAt)) as unknown;
	} catch {
		return null;
	}
	const read = readOperations(rawOperations);
	if (read === null) return null;
	// Recovering nothing is not silence. A step whose every operation was invented
	// stays malformed so the operator can see the model answered in a shape the
	// bank could not use.
	if (read.operations.length === 0 && read.dropped > 0) return null;
	return { operations: read.operations, context: readContext(text.slice(closesAt + OPERATIONS_CLOSE.length)) };
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
