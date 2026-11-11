import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { storeProjectDir, storeRoot } from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";

const tagDirs = new Map<string, string>();
const answers = new Map<string, { key: string; signals: ReadonlyArray<string> }>();

function modified(path: string): number {
	return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
}

/**
 * The capabilities this workspace itself points at, whatever a turn's words: a
 * project whose store holds a tag keeps its data there, so store and data. Only
 * the local backend is read; listing a clio-core store needs its runtime, which a
 * per-turn hint must not start. This runs on every turn, so the answer is kept
 * until the backend record or the project's tag list changes: two stats a turn.
 */
export function workspaceCapabilitySignals(cwd: string): ReadonlyArray<string> {
	const root = storeRoot();
	const project = `${root}\0${cwd}`;
	let tags = tagDirs.get(project);
	if (tags === undefined) {
		tags = join(storeProjectDir(cwd), "tags");
		tagDirs.set(project, tags);
	}
	const backend = join(root, "backend.json");
	const key = `${modified(backend)}:${modified(tags)}`;
	const cached = answers.get(project);
	if (cached?.key === key) return cached.signals;
	const signals = readSignals(backend, tags);
	answers.set(project, { key, signals });
	return signals;
}

function readSignals(backend: string, tags: string): ReadonlyArray<string> {
	try {
		const record = JSON.parse(readFileSync(backend, "utf8")) as { backend?: unknown };
		if (record.backend === "clio-core") return [];
	} catch {
		// No record, or an unreadable one: the local backend serves this project.
	}
	try {
		return readdirSync(tags).length > 0 ? [ToolNames.Store, ToolNames.Data] : [];
	} catch {
		return [];
	}
}
