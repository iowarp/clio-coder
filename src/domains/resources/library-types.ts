/** A library distributes packages; kind describes the package's public contents. */
export type LibraryEntryKind = "skill" | "agent" | "prompt" | "fleet" | "plugin";
export type LibraryRequirementRef = `${LibraryEntryKind}:${string}`;

export const LIBRARY_KINDS: readonly LibraryEntryKind[] = ["plugin", "skill", "agent", "prompt", "fleet"];

export function isLibraryKind(value: unknown): value is LibraryEntryKind {
	return typeof value === "string" && LIBRARY_KINDS.includes(value as LibraryEntryKind);
}

/** The four recipe kinds. A plugin owns recipes; it is never a fifth invocable kind. */
export type LibraryResourceKind = Exclude<LibraryEntryKind, "plugin">;

export const LIBRARY_RESOURCE_KINDS: readonly LibraryResourceKind[] = ["skill", "agent", "prompt", "fleet"];

export function isLibraryResourceKind(value: unknown): value is LibraryResourceKind {
	return typeof value === "string" && LIBRARY_RESOURCE_KINDS.includes(value as LibraryResourceKind);
}

/**
 * Bounded, body-free hint carried by a catalog row. Generated for curated
 * packages from actual parsed runtime names; optional in external indexes. A
 * hint supports discovery only: it never proves the package installs or loads.
 */
export interface LibraryProvidedResource {
	kind: LibraryResourceKind;
	name: string;
	description?: string;
}

export const LIBRARY_PROVIDES_LIMITS = { entries: 256, name: 128, description: 256 } as const;

/** The same record is used in bundled, user, and project library indexes. */
export interface LibraryPackageEntry {
	kind: LibraryEntryKind;
	name: string;
	description: string;
	sourceUrl: string;
	version?: string;
	sha256?: string;
	origin: "catalog" | "index" | "installed";
	requires?: LibraryRequirementRef[];
	category?: string;
	audit?: "pass" | "warn" | "fail" | "unknown";
	triggers?: string[];
	/** Absent means the package contents are unknown until explicit inspection. */
	provides?: LibraryProvidedResource[];
	/** Absolute path of the index file that produced this row. Discovery evidence; never written back. */
	index?: string;
}
