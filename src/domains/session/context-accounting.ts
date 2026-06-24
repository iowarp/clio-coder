import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwdHash, sessionPaths } from "../../engine/session.js";
import type { AgentMessage, Usage } from "../../engine/types.js";
import { categoryForSegment } from "./context-ledger.js";
import type { SessionMeta } from "./contract.js";

const IMAGE_CHAR_ESTIMATE = 4800;
const TOKEN_CHARS = 4;
const MESSAGE_OVERHEAD_TOKENS = 16;

export interface AgentContextEstimateInput {
	messages: ReadonlyArray<AgentMessage>;
	systemPrompt?: string;
	pendingUserText?: string;
	tools?: ReadonlyArray<unknown>;
}

export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	breakdown?: ContextUsageBreakdown;
}

export interface ContextUsageBreakdown {
	systemPromptTokens: number;
	messageTokens: number;
	pendingUserTokens: number;
	toolSchemaTokens: number;
}

export interface ContextSnapshot {
	snapshotId: string;
	sessionId: string;
	turnId: string;
	providerId: string | null;
	runtimeId: string | null;
	modelId: string | null;

	// Inputs captured
	systemPrompt?: string | undefined;
	promptSegments?: { id: string; tokenEstimate: number }[] | undefined;
	conversationMessages?: unknown[] | undefined;
	activeToolSchemas?: unknown[] | undefined;
	pendingUserInput?: string | undefined;
	images?: unknown[] | undefined;

	// Window resolution details
	desiredContextWindow: number;
	effectiveContextWindow: number;
	contextWindowSource: string;

	// Token counts
	categories: {
		system: number;
		tools: number;
		agents: number;
		skills: number;
		memory: number;
		project: number;
		messages: number;
		reserve: number;
		free: number;
		streaming: number;
	};

	// Source labels
	sources: {
		total: "estimated" | "exact" | "reconciled" | "streaming";
		splits: Record<string, "estimated" | "exact" | "reconciled">;
	};

	promptHash?: string | undefined;
	toolSignature?: string | undefined;
	messageRange?: { start: number; end: number } | undefined;
}

export function ceilChars(chars: number): number {
	return Math.ceil(Math.max(0, chars) / TOKEN_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "boolean") return String(value).length;
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function argsLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	return typeof value === "string" ? value.length : jsonLength(value);
}

export function blockChars(block: unknown): number {
	if (typeof block === "string") return block.length;
	if (!isRecord(block)) return jsonLength(block);
	if (block.type === "text" && typeof block.text === "string") return block.text.length;
	if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking.length;
	if (block.type === "image") return IMAGE_CHAR_ESTIMATE;
	if (block.type === "toolCall") {
		const name = typeof block.name === "string" ? block.name : "";
		const id = typeof block.id === "string" ? block.id : "";
		return id.length + name.length + argsLength(block.arguments ?? block.args ?? block.input);
	}
	if (Array.isArray(block.content)) return contentChars(block.content);
	if (typeof block.text === "string") return block.text.length;
	if (typeof block.thinking === "string") return block.thinking.length;
	return jsonLength(block);
}

export function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return jsonLength(content);
	return content.reduce((sum, block) => sum + blockChars(block), 0);
}

export function messageChars(message: unknown): number {
	if (!isRecord(message)) return jsonLength(message);
	let chars = 0;
	chars += typeof message.role === "string" ? message.role.length : 0;
	const payload = message.payload !== undefined ? message.payload : message.content;
	chars += contentChars(payload);
	chars += typeof message.toolCallId === "string" ? message.toolCallId.length : 0;
	chars += typeof message.toolName === "string" ? message.toolName.length : 0;
	chars += typeof message.errorMessage === "string" ? message.errorMessage.length : 0;
	return chars;
}

export function toolSchemaChars(tool: unknown): number {
	if (!isRecord(tool)) return jsonLength(tool);
	const name = typeof tool.name === "string" ? tool.name.length : 0;
	const description = typeof tool.description === "string" ? tool.description.length : 0;
	const parameters = jsonLength(tool.parameters);
	return name + description + parameters;
}

function usageTotalTokens(usage: unknown): number | null {
	if (!isRecord(usage)) return null;
	const total = usage.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
	const output = typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
	const cacheRead = typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
	const sum = input + output + cacheRead + cacheWrite;
	return sum > 0 ? sum : null;
}

function usageInvalidated(message: AgentMessage): boolean {
	return (message as { contextUsageInvalidated?: unknown }).contextUsageInvalidated === true;
}

