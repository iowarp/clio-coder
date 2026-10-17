import { createHash } from "node:crypto";
import { gatewayChainReceipts } from "../../tools/surface.js";
import type { ObservationSourceUnit } from "../memory/index.js";
import { serializeConversation } from "./compaction/branch-summary.js";
import type { SessionEntry } from "./entries.js";
import { payloadObject, projectMessage } from "./message-projection.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => payloadObject(value) ?? {};

/**
 * Session supplies immutable source bytes; no memory policy or destructive cut
 * here. Every message goes through the canonical reasoning-free projection, so
 * a supported payload shape keeps its exact meaning and an unsupported one
 * marks its unit incomplete instead of claiming coverage it cannot back.
 */
export function observationSourceUnits(entries: readonly SessionEntry[]): ObservationSourceUnit[] {
	const units: ObservationSourceUnit[] = [];
	let captured: { entry: SessionEntry; material: unknown; exact: string | null }[] = [];
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
			exact: captured.flatMap(({ entry, exact }) => (exact === null ? [] : [{ ref: entry.turnId, text: exact }])),
			toolCallIds: [...calls],
			...(parts.length ? { parts } : {}),
			successfulResultRefs: successes,
			complete: complete && pending.size === 0,
			// What ordinary compaction would spend on the same entries; a prepared
			// observation is worth requesting only if it can be smaller than this.
			ordinaryTokens: Math.ceil(serializeConversation(captured.map(({ entry }) => entry)).length / 4),
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
		if (entry.kind !== "message") {
			// Skill and branch context is protected elsewhere and never observation-covered.
			if (entry.kind === "skillActivation" || entry.kind === "branchSummary") complete = false;
			if (entry.kind === "bashExecution" && (entry.cancelled || entry.truncated)) complete = false;
			captured.push({ entry, material: entry, exact: null });
			if (pending.size === 0) flush();
			continue;
		}
		const projection = projectMessage(entry);
		if (projection === null) continue;
		const payload = object(entry.payload);
		if (
			(entry.role === "user" || entry.role === "assistant") &&
			pending.size > 0 &&
			(entry.role === "user" || projection.calls.length === 0)
		)
			flush();
		if (!projection.complete) complete = false;
		for (const call of projection.calls) {
			calls.add(call);
			pending.add(call);
		}
		let material: unknown = projection.material;
		if (entry.role === "tool_result") {
			if (projection.resolves === null || !pending.delete(projection.resolves)) complete = false;
			const result = object(object(projection.material).result);
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
					(childDetails.outcome === undefined || childDetails.outcome === "success") &&
					(childDetails.exitCode === undefined || childDetails.exitCode === 0)
				)
					successes.push(ref);
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
			// A tool that bounded its own output (a ranged or capped read, bounded
			// shell output) still gave the actor exactly this text, and the ledger
			// holds that text: the unit is complete as the actor saw it. Coverage
			// means the source was supplied, not that the tool showed a whole file.
		}
		captured.push({ entry, material, exact: projection.exact });
		if (pending.size === 0) flush();
	}
	flush();
	return units;
}

export function observationCheckpoint(entries: readonly SessionEntry[]): { id: string; digest: string } | null {
	const entry = [...entries].reverse().find((entry) => entry.kind === "compactionSummary");
	return entry?.kind === "compactionSummary" ? { id: entry.turnId, digest: digest(entry.summary) } : null;
}
