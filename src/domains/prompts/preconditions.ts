import { ALL_TOOL_NAMES } from "../../core/tool-names.js";

/**
 * What a prompt fragment, or one row inside it, needs from the session before
 * the compiler renders it. A fragment declares `requires`, `surfaces` and
 * `when` in its frontmatter; a row declares one name with a `{name}` marker.
 * Every condition is checked against one `SessionFacts`, so text never names a
 * tool, a slash command or a sandbox the session does not have.
 */

export type PromptSurface = "attended" | "headless" | "worker";
export type SandboxCondition = "active" | "absent";
export type AutonomyCondition = "default" | "yolo" | "yolo-unconfined";

export const PROMPT_SURFACES: ReadonlyArray<PromptSurface> = ["attended", "headless", "worker"];
const SANDBOX_CONDITIONS: ReadonlyArray<SandboxCondition> = ["active", "absent"];
const AUTONOMY_CONDITIONS: ReadonlyArray<AutonomyCondition> = ["default", "yolo", "yolo-unconfined"];

export interface FragmentPreconditions {
	/** Capabilities that must be reachable, directly or through the gateway. */
	requires?: ReadonlyArray<string>;
	/** Surfaces the fragment renders on; absent means every surface. */
	surfaces?: ReadonlyArray<PromptSurface>;
	when?: { sandbox?: SandboxCondition; autonomy?: AutonomyCondition };
}

/** The facts every fragment and row condition is checked against. */
export interface SessionFacts {
	surface: PromptSurface;
	/** Capabilities the rendered prompt can name: the session's capability map, or a worker's admitted tools. */
	capabilities: ReadonlySet<string>;
	/** True when this session's shell commands run under an OS sandbox. */
	sandbox: boolean;
	autonomy: AutonomyCondition;
	demo: boolean;
	/** True only in the terminal UI, where replies render through the TUI's Markdown. */
	terminal: boolean;
	peers: boolean;
}

const FACT_CONDITION_NAMES = ["sandbox", "demo", "terminal", "peers"] as const;

/** Every name a `{name}` row marker may use: a builtin capability, a surface, or a session fact. */
export const ROW_CONDITION_NAMES: ReadonlySet<string> = new Set<string>([
	...ALL_TOOL_NAMES,
	...PROMPT_SURFACES,
	...FACT_CONDITION_NAMES,
]);

const CAPABILITY_NAMES: ReadonlySet<string> = new Set<string>(ALL_TOOL_NAMES);

function stringList(value: unknown, key: string, allowed: ReadonlySet<string>): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`frontmatter.${key} must be a list of names`);
	}
	for (const item of value as string[]) {
		if (!allowed.has(item)) throw new Error(`frontmatter.${key} names unknown "${item}"`);
	}
	return value as string[];
}

/** Parse the optional precondition keys; an unknown name or `when` key throws. */
export function parseFragmentPreconditions(fm: Record<string, unknown>): FragmentPreconditions {
	const out: FragmentPreconditions = {};
	if (fm.requires !== undefined) out.requires = stringList(fm.requires, "requires", CAPABILITY_NAMES);
	if (fm.surfaces !== undefined) {
		out.surfaces = stringList(fm.surfaces, "surfaces", new Set(PROMPT_SURFACES)) as PromptSurface[];
	}
	if (fm.when !== undefined) {
		const when = fm.when;
		if (when === null || typeof when !== "object" || Array.isArray(when)) {
			throw new Error("frontmatter.when must be a mapping");
		}
		const parsed: NonNullable<FragmentPreconditions["when"]> = {};
		for (const [key, value] of Object.entries(when)) {
			if (key === "sandbox" && SANDBOX_CONDITIONS.includes(value as SandboxCondition)) {
				parsed.sandbox = value as SandboxCondition;
			} else if (key === "autonomy" && AUTONOMY_CONDITIONS.includes(value as AutonomyCondition)) {
				parsed.autonomy = value as AutonomyCondition;
			} else {
				throw new Error(`frontmatter.when.${key} is not a known condition (${String(value)})`);
			}
		}
		out.when = parsed;
	}
	return out;
}

