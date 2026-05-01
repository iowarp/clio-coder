import { type Codewiki, type CodewikiEntry, readCodewiki } from "../../domains/context/codewiki/indexer.js";

export function loadCodewikiForTool(
	cwd: string = process.cwd(),
): { ok: true; codewiki: Codewiki } | { ok: false; message: string } {
	const codewiki = readCodewiki(cwd);
	if (!codewiki) {
		return { ok: false, message: "codewiki not built. run /init or end and restart this session." };
	}
	return { ok: true, codewiki };
}

export function renderEntries(entries: ReadonlyArray<CodewikiEntry>): string {
	return JSON.stringify({ entries }, null, 2);
}
