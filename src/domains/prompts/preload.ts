/**
 * Project-context preload classification. One place owns the preload cliff:
 * the session compiler uses it to choose full-CLIO.md preload versus compact
 * synopsis, and reporting surfaces (context-init output, `clio config
 * inspect`, the context-window overlay) use it to make the cliff visible.
 */

export const FULL_PROJECT_CONTEXT_MAX_CHARS = 8000;
export const FULL_PROJECT_CONTEXT_MAX_LINES = 220;

/** Fraction of a limit at which a full preload is flagged as near the cliff. */
const NEAR_LIMIT_FRACTION = 0.9;

export type ProjectPreloadMode = "full" | "synopsis" | "none";
export type ProjectPreloadReason = "size" | "lines" | "no-clio-md";

export interface ProjectPreloadClass {
	mode: ProjectPreloadMode;
	/** Rendered project-context length in characters (untrimmed, as measured by the cliff). */
	chars: number;
	/** Rendered project-context line count. */
	lines: number;
	/** Which limit forced the synopsis; null for full or none. */
	reason: ProjectPreloadReason | null;
	/** True when a full preload is within 10% of either limit. */
	nearLimit: boolean;
	/** Human line, e.g. "full (5.2kB, 130 lines)" or "synopsis (reason: size)". */
	label: string;
}

export interface ClassifyProjectPreloadInput {
	/** True when a parseable CLIO.md contributed to the rendered text. */
	hasClioMd: boolean;
	/** The rendered project prompt context (ProjectPromptContext.text). */
	text: string;
}

function formatKb(chars: number): string {
	return `${(chars / 1000).toFixed(1)}kB`;
}

/**
 * Classify how the session compiler will treat this project context. Must
 * mirror the selection in prompts/extension.ts exactly: full preload only
 * when a parseable CLIO.md exists and the rendered text is within both the
 * char and line limits; empty text preloads nothing.
 */
export function classifyProjectPreload(input: ClassifyProjectPreloadInput): ProjectPreloadClass {
	const chars = input.text.length;
	const lines = input.text.length === 0 ? 0 : input.text.split("\n").length;
	if (input.text.trim().length === 0) {
		return { mode: "none", chars, lines, reason: null, nearLimit: false, label: "none (no project context)" };
	}
	const reason: ProjectPreloadReason | null = !input.hasClioMd
		? "no-clio-md"
		: chars > FULL_PROJECT_CONTEXT_MAX_CHARS
			? "size"
			: lines > FULL_PROJECT_CONTEXT_MAX_LINES
				? "lines"
				: null;
	if (reason !== null) {
		return {
			mode: "synopsis",
			chars,
			lines,
			reason,
			nearLimit: false,
			label: `synopsis (reason: ${reason})`,
		};
	}
	const nearLimit =
		chars > FULL_PROJECT_CONTEXT_MAX_CHARS * NEAR_LIMIT_FRACTION ||
		lines > FULL_PROJECT_CONTEXT_MAX_LINES * NEAR_LIMIT_FRACTION;
	return {
		mode: "full",
		chars,
		lines,
		reason: null,
		nearLimit,
		label: `full (${formatKb(chars)}, ${lines} lines)`,
	};
}
