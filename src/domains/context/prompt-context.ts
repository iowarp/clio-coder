import { statSync } from "node:fs";
import { detectProjectType } from "../session/workspace/project-type.js";
import {
	loadProjectClioMd,
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
} from "./clio-md.js";
import { codewikiPath } from "./codewiki/artifact.js";
import type { ProjectPromptContext } from "./contract.js";
import { computeFingerprintCached, isStale } from "./fingerprint.js";
import { readClioState } from "./state.js";
import { listWikiPages } from "./wiki/layout.js";
import { wikiCompleteness, wikiStaleness } from "./wiki/staleness.js";

/**
 * Render the project prompt context for `cwd`: the project-type marker, the
 * effective CLIO-CODER.md fragments when readable nonempty handbooks exist, the codewiki availability
 * marker, and the Markdown wiki marker when a valid wiki exists. Shared by the
 * prompts extension (session compile),
 * context-init preload reporting, and `clio-coder config inspect`, so every surface
 * measures the same text the session prompt would preload.
 */
/** The one line that stands in for a handbook this workspace does not have. */
export const HANDBOOK_ABSENT_FRAGMENT =
	"<handbook>none: this workspace has no CLIO-CODER.md, so do not read one; learn the repository from its files, and the operator can run /context init to write a handbook</handbook>";

function codewikiArtifactPresent(cwd: string): boolean {
	try {
		return statSync(codewikiPath(cwd)).isFile();
	} catch {
		return false;
	}
}

export function renderPromptContext(cwd: string): ProjectPromptContext {
	// Detection enumerates the tree and reads every `.h` header to classify it,
	// and this renders on session compile and on every bounded dispatch. An
	// indexed project already recorded its type when init, refresh, or the
	// session-start check stamped state; the marker reads that and detects only
	// where nothing has been recorded yet.
	const state = readClioState(cwd);
	const projectType = state?.projectType ?? detectProjectType(cwd);
	const supportFragments = [renderProjectTypeFragment(projectType)];
	const pieces = [...supportFragments];
	const addSupport = (fragment: string): void => {
		pieces.push(fragment);
		supportFragments.push(fragment);
	};
	const warnings: string[] = [];
	const loadedClioMd = loadProjectClioMd(cwd);
	const clioMd: ParsedClioMd | null = loadedClioMd.value;
	for (const file of loadedClioMd.files) pieces.push(renderProjectContextFragment(file.source, file.path));
	for (const issue of loadedClioMd.errors) {
		warnings.push(`clio-coder: unavailable ${issue.path} ignored: ${issue.error}`);
	}
	// Said where the handbook would have been: a model that sees no project
	// context spends its first tool call reading CLIO-CODER.md and gets
	// ENOENT, while the operator's header already says it is missing (#191).
	if (loadedClioMd.files.length === 0 && loadedClioMd.errors.length === 0) addSupport(HANDBOOK_ABSENT_FRAGMENT);
	// The marker states that an artifact is present and whether the recorded
	// source fingerprint still matches the tree. It does not validate the
	// artifact's contents: parsing the JSON here is main-thread work that grows
	// with the index, on session compile and on every bounded dispatch, for a
	// boolean. An unparseable artifact is still "available" in the sense the
	// marker promises, because `code_nav` reads null for it and rebuilds from
	// source under the lease before answering, and the session-start check does
	// the same. The recorded fingerprint carries the line total the freshness
	// check would otherwise have read off the artifact.
	if (codewikiArtifactPresent(cwd)) {
		let stale = true;
		try {
			if (state) {
				stale = isStale(state.fingerprint, computeFingerprintCached(cwd, null, { artifactLoc: state.fingerprint.loc }));
			}
		} catch {
			warnings.push("clio-coder: codewiki freshness unavailable; source could not be read; run /context refresh");
		}
		const suffix = stale ? " (stale; run /context refresh)" : "";
		addSupport(`<codewiki>available${suffix}; use code_nav</codewiki>`);
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
		addSupport(`<wiki>${pages.length} pages at .clio-coder/wiki (start: quickstart.md)${suffix}</wiki>`);
	}
	return {
		text: pieces.join("\n\n"),
		clioMd,
		warnings,
		handbookFiles: loadedClioMd.files.map((file) => file.path),
		handbookSources: loadedClioMd.files.map(({ path, source }) => ({ path, source })),
		supportFragments,
	};
}
