/**
 * Agent ledger reducers: conflict detection, corroboration, disputes, and the
 * bounded plain-text render.
 *
 * Pure functions, no I/O. The agent ledger is the coordination surface
 * concurrent dispatch workers share; this module decides what the board means,
 * and src/domains/dispatch/agent-ledger-store.ts decides what it stores.
 *
 * The render never emits a count, a score, or a consensus line. A single-author
 * finding is the one a merged summary drops, and it is exactly the one a
 * hidden-profile task turns on, so an uncorroborated finding is labeled and
 * left standing on its own rather than folded into a majority view.
 */

import { isAbsolute, relative } from "node:path";
import type { AgentLedgerBody, AgentLedgerEntry } from "../../worker/protocol.js";

/**
 * Ceiling on a rendered board wherever one is handed to a model: a worker's
 * spawn-time prompt and the board the main model reads back off a settled
 * dispatch. Oldest entries drop whole, so a worker that never calls the tool
 * still starts knowing what its peers staked.
 */
export const AGENT_LEDGER_PROMPT_MAX_CHARS = 4000;

/** Corroboration vocabulary, matching src/domains/agents/builtins/scout.md. */
export type CorroborationState = "corroborated" | "uncorroborated" | "ungrounded lead";

function normalizeScopePrefix(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

/** True when two path prefixes overlap in either direction. */
function prefixesOverlap(left: string, right: string): boolean {
	const a = normalizeScopePrefix(left);
	const b = normalizeScopePrefix(right);
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Entry ids of live peer claims whose scope overlaps this claim's. Advisory and
 * visible; it blocks nothing. The scheduler's per-wave write-boundary refusal
 * is what actually stops two writers from touching one path.
 *
 * Claims from the same run never conflict: one run staking two overlapping
 * scopes is refining its own work, not colliding with a peer.
 */
export function claimConflicts(
	body: AgentLedgerBody,
	live: ReadonlyArray<AgentLedgerEntry>,
	runId?: string,
): ReadonlyArray<string> {
	if (body.kind !== "claim") return [];
	const conflicts: string[] = [];
	for (const entry of live) {
		if (entry.body.kind !== "claim") continue;
		if (runId !== undefined && entry.runId === runId) continue;
		const overlaps = entry.body.scope.some((peerScope) =>
			body.scope.some((newScope) => prefixesOverlap(newScope, peerScope)),
		);
		if (overlaps) conflicts.push(entry.id);
	}
	return conflicts;
}

export interface CorroborationReport {
	/** Corroboration state per entry id, for findings only. */
	byEntryId: ReadonlyMap<string, CorroborationState>;
	/** Distinct run ids that cited each corroborated path, in first-seen order. */
	byPath: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Workspace-relative form of a cited path, so two runs naming one file agree.
 * `./src/a.ts`, `src//a.ts`, and the absolute path under the orchestrator's
 * workspace all key as `src/a.ts`. A path outside the workspace keeps the form
 * its author cited, which is the only form anything else can resolve.
 *
 * The orchestrator cwd is the workspace root; it is read here and nowhere else
 * in this module.
 */
function citedPathKey(path: string): string {
	const trimmed = path.trim();
	if (trimmed.length === 0) return trimmed;
	const absolute = isAbsolute(trimmed);
	const candidate = absolute ? relative(process.cwd(), trimmed) : trimmed;
	if (absolute && (candidate.length === 0 || candidate.startsWith(".."))) return trimmed;
	const normalized = candidate
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".")
		.join("/");
	return normalized.length === 0 ? trimmed : normalized;
}

/**
 * Group findings by cited path. A path cited by two or more distinct runs is
 * corroborated; a path cited by one is uncorroborated; a finding that carries
 * no citation is an ungrounded lead.
 */
export function corroboration(entries: ReadonlyArray<AgentLedgerEntry>): CorroborationReport {
	const runsByPath = new Map<string, string[]>();
	for (const entry of entries) {
		if (entry.body.kind !== "finding") continue;
		const path = entry.body.path === undefined ? undefined : citedPathKey(entry.body.path);
		if (path === undefined) continue;
		const runs = runsByPath.get(path) ?? [];
		if (!runs.includes(entry.runId)) runs.push(entry.runId);
		runsByPath.set(path, runs);
	}
	const byEntryId = new Map<string, CorroborationState>();
	for (const entry of entries) {
		if (entry.body.kind !== "finding") continue;
		const path = entry.body.path;
		if (path === undefined) {
			byEntryId.set(entry.id, "ungrounded lead");
			continue;
		}
		const runs = runsByPath.get(citedPathKey(path)) ?? [];
		byEntryId.set(entry.id, runs.length >= 2 ? "corroborated" : "uncorroborated");
	}
	return { byEntryId, byPath: runsByPath };
}

/** Entry ids targeted by a review that did not pass. */
export function disputes(entries: ReadonlyArray<AgentLedgerEntry>): ReadonlySet<string> {
	const disputed = new Set<string>();
	for (const entry of entries) {
		if (entry.body.kind === "review" && !entry.body.passed) disputed.add(entry.body.target);
	}
	return disputed;
}

export interface RenderAgentLedgerOptions {
	/**
	 * Character ceiling for the rendered board. Oldest entries are dropped whole
	 * so no entry is ever shown with a truncated body.
	 */
	maxChars?: number;
}

function authorKey(entry: AgentLedgerEntry): string {
	return `${entry.agentId}\0${entry.runId}`;
}

function renderBody(entry: AgentLedgerEntry, state: CorroborationState | undefined, disputed: boolean): string {
	const marks: string[] = [];
	if (state !== undefined) marks.push(state);
	if (disputed) marks.push("disputed");
	const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
	const body = entry.body;
	if (body.kind === "claim") {
		const conflicts =
			entry.conflictsWith !== undefined && entry.conflictsWith.length > 0
				? ` (overlaps ${entry.conflictsWith.join(", ")})`
				: "";
		return `${entry.id} claim ${body.scope.join(" ")}${conflicts}: ${body.intent}${suffix}`;
	}
	if (body.kind === "finding") {
		const citation = body.path === undefined ? "" : ` ${body.path}${body.line === undefined ? "" : `:${body.line}`}`;
		return `${entry.id} finding${citation}: ${body.claim}${suffix}`;
	}
	return `${entry.id} review ${body.target} ${body.passed ? "passed" : "failed"}: ${body.evidence}${suffix}`;
}

/**
 * Bounded plain text, grouped by author. Every entry shows its id so a peer can
 * target it with a review, every finding shows its corroboration state, and a
 * disputed entry is marked where it stands.
 */
export function renderAgentLedger(
	entries: ReadonlyArray<AgentLedgerEntry>,
	opts: RenderAgentLedgerOptions = {},
): string {
	const maxChars = opts.maxChars;
	let visible = [...entries].sort((left, right) => left.sequence - right.sequence);
	if (visible.length === 0) return "No peer contributions yet.";

	// Drop oldest entries whole until the render fits. Rendering is cheap and
	// the board is capped at 200 entries, so re-rendering beats estimating. A
	// ceiling too small for even the newest entry yields an empty board rather
	// than an entry cut mid-body.
	for (;;) {
		const text = renderAll(visible);
		if (maxChars === undefined || text.length <= maxChars) return text;
		visible = visible.slice(1);
		if (visible.length === 0) return "No peer contributions yet.";
	}
}

function renderAll(entries: ReadonlyArray<AgentLedgerEntry>): string {
	const states = corroboration(entries).byEntryId;
	const disputed = disputes(entries);
	const groups = new Map<string, AgentLedgerEntry[]>();
	for (const entry of entries) {
		const key = authorKey(entry);
		const group = groups.get(key) ?? [];
		group.push(entry);
		groups.set(key, group);
	}
	const lines: string[] = [];
	for (const group of groups.values()) {
		const head = group[0];
		if (head === undefined) continue;
		lines.push(`${head.agentId} (run ${head.runId}, node ${head.nodeId}):`);
		for (const entry of group) {
			lines.push(`  ${renderBody(entry, states.get(entry.id), disputed.has(entry.id))}`);
		}
	}
	return lines.join("\n");
}
