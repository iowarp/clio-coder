import { createHash } from "node:crypto";
import { gatewayChainReceipts } from "../../tools/surface.js";
import type { ObservationSourceUnit } from "../memory/index.js";
import type { SessionEntry } from "./entries.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Session supplies immutable source bytes; no memory policy or destructive cut here. */
export function observationSourceUnits(entries: readonly SessionEntry[]): ObservationSourceUnit[] {
	const units: ObservationSourceUnit[] = [];
	let captured: { entry: SessionEntry; material: unknown }[] = [];
	let pending = new Set<string>();
	let calls = new Set<string>();
	let successes: string[] = [];
	let parts: { ref: string; toolCallId: string }[] = [];
	let complete = true;
	const flush = () => {
		if (!captured.length) return;
		const text = JSON.stringify(
			captured.map(({ entry, material }) => ({
				ref: entry.turnId,
				kind: entry.kind,
				...(entry.kind === "message" ? { role: entry.role } : {}),
				material,
			})),
		);
		units.push({
			refs: captured.map(({ entry }) => entry.turnId),
			text,
			digest: digest(text),
			exact: captured.flatMap(({ entry }) => {
				if (entry.kind !== "message" || entry.role !== "user") return [];
				const payload = object(entry.payload);
				const text =
					typeof payload.operatorText === "string"
						? payload.operatorText
						: typeof payload.text === "string"
							? payload.text
							: typeof entry.payload === "string"
								? entry.payload
								: null;
				return text === null ? [] : [{ ref: entry.turnId, text }];
			}),
			toolCallIds: [...calls],
			...(parts.length ? { parts } : {}),
			successfulResultRefs: successes,
			complete: complete && pending.size === 0,
		});
		captured = [];
		pending = new Set();
		calls = new Set();
		successes = [];
		parts = [];
		complete = true;
	};
	for (const entry of entries) {
		if (entry.kind === "compactionSummary") {
			flush();
			continue;
		}
		if (entry.kind === "bashExecution" && entry.excludeFromContext) continue;
		if (
			entry.kind !== "message" &&
			entry.kind !== "bashExecution" &&
			entry.kind !== "branchSummary" &&
			entry.kind !== "skillActivation"
		)
			continue;
		const payload = entry.kind === "message" ? object(entry.payload) : {};
		if (
			entry.kind === "message" &&
			(entry.role === "user" || entry.role === "assistant") &&
			pending.size > 0 &&
			(entry.role === "user" ||
				!Array.isArray(payload.content) ||
				!payload.content.some((block) => object(block).type === "toolCall"))
		)
			flush();
		if (
			(Array.isArray(payload.images) && payload.images.length) ||
			(Array.isArray(payload.attachments) && payload.attachments.length)
		)
			complete = false;
		let material: unknown = entry;
		if (entry.kind === "message") {
			if (entry.role === "checkpoint") continue;
			if (entry.role === "assistant") {
				const content = Array.isArray(payload.content)
					? payload.content.filter((block) => object(block).type !== "thinking")
					: [];
				material = { ...(typeof payload.text === "string" ? { text: payload.text } : {}), content };
				for (const block of content) {
					const call = object(block);
					if (call.type === "toolCall") {
						if (typeof call.id !== "string") complete = false;
						else {
							calls.add(call.id);
							pending.add(call.id);
						}
					} else if (call.type !== "text") complete = false;
				}
			} else if (entry.role === "tool_call") {
				material = { toolCallId: payload.toolCallId, name: payload.name, args: payload.args };
				if (typeof payload.toolCallId !== "string") complete = false;
				else {
					calls.add(payload.toolCallId);
					pending.add(payload.toolCallId);
				}
			} else if (entry.role === "tool_result") {
				material = {
					toolCallId: payload.toolCallId,
					toolName: payload.toolName,
					result: payload.result,
					isError: payload.isError,
					outcome: payload.outcome,
				};
				if (typeof payload.toolCallId !== "string" || !pending.delete(payload.toolCallId)) complete = false;
				const result = object(payload.result);
				const details = object(result.details);
				const children = gatewayChainReceipts(String(payload.toolName ?? ""), result);
				for (const child of children) {
					const ref = `${entry.turnId}#step:${child.id}`;
					const callId = `${payload.toolCallId}:${child.id}`;
					parts.push({ ref, toolCallId: callId });
					calls.add(callId);
					const childDetails = object(child.result.details);
					if (
						child.admission.outcome === "ok" &&
						child.admission.decision === "allowed" &&
						childDetails.kind === "ok" &&
						(childDetails.exitCode === undefined || childDetails.exitCode === 0)
					)
						successes.push(ref);
					if (
						child.truncated === true ||
						childDetails.truncated === true ||
						object(childDetails.observation).truncated === true
					)
						complete = false;
				}
				if (children.length)
					material = { ...object(material), parts: parts.filter((part) => part.ref.startsWith(`${entry.turnId}#step:`)) };
				if (
					!children.length &&
					payload.outcome === "ok" &&
					payload.isError !== true &&
					result.isError !== true &&
					(details.kind === undefined || details.kind === "ok") &&
					(details.outcome === undefined || details.outcome === "success") &&
					(details.exitCode === undefined || details.exitCode === 0)
				)
					successes.push(entry.turnId);
				if (
					result.truncated === true ||
					details.truncated === true ||
					details.modelTruncated === true ||
					object(details.observation).truncated === true
				)
					complete = false;
				if (Array.isArray(result.content) && result.content.some((block) => object(block).type !== "text"))
					complete = false;
			} else {
				material =
					typeof entry.payload === "string"
						? { text: entry.payload }
						: {
								text: payload.text,
								operatorText: payload.operatorText,
								content: payload.content,
							};
				if (Array.isArray(payload.content) && payload.content.some((block) => object(block).type !== "text"))
					complete = false;
			}
		}
		if (entry.kind === "skillActivation" || entry.kind === "branchSummary") complete = false;
		if (entry.kind === "bashExecution" && (entry.cancelled || entry.truncated)) complete = false;
		captured.push({ entry, material });
		if (pending.size === 0) flush();
	}
	flush();
	return units;
}

export function observationCheckpoint(entries: readonly SessionEntry[]): { id: string; digest: string } | null {
	const entry = [...entries].reverse().find((entry) => entry.kind === "compactionSummary");
	return entry?.kind === "compactionSummary" ? { id: entry.turnId, digest: digest(entry.summary) } : null;
}