function latestUsableAssistantUsage(messages: ReadonlyArray<AgentMessage>): { index: number; tokens: number } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as AgentMessage | undefined;
		if (message?.role !== "assistant") continue;
		if (usageInvalidated(message)) continue;
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		if (stopReason === "error" || stopReason === "aborted") continue;
		const tokens = usageTotalTokens((message as { usage?: Usage }).usage);
		if (tokens !== null) return { index: i, tokens };
	}
	return null;
}

function finitePositive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nestedNumber(root: unknown, path: ReadonlyArray<string>): number | null {
	let current = root;
	for (const key of path) {
		if (!isRecord(current)) return null;
		current = current[key];
	}
	return finitePositive(current);
}

export function extractReasoningTokens(usage: unknown): number | null {
	if (!isRecord(usage)) return null;
	const direct =
		finitePositive(usage.reasoningTokens) ?? finitePositive(usage.reasoning_tokens) ?? finitePositive(usage.reasoning);
	if (direct !== null) return direct;
	const paths = [
		["outputDetails", "reasoningTokens"],
		["output_details", "reasoning_tokens"],
		["output_tokens_details", "reasoning_tokens"],
		["completion_tokens_details", "reasoning_tokens"],
		["completionTokensDetails", "reasoningTokens"],
		["details", "reasoningTokens"],
	] as const;
	for (const path of paths) {
		const value = nestedNumber(usage, path);
		if (value !== null) return value;
	}
	return null;
}

/**
 * Structural view of anything message-shaped enough to estimate. Engine
 * `AgentMessage`s, session `MessageEntry`s, and pi-ai `Context` messages all
 * satisfy it without casting; `messageChars` duck-types every field anyway.
 */
export interface MessageTokenEstimateInput {
	role?: unknown;
	payload?: unknown;
	content?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	errorMessage?: unknown;
}

export function estimateAgentMessageTokens(message: MessageTokenEstimateInput): number {
	return ceilChars(messageChars(message)) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateAgentContextBreakdown(input: AgentContextEstimateInput): ContextUsageBreakdown {
	return {
		systemPromptTokens: input.systemPrompt ? ceilChars(input.systemPrompt.length) : 0,
		messageTokens: input.messages.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0),
		pendingUserTokens: input.pendingUserText ? ceilChars(input.pendingUserText.length) : 0,
		toolSchemaTokens: (input.tools ?? []).reduce<number>((sum, tool) => sum + ceilChars(toolSchemaChars(tool)), 0),
	};
}

export function estimateAgentContextTokens(input: AgentContextEstimateInput): number {
	const breakdown = estimateAgentContextBreakdown(input);
	const projection =
		breakdown.systemPromptTokens + breakdown.messageTokens + breakdown.pendingUserTokens + breakdown.toolSchemaTokens;

	const usage = latestUsableAssistantUsage(input.messages);
	if (!usage) return projection;
	const trailingTokens = input.messages
		.slice(usage.index + 1)
		.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
	const anchored = usage.tokens + trailingTokens + breakdown.pendingUserTokens + breakdown.toolSchemaTokens;
	return Math.max(projection, anchored);
}

export function contextUsageSnapshot(
	tokens: number | null,
	contextWindow: number | null | undefined,
	breakdown?: ContextUsageBreakdown,
): ContextUsageSnapshot {
	const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) ? Math.max(0, contextWindow) : 0;
	const base =
		tokens === null || tokens <= 0 || window <= 0
			? { tokens, contextWindow: window, percent: null }
			: { tokens, contextWindow: window, percent: Math.min(100, (tokens / window) * 100) };
	return breakdown ? { ...base, breakdown } : base;
}

// Persisted snapshot helpers
export function getSnapshotsFilePath(meta: SessionMeta): string {
	const safeMeta = {
		...meta,
		cwdHash: meta.cwdHash || cwdHash(meta.cwd || process.cwd()),
	};
	const paths = sessionPaths(safeMeta);
	return join(dirname(paths.current), "context-snapshots.jsonl");
}

/**
 * Strip the heavy captured inputs before persisting. The JSONL ledger exists
 * for accounting and audit (token splits, window resolution, hashes, ranges);
 * persisting the full conversation and tool schemas per turn would duplicate
 * the session log with O(turns^2) growth. The in-memory snapshot keeps the
 * full capture for the live overlay and replay inspection.
 */
function persistableSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
	const {
		systemPrompt: _systemPrompt,
		conversationMessages: _messages,
		activeToolSchemas: _tools,
		pendingUserInput: _pending,
		images: _images,
		...slim
	} = snapshot;
	return slim;
}

