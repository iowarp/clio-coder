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
 * Reads a non-TTY stdin. `explicit` is a bare `-` on the command line: the caller asked for stdin, so the read
 * waits for its end. Without it, a prompt source beside an open pipe that sends nothing gives up after 2 s, and
 * bytes that do arrive are still used (0.8.x) with a note that `-` is the spelling that will keep them.
 */
export async function readPipedStdin(hasPromptSource = false, explicit = false): Promise<string | undefined> {
	if (process.stdin.isTTY || process.stdin.readableEnded || process.stdin.destroyed) return undefined;
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const cleanup = (): void => {
			clearTimeout(firstByteTimeout);
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			process.stdin.pause();
		};
		const onData = (chunk: Buffer | string): void => {
			if (chunk.length === 0) return;
			clearTimeout(firstByteTimeout);
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		};
		const onEnd = (): void => {
			cleanup();
			if (chunks.length > 0 && hasPromptSource && !explicit) {
				process.stderr.write(
					"clio-coder: deprecated: run <task> with piped stdin and no -; use clio-coder run <task> - (removed in 0.9.0)\n",
				);
			}
			resolve(chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const firstByteTimeout =
			hasPromptSource && !explicit
				? setTimeout(() => {
						cleanup();
						process.stderr.write("clio-coder run: no data on stdin after 2s; ignoring it (redirect </dev/null to skip)\n");
						resolve(undefined);
					}, 2000)
				: undefined;
		process.stdin.on("data", onData);
		process.stdin.once("end", onEnd);
		process.stdin.once("error", onError);
		process.stdin.resume();
	});
}

export function buildInitialMessage(input: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	const [first, ...rest] = input.messages;
	if (first !== undefined) parts.push(first);
	if (input.fileText) parts.push(input.fileText);
	if (input.stdinContent !== undefined) parts.push(input.stdinContent);

	const result: InitialMessageResult = { remainingMessages: rest };
	if (parts.length > 0) result.initialMessage = parts.join("\n\n");
	if (input.fileImages && input.fileImages.length > 0) result.initialImages = [...input.fileImages];
	return result;
}
