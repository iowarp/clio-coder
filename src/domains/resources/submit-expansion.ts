/**
 * Operator syntax in a submitted request, expanded the same way on every surface that submits one:
 * `/skill` requests become pending skill loads, a prompt template's name becomes its body, and
 * `@path` references inline the file, or attach it when it is an image. The terminal and the ACP
 * server both call this, so a request typed in the graphical app means what it means in the TUI.
 */

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
	 * the command under it.
	 */
	display?: { text: string; note?: string };
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
	const display = promptExpansion?.expanded
		? {
				text: parsed.text.trim(),
				note: `expanded prompt template ${promptExpansion.template.name} (${promptExpansion.text.split("\n").length} lines)`,
			}
		: undefined;
	return {
		text: fileExpansion.text,
		images: fileExpansion.images,
		workingContextPaths: fileExpansion.referencedPaths,
		pendingSkillRequests: parsed.pendingSkillRequests,
		...(display ? { display } : {}),
	};
}