/** Best-effort append; accounting telemetry must never abort a turn. */
export function appendContextSnapshot(meta: SessionMeta, snapshot: ContextSnapshot): void {
	try {
		const file = getSnapshotsFilePath(meta);
		appendFileSync(file, `${JSON.stringify(persistableSnapshot(snapshot))}\n`, "utf8");
	} catch {
		// Disk pressure or permissions; the live in-memory snapshot still serves the UI.
	}
}

export function getContextSnapshots(meta: SessionMeta): ContextSnapshot[] {
	try {
		const file = getSnapshotsFilePath(meta);
		if (!existsSync(file)) return [];
		const content = readFileSync(file, "utf8");
		const snapshots: ContextSnapshot[] = [];
		for (const line of content.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				snapshots.push(JSON.parse(line) as ContextSnapshot);
			} catch {
				// Skip a torn trailing line from an interrupted append.
			}
		}
		return snapshots;
	} catch {
		return [];
	}
}

export function getLatestContextSnapshot(meta: SessionMeta): ContextSnapshot | null {
	const list = getContextSnapshots(meta);
	return list.at(-1) ?? null;
}

export function buildSnapshotCategories(inputs: {
	systemPrompt?: string | undefined;
	promptSegments?: ReadonlyArray<{ id: string; tokenEstimate: number }> | undefined;
	tools?: ReadonlyArray<unknown> | undefined;
	messages?: ReadonlyArray<unknown> | undefined;
	effectiveContextWindow: number;
	compactionThreshold: number | null;
}) {
	const raw: {
		system: number;
		tools: number;
		agents: number;
		skills: number;
		memory: number;
		project: number;
		messages: number;
		[key: string]: number;
	} = {
		system: 0,
		tools: 0,
		agents: 0,
		skills: 0,
		memory: 0,
		project: 0,
		messages: 0,
	};

	if (inputs.promptSegments && inputs.promptSegments.length > 0) {
		for (const segment of inputs.promptSegments) {
			const cat = categoryForSegment(segment.id);
			raw[cat] = (raw[cat] ?? 0) + segment.tokenEstimate;
		}
	} else if (inputs.systemPrompt) {
		raw.system += ceilChars(inputs.systemPrompt.length);
	}

	if (inputs.tools) {
		for (const tool of inputs.tools) {
			raw.tools += ceilChars(toolSchemaChars(tool));
		}
	}

	if (inputs.messages) {
		for (const msg of inputs.messages) {
			raw.messages += estimateAgentMessageTokens(msg as MessageTokenEstimateInput);
		}
	}

	const decomposed = Object.keys(raw).reduce((sum, k) => sum + (raw[k] ?? 0), 0);
	const window = inputs.effectiveContextWindow;
	const threshold = inputs.compactionThreshold ?? 0.85;
	let reserve = 0;
	let free = 0;
	if (window > 0) {
		const remaining = Math.max(0, window - decomposed);
		reserve = Math.min(Math.round(window * (1 - threshold)), remaining);
		free = Math.max(0, window - decomposed - reserve);
	}

	return {
		system: raw.system,
		tools: raw.tools,
		agents: raw.agents,
		skills: raw.skills,
		memory: raw.memory,
		project: raw.project,
		messages: raw.messages,
		reserve,
		free,
		streaming: 0,
	};
}

export interface CaptureContextSnapshotInput {
	sessionId: string;
	turnId: string;
	providerId: string | null;
	runtimeId: string | null;
	modelId: string | null;
	systemPrompt?: string | undefined;
	promptSegments?: ReadonlyArray<{ id: string; tokenEstimate: number }> | undefined;
	conversationMessages: ReadonlyArray<unknown>;
	activeToolSchemas: ReadonlyArray<unknown>;
	pendingUserInput?: string | undefined;
	images?: ReadonlyArray<unknown> | undefined;
	desiredContextWindow: number;
	effectiveContextWindow: number;
	contextWindowSource: string;
	compactionThreshold: number | null;
	promptHash?: string | undefined;
	toolSignature?: string | undefined;
}

const SNAPSHOT_SPLIT_KEYS = ["system", "tools", "agents", "skills", "memory", "project", "messages"] as const;

function estimatedSplitSources(): Record<string, "estimated" | "exact" | "reconciled"> {
	const splits: Record<string, "estimated" | "exact" | "reconciled"> = {};
	for (const key of SNAPSHOT_SPLIT_KEYS) splits[key] = "estimated";
	return splits;
}

let snapshotCounter = 0;

