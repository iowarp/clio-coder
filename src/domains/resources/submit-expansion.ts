/**
 * Operator syntax in a submitted request, expanded the same way on every surface that submits one:
 * `/skill` requests become pending skill loads, a prompt template's name becomes its body, and
 * `@path` references inline the file, or attach it when it is an image. The terminal and the ACP
 * server both call this, so a request typed in the graphical app means what it means in the TUI.
 */

import { homedir } from "node:os";
import path from "node:path";
import { expandInlineFileReferencesAsync } from "../../core/file-references.js";
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { ImageContent } from "../../engine/types.js";
import type { ResourcesContract } from "./contract.js";

export interface SubmitExpansion {
	text: string;
	images: ImageContent[];
	workingContextPaths: string[];
	pendingSkillRequests: PendingSkillRequest[];
	/**
	 * What the transcript paints as the operator's turn when `text` is a prompt
	 * template's body: the line they typed, and a note naming the template. The
	 * model still receives `text`; a `/wtfp:new-paper` body is several hundred
	 * lines the operator never wrote, and painting it as their message buried
	 * the command under it. An `@path` reference gets the same treatment: the
	 * injected `<file name="/home/...">` block is the model's copy, and the
	 * note names the attached files by their short paths.
	 */
	display?: { text: string; note?: string };
}

const ATTACHMENT_NOTE_LIMIT = 3;

/** Workspace-relative when inside the cwd, `~/` when inside the home, otherwise absolute. */
function shortAttachmentPath(filePath: string, cwd: string): string {
	for (const [root, prefix] of [
		[path.resolve(cwd), ""],
		[path.resolve(homedir()), "~/"],
	] as const) {
		const rel = path.relative(root, filePath);
		if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel))
			return `${prefix}${rel.split(path.sep).join("/")}`;
	}
	return filePath;
}

function attachmentNote(paths: ReadonlyArray<string>, cwd: string): string {
	const shown = paths.slice(0, ATTACHMENT_NOTE_LIMIT).map((filePath) => shortAttachmentPath(filePath, cwd));
	const more = paths.length - shown.length;
	return `attached ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

export async function expandSubmitText(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
): Promise<SubmitExpansion> {
	const parsed = resources?.parsePendingSkillRequests(text, cwd) ?? {
		text,
		pendingSkillRequests: [],
	};
	const promptExpansion = resources?.expandPromptTemplate(parsed.text, cwd);
	const promptText = promptExpansion?.expanded ? promptExpansion.text : parsed.text;
	const fileExpansion = await expandInlineFileReferencesAsync(promptText, {
		cwd,
		includeImages: true,
		missing: "leave",
	});
	const attached =
		fileExpansion.referencedPaths.length > 0 ? attachmentNote(fileExpansion.referencedPaths, cwd) : undefined;
	const display = promptExpansion?.expanded
		? {
				text: parsed.text.trim(),
				note: [
					`expanded prompt template ${promptExpansion.template.name} (${promptExpansion.text.split("\n").length} lines)`,
					...(attached ? [attached] : []),
				].join("; "),
			}
		: attached
			? { text: text.trim(), note: attached }
			: undefined;
	return {
		text: fileExpansion.text,
		images: fileExpansion.images,
		workingContextPaths: fileExpansion.referencedPaths,
		pendingSkillRequests: parsed.pendingSkillRequests,
		...(display ? { display } : {}),
	};
}
