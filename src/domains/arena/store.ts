import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioProjectRoot } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { choiceFitsMatch } from "./blind.js";
import { ARENA_SCHEMA_VERSION, type ArenaChoice, type ArenaMatch, type ArenaVote } from "./types.js";

const MATCH_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
const DIFF_READ_LIMIT_BYTES = 256 * 1024;

/** `<project>/.clio-coder/arena/`, the one place matches, streams, diffs and votes live. */
export function arenaRoot(cwd: string): string {
	return join(clioProjectRoot(cwd, "arena"), ".clio-coder", "arena");
}

export function isArenaMatchId(id: string): boolean {
	return MATCH_ID.test(id);
}

export function newArenaMatchId(now = new Date()): string {
	const iso = now.toISOString();
	const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
	const suffix = Math.floor(Math.random() * 0x10000)
		.toString(16)
		.padStart(4, "0");
	return `${stamp}-${suffix}`;
}

export function matchDir(root: string, id: string): string {
	if (!isArenaMatchId(id)) throw new Error(`invalid arena match id: ${id}`);
	return join(root, id);
}

export function contenderStreamPath(dir: string, index: number): string {
	return join(dir, `contender-${index + 1}.ndjson`);
}

export function contenderDiffPath(dir: string, index: number): string {
	return join(dir, `contender-${index + 1}.diff`);
}

function writeJson(path: string, value: unknown): void {
	safeResourceWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeMatch(root: string, match: ArenaMatch): void {
	writeJson(join(matchDir(root, match.id), "match.json"), match);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function isMatch(value: unknown): value is ArenaMatch {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ArenaMatch>;
	return (
		record.schemaVersion === ARENA_SCHEMA_VERSION &&
		typeof record.id === "string" &&
		Array.isArray(record.contenders) &&
		Array.isArray(record.order)
	);
}

function isVote(value: unknown): value is ArenaVote {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ArenaVote>;
	return record.schemaVersion === ARENA_SCHEMA_VERSION && typeof record.choice === "string";
}

export function readMatch(root: string, id: string): ArenaMatch | null {
	const value = readJson(join(matchDir(root, id), "match.json"));
	return isMatch(value) ? value : null;
}

export function readVote(root: string, id: string): ArenaVote | null {
	const value = readJson(join(matchDir(root, id), "vote.json"));
	return isVote(value) ? value : null;
}

/** The contender's diff against the match baseline, bounded; null when it has none on disk. */
export function readContenderDiff(
	root: string,
	id: string,
	index: number,
): { text: string; truncated: boolean } | null {
	const path = contenderDiffPath(matchDir(root, id), index);
	if (!existsSync(path)) return null;
	const bytes = readFileSync(path);
	if (bytes.byteLength <= DIFF_READ_LIMIT_BYTES) return { text: bytes.toString("utf8"), truncated: false };
	return { text: bytes.subarray(0, DIFF_READ_LIMIT_BYTES).toString("utf8"), truncated: true };
}

/** Every readable match, newest first, each with its current vote. */
export function listMatches(root: string): Array<{ match: ArenaMatch; vote: ArenaVote | null }> {
	if (!existsSync(root)) return [];
	const found: Array<{ match: ArenaMatch; vote: ArenaVote | null }> = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !isArenaMatchId(entry.name)) continue;
		const match = readMatch(root, entry.name);
		if (match !== null) found.push({ match, vote: readVote(root, entry.name) });
	}
	return found.sort((a, b) => b.match.id.localeCompare(a.match.id));
}

export class ArenaVoteError extends Error {}

/**
 * Record the human's preference. One vote per match: a second needs `replace`,
 * and every vote, replaced or not, stays in the append-only `votes.jsonl`.
 */
export function recordVote(
	root: string,
	id: string,
	input: { choice: ArenaChoice; note: string | null; replace: boolean },
	now = new Date(),
): ArenaVote {
	const match = readMatch(root, id);
	if (match === null) throw new ArenaVoteError(`no arena match ${id}`);
	if (match.status !== "complete") throw new ArenaVoteError(`match ${id} is ${match.status}; vote once it completes`);
	if (!choiceFitsMatch(match, input.choice)) {
		throw new ArenaVoteError(`match ${id} has ${match.order.length} contenders; '${input.choice}' is not one of them`);
	}
	const existing = readVote(root, id);
	if (existing !== null && !input.replace) {
		throw new ArenaVoteError(`match ${id} already has a vote (${existing.choice}); pass --replace to change it`);
	}
	const vote: ArenaVote = {
		schemaVersion: ARENA_SCHEMA_VERSION,
		matchId: id,
		choice: input.choice,
		note: input.note,
		votedAt: now.toISOString(),
		replaced: existing !== null,
	};
	mkdirSync(root, { recursive: true });
	appendFileSync(join(root, "votes.jsonl"), `${JSON.stringify(vote)}\n`);
	writeJson(join(matchDir(root, id), "vote.json"), vote);
	return vote;
}
