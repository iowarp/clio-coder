import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { REPORT_ID, type ReportDraft } from "./draft.js";

/** Every file a report writes lives under here; nothing goes to `os.tmpdir()`. */
export function reportsDirectory(stateDir: string): string {
	return join(stateDir, "reports");
}

export function reportDraftsDirectory(stateDir: string): string {
	return join(reportsDirectory(stateDir), "drafts");
}

function draftPath(stateDir: string, id: string, extension: string): string {
	// The id names a file; anything but the fixed shape could name a path elsewhere.
	if (!REPORT_ID.test(id)) throw new Error(`not a report id: ${id}`);
	return join(reportDraftsDirectory(stateDir), `${id}${extension}`);
}

export function reportDraftPath(stateDir: string, id: string): string {
	return draftPath(stateDir, id, ".json");
}

/** The rendered markdown beside a draft: the body file `gh` reads, or the file a reporter pastes from. */
export function reportMarkdownPath(stateDir: string, id: string, suffix = ""): string {
	return draftPath(stateDir, id, `${suffix}.md`);
}

export function saveReportDraft(stateDir: string, draft: ReportDraft): string {
	const path = reportDraftPath(stateDir, draft.id);
	safeResourceWrite(path, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
	return path;
}

export function writeReportMarkdown(stateDir: string, id: string, text: string, suffix = ""): string {
	const path = reportMarkdownPath(stateDir, id, suffix);
	safeResourceWrite(path, text, { mode: 0o600 });
	return path;
}

export function readReportDraft(stateDir: string, id: string): ReportDraft | null {
	try {
		return JSON.parse(readFileSync(reportDraftPath(stateDir, id), "utf8")) as ReportDraft;
	} catch {
		// A missing or damaged draft reads as absent; the caller says so.
		return null;
	}
}

export function listReportDrafts(stateDir: string): string[] {
	try {
		return readdirSync(reportDraftsDirectory(stateDir))
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -".json".length))
			.filter((id) => REPORT_ID.test(id))
			.sort();
	} catch {
		// No drafts directory yet means no drafts.
		return [];
	}
}

export function deleteReportDraft(stateDir: string, id: string): void {
	for (const path of [reportDraftPath(stateDir, id), reportMarkdownPath(stateDir, id)]) rmSync(path, { force: true });
}
