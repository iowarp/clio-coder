/**
 * `_clio-coder/extensions/list`, `_clio-coder/extensions/reload` and
 * `_clio-coder/library/reload`: what the terminal's /extensions view shows,
 * and the two reloads /extensions reload and /library reload run.
 *
 * The list is the running session's own view of its extensions: which are
 * eligible, disabled, invalid, incompatible or shadowed, and how many problems
 * each has. Manifest paths, roots, digests and provenance records stay
 * host-side. A reload reports the generation it committed, or why it was
 * rejected and which generation stays active; it never reports success for a
 * reload that did not happen.
 */

export const ACP_EXTENSIONS_META_KEY = "clio-coder/extensions";
export const ACP_EXTENSIONS_LIST_METHOD = "_clio-coder/extensions/list";
export const ACP_EXTENSIONS_RELOAD_METHOD = "_clio-coder/extensions/reload";
export const ACP_LIBRARY_META_KEY = "clio-coder/library";
export const ACP_LIBRARY_RELOAD_METHOD = "_clio-coder/library/reload";
const MAX_EXTENSIONS = 64;
const MAX_LINES = 40;
const MAX_TEXT_BYTES = 512;
const MAX_DIAGNOSTICS = 3;

/** The installed-extension fields the list reads; the extensions domain's InstalledExtension, structurally. */
export interface AcpInstalledExtension {
	id: string;
	name: string;
	version: string;
	description: string;
	scope: string;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	loadable: boolean;
	overriddenBy?: string;
	runtime?: unknown;
	diagnostics: ReadonlyArray<{ message: string }>;
}

/** The reload coordinator's outcome, structurally. */
export type AcpExtensionReloadOutcome =
	| {
			status: "committed";
			generation: number;
			changed: boolean;
			added: ReadonlyArray<unknown>;
			removed: ReadonlyArray<unknown>;
			modified: ReadonlyArray<unknown>;
			hooks: { registered: number; dropped: number; fileIssues: number; issues: number; overridden: number };
			lines: ReadonlyArray<string>;
	  }
	| { status: "rejected"; reason: string; generation: number; lines: ReadonlyArray<string> };

export interface AcpExtensionsControl {
	list(): ReadonlyArray<AcpInstalledExtension>;
	reload(): AcpExtensionReloadOutcome;
}

/** Plugin resources reloaded, as the PluginsReloaded event reports them. Throws when the reload fails. */
export type AcpLibraryReload = () => { generation: number; previousGeneration: number; changed: boolean };

function bounded(text: string): string {
	let safe = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		safe += code <= 0x1f || code === 0x7f ? " " : character;
	}
	if (Buffer.byteLength(safe, "utf8") <= MAX_TEXT_BYTES) return safe;
	let cut = safe.slice(0, MAX_TEXT_BYTES);
	while (Buffer.byteLength(cut, "utf8") > MAX_TEXT_BYTES - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

export function projectExtensions(list: ReadonlyArray<AcpInstalledExtension>) {
	return {
		version: 1 as const,
		extensions: list.slice(0, MAX_EXTENSIONS).map((extension) => ({
			id: bounded(extension.id),
			name: bounded(extension.name),
			version: bounded(extension.version),
			description: bounded(extension.description),
			scope: bounded(extension.scope),
			// The overlay's one state word, in the same precedence.
			state: !extension.valid
				? ("invalid" as const)
				: !extension.compatible
					? ("incompatible" as const)
					: !extension.enabled
						? ("disabled" as const)
						: extension.loadable
							? ("eligible" as const)
							: ("shadowed" as const),
			...(extension.overriddenBy !== undefined ? { overriddenBy: bounded(extension.overriddenBy) } : {}),
			runtime: extension.runtime !== undefined,
			problems: extension.diagnostics.length,
			diagnostics: extension.diagnostics.slice(0, MAX_DIAGNOSTICS).map((entry) => bounded(entry.message)),
		})),
		truncated: list.length > MAX_EXTENSIONS,
	};
}

export function projectExtensionReload(outcome: AcpExtensionReloadOutcome) {
	const lines = outcome.lines.slice(0, MAX_LINES).map(bounded);
	if (outcome.status !== "committed") {
		return { status: "rejected" as const, reason: bounded(outcome.reason), generation: outcome.generation, lines };
	}
	return {
		status: "committed" as const,
		generation: outcome.generation,
		changed: outcome.changed,
		added: outcome.added.length,
		removed: outcome.removed.length,
		modified: outcome.modified.length,
		hooks: {
			registered: outcome.hooks.registered,
			dropped: outcome.hooks.dropped,
			issues: outcome.hooks.fileIssues + outcome.hooks.issues,
			overridden: outcome.hooks.overridden,
		},
		lines,
	};
}