/** The preconditions that held, as `/context`-style labels; null when one fails. */
export function heldPreconditions(pre: FragmentPreconditions, facts: SessionFacts): string[] | null {
	const held: string[] = [];
	if (pre.surfaces !== undefined) {
		if (!pre.surfaces.includes(facts.surface)) return null;
		held.push(`surface:${facts.surface}`);
	}
	for (const capability of pre.requires ?? []) {
		if (!facts.capabilities.has(capability)) return null;
		held.push(`requires:${capability}`);
	}
	if (pre.when?.sandbox !== undefined) {
		if (facts.sandbox !== (pre.when.sandbox === "active")) return null;
		held.push(`sandbox:${pre.when.sandbox}`);
	}
	if (pre.when?.autonomy !== undefined) {
		if (facts.autonomy !== pre.when.autonomy) return null;
		held.push(`autonomy:${pre.when.autonomy}`);
	}
	return held;
}

function conditionHolds(name: string, facts: SessionFacts): boolean {
	if ((PROMPT_SURFACES as ReadonlyArray<string>).includes(name)) return facts.surface === name;
	if (name === "sandbox") return facts.sandbox;
	if (name === "demo") return facts.demo;
	if (name === "terminal") return facts.terminal;
	if (name === "peers") return facts.peers;
	return facts.capabilities.has(name);
}

const LIST_ROW = /^([ \t]*)- \{([a-z_]+)\} /;
const INLINE_ROW = /(^|[ \t\n])\{([a-z_]+)\} /g;
const SENTENCE_END = /[.!?](?=\s|$)/g;

/** Every row-condition name in a body, with its 1-based line; for the loader and the hygiene lint. */
export function rowConditionMarkers(body: string): Array<{ name: string; line: number }> {
	const out: Array<{ name: string; line: number }> = [];
	for (const match of body.matchAll(INLINE_ROW)) {
		const index = (match.index ?? 0) + (match[1]?.length ?? 0);
		out.push({ name: match[2] ?? "", line: body.slice(0, index).split("\n").length });
	}
	return out;
}

/** A body with every row kept, for a reader outside a session (the docs guidance). */
export function stripRowMarkers(body: string): string {
	return body.replace(INLINE_ROW, "$1");
}

/**
 * Render a body's row conditions. A list item `- {name} ...` keeps or drops
 * the whole item, its indented continuation lines included. An inline
 * `{name} ` keeps or drops the text up to its sentence's end. A kept row
 * loses only its marker; a body without markers comes back unchanged.
 */
export function renderRowConditions(body: string, facts: SessionFacts): string {
	if (!INLINE_ROW.test(body)) return body;
	INLINE_ROW.lastIndex = 0;
	const lines = body.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const match = LIST_ROW.exec(line);
		if (!match) {
			kept.push(line);
			continue;
		}
		const indent = match[1]?.length ?? 0;
		let end = i + 1;
		while (end < lines.length) {
			const next = lines[end] ?? "";
			const nextIndent = next.length - next.trimStart().length;
			if (next.trim().length === 0 || nextIndent <= indent) break;
			end++;
		}
		if (conditionHolds(match[2] ?? "", facts)) {
			kept.push(line.replace(`{${match[2]}} `, ""), ...lines.slice(i + 1, end));
		}
		i = end - 1;
	}
	return renderInlineConditions(kept.join("\n"), facts);
}

function renderInlineConditions(text: string, facts: SessionFacts): string {
	let out = text;
	for (;;) {
		INLINE_ROW.lastIndex = 0;
		const match = INLINE_ROW.exec(out);
		if (!match) return out;
		const lead = match[1] ?? "";
		const name = match[2] ?? "";
		const markerStart = match.index + lead.length;
		const markerEnd = markerStart + name.length + 3;
		if (conditionHolds(name, facts)) {
			out = out.slice(0, markerStart) + out.slice(markerEnd);
			continue;
		}
		SENTENCE_END.lastIndex = markerEnd;
		const sentence = SENTENCE_END.exec(out);
		const segmentEnd = sentence ? sentence.index + 1 : out.length;
		if (lead === " " || lead === "\t") {
			let start = markerStart;
			while (start > 0 && (out[start - 1] === " " || out[start - 1] === "\t")) start--;
			out = out.slice(0, start) + out.slice(segmentEnd);
			continue;
		}
		// The segment opens a line: drop the space after it, and the line when nothing is left.
		let end = segmentEnd;
		while (out[end] === " " || out[end] === "\t") end++;
		const lineEnd = out.indexOf("\n", end);
		const rest = out.slice(end, lineEnd === -1 ? out.length : lineEnd);
		if (rest.trim().length === 0) {
			const lineStart = markerStart;
			out = lineEnd === -1 ? out.slice(0, Math.max(0, lineStart - 1)) : out.slice(0, lineStart) + out.slice(lineEnd + 1);
		} else {
			out = out.slice(0, markerStart) + out.slice(end);
		}
	}
}
