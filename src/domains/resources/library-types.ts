/** A library distributes packages; kind describes the package's public contents. */
export type LibraryEntryKind = "skill" | "agent" | "prompt" | "fleet" | "plugin";
export type LibraryRequirementRef = `${LibraryEntryKind}:${string}`;

export const LIBRARY_KINDS: readonly LibraryEntryKind[] = ["plugin", "skill", "agent", "prompt", "fleet"];

export function isLibraryKind(value: unknown): value is LibraryEntryKind {
	return typeof value === "string" && LIBRARY_KINDS.includes(value as LibraryEntryKind);
}

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
}
