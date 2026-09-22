import { ceilChars } from "../session/context-accounting.js";
import { eligibleMemoryRecords } from "./operations.js";
import {
	type MemoryRelevanceInput,
	type PrecomputedMemoryCandidate,
	type PrecomputedMemoryRelevance,
	type RankedMemoryCandidate,
	rankMemoryByPrecomputedScore,
	rankMemoryByRelevance,
} from "./relevance.js";
import type {
	MemoryAgentIdentity,
	MemoryRecord,
	MemoryRepositoryIdentity,
	MemoryRuntimeIdentity,
	MemoryScope,
} from "./types.js";

export const MEMORY_PROMPT_DEFAULT_TOKEN_BUDGET = 400;
export const MEMORY_PROMPT_DEFAULT_MAX_ITEMS = 5;

/**
 * Default scopes considered for chat-loop memory injection. We deliberately
 * keep this conservative: `global` records are generally relevant and `repo`
 * records are considered only when they exactly match the active repository
 * identity. `language`, `runtime`, `agent`, `task-family`, and `hpc-domain`
 * need richer context that the chat-loop does not have at submit-time. Future
 * slices can broaden this list per call site.
 */
export const MEMORY_PROMPT_DEFAULT_SCOPES: ReadonlyArray<MemoryScope> = ["global", "repo"];

export interface MemoryPromptOptions {
	/** Explicit experiment only; omitted options preserve legacy priority. */
	relevance?: MemoryRelevanceInput;
	/**
	 * Scores resolved before the turn, applied on top of whatever order the
	 * lexical or legacy path produced. Selection stays synchronous, so a ranker
	 * that has to await anything belongs here rather than behind `relevance`.
	 */
	precomputedRelevance?: PrecomputedMemoryRelevance;
	scopes?: ReadonlyArray<MemoryScope>;
	tokenBudget?: number;
	maxItems?: number;
	/** Missing or unknown identity leaves global memory eligible but excludes repo memory. */
	activeRepository?: MemoryRepositoryIdentity | null;
	/** Missing or unknown identity excludes runtime-scoped memory. */
	activeRuntime?: MemoryRuntimeIdentity | null;
	/** Missing or unknown identity excludes agent-scoped memory. */
	activeAgent?: MemoryAgentIdentity | null;
}

/**
 * Filter approved, non-regressed, evidence-linked memory and cap by scope,
 * deterministic token budget, repository identity, and item count. Stable
 * ordering is guaranteed by `selectApprovedMemory`'s inner sort and the fixed
 * scope list. Repository identities match on exact canonical keys only.
 */
export function selectMemoryForPrompt(
	records: ReadonlyArray<MemoryRecord>,
	options: MemoryPromptOptions = {},
): MemoryRecord[] {
	return inspectMemoryPromptSelection(records, options).records;
}

export interface MemoryPromptDecision {
	id: string;
	reason: "selected" | "token-budget" | "item-limit";
	relevance?: Omit<RankedMemoryCandidate, "record">;
	/** Orthogonal to `relevance`: the two rankers can both run on one selection. */
	precomputed?: Omit<PrecomputedMemoryCandidate, "record">;
}

