import { detectProjectType } from "../session/workspace/project-type.js";
import {
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
	tryReadClioMd,
} from "./clio-md.js";
import { readCodewiki } from "./codewiki/indexer.js";
import type { ProjectPromptContext } from "./contract.js";
import { computeFingerprintCached, isStale } from "./fingerprint.js";
import { readClioState } from "./state.js";
import { listWikiPages } from "./wiki/layout.js";
import { wikiCompleteness, wikiStaleness } from "./wiki/staleness.js";

/**
 * Render the project prompt context for `cwd`: the project-type marker, the
 * CLIO.md fragment when a parseable handbook exists, the codewiki availability
 * marker, and the Markdown wiki marker when a valid wiki exists. Shared by the
 * prompts extension (session compile),
 * context-init preload reporting, and `clio config inspect`, so every surface
 * measures the same text the session prompt would preload.
 */
export function renderPromptContext(cwd: string): ProjectPromptContext {
	const projectType = detectProjectType(cwd);
	const pieces = [renderProjectTypeFragment(projectType)];
	const warnings: string[] = [];
	const clio = tryReadClioMd(cwd);
	let clioMd: ParsedClioMd | null = null;
	if (clio?.ok) {
		clioMd = clio.value;
		pieces.push(renderProjectContextFragment(clio.value));
	}
	if (clio && !clio.ok) warnings.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
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
		const suffix = notes.length > 0 ? ` (${notes.join("; ")}; run clio context wiki --update)` : "";
		pieces.push(`<wiki>${pages.length} pages at .clio/wiki (start: quickstart.md)${suffix}</wiki>`);
	}
	return { text: pieces.join("\n\n"), clioMd, warnings };
}
