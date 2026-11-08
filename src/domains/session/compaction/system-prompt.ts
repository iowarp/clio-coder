import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_PROMPT_BYTES = 64 * 1024;

/** Absolute paths remain supported; relative paths are based on the current session workspace. */
export async function readCompactionSystemPrompt(
	path: string | null | undefined,
	workspace: string,
): Promise<string | undefined> {
	if (path === undefined || path === null) return undefined;
	// Quote the configured path, not file contents. Escape invisible directional
	// formatting too, and bound diagnostics for an invalid oversized filename.
	const quotedPath = JSON.stringify(path).replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
		(character) => `\\u{${character.codePointAt(0)?.toString(16)}}`,
	);
	const displayPath = quotedPath.length <= 1024 ? quotedPath : `${quotedPath.slice(0, 1024)}...`;
	const failure = (reason: string) =>
		new Error(
			`context.compaction.systemPrompt ${displayPath} ${reason}; set a readable, nonempty UTF-8 file of at most ${MAX_PROMPT_BYTES} bytes (relative to the session workspace), or unset the override`,
		);
	if (!path.trim()) throw failure("path is empty");
	let file: Awaited<ReturnType<typeof open>>;
	try {
		// Nonblocking open prevents a named pipe from hanging compaction before stat.
		file = await open(resolve(workspace, path), constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		throw failure("cannot be opened");
	}
	try {
		if (!(await file.stat()).isFile()) throw failure("must refer to a regular file");
		// Read only limit + 1, even if the file grows after stat. No unbounded readFile.
		const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_PROMPT_BYTES) throw failure("file is oversized");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		} catch {
			throw failure("file is not valid UTF-8");
		}
		if (!text.trim()) throw failure("file is empty");
		return text;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("context.compaction.systemPrompt ")) throw error;
		throw failure("file cannot be read");
	} finally {
		await file.close();
	}
}
