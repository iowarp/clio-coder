export type ExtensionScope = "user" | "project";

export interface ExtensionRuntimeDeclaration {
	api: 1;
	entrypoint: string;
	commands: Array<{ name: string; description: string; timeoutMs: number }>;
	events: Array<"session_open" | "turn_end">;
	ui: Array<"status" | "panel">;
}

export interface ExtensionCommandTool {
	name: string;
	description: string;
	runtime: "node" | "python3";
	entrypoint: string;
	inputSchema: Record<string, unknown>;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface ExtensionCapabilities {
	tools: ExtensionCommandTool[];
}

/**
 * The harness extension contract. An extension contributes executable runtime
 * capability to Clio: command tools declared here and hook declarations
 * captured from `hooks.yaml` at the package root. Prompts, skills, agents,
 * fleets, and reference files are plugin content and have no manifest key.
 */
export interface ClioExtensionManifest {
	runtime?: ExtensionRuntimeDeclaration;
	id: string;
	name: string;
	version: string;
	description: string;
	/** Absent for a package whose only capability is its `hooks.yaml`. */
	capabilities?: ExtensionCapabilities;
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
	runtime?: ExtensionRuntimeDeclaration;
	id: string;
	name: string;
	version: string;
	description: string;
	capabilities?: ExtensionCapabilities;
	scope: ExtensionScope;
	rootPath: string;
	manifestPath: string;
	enabled: boolean;
	/** Whether the complete manifest and the installed tree are valid. */
	valid: boolean;
	/** Whether this package admits the running Clio version. */
	compatible: boolean;
	effective: boolean;
	/** The single admission decision for extension-owned tools and hooks. */
	loadable: boolean;
	/** Present exactly when the installed tree and manifest bytes were reverified. */
	provenance?: ExtensionProvenance;
	/** Digest observed while checking installed content on this load. */
	observedContentDigest?: string;
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
	hookSources: ReadonlyArray<ExtensionHookSource>;
	diagnostics: ExtensionSnapshotDiagnostics;
}

export type ExtensionReloadRejectionReason = "build-failed" | "reentrant" | "stale" | "workspace-changed";

export interface ExtensionReloadRejection {
	status: "rejected";
	reason: ExtensionReloadRejectionReason;
	/** Generation that remains committed. */
	generation: number;
	diagnostics: ExtensionSnapshotDiagnostics;
}

/**
 * A fully built and validated generation that has not been published. The
 * bundle holds at most one candidate at a time. `publish` is one reference
 * assignment that never validates, refuses, throws, or calls out; the caller
 * checks `current()` on the same stack immediately before it. `discard`
 * releases the candidate without any visible change.
 */
export interface ExtensionReloadCandidate {
	generation: number;
	previousGeneration: number;
	snapshot: ExtensionSnapshot;
	/** False when the candidate digest equals the committed digest. */
	changed: boolean;
	added: ReadonlyArray<string>;
	removed: ReadonlyArray<string>;
	modified: ReadonlyArray<string>;
	/** True while this is the in-flight candidate and the committed snapshot it was diffed against is still live. */
	current(): boolean;
	publish(): void;
	discard(): void;
}

export type ExtensionReloadPrepareResult =
	| { status: "prepared"; candidate: ExtensionReloadCandidate }
	| ExtensionReloadRejection;

export interface ExtensionReloadCommitted {
	status: "committed";
	generation: number;
	previousGeneration: number;
	changed: boolean;
	digest: string;
	added: ReadonlyArray<string>;
	removed: ReadonlyArray<string>;
	modified: ReadonlyArray<string>;
	diagnostics: ExtensionSnapshotDiagnostics;
}

export type ExtensionReloadResult = ExtensionReloadCommitted | ExtensionReloadRejection;

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

export interface ExtensionState {
	version: 1;
	disabled: string[];
	installed: Record<string, { installedAt: string; source?: string; contentDigest?: string }>;
}
