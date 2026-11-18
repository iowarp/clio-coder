/** Pure Pi message seed contract shared by the host and subprocess. No domain runtime or protected engine graph is loaded. */

import { createHash } from "node:crypto";
import type {
	WorkerContextProvenance,
	WorkerContextSeed,
	WorkerRecallLineage,
} from "../domains/context/worker/contract.js";
import type { AgentMessage } from "../engine/types.js";
import { canonicalJson } from "./protocol.js";

export const WORKER_CONTEXT_MAX_BYTES = 512 * 1024;

const RECALL_ALIAS = /^r[1-9]\d*$/u;
/** The fixed opening of a working-set marker (`src/domains/context/working-set/marker.ts`), aliased form only. */
const MARKER_OPENING = /\[evicted ref=(r[1-9]\d*) /gu;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWorkerContextProvenance(value: unknown): WorkerContextProvenance {
	const fail = (): never => {
		throw new Error("worker context: malformed provenance");
	};
	if (!record(value)) return fail();
	const p = value;
	const fields = [
		"version",
		"mode",
		"source",
		"snapshotHash",
		"contentHash",
		"messageCount",
		"estimatedTokens",
		"bytes",
		"omittedMessages",
		"excludedTailMessages",
		"excludedInterruptedMessages",
		"selectedRefs",
		"recallAliasFloor",
		"inheritedMarkers",
	];
	if (Object.keys(p).some((key) => !fields.includes(key))) fail();
	if (p.version !== 1 || (p.mode !== "fork" && p.mode !== "splice") || !record(p.source)) fail();
	const source = p.source as Record<string, unknown>;
	if (Object.keys(source).some((key) => !["sessionId", "leafTurnId", "cwd"].includes(key))) fail();
	if (
		typeof source.sessionId !== "string" ||
		!source.sessionId ||
		typeof source.cwd !== "string" ||
		!source.cwd ||
		(source.leafTurnId !== null && typeof source.leafTurnId !== "string")
	)
		fail();
	for (const key of ["snapshotHash", "contentHash"] as const)
		if (typeof p[key] !== "string" || !/^[a-f0-9]{64}$/u.test(p[key])) fail();
	for (const key of [
		"messageCount",
		"estimatedTokens",
		"bytes",
		"omittedMessages",
		"excludedTailMessages",
		"excludedInterruptedMessages",
	])
		if (!Number.isSafeInteger(p[key]) || (p[key] as number) < 0) fail();
	if (
		!Array.isArray(p.selectedRefs) ||
		p.selectedRefs.some((ref) => typeof ref !== "string" || !/^(tool:.+|message:[0-9]+)$/u.test(ref)) ||
		new Set(p.selectedRefs).size !== p.selectedRefs.length
	)
		fail();
	if (
		p.recallAliasFloor !== undefined &&
		(!Number.isSafeInteger(p.recallAliasFloor) || (p.recallAliasFloor as number) < 0)
	)
		fail();
	if (p.inheritedMarkers !== undefined) {
		const floor = p.recallAliasFloor;
		if (
			typeof floor !== "number" ||
			!Array.isArray(p.inheritedMarkers) ||
			p.inheritedMarkers.some(
				(marker) =>
					!record(marker) ||
					Object.keys(marker).some((key) => key !== "alias" && key !== "ref") ||
					typeof marker.alias !== "string" ||
					!RECALL_ALIAS.test(marker.alias) ||
					Number(marker.alias.slice(1)) > floor ||
					typeof marker.ref !== "string" ||
					!marker.ref ||
					marker.ref.length > 512,
			) ||
			new Set(p.inheritedMarkers.map((marker) => (marker as { alias: string }).alias)).size !== p.inheritedMarkers.length
		)
			fail();
	}
	return structuredClone(p) as unknown as WorkerContextProvenance;
}

/** Validate at both host admission and the worker wire boundary before any model invocation. */
export function parseWorkerContextSeed(value: unknown): WorkerContextSeed {
	const fail = (): never => {
		throw new Error("worker context: malformed or digest-mismatched seed");
	};
	if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > WORKER_CONTEXT_MAX_BYTES) fail();
	if (!record(value) || !record(value.provenance) || !Array.isArray(value.messages)) return fail();
	const p = parseWorkerContextProvenance(value.provenance);
	for (const message of value.messages) {
		if (
			!record(message) ||
			!["user", "assistant", "toolResult"].includes(String(message.role)) ||
			!Number.isFinite(message.timestamp)
		)
			fail();
		if (message.role === "user" && typeof message.content === "string") continue;
		if (!Array.isArray(message.content)) return fail();
		for (const block of message.content) {
			if (!record(block)) return fail();
			switch (block.type) {
				case "text":
					if (typeof block.text !== "string") fail();
					break;
				case "thinking":
					if (message.role !== "assistant" || typeof block.thinking !== "string") fail();
					break;
				case "image":
					if (message.role === "assistant" || typeof block.data !== "string" || typeof block.mimeType !== "string") fail();
					break;
				case "toolCall":
					if (
						message.role !== "assistant" ||
						typeof block.id !== "string" ||
						typeof block.name !== "string" ||
						!record(block.arguments)
					)
						fail();
					break;
				default:
					fail();
			}
		}
		if (
			message.role === "toolResult" &&
			(typeof message.toolCallId !== "string" ||
				typeof message.toolName !== "string" ||
				typeof message.isError !== "boolean")
		)
			fail();
		if (message.role === "assistant") {
			if (!["stop", "length", "toolUse"].includes(String(message.stopReason))) fail();
			if (
				(message.api !== undefined && typeof message.api !== "string") ||
				(message.provider !== undefined && typeof message.provider !== "string") ||
				(message.model !== undefined && typeof message.model !== "string") ||
				(message.usage !== undefined && !record(message.usage))
			)
				return fail();
			if (record(message.usage)) {
				for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
					if (
						message.usage[field] !== undefined &&
						(typeof message.usage[field] !== "number" || !Number.isFinite(message.usage[field]) || message.usage[field] < 0)
					)
						fail();
			}
		}
	}
	const seed = value as unknown as WorkerContextSeed;
	completeHistoryLength(seed.messages);
	if (p.mode === "splice" && (seed.messages.length !== 1 || seed.messages[0]?.role !== "user")) fail();
	const { contentHash: digest, ...identity } = seed.provenance;
	if (
		contextHash({ ...identity, messages: seed.messages }) !== digest ||
		p.messageCount !== seed.messages.length ||
		p.bytes !== Buffer.byteLength(JSON.stringify(seed.messages), "utf8")
	)
		fail();
	return structuredClone(seed);
}

