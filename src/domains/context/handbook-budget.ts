import type { BootstrapStructuredOutput } from "./bootstrap.js";
import { type ClioMdSection, HANDBOOK_TARGETS, serializeClioMd } from "./clio-md.js";

/**
 * Ignore prose punctuation, but keep operators and glob syntax inside code. A
 * clause-final colon goes too, so "Keep X: Y." splits into a clause equal to
 * the rule "Keep X.".
 */
export function normalizeHandbookRule(text: string): string {
	return text
		.replace(/^\s*(?:[-*+]\s|\d+\.\s)/, "")
		.replace(/\s*\(source: [^)]+\)\s*$/, "")
		.split(/(`[^`]+`)/)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part
						.replace(/[*]/g, "")
						.replace(/[.,;:](?=\s|$)/g, " ")
						.toLowerCase(),
		)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

export function handbookBlocks(body: string): string[] {
	const result: string[] = [];
	let block: string[] = [];
	let fence: string | null = null;
	const flush = (): void => {
		if (block.some((line) => line.trim())) result.push(block.join("\n").trimEnd());
		block = [];
	};
	for (const line of body.split(/\r?\n/)) {
		const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence && (line.trim() === "" || /^(?:[-*+]\s|\d+\.\s)/.test(line))) flush();
		block.push(line);
		if (delimiter) {
			if (fence && delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
			else if (!fence) fence = delimiter;
		}
	}
	flush();
	return result;
}

const LEADING_SECTIONS: ReadonlyArray<RegExp> = [/^tests?\b/i, /gotcha/i];
const RECIPE_SECTION = /change recipe/i;
/** Sections whose rules hold anywhere, though they cite deep paths as examples. */
const UNSCOPED_SECTIONS: ReadonlyArray<RegExp> = [/^tests?\b/i, /gotcha/i, /\bgit\b|release/i, /\bdocs?\b|prose/i];
const PATHS_NONE = "<!-- clio: paths=none -->";
const OVERRIDE_LINE = /^<!--\s*clio:.*-->$/;

function sectionRank(title: string): number {
	const leading = LEADING_SECTIONS.findIndex((pattern) => pattern.test(title));
	if (leading >= 0) return leading;
	return RECIPE_SECTION.test(title) ? LEADING_SECTIONS.length : LEADING_SECTIONS.length + 1;
}

/**
 * The order a fleet worker's packer fills after the invariants: Tests, Gotchas,
 * then Conventions (placed by the serializer), Change recipes, then the rest.
 * The sort is stable, so sections of one rank keep their order.
 */
export function orderSectionsForWorkers<T extends ClioMdSection>(sections: ReadonlyArray<T>): T[] {
	return sections
		.map((section, index) => ({ section, index, rank: sectionRank(section.title) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.section);
}

/**
 * A rule citing a path two directories deep is scoped to that path for workers.
 * The generator's citation rule puts such paths on most lines, so the sections
 * whose rules hold anywhere say `paths=none`; Change recipes stay path-scoped.
 * Conventions follow the leading Tests and Gotchas sections. A section the
 * operator wrote keeps its scope and place: `authoredTitles` names them.
 */
export function markWorkerScopes(
	output: BootstrapStructuredOutput,
	authoredTitles: ReadonlyArray<string> = [],
): BootstrapStructuredOutput {
	const authored = new Set(authoredTitles);
	const sections = (output.sections ?? []).map((section) => {
		if (authored.has(section.title)) return section;
		if (!UNSCOPED_SECTIONS.some((pattern) => pattern.test(section.title))) return section;
		const lines = section.body.split("\n");
		if (OVERRIDE_LINE.test(lines.find((line) => line.trim().length > 0)?.trim() ?? "")) return section;
		const rest = lines
			.filter((line) => line.trim() !== PATHS_NONE)
			.join("\n")
			.trim();
		return { ...section, body: `${PATHS_NONE}\n${rest}` };
	});
	let leading = 0;
	while (
		leading < sections.length &&
		!authored.has(sections[leading]?.title ?? "") &&
		sectionRank(sections[leading]?.title ?? "") < LEADING_SECTIONS.length
	)
		leading += 1;
	const { sectionsBeforeConventions: _before, ...rest } = output;
	return {
		...rest,
		sections,
		conventionsOverride: "paths=none",
		...(leading > 0 ? { sectionsBeforeConventions: leading } : {}),
	};
}

/** What stabilization keeps whatever the model wrote: checker, carried and authored invariants, and carried blocks. */
export interface ProtectedHandbook {
	invariants: ReadonlyArray<string>;
	/** Each section's carried blocks under its title. The model's additions to that section fit like any other. */
	sections: ReadonlyArray<ClioMdSection>;
	/** Titles of the sections the operator wrote, which keep their place and scope. */
	authoredTitles?: ReadonlyArray<string>;
}

/**
 * A rule's clauses, split where a sentence, semicolon or colon ends one. A
 * rule repeats kept text only clause by clause: as a substring, "remove the
 * guard" sat inside "do not remove the guard" and was dropped as stated.
 */
function ruleClauses(text: string): string[] {
	return text
		.split(/(?<=[.;:!?])\s+/)
		.map(normalizeHandbookRule)
		.filter((clause) => clause.length > 0);
}

/**
 * Fit whole rules and recipe blocks; a cut sentence must never lose its remedy.
 * Protected rules and carried blocks are placed whole and counted before any
 * model content, so model content gives way to them. When they alone exceed
 * the target they still stay, and `onOverflow` hears the handbook's size.
 */
export function fitGeneratedHandbook(
	output: BootstrapStructuredOutput,
	protectedContent?: ProtectedHandbook,
	onOverflow?: (size: { chars: number; lines: number }) => void,
): BootstrapStructuredOutput {
	const result: BootstrapStructuredOutput = {
		projectName: output.projectName,
		identity: output.identity,
		invariants: [],
		conventions: [],
		sections: [],
	};
	const protectedInvariants = new Set(protectedContent?.invariants ?? []);
	const carriedParts = new Map((protectedContent?.sections ?? []).map((section) => [section.title, section]));
	const sections = output.sections ?? [];
	// Content not placed yet that every size check counts: carried blocks, then the verification gate.
	let reserved: ClioMdSection[] = sections.flatMap((section) => {
		const carried = carriedParts.get(section.title);
		return carried ? [carried] : [];
	});
	const size = (): { chars: number; lines: number } => {
		const text = serializeClioMd(
			markWorkerScopes(
				{ ...result, sections: [...(result.sections ?? []), ...reserved] },
				protectedContent?.authoredTitles,
			),
		);
		return { chars: text.length, lines: text.trimEnd().split("\n").length };
	};
	const fits = (): boolean => {
		const { chars, lines } = size();
		return chars <= HANDBOOK_TARGETS.chars && lines <= HANDBOOK_TARGETS.lines;
	};
	const seen = new Set<string>();
	const seenClauses = new Set<string>();
	const key = normalizeHandbookRule;
	const remember = (text: string): void => {
		seen.add(key(text));
		for (const clause of ruleClauses(text)) seenClauses.add(clause);
	};
	// Stated already: the same rule, or a long one each of whose clauses a kept rule states whole.
	const covered = (text: string): boolean =>
		seen.has(key(text)) || (key(text).length >= 40 && ruleClauses(text).every((clause) => seenClauses.has(clause)));
	for (const rule of output.invariants) {
		if (!protectedInvariants.has(rule)) continue;
		result.invariants.push(rule);
		remember(rule);
	}
	for (const section of reserved) for (const block of handbookBlocks(section.body)) remember(block);
	// Verification has a reserved place even when every generated rule is long.
	const authored = sections
		.filter((section) => section.title === "Authored project rules")
		.flatMap((section) => handbookBlocks(section.body));
	const verification = sections.filter((section) => /\bverification\b/i.test(section.title));
	for (const section of verification) {
		result.sections?.push(section);
		if (!fits()) result.sections?.pop();
	}
	for (const field of ["invariants", "conventions"] as const) {
		for (const proposed of output[field]) {
			if (field === "invariants" && protectedInvariants.has(proposed)) continue;
			const proposedClauses = ruleClauses(proposed);
			// Keep a whole authored constraint when the model merely shortened it;
			// otherwise both the partial summary and its omitted remedy cost space.
			const canonical =
				key(proposed).length >= 40
					? authored.find((block) => {
							const clauses = new Set(ruleClauses(block));
							return proposedClauses.every((clause) => clauses.has(clause));
						})
					: undefined;
			const rule = canonical?.replace(/^\s*[-*+]\s/, "") ?? proposed;
			if (covered(rule)) continue;
			result[field].push(rule);
			if (!fits()) result[field].pop();
			else remember(rule);
		}
	}
	const retained = [...(result.sections ?? [])];
	result.sections = [];
	reserved = [...reserved, ...retained];
	for (const section of sections.filter((section) => !verification.includes(section))) {
		// A section starts from its carried blocks; the model's additions fit after them.
		const carried = carriedParts.get(section.title);
		if (carried) reserved = reserved.filter((pending) => pending !== carried);
		const candidate = { title: section.title, body: carried?.body ?? "" };
		result.sections.push(candidate);
		for (const block of handbookBlocks(section.body)) {
			if (covered(block)) continue;
			const previous = candidate.body;
			candidate.body = previous ? `${previous}\n${block}` : block;
			if (!fits()) candidate.body = previous;
			else remember(block);
		}
		if (!candidate.body) result.sections.pop();
	}
	reserved = [];
	result.sections.push(...retained);
	if (output.importedAgentContext) {
		result.importedAgentContext = output.importedAgentContext;
		if (!fits()) delete result.importedAgentContext;
	}
	// Every other part was placed only when it fit, so an overflow is protected content alone.
	if (!fits()) onOverflow?.(size());
	return result;
}
