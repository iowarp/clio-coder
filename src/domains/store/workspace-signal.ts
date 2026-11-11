import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeTagSegment, storeProjectDir, storeRoot, validateTagName } from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";

const tagDirs = new Map<string, string>();
interface WorkspaceStore {
	readonly signals: ReadonlyArray<string>;
	readonly tags: ReadonlyArray<string>;
}

const NO_STORE: WorkspaceStore = { signals: [], tags: [] };
const answers = new Map<string, { key: string; store: WorkspaceStore }>();

function modified(path: string): number {
	return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
}

/**
 * The capabilities this workspace itself points at, whatever a turn's words: a
 * project whose store holds a tag keeps its data there, so store and data. Only
 * the local backend is read; listing a clio-core store needs its runtime, which a
 * per-turn hint must not start.
 */
export function workspaceCapabilitySignals(cwd: string): ReadonlyArray<string> {
	return workspaceStore(cwd).signals;
}

/** The project's local store tags, sorted, records tags left out; empty for a clio-core store. */
export function workspaceStoreTags(cwd: string): ReadonlyArray<string> {
	return workspaceStore(cwd).tags;
}

/**
 * Runs on every turn, so the answer is kept until the backend record or the
 * project's tag list changes: two stats a turn, and a directory read only then.
 */
function workspaceStore(cwd: string): WorkspaceStore {
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
	if (cached?.key === key) return cached.store;
	const store = readStore(backend, tags);
	answers.set(project, { key, store });
	return store;
}

function readStore(backend: string, tagsDir: string): WorkspaceStore {
	try {
		const record = JSON.parse(readFileSync(backend, "utf8")) as { backend?: unknown };
		if (record.backend === "clio-core") return NO_STORE;
	} catch {
		// No record, or an unreadable one: the local backend serves this project.
	}
	let entries: string[];
	try {
		entries = readdirSync(tagsDir);
	} catch {
		return NO_STORE;
	}
	const tags = entries
		.flatMap((segment) => {
			try {
				return [decodeTagSegment(segment)];
			} catch {
				return [];
			}
		})
		.filter((tag) => validateTagName(tag) === null)
		.sort();
	return tags.length > 0 ? { signals: [ToolNames.Store, ToolNames.Data], tags } : NO_STORE;
}
