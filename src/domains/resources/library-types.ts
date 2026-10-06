/** A library distributes packages; kind describes the package's public contents. */
export type LibraryEntryKind = "skill" | "agent" | "prompt" | "playbook" | "plugin" | "extension";
export type LibraryRequirementRef = `${LibraryEntryKind}:${string}`;

/** Existing plugin-backed package formats. A standalone extension has its own manifest and writer. */
export const LIBRARY_KINDS: readonly Exclude<LibraryEntryKind, "extension">[] = [
	"plugin",
	"skill",
	"agent",
	"prompt",
	"playbook",
];

export function isLibraryKind(value: unknown): value is LibraryEntryKind {
	return (
		value === "extension" ||
		(typeof value === "string" && LIBRARY_KINDS.includes(value as Exclude<LibraryEntryKind, "extension">))
	);
}

/** The four recipe kinds. A plugin owns recipes; it is never a fifth invocable kind. */
export type LibraryResourceKind = Exclude<LibraryEntryKind, "plugin" | "extension">;

export const LIBRARY_RESOURCE_KINDS: readonly LibraryResourceKind[] = ["skill", "agent", "prompt", "playbook"];

export function isLibraryResourceKind(value: unknown): value is LibraryResourceKind {
	return typeof value === "string" && LIBRARY_RESOURCE_KINDS.includes(value as LibraryResourceKind);
}

/**
 * D9 legacy reads, kept for one release. A playbook was called a fleet
 * contract, so packages, library indexes and install records written before
 * the rename say kind `fleet` and requirement `fleet:<name>`. Readers of those
 * persisted names pass them through these two functions; writers emit only the
 * playbook names. Delete both, and each caller's single use, when the window
 * closes.
 */
export function readLegacyLibraryKind(value: unknown): unknown {
	return value === "fleet" ? "playbook" : value;
}

/** D9: `fleet:<name>` is read as `playbook:<name>`; any other value passes through unchanged. */
export function readLegacyLibraryRef(value: unknown): unknown {
	return typeof value === "string" && value.startsWith("fleet:") ? `playbook:${value.slice("fleet:".length)}` : value;
}

/**
 * Bounded, body-free hint carried by a catalog row. Generated for curated
 * packages from actual parsed runtime names; optional in external indexes. A
 * hint supports discovery only: it never proves the package installs or loads.
 */
export interface LibraryProvidedResource {
	kind: LibraryResourceKind | "extension";
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
	/** Extension rows only: the one plugin this extension serves, so a plugin and its extension pair without reading package trees. */
	plugin?: string;
	category?: string;
	audit?: "pass" | "warn" | "fail" | "unknown";
	triggers?: string[];
	/** Absent means the package contents are unknown until explicit inspection. */
	provides?: LibraryProvidedResource[];
	/** Absolute path of the index file that produced this row. Discovery evidence; never written back. */
	index?: string;
}
