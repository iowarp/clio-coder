import type { ProjectPromptContext } from "../context/contract.js";
import { renderProjectContextFragment } from "../context/index.js";
import { sha256 } from "./hash.js";
import { safePrefixOffsets, sourceLineCount } from "./preload-prefix.js";

/** Historical limits, measured in UTF-16 code units and rendered lines. */
export const FULL_PROJECT_CONTEXT_MAX_CHARS = 8000;
export const FULL_PROJECT_CONTEXT_MAX_LINES = 220;
export type ProjectPreloadMode = "full" | "partial" | "synopsis" | "none";
export type ProjectPreloadReason = "size" | "lines" | "no-clio-md";
export interface ProjectPreloadSource {
	path: string;
	contentHash: string;
	availableChars: number;
	availableLines: number;
	includedChars: number;
	includedLines: number;
	includedRange: [number, number] | null;
	omittedRange: [number, number] | null;
	omissionReason: "budget" | null;
}
export interface ProjectPreloadClass {
	mode: ProjectPreloadMode;
	/** Available rendered UTF-16 code units; retained for historical readers. */
	chars: number;
	/** Available rendered lines, including the final split segment. */
	lines: number;
	reason: ProjectPreloadReason | null;
	nearLimit: boolean;
	label: string;
	/** Additive snapshot accounting; absent in historical full/synopsis records. */
	includedChars?: number;
	includedLines?: number;
	sources?: ProjectPreloadSource[];
	omittedSupportFragments?: number;
	providerSupportsTools?: boolean | null;
}
const renderedLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

function coverage(path: string, source: string, included: string): ProjectPreloadSource {
	const availableLines = sourceLineCount(source);
	const includedLines = sourceLineCount(included);
	return {
		path,
		contentHash: sha256(source),
		availableChars: source.length,
		availableLines,
		includedChars: included.length,
		includedLines,
		includedRange: includedLines === 0 ? null : [1, includedLines],
		omittedRange: included.length === source.length ? null : [includedLines + 1, availableLines],
		omissionReason: included.length === source.length ? null : "budget",
	};
}

/** One selector owns delivered text and reporting; it never re-parses authored markers. */
export function selectProjectPreload(
	context: ProjectPromptContext,
	providerSupportsTools: boolean | null = null,
	options: { maxChars?: number; externalReadTools?: boolean } = {},
): { text: string; classification: ProjectPreloadClass } {
	const maxChars = options.maxChars ?? FULL_PROJECT_CONTEXT_MAX_CHARS;
	const fits = (text: string): boolean =>
		text.length <= maxChars && renderedLines(text) <= FULL_PROJECT_CONTEXT_MAX_LINES;
	const chars = context.text.length;
	const lines = renderedLines(context.text);
	const classify = (
		text: string,
		mode: ProjectPreloadMode,
		sources: ProjectPreloadSource[],
		omittedSupportFragments: number,
	): ProjectPreloadClass => {
		const includedChars = text.length;
		const includedLines = renderedLines(text);
		const incomplete = sources.filter((source) => source.omissionReason !== null).length;
		return {
			mode,
			chars,
			lines,
			includedChars,
			includedLines,
			sources,
			omittedSupportFragments,
			providerSupportsTools,
			reason: mode !== "partial" ? null : chars > maxChars ? "size" : "lines",
			nearLimit: mode === "full" && (chars > maxChars * 0.9 || lines > FULL_PROJECT_CONTEXT_MAX_LINES * 0.9),
			label: `${mode} (included ${includedChars}/${chars} UTF-16 units, ${includedLines}/${lines} rendered lines; ${incomplete} of ${sources.length} handbook sources incomplete${providerSupportsTools === null ? "; tool capability unknown" : ""})`,
		};
	};
	if (fits(context.text)) {
		const sources = context.handbookSources.map(({ path, source }) => coverage(path, source, source));
		return {
			text: context.text,
			classification: classify(context.text, context.text.length === 0 ? "none" : "full", sources, 0),
		};
	}
	const retrieval =
		providerSupportsTools === false
			? "Remaining source text is unavailable to this target and cannot be recovered with tools in this session. Paths are source references."
			: options.externalReadTools
				? "External read tools are unknown. If available and permitted, read the listed omitted physical lines with your file-reading tool. Otherwise report the missing guidance to the parent. Reads use current disk content, which may differ from the captured source."
				: `${providerSupportsTools === null ? "If tools are available, read" : "Read"} each omitted suffix with read({path: ABSOLUTE_PATH, offset: FIRST_OMITTED_LINE, limit: 200}); continue as needed. Reads use current disk content, which may differ from the captured source.`;
	const header = [
		"<project-preload>",
		"Incomplete authored prefixes/excerpts: omitted guidance is not known from this preload. Read the selected sources before relying on project guidance.",
		retrieval,
	];
	const totals = context.handbookSources.map(({ source }) => sourceLineCount(source));
	const sourceRecord = (path: string, included: string, omitted: string): string =>
		`${JSON.stringify(path)}: included physical lines ${included}; omitted physical lines ${omitted}.`;
	const reservedRecords = context.handbookSources.map(({ path }, index) =>
		sourceRecord(path, `none/${totals[index]}-${totals[index]}`, `none/${totals[index]}-${totals[index]} (budget)`),
	);
	const notice = (records: string[], omitted: number): string =>
		[...header, ...records, `Support fragments omitted: ${omitted}.`, "</project-preload>"].join("\n");
	const reservedNotice = notice(reservedRecords, context.supportFragments.length);
	if (!fits(reservedNotice))
		throw new Error(`project preload metadata-budget overflow for ${context.handbookSources.length} handbook sources`);
	const excerpts = context.handbookSources.map(() => "");
	const fragments = context.handbookSources.map(() => "");
	const assemble = (metadata: string, support: readonly string[] = []): string =>
		[metadata, ...fragments.filter(Boolean), ...support].join("\n\n");
	// Allocate nearest first, while fragments retain the original ancestor-first order.
	for (let index = context.handbookSources.length - 1; index >= 0; index--) {
		const entry = context.handbookSources[index];
		if (!entry) continue;
		const { path, source } = entry;
		for (const offset of safePrefixOffsets(source, maxChars).slice(1)) {
			const previous = fragments[index] ?? "";
			fragments[index] = renderProjectContextFragment(source.slice(0, offset), path);
			if (!fits(assemble(reservedNotice))) {
				fragments[index] = previous;
				break;
			}
			excerpts[index] = source.slice(0, offset);
		}
	}
	const support: string[] = [];
	for (const fragment of context.supportFragments) {
		if (fits(assemble(reservedNotice, [...support, fragment]))) support.push(fragment);
	}
	const sources = context.handbookSources.map(({ path, source }, index) =>
		coverage(path, source, excerpts[index] ?? ""),
	);
	const records = sources.map((source) =>
		sourceRecord(
			source.path,
			source.includedRange?.join("-") ?? "none",
			source.omittedRange ? `${source.omittedRange.join("-")} (budget)` : "none",
		),
	);
	const omitted = context.supportFragments.length - support.length;
	const text = assemble(notice(records, omitted), support);
	if (!fits(text)) throw new Error("project preload budget postcondition failed");
	return { text, classification: classify(text, "partial", sources, omitted) };
}
