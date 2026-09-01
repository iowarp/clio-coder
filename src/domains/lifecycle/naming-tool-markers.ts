import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { fsyncDirectory } from "../../core/safe-resource-write.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { findPinnedTool } from "../toolchain/registry.js";

export const LEGACY_TOOL_MARKER = "clio-install.json";
export const CANONICAL_TOOL_MARKER = "clio-coder-install.json";

interface ValidToolMarker {
	id: string;
	version: string;
	sha256: string;
}

export type ToolMarkerNamingStatus =
	| "renamable"
	| "renamed"
	| "invalid-legacy"
	| "canonical-conflict"
	| "agreeing-duplicate"
	| "duplicate-removed";

export interface ToolMarkerNamingReport {
	tool: string;
	version: string;
	legacyPath: string;
	canonicalPath: string;
	status: ToolMarkerNamingStatus;
	detail: string;
}

export interface ToolMarkerNamingOptions {
	dataDir?: string;
	fix?: boolean;
}

function childDirectories(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

function readValidMarker(path: string, tool: string, version: string): ValidToolMarker | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
		const marker = value as Record<string, unknown>;
		if (marker.id !== tool || marker.version !== version) return null;
		if (typeof marker.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(marker.sha256)) return null;
		return { id: tool, version, sha256: marker.sha256 };
	} catch {
		return null;
	}
}

function sameFacts(left: ValidToolMarker, right: ValidToolMarker): boolean {
	return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

/**
 * Inspect or migrate released tool markers only below known tool/version
 * directories in the selected Clio Coder data root. Unknown tool roots and
 * symlinks are never traversed.
 */
export function inspectToolMarkerNaming(options: ToolMarkerNamingOptions = {}): ToolMarkerNamingReport[] {
	const toolsRoot = join(options.dataDir ?? resolveClioDirs().data, "tools");
	const reports: ToolMarkerNamingReport[] = [];
	for (const tool of childDirectories(toolsRoot)) {
		if (findPinnedTool(tool) === null) continue;
		for (const version of childDirectories(join(toolsRoot, tool))) {
			const dir = join(toolsRoot, tool, version);
			const legacyPath = join(dir, LEGACY_TOOL_MARKER);
			if (!existsSync(legacyPath)) continue;
			const canonicalPath = join(dir, CANONICAL_TOOL_MARKER);
			const legacy = readValidMarker(legacyPath, tool, version);
			if (legacy === null) {
				reports.push({
					tool,
					version,
					legacyPath,
					canonicalPath,
					status: "invalid-legacy",
					detail: "legacy marker does not match its known tool/version path and checksum shape; left untouched",
				});
				continue;
			}
			if (!existsSync(canonicalPath)) {
				if (options.fix) {
					renameSync(legacyPath, canonicalPath);
					fsyncDirectory(dir);
				}
				reports.push({
					tool,
					version,
					legacyPath,
					canonicalPath,
					status: options.fix ? "renamed" : "renamable",
					detail: options.fix ? "validated legacy marker renamed atomically" : "validated legacy marker can be renamed",
				});
				continue;
			}
			const canonical = readValidMarker(canonicalPath, tool, version);
			if (canonical === null || !sameFacts(legacy, canonical)) {
				reports.push({
					tool,
					version,
					legacyPath,
					canonicalPath,
					status: "canonical-conflict",
					detail:
						"canonical and legacy marker facts disagree or canonical is invalid; canonical wins and legacy is left untouched",
				});
				continue;
			}
			if (options.fix) {
				rmSync(legacyPath);
				fsyncDirectory(dir);
			}
			reports.push({
				tool,
				version,
				legacyPath,
				canonicalPath,
				status: options.fix ? "duplicate-removed" : "agreeing-duplicate",
				detail: options.fix
					? "validated agreeing legacy duplicate removed; canonical marker kept"
					: "canonical and legacy facts agree; legacy duplicate can be removed",
			});
		}
	}
	return reports;
}
