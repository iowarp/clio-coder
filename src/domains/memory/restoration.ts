import { ceilChars } from "../session/context-accounting.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "./task-bank.js";

export interface MemoryRestorationInput {
	readonly bank: {
		readonly version: TaskMemorySnapshot["version"];
		readonly status: Readonly<TaskMemoryEntry> | null;
		readonly knowledge: readonly Readonly<TaskMemoryEntry>[];
		readonly procedural: readonly Readonly<TaskMemoryEntry>[];
	};
	/** Already admitted current state. Only nonblank text suppresses historical status; it is never recopied. */
	readonly currentState: { readonly kind: "handoff" | "summary"; readonly text: string } | null;
	readonly maxTokens: number;
}

export interface MemoryRestorationRender {
	readonly message: string;
	readonly tokens: number;
	readonly citedEntryIds: readonly string[];
	readonly omittedEntryIds: readonly string[];
}

const PREFIX = "Memory: remembered execution context (unverified; current instructions take precedence).\n";

/**
 * Pure conservative renderer. lastTouchedAt is only a recency/usage heuristic,
 * never verification. Equal whitespace-normalized content shares one rendered
 * row with all source IDs; near duplicates remain distinct. Knowledge and
 * procedure have equal access in recency order, with ID as the stable tie.
 * Nothing is deleted, marked injected, promoted, or inferred to be current.
 */
export function renderMemoryRestoration(input: MemoryRestorationInput): MemoryRestorationRender {
	const hasCurrentState = input.currentState !== null && input.currentState.text.trim().length > 0;
	const source = [
		...(!hasCurrentState && input.bank.status !== null ? [input.bank.status] : []),
		...input.bank.knowledge,
		...input.bank.procedural,
	].sort((a, b) => {
		const status = Number(b.kind === "status") - Number(a.kind === "status");
		return status || b.lastTouchedAt.localeCompare(a.lastTouchedAt) || a.id.localeCompare(b.id);
	});
	const groups = new Map<string, { ids: string[]; kinds: Set<TaskMemoryEntry["kind"]>; content: string }>();
	for (const entry of source) {
		const content = entry.content.replace(/\s+/gu, " ").trim();
		const group = groups.get(content);
		if (group) {
			if (!group.ids.includes(entry.id)) group.ids.push(entry.id);
			group.kinds.add(entry.kind);
		} else groups.set(content, { ids: [entry.id], kinds: new Set([entry.kind]), content: entry.content });
	}
	const lines: string[] = [];
	const cited: string[] = [];
	const omitted = hasCurrentState && input.bank.status !== null ? [input.bank.status.id] : [];
	const validBudget = Number.isFinite(input.maxTokens) && input.maxTokens > 0;
	for (const [content, group] of groups) {
		const kinds = [...group.kinds]
			.sort()
			.map((kind) => (kind === "status" ? "historical status" : `remembered ${kind}`))
			.join("/");
		// Quote the chosen source losslessly, including its original whitespace.
		// Normalization above is only the dedup key, never a rewrite of evidence.
		const line = `- ${group.ids.map((id) => `[${id}]`).join(" ")} ${kinds}: ${JSON.stringify(group.content)}`;
		const candidate = PREFIX + [...lines, line].join("\n");
		if (!validBudget || content.length === 0 || ceilChars(candidate.length) > input.maxTokens) {
			omitted.push(...group.ids);
			continue;
		}
		lines.push(line);
		cited.push(...group.ids);
	}
	const message = lines.length > 0 ? PREFIX + lines.join("\n") : "";
	return Object.freeze({
		message,
		tokens: ceilChars(message.length),
		citedEntryIds: Object.freeze(cited),
		omittedEntryIds: Object.freeze(omitted),
	});
}