/** Diagnostics cover eligible candidates only: excluded records are never scored. */
export function inspectMemoryPromptSelection(
	records: ReadonlyArray<MemoryRecord>,
	options: MemoryPromptOptions = {},
): { records: MemoryRecord[]; decisions: MemoryPromptDecision[] } {
	const scopes = options.scopes ?? MEMORY_PROMPT_DEFAULT_SCOPES;
	const tokenBudget = options.tokenBudget ?? MEMORY_PROMPT_DEFAULT_TOKEN_BUDGET;
	const maxItems = options.maxItems ?? MEMORY_PROMPT_DEFAULT_MAX_ITEMS;
	if (!Number.isFinite(tokenBudget) || !Number.isFinite(maxItems) || tokenBudget <= 0 || maxItems < 1)
		return { records: [], decisions: [] };
	const eligibility = {
		scopes,
		activeRepository: options.activeRepository ?? null,
		activeRuntime: options.activeRuntime ?? null,
		activeAgent: options.activeAgent ?? null,
	};
	const base: LexicalCandidate[] =
		options.relevance === undefined
			? eligibleMemoryRecords(records, eligibility).map((record) => ({ record, relevance: undefined }))
			: rankMemoryByRelevance(records, eligibility, options.relevance).map(({ record, ...relevance }) => ({
					record,
					relevance,
				}));
	const candidates =
		options.precomputedRelevance === undefined
			? base.map((entry) => ({ ...entry, precomputed: undefined }))
			: withPrecomputedOrder(base, options.precomputedRelevance);
	const selected: MemoryRecord[] = [];
	const decisions: MemoryPromptDecision[] = [];
	for (const { record, relevance, precomputed } of candidates) {
		const reason =
			selected.length >= Math.floor(maxItems)
				? "item-limit"
				: ceilChars(renderMemoryPromptSection([...selected, record]).length) > tokenBudget
					? "token-budget"
					: "selected";
		decisions.push({
			id: record.id,
			reason,
			...(relevance === undefined ? {} : { relevance }),
			...(precomputed === undefined ? {} : { precomputed }),
		});
		if (reason === "selected") selected.push(record);
	}
	return { records: selected, decisions };
}

interface LexicalCandidate {
	record: MemoryRecord;
	relevance: Omit<RankedMemoryCandidate, "record"> | undefined;
}

/** Reorders the already-eligible list; eligibility is never revisited here. */
function withPrecomputedOrder(
	base: ReadonlyArray<LexicalCandidate>,
	input: PrecomputedMemoryRelevance,
): Array<LexicalCandidate & { precomputed: Omit<PrecomputedMemoryCandidate, "record"> }> {
	const lexicalById = new Map(base.map((entry) => [entry.record.id, entry.relevance]));
	const ranked = rankMemoryByPrecomputedScore(
		base.map((entry) => entry.record),
		input,
	);
	return ranked.map(({ record, ...precomputed }) => ({
		record,
		relevance: lexicalById.get(record.id),
		precomputed,
	}));
}

/**
 * Render a compact, deterministic memory section for prompt injection. Every
 * line cites evidence ids so the model can reason about provenance. Returns
 * the empty string when no records apply, so callers can treat the section as
 * absent.
 */
export function renderMemoryPromptSection(records: ReadonlyArray<MemoryRecord>): string {
	if (records.length === 0) return "";
	const lines: string[] = [
		"# Memory",
		"",
		"Approved long-term memory records that may apply. Each lesson is gated by human approval and cited evidence; do not extrapolate beyond the cited findings.",
		"",
	];
	for (const record of records) {
		const lesson = record.lesson.replace(/\s+/g, " ").trim();
		const evidence = record.evidenceRefs.join(", ");
		lines.push(`- [${record.id}] (${renderApplicability(record)}) ${lesson} Evidence: ${evidence}.`);
		if (record.appliesWhen.length > 0) lines.push(`  Applies when: ${record.appliesWhen.map(compactText).join("; ")}.`);
		if (record.avoidWhen.length > 0) lines.push(`  Avoid when: ${record.avoidWhen.map(compactText).join("; ")}.`);
	}
	return lines.join("\n");
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function renderApplicability(record: MemoryRecord): string {
	if (record.scope === "repo") {
		if (record.repository !== undefined) {
			return `scope=repo, repository=${JSON.stringify(`${record.repository.kind}:${record.repository.key}`)}`;
		}
		return "scope=repo, repository=unknown";
	}
	if (record.scope === "runtime") {
		return `scope=runtime, runtime=${JSON.stringify(record.runtime?.key ?? "unknown")}`;
	}
	if (record.scope === "agent") {
		return `scope=agent, agent=${JSON.stringify(record.agent?.key ?? "unknown")}`;
	}
	return `scope=${record.scope}`;
}

/** Convenience for callers that want a single end-to-end build step. */
export function buildMemoryPromptSection(
	records: ReadonlyArray<MemoryRecord>,
	options: MemoryPromptOptions = {},
): { section: string; records: MemoryRecord[]; tokens: number } {
	const selected = selectMemoryForPrompt(records, options);
	const section = renderMemoryPromptSection(selected);
	const tokens = ceilChars(section.length);
	return { section, records: selected, tokens };
}
