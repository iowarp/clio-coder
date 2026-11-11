import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeProjectDir, storeRoot } from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";

/**
 * The capabilities this workspace itself points at, whatever a turn's words: a
 * project whose store holds a tag keeps its data there, so store and data. Only
 * the local backend is read; listing a clio-core store needs its runtime, which a
 * per-turn hint must not start.
 */
export function workspaceCapabilitySignals(cwd: string): string[] {
	try {
		const record = JSON.parse(readFileSync(join(storeRoot(), "backend.json"), "utf8")) as { backend?: unknown };
		if (record.backend === "clio-core") return [];
	} catch {
		// No record, or an unreadable one: the local backend serves this project.
	}
	try {
		return readdirSync(join(storeProjectDir(cwd), "tags")).length > 0 ? [ToolNames.Store, ToolNames.Data] : [];
	} catch {
		return [];
	}
}
