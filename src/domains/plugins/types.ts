export type PluginScope = "user" | "project";
export type PluginResourceKind = "skills" | "prompts" | "agents" | "fleets" | "themes";
export type PluginComponentKind = "prompt" | "agent" | "skill" | "fleet" | "script" | "resource" | "tool";
export type PluginResources = Partial<Record<PluginResourceKind, string>>;

export interface PluginDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
	/** Machine-readable reason for writer refusals; message text is unchanged. */
	code?: PluginDiagnosticCode;
	/** The reviewed fact that changed, for `stale_plan`. */
	changed?: { scope: PluginScope; id: string; fact: keyof PluginExpectedCopy; expected: unknown; observed: unknown };
}
export type PluginDiagnosticCode = "stale_plan" | "locked" | "dependents";

/**
 * One reviewed copy fact. Every field present is rechecked inside the writer's
 * lock before any write; a mismatch refuses with `stale_plan`.
 */
export interface PluginExpectedCopy {
	scope: PluginScope;
	id: string;
	/**
	 * A full snapshot (default) also fails when a fact appears or disappears.
	 * `partial` checks only the facts listed; reserved for the legacy
	 * digest-only update path that never reviewed the other facts.
	 */
	partial?: boolean;
	/** Install record present in that scope's state.json. */
	recorded: boolean;
	/** Observed full-tree digest, or absent. */
	tree: "absent" | string;
	enabled?: boolean;
	recordedDigest?: string;
	kind?: LibraryEntryKind;
	trust?: PackageTrust;
	/** Compared JSON-equal, so identical bytes with a different origin still stale a plan. */
	origin?: PluginOrigin;
}
export interface PluginExpectedState {
	copies: PluginExpectedCopy[];
}

export interface PluginComponent {
	kind: PluginComponentKind;
	id: string;
	path: string;
	requires?: string[];
}

export interface ClioPluginConfiguration {
	manifestVersion: 1;
	/** Absent in portable bundles means plugin. All kinds share the package lifecycle. */
	kind?: LibraryEntryKind;
	requires?: LibraryRequirementRef[];
	/** Contained Suite v2 files, selected explicitly by `clio-coder eval`. */
	evals?: Record<string, string>;
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

/** Format of a foreign package as it was found on disk; author labels never set this. */
export type ForeignPackageFormat = "portable" | "claude-code" | "codex";
/**
 * `interop` is a package imported from an installed local agent; `import` is an
 * explicit source path or GitHub tree. Both always carry foreign trust.
 */
export type PluginOrigin =
	| string
	| { kind: "local" | "catalog" | "github"; source: string }
	| { kind: "interop"; host: string; source: string; format?: ForeignPackageFormat; marketplace?: string }
	| {
			kind: "import";
			source: string;
			transport: "local" | "github";
			format: ForeignPackageFormat;
			host?: string;
			marketplace?: string;
	  };
export function isForeignPluginOrigin(origin: PluginOrigin | undefined): boolean {
	return typeof origin === "object" && (origin.kind === "interop" || origin.kind === "import");
}
export type PackageTrust = "trusted" | "foreign";

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
	kind?: LibraryEntryKind;
	trust?: PackageTrust;
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
	trust?: PackageTrust;
}

export interface PluginListOptions {
	cwd?: string;
	scope?: PluginScope;
	all?: boolean;
}

export interface PluginMutationOptions extends PluginListOptions {
	expect?: PluginExpectedState;
}

export interface PluginInstallOptions extends PluginMutationOptions {
	force?: boolean;
	expectedDigest?: string;
	expectedId?: string;
	expectedVersion?: string;
	origin?: PluginOrigin;
	trust?: PackageTrust;
	expectedKind?: LibraryEntryKind;
}

/** One kind-aware publication seam for library and interop adapters. */
export interface LibraryPackageInstallInput extends Omit<PluginInstallOptions, "expectedKind"> {
	kind: LibraryEntryKind;
	sourcePath: string;
	scope: PluginScope;
	origin: PluginOrigin;
	trust: PackageTrust;
}

export interface PluginMutationResult {
	plugin?: InstalledPlugin;
	removed?: { id: string; scope: PluginScope; path: string };
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: PluginDiagnostic[];
}

export type PluginInstallResult = PluginMutationResult;

export interface PluginInstallRecord {
	kind?: LibraryEntryKind;
	installedAt: string;
	source: string;
	origin?: PluginOrigin;
	contentDigest: string;
	trust?: PackageTrust;
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

import type { LibraryEntryKind, LibraryRequirementRef } from "../resources/library-types.js";
