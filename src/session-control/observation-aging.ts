/**
 * Observation aging: the outgoing request drops a tool result the model has
 * already replaced with a fresh copy.
 *
 * A result is aged only when it is superseded: a later call with the same
 * effective tool and canonical arguments (the loop guard's call identity,
 * gateway calls unwrapped) completed ok later in the same request. Age alone
 * never ages anything, and the session ledger keeps every byte; only the copy
 * the provider is about to read changes.
 *
 * This is the maintainer-approved exception to the rule against eager
 * per-round eviction, which raised reprocessed cached bytes 59%. It holds
 * because it is superseded-only, batched and gated: stubs land in one batch
 * once enough superseded bytes accumulate, a stubbed result stays stubbed in
 * every later request so the prefix breaks once per batch, and the gate admits
 * only small-tier routes and routes that do not cache prompts. Cached standard
 * and frontier routes never see it. Wired as the agent's `transformContext`
 * in turn-runtime.ts, the one point every outgoing main-session request
 * passes through, prewarm and provider-replay rebuilds included.
 */

import type { ModelTier } from "../core/model-tier.js";
import { effectiveCallIdentity } from "../engine/loop-guard.js";
import type { AgentMessage } from "../engine/types.js";
import { effectiveToolCall } from "../tools/surface.js";

/**
 * Superseded bytes that must be waiting before a batch is stubbed. Each batch
 * changes an earlier message, so a local server that reuses its KV prefix
 * reprocesses everything after the first stub once; 32 KiB (about 8k tokens)
 * makes every break buy back at least that much on every later call of the
 * turn. One superseded WTF-P `read_record` (about 50 KB) crosses it alone,
 * while a run of small repeated reads waits until together they are worth a
 * break.
 */
export const OBSERVATION_AGING_BATCH_BYTES = 32 * 1024;

/** Longest rendering of a call's arguments a stub carries. */
const STUB_ARGS_CHARS = 160;

/** The route facts the gate reads (C1 metadata on the runtime resolution). */
export interface ObservationAgingRoute {
	modelTier?: ModelTier;
	promptCaching?: boolean;
}

/** Aging runs only for a small model or a route that does not cache prompts. */
export function observationAgingApplies(route: ObservationAgingRoute): boolean {
	return route.modelTier === "small" || route.promptCaching === false;
}

export interface ObservationAgingBatch {
	/** Results this batch stubbed. */
	results: number;
	/** Bytes of result text the batch removed, less the stubs that replaced it. */
	bytesSaved: number;
}

export interface ObservationAgingResult {
	messages: AgentMessage[];
	/** Every tool call id stubbed so far, this batch included. */
	stubbed: ReadonlySet<string>;
	batch: ObservationAgingBatch | null;
}

interface ToolCallFacts {
	identity: string;
	tool: string;
	args: string;
}

interface SupersededResult {
	index: number;
	bytes: number;
	stub: string;
}

type ToolResultView = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	isError?: boolean;
	content?: unknown;
	details?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asToolResult(message: AgentMessage): ToolResultView | null {
	const record = message as unknown as Record<string, unknown>;
	if (record.role !== "toolResult" || typeof record.toolCallId !== "string") return null;
	return record as unknown as ToolResultView;
}

function textBytes(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let bytes = 0;
	for (const block of content)
		if (isRecord(block) && block.type === "text" && typeof block.text === "string")
			bytes += Buffer.byteLength(block.text, "utf8");
	return bytes;
}

/** A working-set marker stands in for a result no longer in context, so it supersedes nothing. */
function isHostMarker(result: ToolResultView): boolean {
	const details = isRecord(result.details) ? result.details : null;
	return isRecord(details?.workingSet) && details.workingSet.evicted === true;
}

function renderArgs(args: Record<string, unknown> | undefined): string {
	let text: string;
	try {
		text = JSON.stringify(args ?? {}) ?? "{}";
	} catch {
		text = "{}";
	}
	return text.length <= STUB_ARGS_CHARS ? text : `${text.slice(0, STUB_ARGS_CHARS - 3)}...`;
}

