import { buildCodewiki, type Codewiki, readCodewiki, writeCodewiki } from "../../domains/context/codewiki/indexer.js";
import { computeFingerprint } from "../../domains/context/fingerprint.js";
import { readClioState, writeClioState } from "../../domains/context/state.js";
import { detectProjectType } from "../../domains/session/workspace/project-type.js";

export function loadCodewikiForTool(
	cwd: string = process.cwd(),
): { ok: true; codewiki: Codewiki } | { ok: false; message: string } {
	const codewiki = readCodewiki(cwd);
	if (codewiki) return { ok: true, codewiki };
	try {
		const generatedAt = new Date().toISOString();
		const projectType = detectProjectType(cwd);
		const rebuilt = buildCodewiki({ cwd, language: projectType, generatedAt });
		writeCodewiki(cwd, rebuilt);
		const prev = readClioState(cwd);
		writeClioState(cwd, {
			version: 1,
			projectType: prev?.projectType ?? projectType,
			fingerprint: computeFingerprint(cwd),
			...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
			...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
			...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
			lastSessionAt: prev?.lastSessionAt ?? generatedAt,
			lastIndexedAt: generatedAt,
		});
		return { ok: true, codewiki: rebuilt };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `codewiki unavailable. run /context-init to rebuild it. ${msg}` };
	}
}

export function renderJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
