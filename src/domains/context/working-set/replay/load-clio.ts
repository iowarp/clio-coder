import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseSessionEntries } from "../../../session/archive-readers.js";
import { isSessionHeader, type SessionEntry } from "../../../session/entries.js";
import { filterEntriesToActivePath } from "../../../session/tree/active-path.js";
import { buildPathIndex } from "../path-index.js";
import { buildReferenceGraph } from "./reference-graph.js";
import { countReplayTurns, type Trace } from "./trace.js";

export interface ReplayFilterOptions {
	minTurns?: number;
	minToolResults?: number;
	requireFileReread?: boolean;
}

export interface LoadClioTraceOptions {
	/** False is the CLI's --no-filter behavior. */
	filter?: false | ReplayFilterOptions;
}

export interface ReplayLoadCascade {
	found: number;
	unreadable: number;
	filtered: Record<string, number>;
	kept: number;
}

const DEFAULT_FILTER = {
	minTurns: 8,
	minToolResults: 8,
	requireFileReread: true,
} as const;

async function collectLedgerFiles(input: string, out: Set<string>): Promise<void> {
	const path = resolve(input);
	let facts: Awaited<ReturnType<typeof stat>>;
	try {
		facts = await stat(path);
	} catch {
		return;
	}
	if (facts.isFile()) {
		// Directory discovery is intentionally limited to current.jsonl below;
		// an explicit JSONL path may also be a frozen synthetic fixture.
		if (path.endsWith(".jsonl")) out.add(path);
		return;
	}
	if (!facts.isDirectory()) return;

	const direct = join(path, "current.jsonl");
	try {
		if ((await stat(direct)).isFile()) {
			out.add(direct);
			return;
		}
	} catch {
		// A sessions root or cwd-hash directory has no direct ledger.
	}

	let children: Dirent[];
	try {
		children = await readdir(path, { withFileTypes: true });
	} catch {
		return;
	}
	for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!child.isDirectory()) continue;
		await collectLedgerFiles(join(path, child.name), out);
	}
}

function sessionId(raw: string, source: string): string {
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (isSessionHeader(value)) return value.id;
		} catch {
			return basename(dirname(source));
		}
	}
	return basename(dirname(source));
}

async function pinnedLeafTurnId(source: string): Promise<string | undefined> {
	try {
		const raw = await readFile(join(dirname(source), "meta.json"), "utf8");
		const value = JSON.parse(raw) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const pinned = (value as Record<string, unknown>).pinnedLeafTurnId;
		return typeof pinned === "string" && pinned.length > 0 ? pinned : undefined;
	} catch {
		return undefined;
	}
}

function cleanActiveEntries(entries: ReadonlyArray<SessionEntry>, activeLeafTurnId?: string): SessionEntry[] {
	return filterEntriesToActivePath(entries, activeLeafTurnId).filter(
		(entry) => entry.kind !== "contextEviction" && entry.kind !== "contextRecall",
	);
}

function toolResultCount(entries: ReadonlyArray<SessionEntry>): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.kind === "message" && entry.role === "tool_result") count += 1;
	}
	return count;
}

/**
 * Load only Clio ledgers. Inputs may be a current.jsonl file, one session
 * directory, a cwd-hash directory, or the sessions root.
 */
export async function loadClioTraces(
	paths: ReadonlyArray<string>,
	options: LoadClioTraceOptions = {},
): Promise<{ traces: Trace[]; cascade: ReplayLoadCascade }> {
	const discovered = new Set<string>();
	let missingInputs = 0;
	for (const path of paths) {
		const before = discovered.size;
		await collectLedgerFiles(path, discovered);
		if (discovered.size === before) {
			try {
				await stat(resolve(path));
			} catch {
				missingInputs += 1;
			}
		}
	}

	const filtered: Record<string, number> = {
		turns_lt_8: 0,
		tool_results_lt_8: 0,
		no_file_reread: 0,
	};
	const cascade: ReplayLoadCascade = {
		found: discovered.size,
		unreadable: missingInputs,
		filtered,
		kept: 0,
	};
	const traces: Trace[] = [];
	const filter =
		options.filter === false
			? null
			: {
					minTurns: options.filter?.minTurns ?? DEFAULT_FILTER.minTurns,
					minToolResults: options.filter?.minToolResults ?? DEFAULT_FILTER.minToolResults,
					requireFileReread: options.filter?.requireFileReread ?? DEFAULT_FILTER.requireFileReread,
				};

	for (const source of [...discovered].sort((a, b) => a.localeCompare(b))) {
		let raw: string;
		try {
			raw = await readFile(source, "utf8");
		} catch {
			cascade.unreadable += 1;
			continue;
		}
		const parsed = parseSessionEntries(raw, source);
		if (parsed.errors.length > 0) {
			cascade.unreadable += 1;
			continue;
		}
		const entries = cleanActiveEntries(parsed.entries, await pinnedLeafTurnId(source));
		const trace: Trace = {
			id: sessionId(raw, source),
			source,
			entries,
			turnCount: countReplayTurns(entries),
		};
		if (filter !== null) {
			if (trace.turnCount < filter.minTurns) {
				filtered.turns_lt_8 = (filtered.turns_lt_8 ?? 0) + 1;
				continue;
			}
			if (toolResultCount(entries) < filter.minToolResults) {
				filtered.tool_results_lt_8 = (filtered.tool_results_lt_8 ?? 0) + 1;
				continue;
			}
			if (filter.requireFileReread) {
				const graph = buildReferenceGraph(trace, buildPathIndex(entries));
				if (!graph.edges.some((edge) => edge.kind === "file_reread")) {
					filtered.no_file_reread = (filtered.no_file_reread ?? 0) + 1;
					continue;
				}
			}
		}
		traces.push(trace);
	}
	cascade.kept = traces.length;
	return { traces, cascade };
}
