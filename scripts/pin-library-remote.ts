/**
 * Refresh "blessed" remote library packages: rows in `library/registry.yaml`
 * whose `sourceUrl` is a GitHub tree URL rather than a path under `library/`.
 * `pnpm library:pin` only ever scans local directories for its rows; without
 * this module a remote row would be silently dropped on the next pin run.
 *
 * A blessed remote row is always re-fetched and re-verified against its own
 * content, so the pinned `sha256` reflects an actually-fetched tree rather
 * than a hand-typed digest. A failed fetch (offline, missing tag, missing
 * subdirectory) never fails the pin run and never drops the row: the
 * previously pinned row passes through unchanged, with a warning.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { fetchPluginSource, type PluginSource, parsePluginGithubSource } from "../src/domains/plugins/catalog.js";
import {
	isLibraryResourceKind,
	LIBRARY_PROVIDES_LIMITS,
	type LibraryProvidedResource,
} from "../src/domains/resources/library-types.js";
import {
	type LibraryPackageValidationResult,
	validateLibraryPackage,
} from "../src/domains/resources/library-validation.js";

/** Same remote test the plugin catalog uses to distinguish a source URL from a relative path. */
export const REMOTE_SOURCE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i;

export type RegistryRow = Record<string, unknown> & { name: string; sourceUrl: string };

export function isBlessedRemoteRow(row: unknown): row is RegistryRow {
	return (
		!!row &&
		typeof row === "object" &&
		typeof (row as RegistryRow).name === "string" &&
		typeof (row as RegistryRow).sourceUrl === "string" &&
		REMOTE_SOURCE_URL.test((row as RegistryRow).sourceUrl) &&
		!!parsePluginGithubSource((row as RegistryRow).sourceUrl)
	);
}

/** Blessed remote rows currently pinned in a registry.yaml file, if any. */
export function readBlessedRemoteRows(registryPath: string): RegistryRow[] {
	if (!existsSync(registryPath)) return [];
	const parsed = parse(readFileSync(registryPath, "utf8")) as { entries?: unknown[] } | null;
	return (parsed?.entries ?? []).filter(isBlessedRemoteRow);
}

/**
 * Build one registry row from a validated package root. Shared shape with
 * locally scanned packages: both are a directory that passed
 * `validateLibraryPackage`, so the row derives from the same evidence
 * (manifest, content digest, parsed resource hints) either way. `category`
 * only applies to skill-kind rows.
 */
export function buildRegistryRow(
	root: string,
	result: Pick<LibraryPackageValidationResult, "manifest" | "contentDigest" | "validation">,
	sourceUrl: string,
	category: string | undefined,
): RegistryRow {
	const manifest = result.manifest;
	if (!manifest) throw new Error(`${root}: missing manifest`);
	const skillFile = path.join(root, "SKILL.md");
	const frontmatter = existsSync(skillFile)
		? /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillFile, "utf8"))?.[1]
		: undefined;
	const metadata = frontmatter ? (parse(frontmatter) as Record<string, unknown>) : {};
	const triggers = Array.isArray(metadata.triggers)
		? metadata.triggers.filter((item): item is string => typeof item === "string")
		: [];
	// Hints are the validator's actual parsed runtime names, never component
	// ids or display titles. Ancillary scripts/resources stay manifest metadata.
	const provides: LibraryProvidedResource[] = result.validation.resources
		.flatMap((resource) =>
			isLibraryResourceKind(resource.kind) && resource.valid
				? [
						{
							kind: resource.kind,
							name: resource.name,
							...(resource.description
								? { description: resource.description.slice(0, LIBRARY_PROVIDES_LIMITS.description) }
								: {}),
						},
					]
				: [],
		)
		.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
		.slice(0, LIBRARY_PROVIDES_LIMITS.entries);
	return {
		kind: manifest.clio.kind ?? "plugin",
		name: manifest.name,
		description: manifest.description ?? "",
		...(manifest.clio.kind === "skill"
			? { category: category ?? "", audit: "pass", ...(triggers.length ? { triggers } : {}) }
			: {}),
		version: manifest.version,
		sourceUrl,
		sha256: result.contentDigest,
		...(manifest.clio.requires ? { requires: manifest.clio.requires } : {}),
		...(provides.length ? { provides } : {}),
	};
}

export interface RefreshDeps {
	fetchPluginSource: (source: string) => PluginSource;
	validateLibraryPackage: (root: string) => LibraryPackageValidationResult;
}

const defaultDeps: RefreshDeps = { fetchPluginSource, validateLibraryPackage };

export interface RefreshResult {
	row: RegistryRow;
	refreshed: boolean;
	warning?: string;
}

/**
 * Always attempt to fetch and re-verify one blessed remote row. On success,
 * the row is fully regenerated from the fetched manifest and content digest.
 * On failure (offline, missing tag, missing subdirectory, invalid package),
 * the previous row passes through unchanged and the failure is reported as a
 * warning rather than thrown, so a pin run never fails or drops the row.
 */
export function refreshBlessedRemoteRow(row: RegistryRow, deps: RefreshDeps = defaultDeps): RefreshResult {
	let fetched: PluginSource | undefined;
	try {
		fetched = deps.fetchPluginSource(row.sourceUrl);
		const result = deps.validateLibraryPackage(fetched.root);
		if (!result.valid || !result.manifest) {
			const msgs = [
				...result.diagnostics.map((d) => d.message),
				...result.validation.diagnostics.map((d) => `[${d.code}] ${d.message}`),
			];
			throw new Error(msgs.join("; ") || "fetched package failed validation");
		}
		if (result.manifest.name !== row.name) {
			throw new Error(`fetched package identity ${result.manifest.name} does not match pinned identity ${row.name}`);
		}
		const refreshedRow = buildRegistryRow(
			fetched.root,
			result,
			row.sourceUrl,
			typeof row.category === "string" ? row.category : undefined,
		);
		return { row: refreshedRow, refreshed: true };
	} catch (error) {
		return {
			row,
			refreshed: false,
			warning: `could not refresh blessed remote package "${row.name}" from ${row.sourceUrl}: ${
				error instanceof Error ? error.message : String(error)
			}. Keeping the previously pinned entry unchanged.`,
		};
	} finally {
		fetched?.cleanup();
	}
}
