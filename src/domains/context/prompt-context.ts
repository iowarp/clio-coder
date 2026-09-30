import { statSync } from "node:fs";
import { detectProjectTypeHint } from "../session/workspace/project-type.js";
import {
	loadProjectClioMd,
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
} from "./clio-md.js";
import { codewikiPath } from "./codewiki/artifact.js";
import type { ProjectPromptContext } from "./contract.js";
import { renderProjectOrientation } from "./orientation.js";
import { readClioState } from "./state.js";
import { readWikiMeta } from "./wiki/meta.js";
import { wikiCompletenessFromMeta } from "./wiki/staleness.js";

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
	// Foreground detection uses root filenames only; full source classification belongs to indexing.
	// and this renders on session compile and on every bounded dispatch. An
	// indexed project already recorded its type when init, refresh, or the
	// session-start check stamped state; the marker reads that and detects only
	// where nothing has been recorded yet.
	const state = readClioState(cwd);
	const projectType = state?.projectType ?? detectProjectTypeHint(cwd);
	const supportFragments = [
		renderProjectTypeFragment(projectType),
		"<context-evidence>Project handbooks provide standing instructions and navigation hints. They do not establish current branch, HEAD, dirty files, task completion, or implementation behavior. For repository orientation use code_nav mode=project for current Git and recorded task observations, even without an index; on a gateway-only tool surface call gateway with op=call, capability=code_nav, args={mode:project}. Read relevant definitions before making behavioral claims or proposing changes; label unverified facts as unknown. Preserve operator edits.</context-evidence>",
	];
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
	// Prompt assembly reports recorded snapshots. Current-tree validation belongs
	// to background lifecycle work and code_nav, never a synchronous full-tree
	// hash on the prompt/dispatch path. Presence does not certify parseability.
	if (codewikiArtifactPresent(cwd)) {
		addSupport("<codemap>available snapshot; freshness checked on retrieval; use code_nav</codemap>");
		if (state?.orientation) addSupport(renderProjectOrientation(cwd, state.orientation, state.fingerprint));
		else
			addSupport(
				"<project-orientation>not recorded; use code_nav mode=project for project facts and current status</project-orientation>",
			);
	}
	// Read checkpoint metadata only. Markdown presence is not successful page
	// validation, and source freshness is checked when wiki context is retrieved.
	const meta = readWikiMeta(cwd);
	if (meta) {
		const completeness = wikiCompletenessFromMeta(meta);
		const notes = [`recorded ${meta.updatedAt}; source freshness unchecked here`];
		if (completeness && completeness.owed > 0)
			notes.push(
				`incomplete: ${completeness.pagesWritten} of ${completeness.pagesPlanned} planned pages validated, ${completeness.owed} owed`,
			);
		if (!completeness) notes.push("coverage unknown");
		const available = new Set(meta.pages.map((page) => page.path));
		if (meta.plan?.pages.some((page) => page.status !== "written" && available.has(page.path)))
			notes.push("published pages awaiting successful validation");
		addSupport(
			`<wiki>${meta.pages.length} recorded pages at .clio-coder/wiki (${notes.join("; ")}); use code_nav mode=wiki; verify claims against current source and evidence</wiki>`,
		);
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
