/**
 * Shared shapes for the knob registry: the curated entries in
 * `docs/knobs.yaml` and the facts the source tree yields for them.
 */

export const KNOB_KINDS = [
	"env",
	"setting",
	"flag",
	"project-file",
	"tool-arg",
	"recipe-key",
	"fragment-key",
	"model-tag",
	"constant",
] as const;
export type KnobKind = (typeof KNOB_KINDS)[number];

export const KNOB_VERDICTS = ["keep", "merge", "deprecate", "document", "remove"] as const;
export type KnobVerdict = (typeof KNOB_VERDICTS)[number];

/** How a `tool-arg` entry relates to policy: a knob, or the task payload the schema also carries. */
export const TOOL_ARG_CLASSES = ["policy", "task"] as const;
export type ToolArgClass = (typeof TOOL_ARG_CLASSES)[number];

export interface RegistryEntry {
	name: string;
	kind: KnobKind;
	/** Owning command (flags) or domain (everything else). */
	owner: string;
	/** For flags: the command that parses it; `global` for startup flags. */
	command?: string;
	/** For `project-file`: the file under `.clio-coder/` the key lives in. */
	file?: string;
	/** For `constant`: the source file that declares it. */
	source?: string;
	/** For `tool-arg`: whether the argument is a policy knob or task data. */
	class?: ToolArgClass;
	/** Rendered verbatim; for settings and constants the check holds it against the code. */
	default?: string;
	controls: string;
	/** Free text describing what beats what when several surfaces set this value. */
	precedence?: string;
	verdict: KnobVerdict;
	/** For `merge` and `deprecate`: the canonical knob to fold into. */
	mergeWith?: string;
	/** A regular expression the check uses to match a family of names (`^CLIO_CODER_HOOK_BUDGET_[A-Z_]+_MS$`). */
	pattern?: string;
	/** Why the verdict is what it is, or anything an operator should know. */
	note?: string;
}

export interface Registry {
	version: 1;
	/** Files whose top-level numeric constants must all be registered. */
	constantScopes: string[];
	/** Tool names whose argument schemas must be fully registered. */
	toolArgScopes: string[];
	entries: RegistryEntry[];
}

export interface SourceSite {
	path: string;
	line: number;
}

export interface SourceKnob {
	kind: KnobKind;
	name: string;
	/** Same disambiguators as the registry entry. */
	command?: string;
	file?: string;
	source?: string;
	sites: SourceSite[];
	/** The value the code carries, where the extractor can read one. */
	default?: string;
	/** A description the source carries beside the knob (schema description, doc comment). */
	description?: string;
}

export interface SourceInventory {
	knobs: SourceKnob[];
	/** Every file under src/cli that carries a flag literal but has no command mapping. */
	unmappedCliFiles: string[];
}

export function knobKey(kind: KnobKind, name: string, disambiguator?: string): string {
	return disambiguator ? `${kind}:${disambiguator}:${name}` : `${kind}:${name}`;
}

export function entryKey(entry: Pick<RegistryEntry, "kind" | "name" | "command" | "file" | "source">): string {
	return knobKey(entry.kind, entry.name, entry.command ?? entry.file ?? entry.source);
}

export function sourceKey(knob: Pick<SourceKnob, "kind" | "name" | "command" | "file" | "source">): string {
	return knobKey(knob.kind, knob.name, knob.command ?? knob.file ?? knob.source);
}