/** The markers whose rendered opening the messages still carry. */
export function carriedMarkers<T extends { alias: string }>(
	markers: ReadonlyArray<T>,
	messages: ReadonlyArray<AgentMessage>,
): T[] {
	if (markers.length === 0) return [];
	const text = JSON.stringify(messages);
	return markers.filter((marker) => text.includes(`[evicted ref=${marker.alias} `));
}

/**
 * The seed's recall aliases as the worker reads them. A seed from before the provenance fields names neither: the
 * floor is then the largest alias its text carries in a marker opening, and those markers are the inherited ones.
 */
export function seedRecallLineage(seed: WorkerContextSeed | undefined): WorkerRecallLineage {
	if (seed === undefined) return { aliasFloor: 0, inheritedMarkers: [] };
	const { provenance, messages } = parseWorkerContextSeed(seed);
	if (provenance.recallAliasFloor !== undefined)
		return { aliasFloor: provenance.recallAliasFloor, inheritedMarkers: provenance.inheritedMarkers ?? [] };
	const aliases = [
		...new Set([...JSON.stringify(messages).matchAll(MARKER_OPENING)].map((match) => match[1] as string)),
	];
	return {
		aliasFloor: aliases.reduce((max, alias) => Math.max(max, Number(alias.slice(1))), 0),
		inheritedMarkers: aliases.map((alias) => ({ alias })),
	};
}

export function seededWorkerMessages(seed: WorkerContextSeed | undefined): AgentMessage[] {
	if (seed === undefined) return [];
	const parsed = parseWorkerContextSeed(seed);
	return parsed.provenance.mode === "fork" ? parsed.messages : [];
}

export function contextHash(value: unknown): string {
	return createHash("sha256")
		.update(`clio-coder.worker-context:1:${canonicalJson(value)}`)
		.digest("hex");
}

export function messageToolCalls(
	message: AgentMessage,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	if (message.role !== "assistant") return [];
	return message.content.filter((block) => block.type === "toolCall");
}

/** Validate complete batches. Only a final unfinished batch can be cut at capture. */
export function completeHistoryLength(messages: ReadonlyArray<AgentMessage>, allowPendingTail = false): number {
	let batchStart = -1;
	const pending = new Set<string>();
	const seen = new Set<string>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("worker context: orphaned or duplicate tool result");
			continue;
		}
		if (pending.size > 0) throw new Error("worker context: incomplete historical tool batch");
		if (message.role !== "user" && message.role !== "assistant")
			throw new Error("worker context: unsupported message role");
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))
			throw new Error("worker context: interrupted assistant message cannot seed a worker");
		const calls = messageToolCalls(message);
		if (calls.length > 0) batchStart = index;
		for (const call of calls) {
			if (!call.id || seen.has(call.id)) throw new Error("worker context: duplicate or empty tool call id");
			seen.add(call.id);
			pending.add(call.id);
		}
	}
	if (pending.size === 0) return messages.length;
	if (allowPendingTail) return batchStart;
	throw new Error("worker context: seed contains an unfinished tool batch");
}
