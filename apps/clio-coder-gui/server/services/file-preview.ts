import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FilePreview } from "../../contracts/sessions.js";
import { WORKSPACE_SECRET_PATHS } from "../clio/http-shims.js";

/** The most a preview reads. A longer file shows its start and says it stopped. */
export const PREVIEW_MAX_BYTES = 256 * 1024;
/** A NUL in the first stretch of a file marks it as binary, the same test Git uses. */
const BINARY_SNIFF_BYTES = 8_000;

function globExpression(pattern: string): RegExp {
	const source = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*");
	return new RegExp(`^${source}$`, "iu");
}
const SECRET_DIRECTORIES = WORKSPACE_SECRET_PATHS.filter((entry) => entry.endsWith("/")).map((entry) =>
	globExpression(entry.slice(0, -1)),
);
const SECRET_FILES = WORKSPACE_SECRET_PATHS.filter((entry) => !entry.endsWith("/")).map(globExpression);

/**
 * Whether a workspace-relative path is one the agent's typed read tool refuses: a secret file name at any depth,
 * or anything under a secret directory. Git's own directory is withheld too, since its config can hold credentials.
 */
export function withheldPath(relativePath: string): boolean {
	const segments = relativePath.split("/").filter(Boolean);
	const name = segments.at(-1) ?? "";
	if (segments.some((segment) => segment === ".git")) return true;
	if (segments.slice(0, -1).some((segment) => SECRET_DIRECTORIES.some((pattern) => pattern.test(segment)))) return true;
	return SECRET_FILES.some((pattern) => pattern.test(name)) || SECRET_DIRECTORIES.some((pattern) => pattern.test(name));
}

/**
 * The workspace-relative form of what a transcript named, or null when it names a place outside the workspace.
 * An absolute path counts when it lies inside the root; `~`, `..` and NUL never do.
 */
export function workspaceRelative(root: string, input: string): string | null {
	if (input.includes("\0") || input.startsWith("~")) return null;
	const spelled = isAbsolute(input) ? relative(root, input).split(sep).join("/") : input;
	const segments = spelled.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
	return segments.join("/");
}

function insideRoot(root: string, target: string): string | null {
	const within = relative(root, target);
	if (within === "" || within.startsWith("..") || isAbsolute(within)) return null;
	return within.split(sep).join("/");
}

export async function readFilePreview(root: string, input: string): Promise<FilePreview> {
	const path = workspaceRelative(root, input);
	if (path === null) return { status: "outside", path: input, reason: "This path is outside the workspace." };
	if (withheldPath(path))
		return { status: "withheld", path, reason: "Secret files and Git's own directory are not shown here." };
	const realRoot = await realpath(root);
	let real: string;
	try {
		real = await realpath(join(realRoot, ...path.split("/")));
	} catch {
		return { status: "missing", path, reason: "No file by this name exists in the workspace now." };
	}
	// A link inside the workspace may point anywhere; what it resolves to is what would be read.
	const resolved = insideRoot(realRoot, real);
	if (resolved === null)
		return { status: "outside", path, reason: "This path leads outside the workspace through a link." };
	if (withheldPath(resolved))
		return { status: "withheld", path, reason: "Secret files and Git's own directory are not shown here." };
	const info = await stat(real);
	if (!info.isFile()) return { status: "not-a-file", path, reason: "This is a folder or a special file, not a file." };
	const handle = await open(real, "r");
	try {
		const buffer = Buffer.alloc(Math.min(info.size, PREVIEW_MAX_BYTES));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0))
			return { status: "binary", path, reason: "This file is binary, so there is no text to show." };
		const truncated = info.size > bytesRead;
		let text = new TextDecoder("utf-8").decode(bytes);
		// A cut can split a line or a character; a preview ends on the last whole line it read.
		if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf("\n") + 1));
		return { status: "text", path, text, size: info.size, truncated };
	} finally {
		await handle.close();
	}
}
