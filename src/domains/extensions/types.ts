export type ExtensionScope = "user" | "project";
export type ExtensionResourceKind = "skills" | "prompts" | "agents" | "fleets" | "themes";

export interface ExtensionManifestResources {
	skills?: string;
	prompts?: string;
	agents?: string;
	fleets?: string;
	themes?: string;
}

export interface ClioExtensionManifest {
	manifestVersion: 1;
	id: string;
	name: string;
	version: string;
	description: string;
	resources: ExtensionManifestResources;
	tools?: string[];
	settings?: string[];
	compatibility?: { clio?: string };
}

export interface ExtensionDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

export interface ExtensionProvenance {
	id: string;
	scope: ExtensionScope;
	/** Path recorded in install state, when known. */
	sourcePath?: string;
	/** Canonical filesystem identity of the installed package root. */
	canonicalRoot: string;
	/** SHA-256 of the manifest bytes covered by the installed-tree digest. */
	manifestDigest: string;
	/** Installed-tree digest recorded at install and reverified on this load. */
	contentDigest: string;
}

export interface InstalledExtension {
	id: string;
	name: string;
	version: string;
	description: string;
	scope: ExtensionScope;
	rootPath: string;
	manifestPath: string;
	enabled: boolean;
	/** Whether the complete manifest and declared resource tree are valid. */
	valid: boolean;
	/** Whether this package admits the running Clio version. */
	compatible: boolean;
	effective: boolean;
	/** The single admission decision for extension-owned resources and hooks. */
	loadable: boolean;
	/** Present exactly when the installed tree and manifest bytes were reverified. */
	provenance?: ExtensionProvenance;
	/** Digest observed while checking installed content on this load. */
	observedContentDigest?: string;
	resources: ExtensionManifestResources;
	overriddenBy?: ExtensionScope;
	diagnostics: ExtensionDiagnostic[];
}

export type LoadableExtension = InstalledExtension & { loadable: true; provenance: ExtensionProvenance };

export function isLoadableExtension(entry: InstalledExtension): entry is LoadableExtension {
	return entry.loadable && entry.provenance !== undefined;
}

export interface ExtensionCandidate {
	path: string;
	manifestPath?: string;
	manifest?: ClioExtensionManifest;
	valid: boolean;
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionResourceRoot {
	id: string;
	scope: ExtensionScope;
	path: string;
	rootPath: string;
	source: string;
	provenance: ExtensionProvenance;
	/** Zero denotes an ephemeral, uncommitted projection. */
	generation: number;
}

export interface ExtensionHookSource {
	provenance: ExtensionProvenance;
	/** SHA-256 of the captured hooks.yaml bytes. */
	declarationsDigest: string;
	/** Parsed captured YAML, or an empty list when parsing failed. */
	declarations: unknown;
	parseError?: string;
}

export interface ExtensionSnapshotDiagnostics {
	entries: ReadonlyArray<ExtensionDiagnostic & { extensionId?: string }>;
	truncated: number;
}

export interface ExtensionSnapshot {
	version: 1;
	generation: number;
	cwd: string;
	builtAt: string;
	/** Content identity; generation, timestamp, and diagnostic text are excluded. */
	digest: string;
	packages: ReadonlyArray<InstalledExtension>;
	resourceRoots: Readonly<Record<ExtensionResourceKind, ReadonlyArray<ExtensionResourceRoot>>>;
	hookSources: ReadonlyArray<ExtensionHookSource>;
	diagnostics: ExtensionSnapshotDiagnostics;
}

export interface ExtensionListOptions {
	scope?: ExtensionScope;
	cwd?: string;
	all?: boolean;
}

export interface ExtensionInstallOptions extends ExtensionListOptions {
	force?: boolean;
}

export interface ExtensionInstallResult {
	extension?: InstalledExtension;
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionMutationResult {
	extension?: InstalledExtension;
	removed?: { id: string; scope: ExtensionScope; path: string };
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionStateUpgradeReport {
	scope: ExtensionScope;
	statePath: string;
	backupPath?: string;
	upgraded: string[];
	refused: Array<{ id: string; reason: string }>;
}

export interface ExtensionState {
	version: 1;
	disabled: string[];
	installed: Record<string, { installedAt: string; source?: string; contentDigest?: string }>;
}
