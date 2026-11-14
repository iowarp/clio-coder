import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm, rmdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { TranscriptDownload as Download, TranscriptFormat } from "../../contracts/rewind.js";
import type { Supervisor } from "../acp/supervisor.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** The largest transcript carried back to the browser; a longer one stays a terminal /export. */
const TRANSCRIPT_DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024;
const TOO_LARGE = "The transcript is too large to download here. Use /export in a terminal session.";

/** `<slug>-<YYYY-MM-DD>.<ext>`, dated by this machine's local calendar as the terminal export is. */
function transcriptFilename(title: string, format: TranscriptFormat, now = new Date()): string {
	const slug =
		title
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 80)
			.replace(/-+$/u, "") || "transcript";
	const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
	return `${slug}-${day}.${format === "markdown" ? "md" : "html"}`;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * The terminal's /export, carried to the browser: the task's own `export` command writes the transcript to a
 * GUI-owned path under the task's directory, this reads it back and removes it, so nothing is left in the project.
 * The ACP child always runs on this server's machine, so the file it writes is a local file here.
 */
export class TranscriptDownload {
	constructor(
		private readonly supervisor: Supervisor,
		private readonly workspaces: WorkspaceService,
	) {}

	async read(id: string, format: TranscriptFormat): Promise<Download> {
		const snapshot = this.supervisor.get(id);
		const root = (await this.workspaces.get(snapshot.workspaceId)).path;
		const exportsDir = join(root, ".clio-coder", "exports");
		// Directories this download creates are removed again, innermost first; ones the operator already had stay.
		const scratch = [exportsDir, join(root, ".clio-coder")];
		const existed = await Promise.all(scratch.map((dir) => present(dir)));
		const relative = `.clio-coder/exports/gui-download-${randomUUID()}.${format === "markdown" ? "md" : "html"}`;
		const written = join(root, relative);
		try {
			const result = await this.supervisor.invokeCommand(id, { command: "export", argv: [relative] });
			if (result.level === "error")
				throw new AppProblem("operation_failed", result.lines.join(" ").trim() || "The engine gave no reason.");
			const file = await realpath(written).catch((error: unknown) => {
				if (missing(error)) throw new AppProblem("operation_failed", "The engine wrote no file.");
				throw error;
			});
			const allowed = `${await realpath(exportsDir)}${sep}`;
			if (!file.startsWith(allowed))
				throw new AppProblem("operation_failed", "The engine wrote the file outside the exports folder.");
			if ((await stat(file)).size > TRANSCRIPT_DOWNLOAD_MAX_BYTES) throw new AppProblem("operation_failed", TOO_LARGE);
			const text = await readFile(file, "utf8");
			return {
				filename: transcriptFilename(snapshot.label ?? snapshot.turns[0]?.prompt ?? id, format),
				mediaType: format === "markdown" ? "text/markdown" : "text/html",
				text,
			};
		} finally {
			await rm(written, { force: true }).catch(() => {
				// `force` already ignores ENOENT (the export may never have been written); any other failure must not
				// replace the answer or the export's own error.
			});
			for (const dir of scratch.filter((_, index) => !existed[index]))
				await rmdir(dir).catch(() => {
					// Only an empty directory this download created is removed; anything else in it keeps it.
				});
		}
	}
}

async function present(path: string) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}
