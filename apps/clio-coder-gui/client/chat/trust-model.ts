/**
 * The project trust review, decided without React: what the verdict says, how a cut file is named,
 * when Trust may be pressed and what the dialog says after it. File text is untrusted project
 * content, so it is made inert here before a `<pre>` shows it.
 */

import type { TrustPreview, TrustPreviewFile, TrustSurface } from "../../contracts/review.js";
import type { SessionTelemetry } from "../../contracts/session-telemetry.js";

export const TRUST_INTRO =
	"CLIO Coder ignored these project files because you have not trusted them. Review a surface to see exactly what it contains, then trust it to apply it to this project.";
export const TRUST_LOADING = "Reading the project files…";
export const TRUST_WAIT_FOR_TURN = "Wait for the current turn to finish.";
export const TRUST_NOTHING_READABLE = "There is no readable file to trust.";
export const TRUST_CHANGED = "The files changed after you opened this review. Review them again.";
export const TRUST_RESTARTING = "Trusted. Restarting this task's engine to apply it…";
export const TRUST_APPLY_LATER = "Trusted. Start a new task or resume this one to apply it.";
export const TRUST_DONE = "Trusted. Tasks you start or resume in this project apply it.";

const VERDICT_WORDS: Readonly<Record<TrustPreview["verdict"], string>> = {
	untrusted: "Not trusted yet",
	changed: "Changed since you trusted it",
	trusted: "Trusted",
};
export function verdictWords(verdict: TrustPreview["verdict"]): string {
	return VERDICT_WORDS[verdict];
}

export function reviewTitle(surface: TrustSurface, workspaceName: string): string {
	return `Review ${surface} for ${workspaceName}`;
}

/** The last path segment of the workspace root, for the title when the workspace list has not named it. */
export function workspaceLabel(root: string): string {
	const parts = root.split(/[\\/]/u).filter(Boolean);
	return parts[parts.length - 1] ?? root;
}

function sizeWords(characters: number): string {
	if (characters >= 1024 * 1024) return `${(characters / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.round(characters / 1024)} KB`;
}
/** Null unless the server cut the file to its first 256 KB. */
export function sizeNote(file: TrustPreviewFile): string | null {
	return file.truncatedFrom === undefined ? null : `Showing the first 256 KB of ${sizeWords(file.truncatedFrom)}.`;
}

// C0 controls other than tab and newline, DEL, C1 controls and the bidirectional overrides and isolates
// that can make text read differently from what it contains.
// biome-ignore lint/suspicious/noControlCharactersInRegex: making control code points visible is the point.
const INERT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
/** Project text with every control character written out as `\u00XX`; a CRLF ending stays a line break. */
export function printable(text: string): string {
	return text.replace(/\r\n/gu, "\n").replace(INERT, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Whether Trust can be pressed, and the note that says why not. */
export function trustAvailability(
	preview: TrustPreview | undefined,
	running: boolean,
): {
	enabled: boolean;
	note: string | null;
} {
	if (running) return { enabled: false, note: TRUST_WAIT_FOR_TURN };
	if (!preview) return { enabled: false, note: null };
	if (preview.contentHash === null || !preview.files.some((file) => file.text !== null))
		return { enabled: false, note: TRUST_NOTHING_READABLE };
	if (preview.verdict === "trusted") return { enabled: false, note: "This surface is already trusted." };
	return { enabled: true, note: null };
}

/** The surfaces an engine trust report lists, each once, in the order it lists them, with their files. */
export function ignoredSurfaces(
	trust: SessionTelemetry["trust"],
): { surface: TrustSurface; verdict: string; files: string[] }[] {
	const groups = new Map<string, { surface: TrustSurface; verdict: string; files: string[] }>();
	for (const row of trust?.ignored ?? []) {
		if (!isTrustSurface(row.surface)) continue;
		const group = groups.get(row.surface) ?? { surface: row.surface, verdict: row.verdict, files: [] };
		group.files.push(row.file);
		groups.set(row.surface, group);
	}
	return [...groups.values()];
}
const SURFACES: readonly string[] = ["safety", "hooks", "settings", "extensions", "plugins", "handbook"];
function isTrustSurface(value: string): value is TrustSurface {
	return SURFACES.includes(value);
}

/**
 * What the dialog says once the approval landed. A task pane's review asks the task's engine to re-read
 * trust; the surface leaving its report is the proof it restarted, and without that proof the dialog
 * says how to apply it rather than claiming a restart.
 */
export function afterTrust(fromTask: boolean, stillIgnored: boolean): { message: string; close: boolean } {
	if (!fromTask) return { message: TRUST_DONE, close: false };
	return stillIgnored ? { message: TRUST_APPLY_LATER, close: false } : { message: TRUST_RESTARTING, close: true };
}
