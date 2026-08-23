import { detectProjectType } from "../session/workspace/project-type.js";
import {
	loadProjectClioMd,
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
} from "./clio-md.js";
import { readCodewiki } from "./codewiki/artifact.js";
import type { ProjectPromptContext } from "./contract.js";
import { computeFingerprintCached, isStale } from "./fingerprint.js";
import { readClioState } from "./state.js";
import { listWikiPages } from "./wiki/layout.js";
import { wikiCompleteness, wikiStaleness } from "./wiki/staleness.js";

/**
 * Render the project prompt context for `cwd`: the project-type marker, the
 * effective CLIO-CODER.md fragments when parseable handbooks exist, the codewiki availability
 * marker, and the Markdown wiki marker when a valid wiki exists. Shared by the
 * prompts extension (session compile),
 * context-init preload reporting, and `clio-coder config inspect`, so every surface
 * measures the same text the session prompt would preload.
 */
/** The one line that stands in for a handbook this workspace does not have. */
export const HANDBOOK_ABSENT_FRAGMENT =
	"<handbook>none: this workspace has no CLIO-CODER.md, so do not read one; learn the repository from its files, and the operator can run /context init to write a handbook</handbook>";

export function renderPromptContext(cwd: string): ProjectPromptContext {
	const projectType = detectProjectType(cwd);
	const pieces = [renderProjectTypeFragment(projectType)];
	const warnings: string[] = [];
	const loadedClioMd = loadProjectClioMd(cwd);
	const clioMd: ParsedClioMd | null = loadedClioMd.value;
	for (const file of loadedClioMd.files) pieces.push(renderProjectContextFragment(file.value, file.path));
	for (const issue of loadedClioMd.errors) {
		warnings.push(`clio: malformed ${issue.path} ignored: ${issue.error}`);
	}
	// Said where the handbook would have been: a model that sees no project
	// context spends its first tool call reading CLIO-CODER.md and gets
	// ENOENT, while the operator's header already says it is missing (#191).
	if (loadedClioMd.files.length === 0 && loadedClioMd.errors.length === 0) pieces.push(HANDBOOK_ABSENT_FRAGMENT);
	const codewiki = readCodewiki(cwd);
	if (codewiki) {
		const state = readClioState(cwd);
		const stale = state ? isStale(state.fingerprint, computeFingerprintCached(cwd, codewiki)) : true;
		const suffix = stale ? " (stale; run /context refresh)" : "";
		pieces.push(`<codewiki>available${suffix}; use code_nav</codewiki>`);
	}
	// A wiki is advertised whenever one exists. There is no invalid-layout state
	// to gate on: every structural defect is repaired by the assembly pass before
	// a tree is promoted, so a promoted wiki is by construction navigable.
	const staleness = wikiStaleness(cwd);
	if (staleness.state !== "absent") {
		const pages = listWikiPages(cwd);
		// Coverage before freshness: a partial wiki can be perfectly current with
		// the tree, so reporting only staleness would let a model read "12 pages"
		// as complete coverage of the repository and stop looking.
		const completeness = wikiCompleteness(cwd);
		const notes: string[] = [];
		if (completeness && completeness.owed > 0) {
			notes.push(
				`incomplete: ${completeness.pagesWritten} of ${completeness.pagesPlanned} planned pages written, ${completeness.owed} owed`,
			);
		}
		if (staleness.state === "stale") notes.push("stale");
		const suffix = notes.length > 0 ? ` (${notes.join("; ")}; run clio-coder context wiki --update)` : "";
		pieces.push(`<wiki>${pages.length} pages at .clio-coder/wiki (start: quickstart.md)${suffix}</wiki>`);
	}
	return { text: pieces.join("\n\n"), clioMd, warnings, handbookFiles: loadedClioMd.files.map((file) => file.path) };
}
