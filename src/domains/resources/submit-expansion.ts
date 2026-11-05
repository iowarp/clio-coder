/**
 * Operator syntax in a submitted request, expanded the same way on every surface that submits one:
 * `/skill` requests become pending skill loads, a prompt template's name becomes its body, and
 * `@path` references inline the file, or attach it when it is an image. The terminal and the ACP
 * server both call this, so a request typed in the graphical app means what it means in the TUI.
 */

import { homedir } from "node:os";
import path from "node:path";
import { expandInlineFileReferencesAsync } from "../../core/file-references.js";
import { PLUGIN_RESOURCE_USE, recordPackageActivity } from "../../core/package-activity.js";
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { templateToolConstraints } from "../../core/turn-constraints.js";
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
	/** An expanded template's `allowed-tools` and `delegated-tools`, submitted as the turn's constraint. */
	constraints?: TurnConstraints;
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

/**
 * What the transcript says about the files a request named. A file whose bytes
 * went to the model is "attached"; a large or binary one went by name only,
 * and calling that attached let the operator believe the model had read it.
 * A file that could not be read is said too, since nothing else would say it.
 */
function attachmentNote(
	paths: ReadonlyArray<string>,
	diagnostics: ReadonlyArray<{ type: string; message: string; path?: string }>,
	cwd: string,
): string | undefined {
	const named = new Map(
		diagnostics.flatMap((item) => (item.type === "warning" && item.path ? [[item.path, item.message] as const] : [])),
	);
	const inlined = paths.filter((filePath) => !named.has(filePath));
	const byName = paths.filter((filePath) => named.has(filePath));
	const unreadable = diagnostics.filter((item) => item.type === "error" && item.path);
	const parts: string[] = [];
	if (inlined.length > 0) {
		const shown = inlined.slice(0, ATTACHMENT_NOTE_LIMIT).map((filePath) => shortAttachmentPath(filePath, cwd));
		const more = inlined.length - shown.length;
		parts.push(`attached ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
	}
	for (const filePath of byName.slice(0, ATTACHMENT_NOTE_LIMIT))
		parts.push(
			`sent ${shortAttachmentPath(filePath, cwd)} by name only: ${named.get(filePath)}, so Clio reads it in parts with its tools`,
		);
	if (byName.length > ATTACHMENT_NOTE_LIMIT) parts.push(`${byName.length - ATTACHMENT_NOTE_LIMIT} more by name only`);
	for (const item of unreadable.slice(0, ATTACHMENT_NOTE_LIMIT))
		parts.push(`could not attach ${shortAttachmentPath(item.path ?? "", cwd)}: ${item.message}`);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

export interface SubmitExpansionOptions {
	/** Aborts a slow attachment read; the expansion then rejects with the signal's reason. */
	signal?: AbortSignal;
	/** Names an attachment, by its short path, as its slow extraction starts. */
	onExtract?: (shortPath: string) => void;
}

export async function expandSubmitText(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
	options: SubmitExpansionOptions = {},
): Promise<SubmitExpansion> {
	const { signal, onExtract } = options;
	const parsed = resources?.parsePendingSkillRequests(text, cwd) ?? {
		text,
		pendingSkillRequests: [],
	};
	const promptExpansion = resources?.expandPromptTemplate(parsed.text, cwd);
	const promptOwner = promptExpansion?.expanded ? promptExpansion.template.sourceInfo?.owner : undefined;
	if (promptExpansion?.expanded && promptOwner)
		recordPackageActivity({
			type: PLUGIN_RESOURCE_USE,
			kind: "prompt",
			owner: promptOwner,
			outcome: "expanded",
			details: { name: promptExpansion.template.name },
		});
	const promptText = promptExpansion?.expanded ? promptExpansion.text : parsed.text;
	const allowedTools = promptExpansion?.expanded ? promptExpansion.template.allowedTools : undefined;
	const delegatedTools = promptExpansion?.expanded ? promptExpansion.template.delegatedTools : undefined;
	const fileExpansion = await expandInlineFileReferencesAsync(promptText, {
		cwd,
		includeImages: true,
		missing: "leave",
		...(signal ? { signal } : {}),
		...(onExtract ? { onExtract: (filePath: string) => onExtract(shortAttachmentPath(filePath, cwd)) } : {}),
	});
	const attached = attachmentNote(fileExpansion.referencedPaths, fileExpansion.diagnostics, cwd);
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
		...(allowedTools || delegatedTools
			? {
					constraints: templateToolConstraints({
						name: promptExpansion?.expanded ? promptExpansion.template.name : "",
						...(allowedTools ? { allowedTools } : {}),
						...(delegatedTools ? { delegatedTools } : {}),
					}),
				}
			: {}),
	};
}
