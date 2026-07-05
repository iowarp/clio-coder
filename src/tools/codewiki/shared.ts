import {
	buildCodewiki,
	type Codewiki,
	codewikiNeedsBackfill,
	readCodewiki,
	writeCodewiki,
} from "../../domains/context/codewiki/indexer.js";
import { computeFingerprint } from "../../domains/context/fingerprint.js";
import { readClioState, writeClioState } from "../../domains/context/state.js";
import { detectProjectType } from "../../domains/session/workspace/project-type.js";

export async function loadCodewikiForTool(
	cwd: string = process.cwd(),
): Promise<{ ok: true; codewiki: Codewiki } | { ok: false; message: string }> {
	const codewiki = readCodewiki(cwd);
	if (codewiki && !codewikiNeedsBackfill(codewiki)) return { ok: true, codewiki };
	try {
		const generatedAt = new Date().toISOString();
		const projectType = detectProjectType(cwd);
		const rebuilt = await buildCodewiki({ cwd, language: projectType, generatedAt });
		writeCodewiki(cwd, rebuilt);
		const prev = readClioState(cwd);
		writeClioState(cwd, {
			version: 1,
			projectType: prev?.projectType ?? projectType,
			fingerprint: computeFingerprint(cwd, rebuilt),
			codewikiVersion: rebuilt.version,
			...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
			...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
			...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
			lastSessionAt: prev?.lastSessionAt ?? generatedAt,
			lastIndexedAt: generatedAt,
		});
		return { ok: true, codewiki: rebuilt };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `codewiki unavailable. run /context refresh to rebuild it. ${msg}` };
	}
}

export function renderJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
