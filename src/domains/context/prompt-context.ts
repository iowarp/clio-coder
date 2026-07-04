import { detectProjectType } from "../session/workspace/project-type.js";
import {
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
	tryReadClioMd,
} from "./clio-md.js";
import { readCodewiki } from "./codewiki/indexer.js";
import type { ProjectPromptContext } from "./contract.js";
import { computeFingerprint, isStale } from "./fingerprint.js";
import { readClioState } from "./state.js";

/**
 * Render the project prompt context for `cwd`: the project-type marker, the
 * CLIO.md fragment when a parseable handbook exists, and the codewiki
 * availability marker. Shared by the prompts extension (session compile),
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
		const stale = state ? isStale(state.fingerprint, computeFingerprint(cwd, codewiki)) : true;
		const suffix = stale ? " (stale; run /context refresh)" : "";
		pieces.push(`<codewiki>available${suffix}; use code_nav</codewiki>`);
	}
	return { text: pieces.join("\n\n"), clioMd, warnings };
}
