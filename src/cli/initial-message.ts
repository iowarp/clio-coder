import type { ImageContent } from "../engine/types.js";

export interface InitialMessageInput {
	messages: ReadonlyArray<string>;
	stdinContent?: string;
	fileText?: string;
	fileImages?: ImageContent[];
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
	remainingMessages: string[];
}

/**
 * Reads a non-TTY stdin to its end. `run` calls it only for a bare `-` on the command line (SPEC 6.2, maintainer
 * ruling of 2026-11-20): stdin is never read implicitly, so a pipe beside a task given as text is left alone and
 * nothing waits on it.
 */
export async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY || process.stdin.readableEnded || process.stdin.destroyed) return undefined;
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const cleanup = (): void => {
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			process.stdin.pause();
		};
		const onData = (chunk: Buffer | string): void => {
			if (chunk.length === 0) return;
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		};
		const onEnd = (): void => {
			cleanup();
			resolve(chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		process.stdin.on("data", onData);
		process.stdin.once("end", onEnd);
		process.stdin.once("error", onError);
		process.stdin.resume();
	});
}

/**
 * The first run's user message (SPEC 6.2): argv text, then `@file` blocks, then piped stdin. Stdin that follows argv
 * text is framed as a `<stdin>` block, the shape `<file name>` attachments use, so every output format assembles the
 * same task (H23). With no argv text, stdin is the task itself and stays unframed.
 */
export function buildInitialMessage(input: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	const [first, ...rest] = input.messages;
	if (first !== undefined) parts.push(first);
	if (input.fileText) parts.push(input.fileText);
	if (input.stdinContent !== undefined)
		parts.push(first !== undefined ? `<stdin>\n${input.stdinContent}\n</stdin>` : input.stdinContent);

	const result: InitialMessageResult = { remainingMessages: rest };
	if (parts.length > 0) result.initialMessage = parts.join("\n\n");
	if (input.fileImages && input.fileImages.length > 0) result.initialImages = [...input.fileImages];
	return result;
}
