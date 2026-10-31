import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { telemetryHub } from "../../../core/telemetry/hub.js";
import { clioDataDir } from "../../../core/xdg.js";
import type { Migration } from "./index.js";

/**
 * Removes once what the telemetry stores before #434 left on an existing home. Every name below is one an earlier
 * release wrote and the current tree never writes, so the removal cannot touch live state: session ledgers, metas and
 * trees, run recordings and their wiki sidecars, route history, the memory store and everything under the
 * `telemetry/` process, session and run scopes stay. Only regular files and directories are removed. A symlink or
 * any other entry is left in place with its parent, and no path is resolved through one. A failure is counted, never
 * thrown, so boot proceeds whatever the home holds.
 */

const STATE_FILES = ["trace.sqlite", "trace.sqlite-wal", "trace.sqlite-shm", "evidence-index.json"] as const;
const STATE_DIRECTORIES = [
	["usage"],
	["receipts"],
	["audit"],
	["route-decisions"],
	["systemone"],
	["startup"],
	["telemetry", "research"],
] as const;
const DATA_DIRECTORIES = [["evidence"]] as const;
const MEMORY_FILES = [
	"steps.jsonl",
	"steps.jsonl.1",
	"observation-events.jsonl",
	"observation-events.jsonl.1",
] as const;
const SESSION_FILES = /^(?:calls(?:\..+)?\.jsonl|prompt-manifest\.jsonl|context-snapshots\.jsonl)$/u;
const RUN_FILES = /^events(?:\..+)?\.ndjson$/u;
const META_MAX_BYTES = 4 * 1024 * 1024;

interface Tally {
	files: number;
	directories: number;
	rewritten: number;
	skipped: number;
	failed: number;
}

type EntryKind = "file" | "directory" | "other" | "absent";

function kindOf(path: string): EntryKind {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return "absent";
	if (stat.isFile()) return "file";
	return stat.isDirectory() ? "directory" : "other";
}

/** `segments` under `root` when every one of them is a real directory, so nothing below is reached through a link. */
function realDirectory(root: string, ...segments: string[]): string | null {
	let path = root;
	for (const segment of segments) {
		path = join(path, segment);
		if (kindOf(path) !== "directory") return null;
	}
	return path;
}

function names(directory: string, tally: Tally): string[] {
	try {
		return readdirSync(directory);
	} catch {
		tally.failed += 1;
		return [];
	}
}

function removeFile(path: string, tally: Tally): void {
	try {
		unlinkSync(path);
		tally.files += 1;
	} catch {
		tally.failed += 1;
	}
}

/** A directory empties bottom up; one left holding a skipped or failed entry stays. */
function removeDirectory(path: string, tally: Tally): void {
	for (const name of names(path, tally)) remove(join(path, name), tally);
	try {
		rmdirSync(path);
		tally.directories += 1;
	} catch {
		// Not empty because an entry below was kept; that entry is already counted.
	}
}

function remove(path: string, tally: Tally): void {
	switch (kindOf(path)) {
		case "file":
			removeFile(path, tally);
			return;
		case "directory":
			removeDirectory(path, tally);
			return;
		case "other":
			tally.skipped += 1;
			return;
		case "absent":
			return;
	}
}

function removeNamedFile(path: string, tally: Tally): void {
	const kind = kindOf(path);
	if (kind === "file") removeFile(path, tally);
	else if (kind !== "absent") tally.skipped += 1;
}

/** meta.json without the usage projection the session store kept in it. */
function dropMetaUsage(path: string, tally: Tally): void {
	if (kindOf(path) !== "file") return;
	try {
		if (lstatSync(path).size > META_MAX_BYTES) return;
		const meta = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (meta === null || typeof meta !== "object" || Array.isArray(meta) || !Object.hasOwn(meta, "usage")) return;
		delete (meta as Record<string, unknown>).usage;
		safeResourceWrite(path, JSON.stringify(meta, null, 2));
		tally.rewritten += 1;
	} catch {
		tally.failed += 1;
	}
}

function sweepSessions(stateDir: string, tally: Tally): void {
	const sessions = realDirectory(stateDir, "sessions");
	if (sessions === null) return;
	for (const cwdHash of names(sessions, tally)) {
		const workspace = realDirectory(sessions, cwdHash);
		if (workspace === null) continue;
		for (const sessionId of names(workspace, tally)) {
			const session = realDirectory(workspace, sessionId);
			if (session === null) continue;
			for (const name of names(session, tally)) {
				if (SESSION_FILES.test(name)) removeNamedFile(join(session, name), tally);
				else if (name === "objects") {
					const objects = join(session, name);
					if (kindOf(objects) === "directory") removeDirectory(objects, tally);
					else tally.skipped += 1;
				}
			}
			dropMetaUsage(join(session, "meta.json"), tally);
		}
	}
}

function sweepRuns(stateDir: string, tally: Tally): void {
	const runs = realDirectory(stateDir, "runs");
	if (runs === null) return;
	for (const runId of names(runs, tally)) {
		const run = realDirectory(runs, runId);
		if (run === null) continue;
		for (const name of names(run, tally)) if (RUN_FILES.test(name)) removeNamedFile(join(run, name), tally);
	}
}

function sweepDirectories(root: string, paths: ReadonlyArray<ReadonlyArray<string>>, tally: Tally): void {
	for (const segments of paths) {
		const parent = realDirectory(root, ...segments.slice(0, -1));
		const name = segments.at(-1);
		if (parent === null || name === undefined) continue;
		const path = join(parent, name);
		const kind = kindOf(path);
		if (kind === "directory") removeDirectory(path, tally);
		else if (kind !== "absent") tally.skipped += 1;
	}
}

function sweep(stateDir: string, tally: Tally): void {
	for (const name of STATE_FILES) removeNamedFile(join(stateDir, name), tally);
	sweepDirectories(stateDir, STATE_DIRECTORIES, tally);
	sweepDirectories(clioDataDir(), DATA_DIRECTORIES, tally);
	const memory = realDirectory(stateDir, "memory");
	if (memory !== null) for (const name of MEMORY_FILES) removeNamedFile(join(memory, name), tally);
	sweepSessions(stateDir, tally);
	sweepRuns(stateDir, tally);
}

const migration: Migration = {
	id: "2026-10-31-remove-old-telemetry",
	async up(stateDir: string): Promise<void> {
		const tally: Tally = { files: 0, directories: 0, rewritten: 0, skipped: 0, failed: 0 };
		try {
			sweep(stateDir, tally);
		} catch {
			tally.failed += 1;
		}
		try {
			telemetryHub().emit("old_telemetry.removed", tally);
		} catch {
			// The summary is a record of the sweep; losing it never stops boot.
		}
	},
};

export default migration;
