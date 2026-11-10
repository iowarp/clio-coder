import type { ReportDraft } from "./draft.js";
import { titleCore } from "./draft.js";
import { renderObservation } from "./observe.js";
import { type LocalIdentity, mergeMasks, type ReportMask, scrubText } from "./scrub.js";
import {
	REPORT_BLOCK_TAG,
	REPORT_DETAILS_SUMMARY,
	REPORT_EMPTY_SECTION,
	REPORT_FOOTER,
	REPORT_HEADINGS,
	REPORT_NOTHING_OBSERVED,
	REPORT_NOTHING_UNKNOWN,
	reportOs,
} from "./vocabulary.js";

/** A rendered report: the exact bytes the preview shows and the transport sends. */
export interface RenderedReport {
	id: string;
	title: string;
	body: string;
	masks: ReportMask[];
	/** The same text split by the issue form's field ids, for a prefilled link. */
	fields: { problem: string; expected: string; reproduce: string; environment: string; details: string };
}

function oneLine(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function orEmpty(text: string): string {
	return text.trim().length > 0 ? text.trim() : REPORT_EMPTY_SECTION;
}

function section(heading: string, text: string): string {
	return `### ${heading}\n\n${text}`;
}

const TITLE_PREFIX: Readonly<Record<ReportDraft["kind"], string | null>> = {
	bug: "fix",
	feature: "feat",
	question: null,
};

/** The machine-readable block of R-04: one `key: value` per line, every value closed or of a fixed shape. */
export function renderReportBlock(draft: ReportDraft): string {
	const lines = [
		"v: 1",
		`id: ${draft.id}`,
		`kind: ${draft.kind}`,
		`area: ${draft.area ?? "none"}`,
		`surface: ${draft.environment.surface}`,
		`version: ${draft.environment.clioCoder}`,
		`os: ${reportOs(draft.environment.platform.split("-")[0] as NodeJS.Platform) ?? "none"}`,
		`install: ${draft.environment.install}`,
		`trigger: ${draft.trigger}`,
		`cause: ${draft.cause ?? "none"}`,
		`fingerprint: ${draft.fingerprint ?? "none"}`,
		`links: ${draft.links.length > 0 ? draft.links.map((n) => `#${n}`).join(", ") : "none"}`,
		`regression: ${draft.regression === true ? "yes" : "no"}`,
		"bundle: none",
		"consent: none",
		"credit: no",
	];
	return `<details><summary>${REPORT_DETAILS_SUMMARY}</summary>\n\n\`\`\`${REPORT_BLOCK_TAG}\n${lines.join("\n")}\n\`\`\`\n</details>`;
}

/** The first `clio-coder-report` block's `key: value` lines, as R-05's labeler reads them; null when there is none. */
export function parseReportBlock(body: string): Record<string, string> | null {
	const lines = body.split(/\r?\n/u);
	const start = lines.findIndex((line) => line.trim() === `\`\`\`${REPORT_BLOCK_TAG}`);
	if (start < 0) return null;
	const fields: Record<string, string> = {};
	for (const line of lines.slice(start + 1)) {
		if (line.trim().startsWith("```")) return fields;
		const match = /^([a-z][a-z0-9_-]*):\s*(.*?)\s*$/u.exec(line);
		if (match?.[1] !== undefined && !(match[1] in fields)) fields[match[1]] = match[2] ?? "";
	}
	return null;
}

/**
 * Render a draft into the fixed sections: what happened, the operator's words, expected, steps, what Clio observed,
 * what is not known, the environment, the report block and the footer. Every free-text field is scrubbed; the
 * scaffold and the block hold only fixed words and vocabulary values, which the scrubber never replaces.
 */
export function renderReport(draft: ReportDraft, identity: LocalIdentity): RenderedReport {
	const lists: ReportMask[][] = [];
	const scrub = (text: string) => {
		const result = scrubText(text, identity, draft.unmasked);
		lists.push(result.masks);
		return result.text;
	};
	const prefix = TITLE_PREFIX[draft.kind];
	const core = scrub(oneLine(titleCore(draft.title)));
	const head = prefix === null ? "" : `${prefix}${draft.area !== null ? `(${draft.area})` : ""}: `;
	const title = `${head}${draft.regression === true ? "regression: " : ""}${core}`;

	const happened = orEmpty(scrub(draft.sections.happened));
	const operatorWords = scrub(draft.sections.operatorWords.trim());
	const quoted =
		operatorWords.length > 0
			? section(
					REPORT_HEADINGS.operatorWords,
					operatorWords
						.split("\n")
						.map((line) => (line.length > 0 ? `> ${line}` : ">"))
						.join("\n"),
				)
			: null;
	const expected = orEmpty(scrub(draft.sections.expected));
	const reproduce = orEmpty(scrub(draft.sections.reproduce));
	const observed =
		draft.observed.length > 0
			? scrub(draft.observed.map((observation) => `- ${renderObservation(observation)}`).join("\n"))
			: REPORT_NOTHING_OBSERVED;
	const notKnownItems = draft.sections.notKnown.map((item) => oneLine(scrub(item))).filter((item) => item.length > 0);
	const notKnown =
		notKnownItems.length > 0 ? notKnownItems.map((item) => `- ${item}`).join("\n") : REPORT_NOTHING_UNKNOWN;
	const env = draft.environment;
	const environment = scrub(
		[
			`- Clio Coder: ${env.clioCoder}`,
			`- Platform: ${env.platform}`,
			`- Node: ${env.node}`,
			`- Install: ${env.install}`,
			`- Surface: ${env.surface}`,
			...(env.autonomy !== null ? [`- Autonomy: ${env.autonomy}`] : []),
			...(env.runtime !== null ? [`- Runtime: ${env.runtime}`] : []),
			...(draft.includeModel && env.model !== null ? [`- Model: ${env.model}`] : []),
		].join("\n"),
	);
	const details = `${renderReportBlock(draft)}\n\n${REPORT_FOOTER}`;

	const observedSection = section(REPORT_HEADINGS.observed, observed);
	const notKnownSection = section(REPORT_HEADINGS.notKnown, notKnown);
	const body = [
		section(REPORT_HEADINGS.happened, happened),
		...(quoted !== null ? [quoted] : []),
		section(REPORT_HEADINGS.expected, expected),
		section(REPORT_HEADINGS.reproduce, reproduce),
		observedSection,
		notKnownSection,
		section(REPORT_HEADINGS.environment, environment),
		details,
	].join("\n\n");
	return {
		id: draft.id,
		title,
		body: `${body}\n`,
		masks: mergeMasks(lists),
		fields: {
			problem: [happened, ...(quoted !== null ? [quoted] : []), observedSection, notKnownSection].join("\n\n"),
			expected: draft.sections.expected.trim().length > 0 ? expected : "",
			reproduce: draft.sections.reproduce.trim().length > 0 ? reproduce : "",
			environment,
			details,
		},
	};
}

/** True when scrubbing the rendered title and body again changes nothing. */
export function isFixedPoint(
	rendered: Pick<RenderedReport, "title" | "body">,
	identity: LocalIdentity,
	unmasked: ReadonlyArray<string> = [],
): boolean {
	return (
		scrubText(rendered.body, identity, unmasked).text === rendered.body &&
		scrubText(rendered.title, identity, unmasked).text === rendered.title
	);
}
