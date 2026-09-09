export type PluginScope = "user" | "project";
export type PluginResourceKind = "skills" | "prompts" | "agents" | "fleets" | "themes";
export type PluginComponentKind = "prompt" | "agent" | "skill" | "fleet" | "script" | "resource" | "tool";
export type PluginResources = Partial<Record<PluginResourceKind, string>>;

export interface PluginDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

export interface PluginComponent {
	kind: PluginComponentKind;
	id: string;
	path: string;
	requires?: string[];
}

export interface ClioPluginConfiguration {
	manifestVersion: 1;
	compatibility?: { clio?: string };
	resources: PluginResources;
	components: PluginComponent[];
}

/** Standard identity stays canonical; `clio` is the validated runtime projection. */
export interface PluginManifest {
	$schema: string;
	name: string;
	version?: string;
	description?: string;
	author?: { name?: string; email?: string; url?: string };
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	extensions?: Record<string, Record<string, unknown>>;
	clio: ClioPluginConfiguration;
}

export interface PluginCandidate {
	path: string;
	manifestPath?: string;
	manifest?: PluginManifest;
	valid: boolean;
	diagnostics: PluginDiagnostic[];
	contentDigest?: string;
	manifestDigest?: string;
}

export type PluginOrigin = string | { kind: "local" | "catalog" | "github"; source: string };

export interface PluginProvenance {
	id: string;
	scope: PluginScope;
	sourcePath?: string;
	canonicalRoot: string;
	manifestDigest: string;
	contentDigest: string;
}

export interface InstalledPlugin {
	id: string;
	name: string;
	version: string;
	description: string;
	scope: PluginScope;
	rootPath: string;
	manifestPath: string;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	effective: boolean;
	loadable: boolean;
	resources: PluginResources;
	manifest?: PluginManifest;
	provenance?: PluginProvenance;
	observedContentDigest?: string;
	overriddenBy?: PluginScope;
	diagnostics: PluginDiagnostic[];
}

export interface PluginResourceRoot {
	id: string;
	scope: PluginScope;
	path: string;
	rootPath: string;
	source: string;
	provenance: PluginProvenance;
	generation: number;
}

export interface PluginListOptions {
	cwd?: string;
	scope?: PluginScope;
	all?: boolean;
}

export interface PluginInstallOptions extends PluginListOptions {
	force?: boolean;
	expectedDigest?: string;
	expectedId?: string;
	expectedVersion?: string;
	origin?: PluginOrigin;
}

export interface PluginMutationResult {
	plugin?: InstalledPlugin;
	removed?: { id: string; scope: PluginScope; path: string };
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: PluginDiagnostic[];
}

export type PluginInstallResult = PluginMutationResult;

export interface PluginInstallRecord {
	installedAt: string;
	source: string;
	origin?: PluginOrigin;
	contentDigest: string;
}

export interface PluginState {
	version: 1;
	disabled: string[];
	installed: Record<string, PluginInstallRecord>;
}

export interface PluginSnapshot {
	version: 1;
	generation: number;
	cwd: string;
	digest: string;
	packages: ReadonlyArray<InstalledPlugin>;
	resourceRoots: Readonly<Record<PluginResourceKind, ReadonlyArray<PluginResourceRoot>>>;
}