function callFacts(messages: ReadonlyArray<AgentMessage>): Map<string, ToolCallFacts> {
	const calls = new Map<string, ToolCallFacts>();
	for (const message of messages) {
		const record = message as unknown as Record<string, unknown>;
		if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
		for (const block of record.content) {
			if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
			const name = typeof block.name === "string" ? block.name : "";
			if (name.length === 0) continue;
			const effective = effectiveToolCall(name, block.arguments);
			calls.set(block.id, {
				identity: effectiveCallIdentity(name, block.arguments),
				tool: effective.toolName,
				args: renderArgs(effective.args),
			});
		}
	}
	return calls;
}

/** The one-line stand-in for a superseded result; deterministic so every request sends the same bytes. */
function agingStub(call: ToolCallFacts, bytes: number): string {
	return (
		`[observation aged] ${call.tool} ${call.args} returned ${bytes} bytes here. A later call with the same ` +
		`arguments succeeded and its result is already in context below; call ${call.tool} again with these ` +
		"arguments if you need a fresh copy."
	);
}

/** Results a later identical call superseded, by tool call id, newest-first walk. */
function supersededResults(messages: ReadonlyArray<AgentMessage>): Map<string, SupersededResult> {
	const calls = callFacts(messages);
	const refreshed = new Set<string>();
	const superseded = new Map<string, SupersededResult>();
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const result = message ? asToolResult(message) : null;
		if (result === null) continue;
		const call = calls.get(result.toolCallId);
		if (call === undefined) continue;
		if (refreshed.has(call.identity) && !isHostMarker(result)) {
			const bytes = textBytes(result.content);
			const stub = agingStub(call, bytes);
			if (bytes > Buffer.byteLength(stub, "utf8")) superseded.set(result.toolCallId, { index, bytes, stub });
		}
		if (result.isError !== true && !isHostMarker(result)) refreshed.add(call.identity);
	}
	return superseded;
}

/**
 * Project one outgoing request. Pure: `stubbed` is what earlier requests
 * already stubbed, and the result names the new set. A batch forms only when
 * the superseded bytes not yet stubbed reach `thresholdBytes`; a result
 * stubbed earlier is stubbed again whenever it is still superseded, which on
 * one branch is every later request.
 */
export function ageObservations(
	messages: ReadonlyArray<AgentMessage>,
	stubbed: ReadonlySet<string>,
	thresholdBytes: number = OBSERVATION_AGING_BATCH_BYTES,
): ObservationAgingResult {
	const superseded = supersededResults(messages);
	let pendingBytes = 0;
	for (const [id, result] of superseded) if (!stubbed.has(id)) pendingBytes += result.bytes;
	let batch: ObservationAgingBatch | null = null;
	let next = stubbed;
	if (pendingBytes > 0 && pendingBytes >= thresholdBytes) {
		const grown = new Set(stubbed);
		batch = { results: 0, bytesSaved: 0 };
		for (const [id, result] of superseded) {
			if (grown.has(id)) continue;
			grown.add(id);
			batch.results += 1;
			batch.bytesSaved += result.bytes - Buffer.byteLength(result.stub, "utf8");
		}
		next = grown;
	}
	const applied = [...superseded].filter(([id]) => next.has(id));
	if (applied.length === 0) return { messages: [...messages], stubbed: next, batch };
	const out = [...messages];
	for (const [, result] of applied) {
		const message = out[result.index];
		if (message === undefined) continue;
		out[result.index] = { ...message, content: [{ type: "text", text: result.stub }] } as AgentMessage;
	}
	return { messages: out, stubbed: next, batch };
}

/**
 * The stateful half: remembers what earlier requests stubbed so a result,
 * once stubbed, stays stubbed. One per agent runtime.
 */
export function createObservationAging(thresholdBytes: number = OBSERVATION_AGING_BATCH_BYTES): {
	project(
		messages: ReadonlyArray<AgentMessage>,
		route: ObservationAgingRoute,
	): { messages: AgentMessage[]; batch: ObservationAgingBatch | null };
} {
	let stubbed: ReadonlySet<string> = new Set();
	return {
		project(messages, route) {
			if (!observationAgingApplies(route)) return { messages: [...messages], batch: null };
			const aged = ageObservations(messages, stubbed, thresholdBytes);
			stubbed = aged.stubbed;
			return { messages: aged.messages, batch: aged.batch };
		},
	};
}
