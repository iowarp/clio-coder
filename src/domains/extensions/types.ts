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
	/** Digest recorded when this package was transactionally installed. */
	installedContentDigest?: string;
	/** Digest observed while checking installed content on this load. */
	observedContentDigest?: string;
	resources: ExtensionManifestResources;
	overriddenBy?: ExtensionScope;
	diagnostics: ExtensionDiagnostic[];
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
	installedContentDigest: string;
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
