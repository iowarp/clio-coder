export type ExtensionScope = "user" | "project";
export type ExtensionResourceKind = "skills" | "prompts" | "themes";

export interface ExtensionManifestResources {
	skills?: string;
	prompts?: string;
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
	effective: boolean;
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
	source: string;
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
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionMutationResult {
	extension?: InstalledExtension;
	removed?: { id: string; scope: ExtensionScope; path: string };
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionState {
	version: 1;
	disabled: string[];
	installed: Record<string, { installedAt: string; source?: string }>;
}
