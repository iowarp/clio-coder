import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { extensionResourcePath } from "./resource-path.js";
import { type InstalledExtensionRecord, listInstalledExtensionRecords } from "./state.js";
import {
	type ExtensionDiagnostic,
	type ExtensionHookSource,
	type ExtensionResourceKind,
	type ExtensionResourceRoot,
	type ExtensionSnapshot,
	type ExtensionSnapshotDiagnostics,
	isLoadableExtension,
} from "./types.js";

export const EXTENSION_SNAPSHOT_DIAGNOSTIC_CAP = 200;
export const EXTENSION_SNAPSHOT_DIAGNOSTIC_PER_PACKAGE_CAP = 20;
export const EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP = 512;

const RESOURCE_KINDS: ReadonlyArray<ExtensionResourceKind> = ["skills", "prompts", "agents", "fleets", "themes"];

export interface BuildExtensionSnapshotInput {
	cwd: string;
	generation: number;
	now?: () => Date;
	listRecords?: (cwd?: string, options?: { all?: boolean }) => InstalledExtensionRecord[];
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
	seen.add(value as object);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function boundedDiagnostics(records: ReadonlyArray<InstalledExtensionRecord>): ExtensionSnapshotDiagnostics {
	const entries: Array<ExtensionDiagnostic & { extensionId?: string }> = [];
	let truncated = 0;
	for (const { entry } of records) {
		let admittedForPackage = 0;
		for (const diagnostic of entry.diagnostics) {
			if (
				admittedForPackage >= EXTENSION_SNAPSHOT_DIAGNOSTIC_PER_PACKAGE_CAP ||
				entries.length >= EXTENSION_SNAPSHOT_DIAGNOSTIC_CAP
			) {
				truncated += 1;
				continue;
			}
			entries.push({
				type: diagnostic.type,
				message: diagnostic.message.slice(0, EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP),
				...(diagnostic.path ? { path: diagnostic.path } : {}),
				extensionId: entry.id,
			});
			admittedForPackage += 1;
		}
	}
	return { entries, truncated };
}

export function buildExtensionSnapshot(input: BuildExtensionSnapshotInput): ExtensionSnapshot {
	const cwd = realpathSync(path.resolve(input.cwd));
	const records = (input.listRecords ?? listInstalledExtensionRecords)(cwd, { all: true });
	const resourceRoots: Record<ExtensionResourceKind, ExtensionResourceRoot[]> = {
		skills: [],
		prompts: [],
		agents: [],
		fleets: [],
		themes: [],
	};
	const hookSources: ExtensionHookSource[] = [];
	const digestPackages: unknown[] = [];

	for (const record of records) {
		const { entry } = record;
		const packageRoots: Array<{ kind: ExtensionResourceKind; path: string }> = [];
		let hooksDigest: string | undefined;
		if (isLoadableExtension(entry)) {
			for (const kind of RESOURCE_KINDS) {
				const relative = entry.resources[kind];
				if (!relative) continue;
				const resolved = extensionResourcePath(entry.rootPath, relative);
				if (!resolved) continue;
				resourceRoots[kind].push({
					id: entry.id,
					scope: entry.scope,
					path: resolved,
					rootPath: entry.rootPath,
					source: `extension:${entry.scope}:${entry.id}`,
					provenance: entry.provenance,
					generation: input.generation,
				});
				packageRoots.push({ kind, path: resolved });
			}
			const hookBytes = record.captured?.get("hooks.yaml");
			if (hookBytes !== undefined) {
				hooksDigest = createHash("sha256").update(hookBytes).digest("hex");
				let declarations: unknown = [];
				let parseError: string | undefined;
				try {
					declarations = parseYaml(hookBytes.toString("utf8")) ?? [];
				} catch (error) {
					parseError = error instanceof Error ? error.message : String(error);
				}
				hookSources.push({
					provenance: entry.provenance,
					declarationsDigest: hooksDigest,
					declarations,
					...(parseError ? { parseError } : {}),
				});
			}
		}
		digestPackages.push({
			id: entry.id,
			scope: entry.scope,
			loadable: entry.loadable,
			...(entry.provenance ? { provenance: entry.provenance } : {}),
			resourceRoots: packageRoots,
			...(hooksDigest ? { hooksDigest } : {}),
		});
	}

	const snapshot: ExtensionSnapshot = {
		version: 1,
		generation: input.generation,
		cwd,
		builtAt: (input.now ?? (() => new Date()))().toISOString(),
		digest: createHash("sha256").update(canonicalJson(digestPackages)).digest("hex"),
		packages: records.map((record) => record.entry),
		resourceRoots,
		hookSources,
		diagnostics: boundedDiagnostics(records),
	};
	return deepFreeze(snapshot);
}

function packageFingerprints(snapshot: ExtensionSnapshot): Map<string, string> {
	const grouped = new Map<string, unknown[]>();
	for (const entry of snapshot.packages) {
		const list = grouped.get(entry.id) ?? [];
		list.push({
			scope: entry.scope,
			loadable: entry.loadable,
			provenance: entry.provenance ?? null,
			resources: entry.resources,
		});
		grouped.set(entry.id, list);
	}
	return new Map(
		[...grouped].map(([id, values]) => [id, createHash("sha256").update(canonicalJson(values)).digest("hex")]),
	);
}

export function diffExtensionSnapshots(
	previous: ExtensionSnapshot | null,
	next: ExtensionSnapshot,
): { changed: boolean; added: string[]; removed: string[]; modified: string[] } {
	if (previous === null) {
		return { changed: true, added: [...new Set(next.packages.map((entry) => entry.id))], removed: [], modified: [] };
	}
	const before = packageFingerprints(previous);
	const after = packageFingerprints(next);
	const added = [...after.keys()].filter((id) => !before.has(id));
	const removed = [...before.keys()].filter((id) => !after.has(id));
	const modified = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
	return { changed: previous.digest !== next.digest, added, removed, modified };
}
