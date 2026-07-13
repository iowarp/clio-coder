import {
	buildMemoryInterventionUserPrompt,
	MEMORY_INTERVENTION_SYSTEM_PROMPT,
} from "../prompts/memory-intervention.js";
import { TASK_MEMORY_CONTENT_MAX_CHARS, type TaskMemoryBank, type TaskMemoryRenderableClass } from "./task-bank.js";

export const TASK_MEMORY_POLICY_MAX_OPERATIONS = 8;
export const TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS = 20_000;
export const TASK_MEMORY_POLICY_MODEL_MAX_OUTPUT_TOKENS = 1_200;

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
		const parsed = parseTaskMemoryPolicyResponse(response.text, input.maxTokens);
		if (parsed === null || !operationsApplyCleanly(bank, parsed.operations)) {
			return {
				...empty("malformed"),
				inputTokens: nonNegativeInteger(response.inputTokens),
				outputTokens: nonNegativeInteger(response.outputTokens),
			};
		}
		applyOperations(bank, parsed.operations);
		const usage = {
			inputTokens: nonNegativeInteger(response.inputTokens),
			outputTokens: nonNegativeInteger(response.outputTokens),
		};
		if (parsed.context === null) {
			return { decision: "silent", bankOperations: parsed.operations.length, reminder: null, ...usage };
		}
		const reminder = withMemoryPrefix(parsed.context, input.maxTokens);
		if (reminder.length === 0) {
			return { decision: "malformed", bankOperations: parsed.operations.length, reminder: null, ...usage };
		}
		if (input.suppressIntervention === true || reminder === input.previousReminder) {
			return { decision: "silent", bankOperations: parsed.operations.length, reminder: null, ...usage };
		}
		const citedIds = citedRenderableEntryIds(bank, reminder);
		if (!input.deterministicTrigger && citedIds.length === 0) {
			return { decision: "gated", bankOperations: parsed.operations.length, reminder: null, ...usage };
		}
		bank.recordInjection(citedIds);
		return { decision: "injected", bankOperations: parsed.operations.length, reminder, ...usage };
	} catch {
		return empty("silent");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function parseTaskMemoryPolicyResponse(response: string, maxTokens: number): ParsedMemoryStep | null {
	if (typeof response !== "string" || response.length === 0) return null;
	const match =
		/^<operations>(\[[^\r\n]*\])<\/operations>\r?\n(<no_intervention\/>|<context_for_action>([^<>]*)<\/context_for_action>)$/u.exec(
			response.trim(),
		);
	if (match === null) return null;
	let rawOperations: unknown;
	try {
		rawOperations = JSON.parse(match[1] ?? "") as unknown;
	} catch {
		return null;
	}
	const operations = readOperations(rawOperations);
	if (operations === null) return null;
	const context = match[2] === "<no_intervention/>" ? null : (match[3]?.replace(/\s+/gu, " ").trim() ?? "");
	const contextMaxChars = Math.max(0, maxTokens) * 4 - "Memory: ".length;
	if (context !== null && (context.length === 0 || context.length > contextMaxChars)) return null;
	return { operations, context };
}

function readOperations(value: unknown): TaskMemoryOperation[] | null {
	if (!Array.isArray(value) || value.length > TASK_MEMORY_POLICY_MAX_OPERATIONS) return null;
	const operations: TaskMemoryOperation[] = [];
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
				return null;
		}
	}
	return operations;
}

function operationsApplyCleanly(bank: TaskMemoryBank, operations: ReadonlyArray<TaskMemoryOperation>): boolean {
	const snapshot = bank.snapshot();
	const classes = new Map<string, "status" | TaskMemoryRenderableClass>();
	if (snapshot.status !== null) classes.set(snapshot.status.id, "status");
	for (const entry of snapshot.knowledge) classes.set(entry.id, "knowledge");
	for (const entry of snapshot.procedural) classes.set(entry.id, "procedural");
	for (const operation of operations) {
		switch (operation.op) {
			case "update_status":
				break;
			case "save_knowledge":
			case "save_procedural": {
				if (operation.id === undefined) break;
				const expected = operation.op === "save_knowledge" ? "knowledge" : "procedural";
				if (classes.get(operation.id) !== expected) return false;
				break;
			}
			case "delete":
				if (!classes.delete(operation.id)) return false;
				break;
		}
	}
	return true;
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