function nextSnapshotId(): string {
	snapshotCounter += 1;
	return `snap-${Date.now()}-${snapshotCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Single assembly point for a turn's context snapshot. Every capture site
 * (turn submit, observation masking, LLM-summary compaction) feeds the same
 * inputs through the same category decomposition, so totals shown in the
 * footer, the overlay, and the persisted ledger cannot drift apart.
 */
export function captureContextSnapshot(input: CaptureContextSnapshotInput): ContextSnapshot {
	const categories = buildSnapshotCategories({
		systemPrompt: input.systemPrompt,
		promptSegments: input.promptSegments,
		tools: input.activeToolSchemas,
		messages: input.conversationMessages,
		effectiveContextWindow: input.effectiveContextWindow,
		compactionThreshold: input.compactionThreshold,
	});
	return {
		snapshotId: nextSnapshotId(),
		sessionId: input.sessionId,
		turnId: input.turnId,
		providerId: input.providerId,
		runtimeId: input.runtimeId,
		modelId: input.modelId,
		systemPrompt: input.systemPrompt,
		promptSegments: input.promptSegments ? [...input.promptSegments] : undefined,
		conversationMessages: [...input.conversationMessages],
		activeToolSchemas: [...input.activeToolSchemas],
		pendingUserInput: input.pendingUserInput,
		images: input.images ? [...input.images] : undefined,
		desiredContextWindow: input.desiredContextWindow,
		effectiveContextWindow: input.effectiveContextWindow,
		contextWindowSource: input.contextWindowSource,
		categories,
		sources: { total: "estimated", splits: estimatedSplitSources() },
		promptHash: input.promptHash,
		toolSignature: input.toolSignature,
		messageRange:
			input.conversationMessages.length > 0 ? { start: 0, end: input.conversationMessages.length - 1 } : undefined,
	};
}

/** Sum of the prompt-side categories (everything except reserve/free/streaming). */
export function snapshotInputTokens(snapshot: ContextSnapshot): number {
	return SNAPSHOT_SPLIT_KEYS.reduce((sum, key) => sum + (snapshot.categories[key] ?? 0), 0);
}

export function reconcileSnapshot(snapshot: ContextSnapshot, usage: Usage): ContextSnapshot {
	// Cached prompt tokens still occupy the context window; providers report
	// them outside `input`, so fold them back in to get the true prompt size.
	const exactInput = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
	const exactOutput = usage.output || 0;

	if (exactInput <= 0) {
		const updatedCategories = {
			...snapshot.categories,
			streaming: exactOutput,
		};
		const window = snapshot.effectiveContextWindow;
		const used = snapshotInputTokens(snapshot) + exactOutput;
		let reserve = snapshot.categories.reserve;
		let free = 0;
		if (window > 0) {
			const remaining = Math.max(0, window - used);
			reserve = Math.min(reserve, remaining);
			free = Math.max(0, window - used - reserve);
		}
		updatedCategories.reserve = reserve;
		updatedCategories.free = free;
		return {
			...snapshot,
			categories: updatedCategories,
			sources: {
				total: "estimated",
				splits: snapshot.sources.splits,
			},
		};
	}

	const keys = SNAPSHOT_SPLIT_KEYS;
	const currentCategories = { ...snapshot.categories };
	const sum = keys.reduce((s, k) => s + (currentCategories[k] ?? 0), 0);

	let normalized: Record<string, number>;
	if (sum === 0) {
		normalized = keys.reduce(
			(acc, k) => {
				acc[k] = k === "messages" ? exactInput : 0;
				return acc;
			},
			{} as Record<string, number>,
		);
	} else {
		normalized = {};
		let newSum = 0;
		for (const key of keys) {
			const val = currentCategories[key] ?? 0;
			const norm = Math.round((val / sum) * exactInput);
			normalized[key] = norm;
			newSum += norm;
		}
		const diff = exactInput - newSum;
		if (diff !== 0) {
			const largestKey = keys.reduce((a, b) => ((normalized[a] ?? 0) >= (normalized[b] ?? 0) ? a : b));
			normalized[largestKey] = (normalized[largestKey] ?? 0) + diff;
		}
	}

	const updatedCategories = {
		...snapshot.categories,
		...normalized,
		streaming: exactOutput,
	};

	const window = snapshot.effectiveContextWindow;
	const used = exactInput + exactOutput;
	let reserve = snapshot.categories.reserve;
	let free = 0;
	if (window > 0) {
		const remaining = Math.max(0, window - used);
		reserve = Math.min(reserve, remaining);
		free = Math.max(0, window - used - reserve);
	}
	updatedCategories.reserve = reserve;
	updatedCategories.free = free;

	const splitsSources = keys.reduce(
		(acc, k) => {
			acc[k] = "reconciled";
			return acc;
		},
		{} as Record<string, "estimated" | "exact" | "reconciled">,
	);

	return {
		...snapshot,
		categories: updatedCategories,
		sources: {
			total: "reconciled",
			splits: splitsSources,
		},
	};
}
